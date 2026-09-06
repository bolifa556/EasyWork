@echo off
setlocal
cd /d "%~dp0"
set "NODE_ENV=production"
if exist ".env" (
  "%~dp0runtime\node.exe" --env-file="%~dp0.env" "%~dp0scripts\serve-easywork.mjs"
) else (
  "%~dp0runtime\node.exe" "%~dp0scripts\serve-easywork.mjs"
)
set "EASYWORK_EXIT=%ERRORLEVEL%"
if not "%EASYWORK_EXIT%"=="0" pause
exit /b %EASYWORK_EXIT%
