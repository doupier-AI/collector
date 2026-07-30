@echo off
setlocal
cd /d "%~dp0"
call npm.cmd run launch
if errorlevel 1 pause
