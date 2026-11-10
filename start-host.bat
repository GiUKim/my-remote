@echo off
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0host\node_modules\electron\dist\electron.exe" "%~dp0host"
