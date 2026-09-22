@echo off
REM LMS Saver Native Messaging host (Windows / PyInstallerビルド用ラッパ)
REM
REM 使い方 (リポジトリルートで):
REM   pip install pyinstaller
REM   pyinstaller --onefile --name lms_saver_host_win --distpath build\pyinstaller native\lms_saver_host.py
REM   powershell -ExecutionPolicy Bypass -File native\install.ps1 -BuildDir build\chrome-mv3-prod -HostExe build\pyinstaller\lms_saver_host_win.exe
REM
REM PyInstallerバイナリは stdin/stdout をそのまま透過するので
REM Native Messaging の 4バイト長プレフィックス + JSON プロトコルはそのまま動く。

pyinstaller --onefile --name lms_saver_host_win ^
    --distpath build\pyinstaller ^
    --workpath build\pyinstaller_work ^
    --specpath build\pyinstaller_work ^
    native\lms_saver_host.py

if %ERRORLEVEL% neq 0 (
    echo ビルド失敗
    exit /b 1
)
echo ビルド完了: build\pyinstaller\lms_saver_host_win.exe
echo.
echo 次のコマンドでホストを登録してください:
echo   powershell -ExecutionPolicy Bypass -File native\install.ps1 -BuildDir build\chrome-mv3-prod -HostExe build\pyinstaller\lms_saver_host_win.exe
