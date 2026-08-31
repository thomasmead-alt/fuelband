@echo off
REM Double-click this file on Windows to start the app.
cd /d "%~dp0"

echo.
echo   FuelBand Revival
echo   ================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed.
  echo.
  echo   Please install it from https://nodejs.org ^(choose the LTS version^),
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "..\node_modules" (
  echo   First run - installing what's needed ^(about a minute^)...
  echo.
  pushd .. && call npm install && popd
  echo.
)

echo   Starting... your browser will open automatically.
echo   Keep THIS window open while you use the app.
echo.
node server.js
pause
