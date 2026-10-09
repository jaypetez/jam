@echo off
rem Start the jam bridge on Windows. Set JAM_HOST / JAM_KEY in .env or the environment.
cd /d "%~dp0"
if exist .env for /f "usebackq tokens=1,* delims==" %%a in (".env") do set "%%a=%%b"
node bridge.mjs %*
