@echo off
title IllusTrade - Trading Tracker
cd /d "%~dp0"

echo.
echo  ==========================================
echo   IllusTrade - Local Trading Tracker
echo  ==========================================
echo.
echo  Working directory: %CD%
echo.

:: ── STEP 1: Check Python ─────────────────────────────────────
echo  [1/4] Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: Python was not found in PATH.
    echo.
    echo  Fix: Install Python 3.9+ from https://python.org
    echo       During install, tick "Add Python to PATH".
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo         %%v found.

:: ── STEP 2: Create virtual environment ───────────────────────
echo.
echo  [2/4] Checking virtual environment...
if exist "venv\Scripts\python.exe" (
    echo         venv already exists, skipping creation.
) else (
    echo         Creating venv...
    python -m venv venv
    if errorlevel 1 (
        echo.
        echo  ERROR: Failed to create virtual environment.
        echo  Try running as administrator or check disk space.
        echo.
        pause
        exit /b 1
    )
    echo         venv created.
)

:: ── STEP 3: Install / update dependencies ────────────────────
echo.
echo  [3/4] Installing dependencies (may take a minute on first run)...
venv\Scripts\pip install -r backend\requirements.txt --no-warn-script-location
if errorlevel 1 (
    echo.
    echo  ERROR: pip install failed.
    echo  If the error mentions a build failure, try:
    echo    1. Delete the "venv" folder
    echo    2. Run start.bat again
    echo.
    pause
    exit /b 1
)
echo  [3/4] Dependencies OK.

:: ── STEP 4: Free port 8000 if occupied ───────────────────────
echo.
echo  [4/4] Checking port 8000...
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr /R " :8000 "') do (
    echo         Freeing port 8000 (PID %%p)...
    taskkill /PID %%p /F >nul 2>&1
)
echo         Port 8000 ready.

:: ── Open browser after server starts ─────────────────────────
start "" cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:8000"

echo.
echo  ==========================================
echo   App  : http://localhost:8000
echo   Data : %CD%\backend\trading_tracker.db
echo  ==========================================
echo.
echo  Starting server... (Close this window to stop)
echo.

:: ── Start the server ─────────────────────────────────────────
cd backend
..\venv\Scripts\python -m uvicorn main:app --host 127.0.0.1 --port 8000

:: ── If we reach here, server stopped ─────────────────────────
cd ..
echo.
echo  Server stopped.
pause
