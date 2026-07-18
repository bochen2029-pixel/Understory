@echo off
rem Launch the built Bonsai desktop app. Prefers the release build; falls back
rem to the debug build. If neither exists, tells you how to build it.
setlocal
set HERE=%~dp0
set REL=%HERE%src-tauri\target\release\bonsai.exe
set DBG=%HERE%src-tauri\target\debug\bonsai.exe

if exist "%REL%" (
  start "" "%REL%"
  goto :eof
)
if exist "%DBG%" (
  start "" "%DBG%"
  goto :eof
)

echo Bonsai has not been built yet.
echo Run:  pnpm install  ^&^&  pnpm tauri build
echo (or)  pnpm tauri dev
pause
