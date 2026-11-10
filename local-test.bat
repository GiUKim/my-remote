@echo off
rem Try it on this PC only: host + view-only client in your browser.
rem Uses a local relay and a throwaway key. Nothing is sent to the internet.
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0host\node_modules\electron\dist\electron.exe" "%~dp0host" --localtest
