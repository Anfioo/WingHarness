@echo off
rem Entry point for the config-capability showcase.
rem
rem The app sets exactly two variables: PLUGIN_ID and PLUGIN_DIR. This script
rem reads its own files (.env, cfg.json, cfg.yaml, generated.yml) from
rem PLUGIN_DIR -- the same files the config window edits, so the file is truth.
rem
rem The server stays in the foreground on purpose: the app streams a script's
rem output until it exits, so a detached server would be unkillable from the
rem settings page. The page carries a Stop button, which ends the run normally.
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo [plugin-showcase] PowerShell was not found on PATH. 1>&2
  echo [plugin-showcase] This demo serves its page with System.Net.HttpListener. 1>&2
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
exit /b %errorlevel%
