@echo off
chcp 65001 >nul
title SubDub - Cai giong VieNeu
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0vieneu\install.ps1"
exit /b %errorlevel%
