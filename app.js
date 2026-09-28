// Row format from build.ps1: [position, name, creator, levelId, youtubeId, thumbIndex, flags]; flags: 1 = legacy, 2 = two-player
const LEVELS = DATA.levels.map(r => ({
  pos: r[0], name: r[1], creator: r[2] || 'Unknown', id: r[3], yt: r[4], thumb: r[5],
  legacy: (r[6] & 1) > 0, twoP: (r[6] & 2) > 0,
}));
const BY_KEY = new Map();
for (const l of LEVELS) {
  l.key = String(l.id) + (l.twoP ? 'p' : '');
  if (BY_KEY.has(l.key)) l.key += '-' + l.pos;
  BY_KEY.set(l.key, l);
}
const MAIN_MAX = Math.max(1, ...LEVELS.filter(l => !l.legacy).map(l => l.pos));
const ALL_MAX = Math.max(MAIN_MAX, ...LEVELS.map(l => l.pos));
const PRESETS = [[1, 75], [1, 150], [1, 500], [1, 1000], [1, 'all']];
const STORE_KEY = 'aredl-roulette-v1';

const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString('en-US');

let settings = { from: 1, to: MAIN_MAX, twoP: false, legacy: false };
let run = null;

// ---------- persistence ----------
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ settings, run })); } catch (e) {}
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
}

// ---------- level pool ----------
const maxFor = s => (s.legacy ? ALL_MAX : MAIN_MAX);
function inRange(s) {
  return LEVELS.filter(l => l.pos >= s.from && l.pos <= s.to && (s.twoP || !l.twoP) && (s.legacy || !l.legacy));
}
function needed() {
  return run.history.length ? run.history[run.history.length - 1].got + 1 : 1;
}
function pickNext() {
  const used = new Set(run.history.map(h => h.key));
  if (run.current) used.add(run.current);
  const pool = inRange(run).filter(l => !used.has(l.key));
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}
function leftInRange() {
  const used = new Set(run.history.map(h => h.key));
  if (run.current) used.add(run.current);
  return inRange(run).filter(l => !used.has(l.key)).length;
}

// ---------- thumbnails (5x5 sprite sheets of 320x180 tiles) ----------
const PER_SHEET = 25, COLS = 5, TW = 320, TH = 180;
const sheets = new Map();
function loadSheet(i) {
  if (!sheets.has(i)) {
    sheets.set(i, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { sheets.delete(i); reject(new Error('sheet ' + i)); };
      img.src = 'thumbs/' + String(i).padStart(2, '0') + '.jpg';
    }));
  }
  return sheets.get(i);
}
async function drawThumb(box, canvas, level) {
  canvas.dataset.key = level.key;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  box.classList.remove('none');
  if (level.thumb < 0) { box.classList.remove('loading'); box.classList.add('none'); return; }
  box.classList.add('loading');
  const t = level.thumb % PER_SHEET;
  try {
    const img = await loadSheet(Math.floor(level.thumb / PER_SHEET));
    if (canvas.dataset.key !== level.key) return;
    ctx.drawImage(img, (t % COLS) * TW, Math.floor(t / COLS) * TH, TW, TH, 0, 0, canvas.width, canvas.height);
    box.classList.remove('loading');
  } catch (e) {
    if (canvas.dataset.key !== level.key) return;
    box.classList.remove('loading');
    box.classList.add('none');
  }
}

// ---------- setup screen ----------
const lo = $('lo'), hi = $('hi'), loNum = $('loNum'), hiNum = $('hiNum');

function clampSettings() {
  const max = maxFor(settings);
  settings.from = Math.min(Math.max(1, Math.round(settings.from) || 1), max);
  settings.to = Math.min(Math.max(1, Math.round(settings.to) || max), max);
  if (settings.from > settings.to) [settings.from, settings.to] = [settings.to, settings.from];
}

function renderSetup() {
  clampSettings();
  const max = maxFor(settings);
  for (const el of [lo, hi, loNum, hiNum]) el.max = max;
  lo.value = settings.from; hi.value = settings.to;
  if (document.activeElement !== loNum) loNum.value = settings.from;
  if (document.activeElement !== hiNum) hiNum.value = settings.to;
  $('twoP').checked = settings.twoP;
  $('legacy').checked = settings.legacy;

  const span = Math.max(1, max - 1);
  const a = (settings.from - 1) / span * 100, b = (settings.to - 1) / span * 100;
  $('fill').style.left = `calc(${a}% + ${11 - a * 0.22}px)`;
  $('fill').style.width = `calc(${b - a}% - ${(b - a) * 0.22}px)`;
  lo.style.zIndex = settings.from > max * 0.9 ? 3 : 2;

  const count = inRange(settings).length;
  $('poolCount').textContent = fmt(count);
  $('sumText').textContent = `#${fmt(settings.from)} – #${fmt(settings.to)} · ${fmt(count)} levels`;
  const warn = $('fewWarn');
  warn.hidden = count >= 100;
  warn.textContent = count === 0
    ? 'No levels match this range. Widen it or turn on more level types.'
    : `Only ${fmt(count)} levels in this range. You could run out of levels before reaching 100%.`;
  $('startBtn').disabled = count === 0;

  const presets = $('presets');
  presets.textContent = '';
  for (const [f, t] of PRESETS) {
    const to = t === 'all' ? max : t;
    if (to > max) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = t === 'all' ? `All ${fmt(max)}` : `Top ${fmt(to)}`;
    btn.setAttribute('aria-pressed', String(settings.from === f && settings.to === to));
    btn.addEventListener('click', () => { settings.from = f; settings.to = to; renderSetup(); save(); });
    presets.append(btn);
  }
}

