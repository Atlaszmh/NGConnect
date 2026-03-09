@echo off
title NGConnect Server
cd /d "%~dp0"

echo.
echo   =============================================
echo     NGConnect Server
echo   =============================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   [ERROR] Node.js is not installed or not in PATH.
    echo   Download from https://nodejs.org
    pause
    exit /b 1
)

:: Check if already built
if not exist "server\dist\index.js" (
    echo   Building for first run...
    call npm run build
    if %errorlevel% neq 0 (
        echo   [ERROR] Build failed.
        pause
        exit /b 1
    )
    echo.
)

:: Check .env
if not exist ".env" (
    echo   [WARNING] No .env file found.
    echo   Copy .env.example to .env and configure your API keys.
    echo.
)

echo   Starting server on http://localhost:3001
echo   Press Ctrl+C to stop.
echo.

cd server
call npx cross-env NODE_ENV=production node --env-file=../.env dist/index.js
pause
