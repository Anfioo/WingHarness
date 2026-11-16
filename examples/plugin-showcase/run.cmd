@echo off
rem Entry point for the config-capability showcase.
rem
rem The app sets three variables: PLUGIN_ID, PLUGIN_DIR and PLUGIN_PERSIST. This
rem script reads its own files (.env, cfg.json, cfg.yaml, generated.yml) from
rem PLUGIN_PERSIST -- the same files the config window edits, so the file is
rem truth, and `scoop update` replacing PLUGIN_DIR cannot lose them.
rem
rem The server stays in the foreground on purpose: the app streams a script's
rem output until it exits, so a detached server would be unkillable from the
rem settings page. The page carries a Stop button, which ends the run normally.
setlocal
cd /d "%~dp0"

rem Running the script by hand has no app to set the persist folder; fall back
rem to the folder it sits in so the example still works outside the app.
if not defined PLUGIN_PERSIST set "PLUGIN_PERSIST=%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo [plugin-showcase] PowerShell was not found on PATH. 1>&2
  echo [plugin-showcase] This demo serves its page with System.Net.HttpListener. 1>&2
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
exit /b %errorlevel%
