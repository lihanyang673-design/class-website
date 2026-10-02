@echo off
title Class Website Server
cd /d "%~dp0"
set PORT=80
rem Ensure node can be found even if PATH is stale (node was moved to D:\node)
set PATH=%PATH%;D:\node
:loop
rem If port 80 is already in use, wait 30s and check again (avoids double start)
rem /C: matches the literal string ":80 " (including the trailing space), so ports
rem like 8082/8080 are NOT mistaken for port 80.
netstat -ano | findstr /C:":80 " | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  ping -n 31 127.0.0.1 >nul
  goto loop
)
echo [%date% %time%] Starting class website server on port 80 ...
node server.js
echo [%date% %time%] Server stopped. Restarting in 5 seconds ...
ping -n 6 127.0.0.1 >nul
goto loop
