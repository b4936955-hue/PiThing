@echo off
setlocal
cd /d "%~dp0"
echo Rebuilding inline account/community bundle...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build-inline.ps1"
if errorlevel 1 goto :fail
node --check assets/community/auth-gate.js
if errorlevel 1 goto :fail
node --check assets/community/community.js
if errorlevel 1 goto :fail
git diff --check
if errorlevel 1 goto :fail
call push.bat
exit /b %errorlevel%
:fail
echo Build stopped. No push was made.
exit /b 1
