@echo off
chcp 65001 >nul
cd /d "%~dp0.."
rem Audio probe paths are machine-specific: keep them in start.local.bat (gitignored).
if exist "%~dp0..\start.local.bat" call "%~dp0..\start.local.bat"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
node tools\harden-acl.mjs --quiet
node tools\ensure-tts.mjs
node tools\ensure-breeze-tunnel.mjs
:loop
node app\whale.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
