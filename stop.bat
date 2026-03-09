@echo off
title NGConnect - Stop
echo.
echo   Stopping NGConnect server...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
    echo   Stopped process %%a
)

echo   Done.
timeout /t 2 >nul
