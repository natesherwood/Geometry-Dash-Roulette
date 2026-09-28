<#
.SYNOPSIS
  Rebuilds the level table and thumbnail sprites for AREDL Roulette.
.DESCRIPTION
  1. Downloads the full list from the AREDL API.
  2. Fetches each level's publisher and verification video.
  3. Downloads each verification's YouTube thumbnail (320x180).
  4. Packs the thumbnails into 5x5 JPEG sprite sheets in .\thumbs\.
  5. Writes the level table into levels.js.
  Level details and thumbnails are cached in %TEMP%\aredl-roulette-cache, so a re-run only
  fetches levels that are new since the last run. Pass -Fresh to refetch everything.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\build.ps1
#>
param(
  [switch]$Fresh,
  [int]$Concurrency = 4
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.Drawing
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$api      = 'https://api.aredl.net/v2/api/aredl/levels'
$root     = $PSScriptRoot
$cache    = Join-Path $env:TEMP 'aredl-roulette-cache'
$detDir   = Join-Path $cache 'details'
$ytDir    = Join-Path $cache 'yt'
$thumbDir = Join-Path $root 'thumbs'
$dataFile = Join-Path $root 'levels.js'

if ($Fresh -and (Test-Path $cache)) { Remove-Item -Recurse -Force $cache }
New-Item -ItemType Directory -Force $detDir, $ytDir, $thumbDir | Out-Null

$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(60)
$http.DefaultRequestHeaders.UserAgent.ParseAdd('aredl-roulette-build/1.0')

# GETs every URL, $Concurrency at a time. Rate limits (429) pause the run for the server's
# Retry-After (or 20s) and requeue; network errors and 5xx are retried too, up to 10 tries per URL.
# Returns one @{ Status; Bytes } per URL, in order.
function Get-Many([string[]]$Urls) {
  $out = New-Object object[] $Urls.Count
  $queue = New-Object System.Collections.Generic.Queue[int]
  foreach ($k in 0..($Urls.Count - 1)) { $queue.Enqueue($k) }
  $tries = @{}; $done = 0
  while ($queue.Count) {
    $batch = @(); while ($queue.Count -and $batch.Count -lt $Concurrency) { $batch += $queue.Dequeue() }
    $tasks = @{}
    foreach ($k in $batch) { $tasks[$k] = $http.GetAsync($Urls[$k]) }
    $wait = 0
    foreach ($k in $batch) {
      $status = 0; $bytes = $null; $retryAfter = 0
      try {
        $res = $tasks[$k].GetAwaiter().GetResult()
        $status = [int]$res.StatusCode
        if ($res.IsSuccessStatusCode) { $bytes = $res.Content.ReadAsByteArrayAsync().Result }
        if ($res.Headers.RetryAfter -and $res.Headers.RetryAfter.Delta) { $retryAfter = [int]$res.Headers.RetryAfter.Delta.TotalSeconds }
        $res.Dispose()
      } catch { }
      $tries[$k] = 1 + [int]$tries[$k]
      if (($status -eq 0 -or $status -eq 429 -or $status -ge 500) -and $tries[$k] -lt 10) {
        $queue.Enqueue($k)
        $wait = [Math]::Max($wait, $(if ($retryAfter) { $retryAfter } elseif ($status -eq 429) { 20 } else { 3 }))
      } else {
        $out[$k] = @{ Status = $status; Bytes = $bytes }
        $done++
        if ($done % 100 -eq 0 -or $done -eq $Urls.Count) { Write-Host "    $done / $($Urls.Count)" }
      }
    }
    if ($wait) { Write-Host "    rate limited; waiting $wait s"; Start-Sleep -Seconds $wait }
  }
  $out
}

function Get-YouTubeId([string]$Url) {
  if ($Url -match '(?:youtu\.be/|youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/|embed/|v/))([A-Za-z0-9_-]{11})') { return $Matches[1] }
  $null
}

# 1. The list
Write-Host 'Fetching the AREDL list...'
$listJson = $http.GetStringAsync($api).GetAwaiter().GetResult()
# Assign first: Windows PowerShell emits a parsed JSON array as one object, and piping the variable enumerates it
$parsed = ConvertFrom-Json $listJson
$levels = @($parsed | Sort-Object position)
Write-Host "  $($levels.Count) levels"

# 2. Publisher + verification video for each level
$missing = @($levels | Where-Object { -not (Test-Path (Join-Path $detDir "$($_.id).json")) })
Write-Host "Fetching details for $($missing.Count) levels ($($levels.Count - $missing.Count) cached)..."
if ($missing.Count) {
  $res = Get-Many @($missing | ForEach-Object { "$api/$($_.id)" })
  for ($k = 0; $k -lt $missing.Count; $k++) {
    if ($res[$k].Bytes) { [IO.File]::WriteAllBytes((Join-Path $detDir "$($missing[$k].id).json"), $res[$k].Bytes) }
    else { Write-Warning "No details for $($missing[$k].name) (HTTP $($res[$k].Status))" }
  }
}

$info = @{}
foreach ($lv in $levels) {
  $file = Join-Path $detDir "$($lv.id).json"
  $creator = $null; $yt = $null
  if (Test-Path $file) {
    $d = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $creator = $d.publisher.global_name
    foreach ($v in @($d.verifications)) {
      if ($v -and -not $v.hide_video -and $v.video_url) { $yt = Get-YouTubeId $v.video_url; if ($yt) { break } }
    }
  }
  $info[$lv.id] = @{ Creator = $creator; Yt = $yt }
}

# 3. YouTube thumbnails (skips videos that are gone: 404 or YouTube's 120x90 placeholder)
$ytIds = @($info.Values | ForEach-Object { $_.Yt } | Where-Object { $_ } | Sort-Object -Unique)
$needed = @($ytIds | Where-Object { -not (Test-Path (Join-Path $ytDir "$_.jpg")) -and -not (Test-Path (Join-Path $ytDir "$_.none")) })
Write-Host "Downloading $($needed.Count) thumbnails ($($ytIds.Count - $needed.Count) cached)..."
if ($needed.Count) {
  $res = Get-Many @($needed | ForEach-Object { "https://i.ytimg.com/vi/$_/mqdefault.jpg" })
  for ($k = 0; $k -lt $needed.Count; $k++) {
    $ok = $false
    if ($res[$k].Bytes) {
      try {
        $ms = New-Object IO.MemoryStream (, $res[$k].Bytes)
        $img = [Drawing.Image]::FromStream($ms)
        $ok = $img.Width -ge 200
        $img.Dispose(); $ms.Dispose()
      } catch { }
    }
    if ($ok) { [IO.File]::WriteAllBytes((Join-Path $ytDir "$($needed[$k]).jpg"), $res[$k].Bytes) }
    elseif ($res[$k].Status -eq 404 -or $res[$k].Bytes) { New-Item -ItemType File -Force (Join-Path $ytDir "$($needed[$k]).none") | Out-Null }
  }
}

# 4. Sprite sheets: 5x5 tiles of 320x180, in list order
$cols = 5; $rows = 5; $tw = 320; $th = 180; $perSheet = $cols * $rows
$thumbFiles = New-Object System.Collections.Generic.List[string]
$thumbIndex = @{}
foreach ($lv in $levels) {
  $yt = $info[$lv.id].Yt
  $file = if ($yt) { Join-Path $ytDir "$yt.jpg" } else { $null }
  if ($file -and (Test-Path $file)) { $thumbIndex[$lv.id] = $thumbFiles.Count; $thumbFiles.Add($file) }
  else { $thumbIndex[$lv.id] = -1 }
}

Write-Host "Packing $($thumbFiles.Count) thumbnails into sprite sheets..."
Get-ChildItem $thumbDir -Filter *.jpg | Remove-Item
$jpeg = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object Drawing.Imaging.EncoderParameters 1
$encParams.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality), ([long]80)
$attrs = New-Object Drawing.Imaging.ImageAttributes
$attrs.SetWrapMode([Drawing.Drawing2D.WrapMode]::TileFlipXY)
$sheetCount = [Math]::Ceiling($thumbFiles.Count / $perSheet)
for ($s = 0; $s -lt $sheetCount; $s++) {
  $bmp = New-Object Drawing.Bitmap ($cols * $tw), ($rows * $th)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([Drawing.Color]::FromArgb(12, 18, 48))
  for ($t = 0; $t -lt $perSheet; $t++) {
    $i = $s * $perSheet + $t
    if ($i -ge $thumbFiles.Count) { break }
    $img = [Drawing.Image]::FromFile($thumbFiles[$i])
    $dest = New-Object Drawing.Rectangle (($t % $cols) * $tw), ([int][Math]::Floor($t / $cols) * $th), $tw, $th
    $g.DrawImage($img, $dest, 0, 0, $img.Width, $img.Height, [Drawing.GraphicsUnit]::Pixel, $attrs)
    $img.Dispose()
  }
  $g.Dispose()
  $bmp.Save((Join-Path $thumbDir ('{0:D2}.jpg' -f $s)), $jpeg, $encParams)
  $bmp.Dispose()
}
Write-Host "  $sheetCount sheets in thumbs\"

# 5. Level table -> levels.js
# Row format: [position, name, creator, levelId, youtubeId, thumbIndex, flags]; flags: 1 = legacy, 2 = two-player
$rowsOut = foreach ($lv in $levels) {
  $flags = 0
  if ($lv.status -eq 'Legacy') { $flags += 1 }
  if ($lv.two_player) { $flags += 2 }
  , @([int]$lv.position, [string]$lv.name, $info[$lv.id].Creator, [long]$lv.level_id, $info[$lv.id].Yt, [int]$thumbIndex[$lv.id], $flags)
}
$table = (ConvertTo-Json -InputObject @($rowsOut) -Compress -Depth 3) -replace '</', '<\/'
$data = '{"updated":"' + (Get-Date).ToString('yyyy-MM-dd') + '","levels":' + $table + '}'

[IO.File]::WriteAllText($dataFile, "const DATA = $data;`n", (New-Object Text.UTF8Encoding $false))
Write-Host "Wrote $($levels.Count) levels into levels.js"

$noThumb = @($levels | Where-Object { $thumbIndex[$_.id] -lt 0 }).Count
Write-Host "Done. $($levels.Count) levels, $($thumbFiles.Count) thumbnails, $noThumb without a YouTube thumbnail."
