@echo off
chcp 65001 >nul
title Sync New Songs
cd /d "%~dp0"

echo ============================================
echo      Naiwa Dance - Sync New Songs
echo ============================================
echo.
echo Reminder: open your proxy (Clash) before push
echo.

node sync-new-songs.js

echo.
echo ============================================
pause
