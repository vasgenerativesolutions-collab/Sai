@echo off
setlocal enabledelayedexpansion
title Sai Traders — Enterprise Operations & Agent Server

echo ===============================================================================
echo          SAI TRADERS — ENTERPRISE INVENTORY & OPERATIONS AGENT
echo ===============================================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\SaiTradersAgent.lnk"
set "VBS_SCRIPT=%SCRIPT_DIR%run_silent.vbs"

:: -----------------------------------------------------------------------------
:: 1. Auto-Configure Windows Boot Startup (Runs automatically on every boot)
:: -----------------------------------------------------------------------------
if not exist "%SHORTCUT_PATH%" (
    echo [SETUP] Configuring automatic start on Windows boot...
    
    :: Create silent background VBS runner
    echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_SCRIPT%"
    echo WshShell.CurrentDirectory = "%SCRIPT_DIR%" >> "%VBS_SCRIPT%"
    echo WshShell.Run "cmd /c ""%~f0"" /silent", 0, False >> "%VBS_SCRIPT%"
    
    :: Create shortcut in Startup folder
    echo Set oWS = WScript.CreateObject("WScript.Shell") > "%TEMP%\CreateShortcut.vbs"
    echo sLinkFile = "%SHORTCUT_PATH%" >> "%TEMP%\CreateShortcut.vbs"
    echo Set oLink = oWS.CreateShortcut(sLinkFile) >> "%TEMP%\CreateShortcut.vbs"
    echo oLink.TargetPath = "wscript.exe" >> "%TEMP%\CreateShortcut.vbs"
    echo oLink.Arguments = """" ^& "%VBS_SCRIPT%" ^& """" >> "%TEMP%\CreateShortcut.vbs"
    echo oLink.WorkingDirectory = "%SCRIPT_DIR%" >> "%TEMP%\CreateShortcut.vbs"
    echo oLink.Description = "Sai Traders Autonomous ERP and Storefront Agent" >> "%TEMP%\CreateShortcut.vbs"
    echo oLink.Save >> "%TEMP%\CreateShortcut.vbs"
    cscript //nologo "%TEMP%\CreateShortcut.vbs" >nul 2>&1
    del "%TEMP%\CreateShortcut.vbs" >nul 2>&1
    
    echo [OK] Auto-start enabled: App will now automatically start on every PC boot.
) else (
    echo [OK] Windows boot auto-start is already active.
)

:: -----------------------------------------------------------------------------
:: 2. Auto-Update Admin Web Build from GitHub
:: -----------------------------------------------------------------------------
echo [UPDATE] Checking for latest admin web updates from GitHub...
where git >nul 2>nul
if %ERRORLEVEL% equ 0 (
    if not exist "admin\public\.git" (
        pushd admin\public
        git init -b main >nul 2>&1
        git remote add origin https://github.com/vasgenerativesolutions-collab/Sai.git >nul 2>&1
        git fetch origin main >nul 2>&1
        git reset --hard origin/main >nul 2>&1
        popd
        echo [OK] Initialized admin web build tracking from https://github.com/vasgenerativesolutions-collab/Sai
    ) else (
        pushd admin\public
        git fetch origin main >nul 2>&1
        git reset --hard origin/main >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            echo [OK] Admin web build is up to date with GitHub (origin/main).
        ) else (
            echo [WARNING] Could not pull from GitHub. Continuing with local build...
        )
        popd
    )
) else (
    echo [INFO] Git is not installed, using local web build.
)

:: -----------------------------------------------------------------------------
:: 3. Environment & Dependency Validation
:: -----------------------------------------------------------------------------
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

if not exist .env (
    if exist ..\.env (
        copy ..\.env .env >nul
    ) else if exist .env.example (
        copy .env.example .env >nul
        echo [!] Created .env from .env.example. Please configure keys if needed.
    )
)

if not exist node_modules (
    echo [INFO] Installing required dependencies...
    call npm install
)

:: Check for cloudflared binary
if not exist "scripts\cloudflared.exe" (
    if exist "..\scripts\cloudflared.exe" (
        if not exist "scripts" mkdir scripts
        copy "..\scripts\cloudflared.exe" "scripts\cloudflared.exe" >nul
    ) else (
        echo [INFO] Downloading Cloudflare Tunnel binary for public HTTPS URL...
        if not exist "scripts" mkdir scripts
        powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'scripts\cloudflared.exe'"
    )
)

:: -----------------------------------------------------------------------------
:: 3. Launch Server & Secure Public Tunnel
:: -----------------------------------------------------------------------------
echo.
echo [1/3] Starting Sai Traders Backend & Storefront APIs on http://localhost:3000...
start /B node admin/server.js > admin_server.log 2>&1

timeout /t 3 /nobreak >nul

echo [2/3] Establishing Secure Public Cloudflare Tunnel for External Webstore...
start /B scripts\cloudflared.exe tunnel --url http://localhost:3000 > tunnel.log 2>&1

timeout /t 4 /nobreak >nul

echo [3/3] Extracting Live Public HTTPS URL...
echo.
powershell -Command "$url = Get-Content tunnel.log -ErrorAction SilentlyContinue | Select-String 'trycloudflare.com' | Select-Object -First 1; if ($url) { Write-Host '===============================================================================' -ForegroundColor Green; Write-Host '🌐 SECURE PUBLIC STOREFRONT URL:' -ForegroundColor Yellow; Write-Host $url.Line.Trim() -ForegroundColor Cyan; Write-Host '===============================================================================' -ForegroundColor Green } else { Write-Host 'Tunnel initializing, check tunnel.log for public URL.' -ForegroundColor Gray }"

echo.
echo -------------------------------------------------------------------------------
echo  LOCAL ACCESS:
echo  • Admin Operations Web Portal : http://localhost:3000
echo  • Storefront API Simulator    : http://localhost:3000/api-test
echo  • GitHub Web Build Repo       : https://github.com/vasgenerativesolutions-collab/Sai
echo -------------------------------------------------------------------------------

:: Open browser unless silent boot mode
if "%1" neq "/silent" (
    echo [INFO] Opening Admin Web Portal in default browser...
    start http://localhost:3000
)

echo.
echo ===============================================================================
echo ✓ SYSTEM STATUS: ACTIVE & RUNNING
echo ✓ WINDOWS BOOT: AUTO-START CONFIGURED
echo Keep this window open, or minimize it.
echo ===============================================================================
echo.
if "%1" neq "/silent" pause
