@REM node "E:\o\vscode-dotnet\dotenvrtdb\cli.js" -e "E:\o\vscode-dotnet\dotenvrtdb\test\.env" --writefilebase64="E:\o\vscode-dotnet\dotenvrtdb\test\CLOUDFLARED_CREDENTIALS.json" --var=CLOUDFLARED_CREDENTIALS


@echo off
cd /d "%~dp0"

node "..\cli.js" -e ".env" --writefileraw="API_BASE.txt" --var=API_BASE