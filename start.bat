@echo off
cd /d "C:\Users\ROG STRIX\Desktop\Vibe Coding\Line@預約系統\backend"
echo [Backend] Installing dependencies...
call npm install
echo.
echo [Backend] Starting server...
call npm run dev
pause
