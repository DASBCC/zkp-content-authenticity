@echo off
REM Abre el sistema sin solicitar comandos ni mostrar terminales de trabajo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\start-web.ps1"
