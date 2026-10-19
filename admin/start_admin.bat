@echo off
title Sai Traders — Admin Portal & Photo Manager
color 0D
cd /d "%~dp0.."
echo ===============================================================================
echo            SAI TRADERS - ADMIN PORTAL & PHOTO MANAGER
echo ===============================================================================
echo.
echo Starting web server on http://localhost:3000 ...
start http://localhost:3000
node admin/server.js
pause
