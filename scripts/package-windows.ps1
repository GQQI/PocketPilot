# Build the Windows installer from a checkout at D:\Project\MobileAgent
# (or any other folder). Run in PowerShell from the repo root:
#   powershell -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required."
}
npm install
npm run desktop:dist:win
Write-Host "Installer output: apps\desktop\release"
