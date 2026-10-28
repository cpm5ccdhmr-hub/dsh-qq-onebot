@echo off
REM 单独起一个 DSH 宿主进程跑 qqbot profile（不占用桌面窗口）。
REM
REM 用法：按需改下面两个变量，然后在命令行里跑本文件。
REM   DSH_EXE   DeepSeek Harness 的 exe 路径
REM   LOG_PATH  宿主日志落盘位置（便于回头查连接问题）
REM
REM 注意：别用 `start` 或重定向管道拉这个进程——父进程退出时管道会断，插件跟着掉线。
REM 直接双击，或者在终端里单独跑，让它自己独立活着。

set "DSH_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
set "LOG_PATH=%~dp0..\qqbot-host.log"

if not exist "%DSH_EXE%" (
  echo [x] 找不到 DeepSeek Harness：%DSH_EXE%
  echo     请改本文件开头的 DSH_EXE。
  exit /b 1
)

"%DSH_EXE%" --expose-internals "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" --profile qqbot >> "%LOG_PATH%" 2>&1
