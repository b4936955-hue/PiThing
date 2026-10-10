@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "REMOTE_URL=https://github.com/b4936955-hue/PiThing.git"
set "BRANCH=master"
set "GIT_NAME="
set "GIT_EMAIL="

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git was not found. Install Git for Windows and retry.
  goto :failed
)

call build.bat
if errorlevel 1 goto :failed

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  git init
  if errorlevel 1 goto :git_error
)

git config user.name >nul 2>&1
if errorlevel 1 (
  set /p "GIT_NAME=Name to show on your Git commits: "
  if not defined GIT_NAME goto :failed
  git config user.name "%GIT_NAME%"
  if errorlevel 1 goto :git_error
)

git config user.email >nul 2>&1
if errorlevel 1 (
  set /p "GIT_EMAIL=Email to show on your Git commits: "
  if not defined GIT_EMAIL goto :failed
  git config user.email "%GIT_EMAIL%"
  if errorlevel 1 goto :git_error
)

set "CURRENT_REMOTE="
for /f "delims=" %%U in ('git remote get-url origin 2^>nul') do set "CURRENT_REMOTE=%%U"
if not defined CURRENT_REMOTE (
  git remote add origin "%REMOTE_URL%"
  if errorlevel 1 goto :git_error
) else if /I not "%CURRENT_REMOTE%"=="%REMOTE_URL%" (
  echo ERROR: origin is "%CURRENT_REMOTE%", expected "%REMOTE_URL%".
  echo Update REMOTE_URL in push.bat if this project uses a different repository.
  goto :failed
)

git branch --show-current | findstr /x /c:"%BRANCH%" >nul
if errorlevel 1 git branch -M "%BRANCH%"
if errorlevel 1 goto :git_error

git fetch origin "%BRANCH%"
if errorlevel 1 (
  echo ERROR: Could not fetch origin/%BRANCH%. Check repository access and branch name.
  goto :failed
)
git merge-base --is-ancestor "origin/%BRANCH%" HEAD
if errorlevel 1 (
  echo Bringing the latest GitHub changes into this folder before pushing...
  git merge --no-edit "origin/%BRANCH%"
  if errorlevel 1 (
    echo.
    echo The local and GitHub files conflict. Resolve the conflicts, then run push.bat again.
    goto :failed
  )
)

node scripts\push-chunks.js
if errorlevel 1 goto :failed

git add -A
if errorlevel 1 goto :git_error
git diff --cached --quiet
if errorlevel 2 goto :git_error
if errorlevel 1 (
  git commit -m "Build GitHub Pages site"
  if errorlevel 1 goto :git_error
) else (
  echo No file changes to commit.
)

git push -u origin "%BRANCH%"
if not errorlevel 1 goto :success

echo.
echo Push failed. If the GitHub repository already has commits, run:
echo   git pull --rebase origin %BRANCH%
echo Resolve any conflicts, then run push.bat again.
goto :failed

:success
echo.
echo Push complete. The updated pi digit app is available at the repository root.
echo GitHub Pages can also use the "%BRANCH%" branch and "/docs" folder.
exit /b 0

:git_error
echo.
echo ERROR: A Git command failed. Read the message above.

:failed
echo.
echo Push stopped. Local files were not deleted.
exit /b 1
