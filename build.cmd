@echo off
rem Produce the standalone release build: a self-contained bonsai.exe with the
rem UI embedded (no dev server needed) plus an NSIS installer.
rem Outputs:
rem   src-tauri\target\release\bonsai.exe                     (portable)
rem   src-tauri\target\release\bundle\nsis\Bonsai_*_x64-setup.exe (installer)
cd /d "%~dp0"
call pnpm tauri build
echo.
echo Done. Launch with "Launch Bonsai.cmd" or run the installer above.
pause
