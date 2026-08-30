@echo off
title Nexley
cd /d "%~dp0"
python serve.py
if errorlevel 1 (
  echo.
  echo Could not start. Is Python installed and on PATH?
  pause
)
