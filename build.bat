@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js was not found. Install Node.js, then run build.bat again.
  exit /b 1
)

node scripts\build-github.js %*
exit /b %errorlevel%
