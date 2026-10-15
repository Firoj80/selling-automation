@echo off
setlocal
cd /d "%~dp0"
if defined META_PRODUCT_CONSOLE goto execute
set "META_PRODUCT_CONSOLE=1"
cmd /d /k call "%~f0" %*
exit /b %errorlevel%
:execute
title Meta Automation - Posting and Engagement
where node >nul 2>&1
if errorlevel 1 goto missing_node

node scripts\start-product-automation.js %*
exit /b %errorlevel%
:missing_node
echo Node.js is missing. Install Node.js 18 or newer.
exit /b 1

