# Makes the upload key for Google Play (Pangmote for Android). Run it yourself, in your own PowerShell window: it asks
# for a password, which only you type and keep (a password manager). Nobody else, an agent neither, runs it or reads
# the key.
#   powershell -NoProfile -ExecutionPolicy Bypass -File android\play\upload-key.ps1
# The key is written to %USERPROFILE%\.pangmote-release\play-upload.jks (outside the repository) and never replaced.
# Keep a copy of that file and its password somewhere safe: without them Play takes no update until Google resets the
# upload key on your request (Play App Signing keeps the key that signs what phones install, so the app itself is safe).
# Afterwards it prints the certificate's fingerprints: those are public (Play Console shows the same).
param([string]$Out = (Join-Path $env:USERPROFILE '.pangmote-release\play-upload.jks'))
$ErrorActionPreference = 'Stop'

function Find-JdkTool([string]$name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $hit = Get-ChildItem 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java', 'C:\Program Files\Microsoft', 'C:\Program Files\Android\Android Studio\jbr' -Recurse -Filter "$name.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  throw "$name was not found: install a JDK (for example: winget install EclipseAdoptium.Temurin.21.JDK) and run this again"
}

if (Test-Path -LiteralPath $Out) { Write-Host "There is an upload key already: $Out (left as it is)"; exit 1 }
$keytool = Find-JdkTool 'keytool'
New-Item -ItemType Directory -Force (Split-Path -Parent $Out) | Out-Null
Write-Host 'Making the upload key. Choose a password of at least 6 characters, type it twice, and keep it.'
& $keytool -genkeypair -keystore $Out -storetype PKCS12 -alias upload -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Pangmote'
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Out)) { throw 'keytool did not make the key' }
Write-Host ''
Write-Host "Made: $Out"
Write-Host 'Its certificate (public; type the password once more):'
& $keytool -list -v -keystore $Out -alias upload | Select-String -Pattern 'SHA1:|SHA256:|Valid from'
Write-Host ''
Write-Host 'Now copy that file to a safe place (a USB stick, a password manager attachment) and keep the password with it.'
