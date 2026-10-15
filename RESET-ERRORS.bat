@echo off
setlocal
cd /d "%~dp0"
echo Inspecting recovery state. No history is deleted or requeued.
node threads-agent.js recover --inspect
set "automation_exit=%errorlevel%"
echo For a verified dead owner's lock, use: node threads-agent.js recover --stale-lock
pause
exit /b %automation_exit%
