@echo off
setlocal
set "EASYWORK_AGENT_NODE=%~dp0..\runtime\node.exe"
if exist "%EASYWORK_AGENT_NODE%" goto run
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13+ is required. Use an EasyWork release with its bundled runtime.
  exit /b 1
)
set "EASYWORK_AGENT_NODE=node"
:run
"%EASYWORK_AGENT_NODE%" "%~dp0update-agent-app.mjs" %*
exit /b %errorlevel%
