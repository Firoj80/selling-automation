@echo off
echo Launching Microsoft Edge with CDP debugging on port 9222...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\Microsoft\Edge\AutomationData" --no-first-run --no-default-browser-check https://www.threads.com/ https://www.facebook.com/ https://x.com/ https://www.instagram.com/
echo Edge window opened! Please log in to your accounts and keep the browser open.
