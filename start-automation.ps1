$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
& node "$PSScriptRoot/scripts/start-product-automation.js" @args
exit $LASTEXITCODE
