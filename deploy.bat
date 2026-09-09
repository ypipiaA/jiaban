@echo off
setlocal
cd /d "%~dp0"
if defined JIABAN_PYTHON goto ready
set "JIABAN_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%JIABAN_PYTHON%" goto ready
set "JIABAN_PYTHON=python"
:ready
"%JIABAN_PYTHON%" cloud_setup.py
if errorlevel 1 goto done
"%JIABAN_PYTHON%" cf_deploy.py
:done
pause
