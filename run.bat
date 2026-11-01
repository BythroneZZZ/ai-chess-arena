@echo off
chcp 65001 >nul
title AI CHESS ARENA
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
  set "PY=python"
) else (
  where py >nul 2>nul
  if %errorlevel%==0 ( set "PY=py" ) else (
    echo.
    echo   [错误] 未找到 Python。
    echo   本项目需要本地服务器运行（浏览器安全策略不允许直接打开本地文件加载资源）。
    echo   请安装 Python 3 ，或手动执行：npx serve .
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   AI CHESS ARENA
echo   正在启动本地服务器...
echo.

start "" http://localhost:8765/index.html
%PY% -m http.server 8765
