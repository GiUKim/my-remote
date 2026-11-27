# Signs the app bundle (.aab) for Google Play with your upload key (made by upload-key.ps1). Run it yourself: it asks
# for the key's password.
#   powershell -NoProfile -ExecutionPolicy Bypass -File android\play\sign-bundle.ps1 <app-release.aab>
# The bundle comes from CI (the job "Android app (builds)", artifact pangmote-android-release-unsigned) or from
# `gradle bundleRelease`; it is unsigned. Writes <name>-signed.aab next to it and checks the signature; that file is
# what goes up in Play Console.
param(
  [Parameter(Mandatory = $true)][string]$Bundle,
  [string]$Key = (Join-Path $env:USERPROFILE '.pangmote-release\play-upload.jks')
)
$ErrorActionPreference = 'Stop'

function Find-JdkTool([string]$name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $hit = Get-ChildItem 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java', 'C:\Program Files\Microsoft', 'C:\Program Files\Android\Android Studio\jbr' -Recurse -Filter "$name.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  throw "$name was not found: install a JDK (for example: winget install EclipseAdoptium.Temurin.21.JDK) and run this again"
}

$in = (Resolve-Path -LiteralPath $Bundle).Path
if ($in -notmatch '\.aab$') { throw "not an app bundle (.aab): $in" }
if (-not (Test-Path -LiteralPath $Key)) { throw "no upload key at $Key (make it with upload-key.ps1)" }
$out = $in -replace '(-unsigned)?\.aab$', '-signed.aab'
if (Test-Path -LiteralPath $out) { throw "already there: $out (move it away first)" }
$jarsigner = Find-JdkTool 'jarsigner'

Write-Host "Signing $in"
Write-Host 'Type the upload key password:'
& $jarsigner -sigalg SHA256withRSA -digestalg SHA-256 -keystore $Key -signedjar $out $in upload
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $out)) { throw 'jarsigner did not sign the bundle' }
$check = & $jarsigner -verify $out 2>&1 | Out-String
if ($check -notmatch 'jar verified') { throw "the signature does not verify:`n$check" }
Write-Host ''
Write-Host "Signed and verified: $out"
Write-Host 'Upload this file in Play Console (Testing > Closed testing > Create new release).'
