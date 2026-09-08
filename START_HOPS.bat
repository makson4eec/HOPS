@echo off
title HOPS
cd /d "%~dp0"
docker compose up --build -d
if errorlevel 1 goto :end
start "" http://localhost:3000
:end
pause
