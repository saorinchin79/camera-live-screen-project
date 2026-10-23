@echo off
rem Stream Studio: starts the server and opens the admin page in the browser.
rem Keep this window open while you use Stream Studio; close it to stop Stream Studio.
rem   Start-StreamStudio.bat /nobrowser   starts it without the browser (used when it starts at log-in)
rem The port is 3000; to use another one, write the number (for example 3001) into data\port.txt.
title Stream Studio
cd /d "%~dp0"
set OPEN_BROWSER=1
if /i "%~1"=="/nobrowser" set OPEN_BROWSER=
set "NODE_EXE=node"
if exist "%~dp0runtime\node\node.exe" set "NODE_EXE=%~dp0runtime\node\node.exe"
if "%NODE_EXE%"=="node" where node >nul 2>nul || (echo. & echo   Node.js was not found. Run Install-Windows.bat first. & echo. & pause & exit /b 1)
rem one ( ) block, read whole by cmd: an update may replace this file while the server runs.
rem The full path of server.js tells the installer which running server belongs to this folder.
(
  "%NODE_EXE%" "%~dp0server.js"
  if errorlevel 1 pause
  exit /b
)
