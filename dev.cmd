@echo off
rem Dev mode: starts the Vite dev server AND the Tauri window together with
rem hot-reload. Use this (NOT the bare debug exe) when developing — a debug
rem Tauri binary loads its UI from http://localhost:1420, so the dev server
rem must be running or the window shows "localhost refused to connect".
rem For a standalone app that needs no dev server, run  build.cmd  instead.
cd /d "%~dp0"
call pnpm tauri dev