lo.addEventListener('input', () => { settings.from = Math.min(+lo.value, settings.to); renderSetup(); });
hi.addEventListener('input', () => { settings.to = Math.max(+hi.value, settings.from); renderSetup(); });
for (const el of [lo, hi]) el.addEventListener('change', save);
function fromNumbers() {
  const f = parseInt(loNum.value, 10), t = parseInt(hiNum.value, 10);
  if (Number.isFinite(f)) settings.from = f;
  if (Number.isFinite(t)) settings.to = t;
}
for (const el of [loNum, hiNum]) {
  el.addEventListener('input', () => { fromNumbers(); renderSetup(); });
  el.addEventListener('change', () => { fromNumbers(); loNum.value = ''; hiNum.value = ''; el.blur(); renderSetup(); save(); });
}
$('twoP').addEventListener('change', e => { settings.twoP = e.target.checked; renderSetup(); save(); });
$('legacy').addEventListener('change', e => {
  const wasAtEnd = settings.to === maxFor(settings);
  settings.legacy = e.target.checked;
  if (wasAtEnd || !settings.legacy) settings.to = Math.min(maxFor(settings), wasAtEnd ? maxFor(settings) : settings.to);
  renderSetup(); save();
});

$('startBtn').addEventListener('click', () => {
  clampSettings();
  run = { ...settings, history: [], current: null, status: 'playing', quitOn: null };
  const first = pickNext();
  if (!first) return;
  run.current = first.key;
  save();
  render(true);
  window.scrollTo({ top: 0 });
  $('pctInput').focus();
});

// ---------- play screen ----------
function renderPlay(animate) {
  const level = BY_KEY.get(run.current);
  const need = needed();
  $('hudLevel').textContent = run.history.length + 1;
  $('hudRange').textContent = `#${fmt(run.from)}–#${fmt(run.to)}`;
  $('hudLeft').textContent = fmt(leftInRange());

  $('rank').textContent = '#' + fmt(level.pos);
  const tag = level.legacy ? 'Legacy' : level.twoP ? '2 player' : '';
  $('tag').hidden = !tag;
  $('tag').textContent = tag;
  $('levelName').textContent = level.name;
  $('creator').textContent = level.creator;
  $('levelId').textContent = level.id;
  $('copyBtn').textContent = 'Copy';
  $('thumbCanvas').setAttribute('aria-label', `Thumbnail for ${level.name}`);
  drawThumb($('thumb'), $('thumbCanvas'), level);

  const yt = $('ytLink');
  yt.hidden = !level.yt;
  if (level.yt) yt.href = 'https://www.youtube.com/watch?v=' + level.yt;
  $('aredlLink').href = 'https://aredl.net/list/' + level.id;

  $('goalPct').textContent = need + '%';
  $('barFill').style.width = need + '%';
  $('bar').setAttribute('aria-valuenow', need);
  $('bar').setAttribute('aria-label', `Goal: ${need}%`);
  const input = $('pctInput');
  input.min = need;
  input.placeholder = `${need} or more`;
  if (animate) { input.value = ''; $('entryError').textContent = ''; }
  resetQuit();

  if (animate) {
    const card = $('card');
    card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop');
  }
}

