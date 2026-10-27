@echo off
chcp 65001 >nul
title SubDub - Go giong VieNeu
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0vieneu\uninstall.ps1"
exit /b %errorlevel%
