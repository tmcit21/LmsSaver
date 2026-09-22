#!/bin/bash
# LMS Saver Native Messaging host インストーラ (macOS)
# 使い方:  bash install.sh /path/to/chrome-mv3-dev
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${1:-$DIR/../build/chrome-mv3-dev}"

HOST_NAME="jp.ac.kanazawa_u.lms_saver"
HOST_PY="$DIR/lms_saver_host.py"
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

# Chrome for Testing / Chromium / Edge は別ディレクトリを見るので登録する
CHROMIUM_TARGET_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
CFT_TARGET_DIR="$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts"
EDGE_TARGET_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
PLIST="$TARGET_DIR/$HOST_NAME.json"

PYTHON="/opt/homebrew/bin/python3.12"
if [ ! -x "$PYTHON" ]; then
  PYTHON="$(command -v python3)"
  echo "警告: /opt/homebrew/bin/python3.12 が無いので $PYTHON を使用"
fi

if [ ! -d "$BUILD_DIR" ]; then
  echo "エラー: ビルドディレクトリが見つかりません: $BUILD_DIR"
  echo "先に pnpm build (または pnpm dev) を実行してください"
  exit 1
fi

# 拡張ID = SHA256(絶対パス) の先頭32文字 (小文字hex, a-p)
EXT_ID="$(node -e '
const crypto = require("crypto");
const p = process.argv[1];
console.log(crypto.createHash("sha256").update(p).digest("hex").slice(0, 32)
  .split("").map(c => "abcdefghijklmnop"[parseInt(c, 16)]).join(""));
' "$(cd "$BUILD_DIR" && pwd)")"

echo "拡張ID: $EXT_ID"
echo "  (chrome://extensions でデベロッパーモード→パッケージされていない拡張機能を読み込み: $BUILD_DIR)"

mkdir -p "$TARGET_DIR"

# 既存のplistがあれば allowed_origins をマージ (dev/prod両対応)
EXISTING_ORIGINS="[]"
if [ -f "$PLIST" ]; then
  EXISTING_ORIGINS="$(python3 -c "
import json,sys
try:
    d=json.load(open('$PLIST'))
    print(json.dumps(d.get('allowed_origins',[])))
except Exception:
    print('[]')
")"
fi

MERGED="$(EXT_ID="$EXT_ID" EXISTING_ORIGINS="$EXISTING_ORIGINS" python3 -c "
import json, os
origins = set(json.loads(os.environ['EXISTING_ORIGINS']))
origins.add('chrome-extension://' + os.environ['EXT_ID'] + '/')
print(json.dumps(sorted(origins)))
")"

cat > "$PLIST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "LMS Saver: WebClass資料自動保存",
  "path": "$HOST_PY",
  "type": "stdio",
  "allowed_origins": $MERGED
}
EOF

chmod +x "$HOST_PY"
python3 -c "import json; json.load(open('$PLIST'))" && echo "plist JSON OK: $PLIST"

# Chromium / Chrome for Testing / Edge 向けにも同一マニフェストを配置
for D in "$CHROMIUM_TARGET_DIR" "$CFT_TARGET_DIR" "$EDGE_TARGET_DIR"; do
  mkdir -p "$D"
  cp "$PLIST" "$D/$HOST_NAME.json"
done
echo "Chromium/CfT/Edge向けにも登録"

# Firefox 向け: NativeMessagingHosts は ~/Library/Application Support/Mozilla/NativeMessagingHosts
# 注意: Firefoxのネイティブマニフェストは allowed_origins ではなく
#       allowed_extensions (gecko IDの配列) を使う
if [ "${1:-}" != "--no-firefox" ]; then
  FF_TARGET_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  mkdir -p "$FF_TARGET_DIR"
  FF_GECKO_ID="${GECKO_ID:-lms-saver@kanazawa-u.example}"
  cat > "$FF_TARGET_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "LMS Saver: WebClass資料自動保存 (Firefox)",
  "path": "$HOST_PY",
  "type": "stdio",
  "allowed_extensions": ["$FF_GECKO_ID"]
}
EOF
  python3 -c "import json; json.load(open('$FF_TARGET_DIR/$HOST_NAME.json'))" && echo "Firefox plist OK: $FF_TARGET_DIR/$HOST_NAME.json"
  echo "Firefox gecko ID: $FF_GECKO_ID"
fi

cat <<EOF

✅ インストール完了
  ホストスクリプト: $HOST_PY
  設定マニフェスト: $PLIST
  Python: $PYTHON
  拡張ID: $EXT_ID

Chromeを再起動して拡張ポップアップの「接続テスト」を押してください。
保存先の変更は ~/.lms_saver/config.json (またはポップアップ) で行えます。
EOF
