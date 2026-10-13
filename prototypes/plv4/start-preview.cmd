@echo off
cd /d "%~dp0..\.."
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath (Get-Command python).Source -ArgumentList @('prototypes/plv4/serve.py','--port','8766') -WindowStyle Hidden }"
start "" http://127.0.0.1:8766/prototypes/plv4/nested.html
