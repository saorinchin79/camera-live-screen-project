@echo off
rem Stream Studio installer for Windows 10 and 11: double-click this file.
rem Inside the downloaded project it installs that copy. On its own, or in the installed
rem StreamStudio folder, it downloads the latest Stream Studio from GitHub (an update keeps your data).
rem Everything runs inside one ( ) block: cmd reads a block whole, so an update may replace this file.
title Stream Studio setup
if exist "%~dp0setup\install-windows.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\install-windows.ps1" %*
  echo.
  pause
  exit /b
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((Invoke-RestMethod -UseBasicParsing 'https://raw.githubusercontent.com/saorinchin79/camera-live-screen-project/main/setup/install-windows.ps1')))"
  echo.
  pause
  exit /b
)
