# One-shot setup for the host PC. No admin rights needed, nothing is installed system-wide.
#   powershell -ExecutionPolicy Bypass -File setup.ps1 [-SkipSelfTest]
# 1. Uses Node.js >= 22.12 if present, otherwise downloads portable Node 22 LTS into .\tools\node (SHA-256 verified).
# 2. Runs npm install in .\host (Electron + koffi).
# 3. Runs the self-test. It is fully local: no internet traffic, throwaway key, no input injected.
param([switch]$SkipSelfTest)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeDir = Join-Path $root 'tools\node'
$hostDir = Join-Path $root 'host'

# Terminals inside VS Code / Cursor set this; with it Electron runs as plain Node and the app cannot start.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# Electron 45's npm package needs Node 22.12 or newer.
function Test-NodeVersion($exe) {
    $p = ((& $exe -v) -replace '^v', '').Split('.') | ForEach-Object { [int]$_ }
    return ($p[0] -gt 22) -or ($p[0] -eq 22 -and $p[1] -ge 12)
}
function Find-Node {
    $own = Join-Path $nodeDir 'node.exe'
    if (Test-Path $own) {
        if (Test-NodeVersion $own) { return $nodeDir }
        throw "tools\node holds Node $(& $own -v), older than 22.12. Delete the tools\node folder and run setup.ps1 again."
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and (Test-NodeVersion $cmd.Source)) { return (Split-Path -Parent $cmd.Source) }
    return $null
}

$nodeHome = Find-Node
if (-not $nodeHome) {
    Write-Host '[setup] Node.js not found - downloading portable Node 22 LTS into tools\node'
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $ver = ($index | Where-Object { $_.lts -and $_.version -like 'v22.*' } | Select-Object -First 1).version
    if (-not $ver) { throw 'Could not determine the Node 22 LTS version' }
    $name = "node-$ver-win-x64"
    $toolsDir = Join-Path $root 'tools'
    New-Item -ItemType Directory -Force $toolsDir | Out-Null
    $zip = Join-Path $toolsDir 'node.zip'
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$ver/$name.zip" -OutFile $zip
    $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$ver/SHASUMS256.txt").Content
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($sums -notmatch "$hash\s+$name\.zip") { Remove-Item $zip; throw 'Node.js download failed the SHA-256 check' }
    Expand-Archive $zip -DestinationPath $toolsDir -Force
    Rename-Item (Join-Path $toolsDir $name) 'node'
    Remove-Item $zip
    $nodeHome = $nodeDir
}
$env:Path = "$nodeHome;$env:Path"
Write-Host "[setup] Node $(& (Join-Path $nodeHome 'node.exe') -v) at $nodeHome"

Write-Host '[setup] npm install (downloads Electron, about 100 MB)'
Push-Location $hostDir
try {
    & (Join-Path $nodeHome 'npm.cmd') install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    # npm install no longer fetches Electron's program itself (seen with Electron 45; it would come at
    # first start through the npm package); fetch it now (checksums verified by @electron/get), so that
    # the launchers, which start dist\electron.exe directly, find it.
    & (Join-Path $nodeHome 'node.exe') 'node_modules\electron\install.js'
    if ($LASTEXITCODE -ne 0) { throw "Downloading Electron failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

$electron = Join-Path $hostDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw 'Electron was not installed (node_modules\electron\dist\electron.exe is missing)' }

if (-not $SkipSelfTest) {
    Write-Host '[setup] Running local self-test (about 1 minute; captures the screen locally, sends nothing out)'
    $log = Join-Path $env:TEMP 'pangmote-selftest.log'
    $p = Start-Process -FilePath $electron -ArgumentList "`"$hostDir`"", '--selftest' -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $null = $p.Handle
    if (-not $p.WaitForExit(240000)) { $p.Kill(); throw 'Self-test timed out' }
    Get-Content $log -Encoding UTF8 | Where-Object { $_ -match '\[selftest\]' } | ForEach-Object { Write-Host $_ }
    if ($p.ExitCode -ne 0) { throw "Self-test failed (exit code $($p.ExitCode)). Full log: $log" }
}

Write-Host ''
Write-Host '[setup] Done.'
Write-Host '  Start the host : start-host.bat   (the first run may show a Windows Firewall prompt)'
Write-Host '  Try it locally : local-test.bat   (view-only, no internet traffic)'
Write-Host '  Client app     : start-client.bat      (on the PC you connect FROM; one-click multi-monitor layout)'
Write-Host '  Client, no install: pangmote-client.html (open in Chrome or Edge on the other PC)'
