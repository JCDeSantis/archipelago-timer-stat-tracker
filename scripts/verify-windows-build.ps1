$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $projectRoot 'dist'
$version = (Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$executable = Join-Path $outputRoot 'win-unpacked/Archipelago Timer and Stat Tracker.exe'
$reportPath = Join-Path $outputRoot ('packaged-selftest-' + [guid]::NewGuid().ToString('N') + '.json')
$previousReport = $env:AP_TIMER_SELFTEST
$previousProfile = $env:AP_TIMER_USER_DATA
$previousScreenshot = $env:AP_TIMER_SCREENSHOT
try {
    $env:AP_TIMER_SELFTEST = $reportPath
    Remove-Item Env:AP_TIMER_USER_DATA -ErrorAction SilentlyContinue
    Remove-Item Env:AP_TIMER_SCREENSHOT -ErrorAction SilentlyContinue
    $buildTestProcess = Start-Process -FilePath $executable -WindowStyle Hidden -PassThru
    if (-not $buildTestProcess.WaitForExit(60000)) {
        $buildTestProcess.Kill()
        throw 'Packaged app self-test timed out.'
    }
    if ($buildTestProcess.ExitCode -ne 0) { throw 'Packaged app exited unsuccessfully.' }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if ($report.ok -ne $true -or $report.packaged -ne $true) { throw 'Packaged app self-test failed.' }
    Write-Output 'Packaged application self-test passed.'
} finally {
    $env:AP_TIMER_SELFTEST = $previousReport
    $env:AP_TIMER_USER_DATA = $previousProfile
    $env:AP_TIMER_SCREENSHOT = $previousScreenshot
}

$downloads = Join-Path $outputRoot 'downloads'
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
$names = @(
    'Archipelago-Timer-and-Stat-Tracker-Portable.exe',
    'Archipelago-Timer-and-Stat-Tracker-Setup.exe',
    "Archipelago-Timer-and-Stat-Tracker-$version-x64.zip"
)
# Keep this generated staging folder to one version's downloads.
Get-ChildItem -LiteralPath $downloads -File -Filter '*.zip' |
    Where-Object { $_.Name -match '^Archipelago-Timer-and-Stat-Tracker-\d+\.\d+\.\d+(?:-[\w.-]+)?-x64\.zip$' -and $_.Name -notin $names } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName }
$checksums = foreach ($name in $names) {
    $source = Join-Path $outputRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing build: $name" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $downloads $name) -Force
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $name"
}
$checksums | Set-Content -LiteralPath (Join-Path $downloads 'SHA256SUMS.txt') -Encoding ascii
Write-Output 'Prepared Windows portable, installer, ZIP, and SHA256SUMS.txt.'
