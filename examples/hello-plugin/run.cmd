@echo off
rem The app sets only PLUGIN_ID and PLUGIN_DIR; every setting lives in a file.
rem This script re-reads its own files -- the same files the config window edits.
setlocal
cd /d "%~dp0"

rem The .env is UTF-8, but cmd reads files in the console code page (GBK on a
rem Chinese Windows). Without this, a non-ASCII comment line decodes to a byte
rem sequence that swallows the following newline, and the key on the next line
rem gets glued onto the comment and skipped. The app decodes output as UTF-8 too.
chcp 65001 >nul

set "GREETING="
set "TIMES="
set "LOUD="
set "MODE="

echo [hello-plugin] PLUGIN_ID  = %PLUGIN_ID%
echo [hello-plugin] PLUGIN_DIR = %PLUGIN_DIR%
echo.

rem A .cmd has no env parser, so this reads the keys it needs. `eol=#` skips
rem comment lines; the first token is the key, the rest is the value.
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if not "%%a"=="" echo [hello-plugin] %%a=%%b
    if /i "%%a"=="GREETING" set "GREETING=%%b"
    if /i "%%a"=="TIMES"    set "TIMES=%%b"
    if /i "%%a"=="LOUD"     set "LOUD=%%b"
    if /i "%%a"=="MODE"     set "MODE=%%b"
  )
) else (
  echo [hello-plugin] .env is missing ^(save a setting to create it^).
)
echo.

if /i "%LOUD%"=="true" echo [hello-plugin] LOUD MODE IS ON

if not exist "cfg.json" (
  echo [hello-plugin] cfg.json is missing.
  exit /b 0
)

echo --- cfg.json ---
type "cfg.json"
echo.

rem TIMES may be blank when .env was just created; default it so the loop below
rem has something to count.
if not defined TIMES set "TIMES=1"

if /i "%MODE%"=="json" (
  echo {"ok":true,"greeting":"%GREETING%","times":"%TIMES%"}
) else (
  for /l %%i in (1,1,%TIMES%) do echo %GREETING%
)
echo.

exit /b 0
