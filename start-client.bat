@echo off
rem My Remote client app. Run setup.ps1 once first (it installs Electron under host\node_modules).
set ELECTRON_RUN_AS_NODE=
if not exist "%~dp0host\node_modules\electron\dist\electron.exe" (
  echo Run this first:  powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -SkipSelfTest
  pause
  exit /b 1
)
start "" "%~dp0host\node_modules\electron\dist\electron.exe" "%~dp0client"
