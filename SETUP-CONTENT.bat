@echo off
setlocal
cd /d "%~dp0"
node threads-agent.js settings validate
if errorlevel 1 goto failed
node scripts\launch-browser-cdp.js
if errorlevel 1 goto failed
echo Sign in to all enabled platforms before continuing.
echo Stop any running automation before setup.
pause
node threads-agent.js setup
if errorlevel 1 goto failed
node threads-agent.js queue list
set "automation_exit=%errorlevel%"
pause
exit /b %automation_exit%
:failed
echo Setup stopped. Saved drafts are preserved. See COMMANDS.md.
pause
exit /b 1
