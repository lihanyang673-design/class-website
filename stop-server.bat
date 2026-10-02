@echo off
title Stop Class Website Server
set found=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":80 " ^| findstr "LISTENING"') do (
  set found=1
  echo Stopping process PID %%a ...
  taskkill /f /pid %%a >nul 2>&1
)
if "%found%"=="0" echo Server is not running.
if "%found%"=="1" echo Server stopped.
pause
