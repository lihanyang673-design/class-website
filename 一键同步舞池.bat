@echo off
chcp 65001 >nul
title Sync New Themes
cd /d "%~dp0"

echo ============================================
echo     Naiwa Dance - Sync New Themes
echo ============================================
echo.
echo Reminder: open your proxy (Clash) before push
echo.

node sync-new-themes.js

echo.
echo ============================================
pause
