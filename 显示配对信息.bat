@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ===== AgentFrame 配对信息 =====
node scripts\pair-qr.mjs "%USERPROFILE%\pair-qr.png"
if exist "%USERPROFILE%\pair-qr.png" start "" "%USERPROFILE%\pair-qr.png"
echo.
pause
