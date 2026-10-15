@echo off
setlocal
cd /d "%~dp0"
echo Stop the running automation before repairing drafts.
node threads-agent.js queue rehumanize --pending --preview
if errorlevel 1 goto failed
choice /c YN /n /m "Rehumanize these saved drafts now? [Y/N] "
if errorlevel 2 exit /b 0
node threads-agent.js queue rehumanize --pending
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo Repair stopped. Saved drafts are preserved. See COMMANDS.md.
pause
exit /b 1
