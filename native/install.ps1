# LMS Saver Native Messaging host インストーラ (Windows / PowerShell)
#
# 使い方 (PowerShell):
#   powershell -ExecutionPolicy Bypass -File install.ps1 -BuildDir C:\path\to\chrome-mv3-prod
#
# - Firefox/Chrome/Edge に対応
# - Python (3.10+) が必要: https://www.python.org/downloads/ (「Add to PATH」にチェック)
#   py ランチャーがあればそれを使う

param(
    [string]$BuildDir = "",
    # PyInstallerでビルドした実行ファイルを使う場合に指定 (Python不要の配布形態)
    [string]$HostExe = ""
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

# ---- ホスト実行ファイルの決定 ---------------------------------------------------
# -HostExe が指定されていれば PyInstaller バイナリを使う (Python不要のエンドユーザー配布)
# 無ければ Python を検出して .bat ラッパ経由で動かす
$BatPath = $null
$HostBinary = $null
if ($HostExe) {
    if (-not (Test-Path $HostExe)) {
        Write-Error "指定されたホスト実行ファイルが見つかりません: $HostExe"
    }
    $HostBinary = (Resolve-Path $HostExe).Path
    Write-Host "ホスト実行ファイル (PyInstaller): $HostBinary"
} else {
    # ---- Python の検出 ---------------------------------------------------------
    # 1) py ランチャー  2) python.exe on PATH  3) 一般的なインストール先
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
        Write-Error "Python 3.10+ が見つかりません。https://www.python.org/downloads/ からインストールして「Add python.exe to PATH」にチェックするか、-HostExe でPyInstallerビルド済みバイナリを指定してください"
    }
    Write-Host "Python: $PythonExe"

    # ---- 拡張IDの計算 (未パッケージ拡張 = SHA256(絶対パス) の先頭32文字を a-p にマップ) --
    $ExtId = & $PythonExe -c @"
import hashlib
p = r'''$BuildDir'''
print(hashlib.sha256(p.encode()).hexdigest()[:32].translate(str.maketrans('0123456789abcdef','abcdefghijklmnop')))
"@
    Write-Host "拡張ID: $ExtId"
    Write-Host "  (chrome://extensions デベロッパーモードで読み込むディレクトリ: $BuildDir)"

    # ---- ラッパ .bat の作成 ----------------------------------------------------
    # manifest の "path" は .bat や .exe を指せる。argv[1] に拡張IDが来るので %* で透過。
    $BatPath = Join-Path $Dir "lms_saver_host.bat"
    @"
@echo off
"$PythonExe" "$HostPy" %*
"@ | Out-File -FilePath $BatPath -Encoding ascii
    Write-Host "ラッパ: $BatPath"
    $HostBinary = $BatPath
}

# ---- 設定マニフェストの作成 ----------------------------------------------------
# Windowsでは「レジストリキー → manifest JSON」の順で解決される。
# Chrome/Edge/Chromium/Firefox それぞれの HKCU キーを作成する。
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
    path        = $HostBinary
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

# ---- レジストリ登録 (Windowsではこれが必須) -------------------------------------
# ブラウザごとに HKCU\Software\<vendor>\NativeMessagingHosts\<host名> の
# 既定値にmanifest JSONへのフルパスを設定する
foreach ($Pair in @(
    @{ Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts";  Manifest = (Join-Path $ChromeDir "$HostName.json");  Name = "Chrome" },
    @{ Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"; Manifest = (Join-Path $EdgeDir "$HostName.json");    Name = "Edge" },
    @{ Key = "HKCU:\Software\Chromium\NativeMessagingHosts";       Manifest = (Join-Path $ChromiumDir "$HostName.json"); Name = "Chromium" },
    @{ Key = "HKCU:\Software\Mozilla\NativeMessagingHosts";        Manifest = (Join-Path $FirefoxDir "$HostName.json");  Name = "Firefox" }
)) {
    New-Item -Path $Pair.Key -Force | Out-Null
    Set-ItemProperty -Path $Pair.Key -Name $HostName -Value $Pair.Manifest
    Write-Host "レジストリ登録: $($Pair.Name) -> $($Pair.Manifest)"
}

# ---- Firefox ----------------------------------------------------------------
# Firefoxのネイティブマニフェストは allowed_extensions を使う
New-Item -ItemType Directory -Force -Path $FirefoxDir | Out-Null
$FfManifest = [ordered]@{
    name        = $HostName
    description = "LMS Saver: WebClass資料自動保存 (Firefox)"
    path        = $HostBinary
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
Write-Host "  ホスト: $HostBinary"
if ($HostExe) {
    Write-Host "  モード: PyInstallerバイナリ (Python不要)"
} else {
    Write-Host "  Python: $PythonExe"
}
Write-Host "  拡張ID: $ExtId"
Write-Host ""
Write-Host "ブラウザを再起動して拡張ポップアップの「接続テスト」を押してください。"
