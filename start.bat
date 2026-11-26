@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ==========================================
echo    ChainBar - 一键启动
echo    链 + 合约 + 后端（含前端页面）
echo ==========================================
echo.
node scripts\start.js
echo.
echo 已退出。若不是你按 Ctrl+C，请把上面的报错发出来。
pause
