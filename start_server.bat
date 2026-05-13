@echo off
REM Set UTF-8 encoding for better Chinese character support
chcp 65001 >nul

REM Change to backend directory
cd /d "%~dp0"
echo.
echo ========================================
echo Starting Backend Server...
echo Current Directory: %cd%
echo ========================================
echo.

REM Load environment variables from .env file
echo Loading environment variables...

REM Start the server
echo Starting npm run dev...
npm run dev

REM Keep window open if there's an error
pause