$('copyBtn').addEventListener('click', () => {
  const text = $('levelId').textContent;
  const done = () => { $('copyBtn').textContent = 'Copied'; };
  const fallback = () => {
    const range = document.createRange();
    range.selectNodeContents($('levelId'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    $('copyBtn').textContent = 'Press Ctrl+C';
  };
  try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
});

$('entryForm').addEventListener('submit', e => {
  e.preventDefault();
  const need = needed();
  const raw = $('pctInput').value.trim();
  const got = Number(raw);
  if (!raw || !Number.isInteger(got) || got < need || got > 100) {
    $('entryError').textContent = `Enter a whole number from ${need} to 100.`;
    $('pctInput').focus();
    return;
  }
  $('entryError').textContent = '';
  run.history.push({ key: run.current, need, got });
  if (got >= 100) {
    run.status = 'won'; run.current = null;
  } else {
    const next = pickNext();
    if (next) run.current = next.key;
    else { run.status = 'empty'; run.current = null; }
  }
  save();
  render(true);
  if (run.status === 'playing') $('pctInput').focus();
});

let quitTimer = 0;
function resetQuit() {
  clearTimeout(quitTimer);
  $('quitBtn').classList.remove('armed');
  $('quitBtn').textContent = 'Give up';
}
$('quitBtn').addEventListener('click', () => {
  const btn = $('quitBtn');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'Click again to give up';
    quitTimer = setTimeout(resetQuit, 4000);
    return;
  }
  resetQuit();
  run.status = 'quit';
  run.quitOn = { key: run.current, need: needed() };
  run.current = null;
  save();
  render(true);
});

// ---------- end screen + log ----------
function renderEnd() {
  const best = run.history.length ? run.history[run.history.length - 1].got : 0;
  const title = $('endTitle');
  title.classList.toggle('win', run.status === 'won');
  if (run.status === 'won') {
    title.textContent = 'Roulette complete!';
    $('endText').textContent = `You reached 100% in ${run.history.length} ${run.history.length === 1 ? 'level' : 'levels'}.`;
  } else if (run.status === 'empty') {
    title.textContent = 'Out of levels';
    $('endText').textContent = `You played every level in #${fmt(run.from)}–#${fmt(run.to)} and got to ${best}%. Widen the range next time to keep going.`;
  } else {
    title.textContent = `Run over at ${best}%`;
    $('endText').textContent = run.quitOn
      ? `You gave up on ${BY_KEY.get(run.quitOn.key)?.name ?? 'a level'}, which needed ${run.quitOn.need}%.`
      : 'You gave up before your first level.';
  }
  const stats = [
    ['Levels beaten', run.history.length],
    ['Highest %', best + '%'],
    ['Range', `#${fmt(run.from)}–#${fmt(run.to)}`],
  ];
  const box = $('endStats');
  box.textContent = '';
  for (const [label, value] of stats) {
    const s = document.createElement('div');
    s.className = 'stat';
    s.innerHTML = '<span></span><b></b>';
    s.children[0].textContent = label;
    s.children[1].textContent = value;
    box.append(s);
  }
}

function renderLog() {
  const rows = run.history.map((h, i) => ({ ...h, n: i + 1 }));
  if (run.quitOn) rows.push({ ...run.quitOn, n: rows.length + 1, quit: true });
  $('log').hidden = rows.length === 0;
  const list = $('logList');
  list.textContent = '';
  for (const r of rows.reverse()) {
    const level = BY_KEY.get(r.key);
    if (!level) continue;
    const li = document.createElement('li');
    li.className = 'panel';
    li.innerHTML = '<div class="thumb mini"><canvas width="320" height="180"></canvas></div><div class="who"><b><span class="pos"></span> – <span></span></b><span></span></div><div class="res"></div>';
    const [pos, name] = li.querySelectorAll('.who b span');
    pos.textContent = '#' + fmt(level.pos);
    name.textContent = level.name;
    li.querySelector('.who > span').textContent = `by ${level.creator}`;
    const res = li.querySelector('.res');
    if (r.quit) {
      res.classList.add('quit');
      res.innerHTML = 'Gave up<small></small>';
      res.querySelector('small').textContent = `needed ${r.need}%`;
    } else {
      res.classList.add('hit');
      res.innerHTML = '<span></span><small></small>';
      res.firstChild.textContent = r.got + '%';
      res.querySelector('small').textContent = `needed ${r.need}%`;
    }
    const mini = li.querySelector('.mini');
    drawThumb(mini, mini.querySelector('canvas'), level);
    list.append(li);
  }
}

$('againBtn').addEventListener('click', () => {
  settings = { from: run.from, to: run.to, twoP: run.twoP, legacy: run.legacy };
  run = null;
  save();
  render();
  window.scrollTo({ top: 0 });
});

// ---------- screens ----------
function render(animate) {
  const playing = run && run.status === 'playing' && BY_KEY.has(run.current);
  const ended = run && run.status !== 'playing';
  const started = !!run && (playing || ended);
  $('setup').hidden = started;
  $('topbar').hidden = !started;
  $('runPage').hidden = !started;
  $('hudStats').hidden = !playing;
  $('quitBtn').hidden = !playing;
  $('play').hidden = !playing;
  $('end').hidden = !ended;
  if (!run || (!playing && !ended)) { run = null; $('log').hidden = true; renderSetup(); return; }
  if (playing) renderPlay(animate);
  if (ended) renderEnd();
  renderLog();
}

function start(hotData) {
  const saved = (hotData && hotData.state) || load();
  if (saved.settings) settings = { ...settings, ...saved.settings };
  if (saved.run && Array.isArray(saved.run.history)) run = saved.run;
  const main = LEVELS.filter(l => !l.legacy).length;
  $('meta').innerHTML = `<b>${fmt(main)}</b> extremes on the list · updated <b></b>`;
  $('meta').lastElementChild.textContent = DATA.updated || 'unknown';
  render();
}

window.claude?.hot?.snapshot?.(() => ({ state: { settings, run } }));
window.claude?.hot?.ready ? window.claude.hot.ready(start) : start(window.claude?.hot?.data ?? {});
