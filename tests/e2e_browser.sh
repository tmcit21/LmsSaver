#!/bin/bash
# 実ブラウザE2E: モックLMS (tests/mock_lms.py 8765) が起動している前提。
# 使い方: bash tests/e2e_browser.sh
#   1. Edge/Chrome のいずれかを --load-extension 付きで起動 (プロファイルは毎回作り直す)
#   2. course.php を開き、自動保存の経過をコンソール/ホストログ/保存ツリーで表示
# ※ Google Chrome (v137+) は --load-extension を無視するので Edge を既定にしている。
#    Chromeで試す場合は chrome://extensions から手動で読み込むこと。

BROWSER="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
EXT="$(cd "$(dirname "$0")/.." && pwd)/build/chrome-mv3-prod"
PROFILE=/tmp/lms-saver-e2e-profile

if [ ! -d "$EXT" ]; then
  echo "エラー: $EXT が無い。先に pnpm build"
  exit 1
fi
if ! curl -s -o /dev/null "http://localhost:8765/webclass/course.php"; then
  echo "エラー: モックLMSが起動していない。別ターミナルで:"
  echo "  /opt/homebrew/bin/python3.12 tests/mock_lms.py 8765"
  exit 1
fi

pkill -f "lms-saver-e2e-profile" 2>/dev/null
sleep 1
rm -rf "$PROFILE"   # 拡張コードのキャッシュを避ける

"$BROWSER" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  --load-extension="$EXT" \
  --enable-logging=stderr --v=0 \
  "http://localhost:8765/webclass/course.php?course_id=999" > /tmp/edge_e2e.log 2>&1 &

sleep 18
echo "=== extension console ==="
grep "CONSOLE" /tmp/edge_e2e.log | sed 's/.*INFO:CONSOLE:[0-9]*\] //' | sed 's/", source:.*//' | head -40
echo "=== host.log ==="
tail -8 ~/.lms_saver/host.log 2>/dev/null
echo "=== saved tree ==="
find ~/Documents/WebClass資料 -type f 2>/dev/null || echo "(無し)"
echo "=== done (browser left running) ==="
