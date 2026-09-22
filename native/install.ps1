# LMS Saver Native Messaging host インストーラ (Windows / PowerShell)
#
# 使い方 (PowerShell):
#   powershell -ExecutionPolicy Bypass -File install.ps1 -BuildDir C:\path\to\chrome-mv3-prod
#
# - Firefox/Chrome/Edge に対応
# - Python (3.10+) が必要: https://www.python.org/downloads/ (「Add to PATH」にチェック)
#   py ランチャーがあればそれを使う

param(
    [string]$BuildDir = ""
)

$ErrorActionPreference = "Stop"

$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $BuildDir) {
    $BuildDir = Join-Path $Dir "..\build\chrome-mv3-prod"
}
$BuildDir = (Resolve-Path $BuildDir).Path

$HostName = "jp.ac.kanazawa_u.lms_saver"
$HostPy = Join-Path $Dir "lms_saver_host.py"
$GeckoId = "lms-saver@kanazawa-u.example"

if (-not (Test-Path $BuildDir)) {
    Write-Error "ビルドディレクトリが見つかりません: $BuildDir : 先に pnpm build を実行してください"
}

# ---- Python の検出 -----------------------------------------------------------
# 1) py ランチャー  2) python.exe on PATH  3) 一般的なインストール先
# Native Messaging のマニフェスト path は「実行ファイル」でなければならないので
# Python スクリプト直指定は不可。ラッパ .bat を作ってそれを指定する。
$PythonExe = $null
try {
    $py = & py -3 -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $py) { $PythonExe = $py.Trim() }
} catch {}
if (-not $PythonExe) {
    $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $v = & $cmd.Source -c "import sys; print(sys.version_info >= (3,10))" 2>$null
        if ($v -match "True") { $PythonExe = $cmd.Source }
    }
}
if (-not $PythonExe) {
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
        "C:\Python312\python.exe",
        "C:\Program Files\Python312\python.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $PythonExe = $c; break }
    }
}
if (-not $PythonExe) {
    Write-Error "Python 3.10+ が見つかりません。https://www.python.org/downloads/ からインストールし、「Add python.exe to PATH」にチェックを入れてから再実行してください"
}
Write-Host "Python: $PythonExe"

# ---- 拡張IDの計算 (未パッケージ拡張 = SHA256(絶対パス) の先頭32文字を a-p にマップ) --
$ExtId = & python -c @"
import hashlib
p = r'''$BuildDir'''
print(hashlib.sha256(p.encode()).hexdigest()[:32].translate(str.maketrans('0123456789abcdef','abcdefghijklmnop')))
"@
Write-Host "拡張ID: $ExtId"
Write-Host "  (chrome://extensions デベロッパーモードで読み込むディレクトリ: $BuildDir)"

# ---- ラッパ .bat の作成 -------------------------------------------------------
# manifest の "path" は .bat や .exe を指せる。argv[1] に拡張IDが来るので %* で透過。
$BatPath = Join-Path $Dir "lms_saver_host.bat"
@"
@echo off
"$PythonExe" "$HostPy" %*
"@ | Out-File -FilePath $BatPath -Encoding ascii
Write-Host "ラッパ: $BatPath"

# ---- 設定マニフェストの作成 ----------------------------------------------------
# Chrome/Edge/Chromium: %LOCALAPPDATA% 配下 (HKCUレジストリ登録は不要。ユーザーディレクトリでOK)
$ChromeDir  = "$env:LOCALAPPDATA\Google\Chrome\User Data\NativeMessagingHosts"
$EdgeDir    = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\NativeMessagingHosts"
$ChromiumDir = "$env:LOCALAPPDATA\Chromium\User Data\NativeMessagingHosts"
$FirefoxDir = "$env:APPDATA\Mozilla\NativeMessagingHosts"

$Origins = @("chrome-extension://$ExtId/")
# 既存マニフェストがあれば allowed_origins をマージ
foreach ($D in @($ChromeDir, $EdgeDir, $ChromiumDir)) {
    $P = Join-Path $D "$HostName.json"
    if (Test-Path $P) {
        try {
            $j = Get-Content $P -Raw | ConvertFrom-Json
            foreach ($o in $j.allowed_origins) { $Origins += $o }
        } catch {}
    }
}
$Origins = $Origins | Select-Object -Unique

$ManifestObj = [ordered]@{
    name        = $HostName
    description = "LMS Saver: WebClass資料自動保存"
    path        = $BatPath
    type        = "stdio"
    allowed_origins = $Origins
}
$ManifestJson = $ManifestObj | ConvertTo-Json -Depth 3

foreach ($D in @($ChromeDir, $EdgeDir, $ChromiumDir)) {
    New-Item -ItemType Directory -Force -Path $D | Out-Null
    $P = Join-Path $D "$HostName.json"
    [System.IO.File]::WriteAllText($P, $ManifestJson)
    Write-Host "登録: $P"
}

# ---- Firefox ----------------------------------------------------------------
# Firefoxのネイティブマニフェストは allowed_extensions を使う
New-Item -ItemType Directory -Force -Path $FirefoxDir | Out-Null
$FfManifest = [ordered]@{
    name        = $HostName
    description = "LMS Saver: WebClass資料自動保存 (Firefox)"
    path        = $BatPath
    type        = "stdio"
    allowed_extensions = @($GeckoId)
}
$FfPath = Join-Path $FirefoxDir "$HostName.json"
[System.IO.File]::WriteAllText($FfPath, ($FfManifest | ConvertTo-Json -Depth 3))
Write-Host "登録: $FfPath (Firefox, gecko ID: $GeckoId)"

# ---- 初期設定 ----------------------------------------------------------------
$ConfigDir = "$env:USERPROFILE\.lms_saver"
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$CfgPath = Join-Path $ConfigDir "config.json"
if (-not (Test-Path $CfgPath)) {
    $defaultRoot = "$env:USERPROFILE\Documents\WebClass資料"
    [System.IO.File]::WriteAllText($CfgPath, (@{ root = $defaultRoot } | ConvertTo-Json))
    Write-Host "初期設定作成: $CfgPath (root: $defaultRoot)"
}

Write-Host ""
Write-Host "✅ インストール完了"
Write-Host "  ホスト: $HostPy"
Write-Host "  ラッパ: $BatPath"
Write-Host "  Python: $PythonExe"
Write-Host "  拡張ID: $ExtId"
Write-Host ""
Write-Host "ブラウザを再起動して拡張ポップアップの「接続テスト」を押してください。"
