@echo off
title Sai Traders — Native Windows Desktop Application
cd /d "%~dp0"

echo ===============================================================================
echo          SAI TRADERS — ENTERPRISE WINDOWS DESKTOP APPLICATION
echo ===============================================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] Installing required dependencies...
    call npm install
)

echo [INFO] Launching Sai Traders Native Desktop Application...
npx electron desktop/main.js
