# lms_saver

金沢大学 WebClass (LMS) の授業資料を、開いた瞬間に自動でローカル保存するブラウザ拡張 + Native Messaging ホスト。

- **対応ブラウザ**: Chrome / Edge (MV3)、Firefox (MV2変換ビルド)
- **対応OS**: macOS / Windows
- 機能:
  1. **資料の自動保存** — LMSで資料を開くと `<保存先>/<授業名>/<第NN回>/<ファイル名>` へ自動保存
  2. **課題リマインド** — コーストップの「利用可能期間」付きコンテンツを Google Tasks に自動登録

```
WebClassページ
  └─ content.ts        資料リンク検出 / ページ解析 / ファイル取得 (fetch)
       └─ background (Service Worker)
            ├─ 保存キュー (直列) / 重複排除 / ファイル名決定
            ├─ 課題検出 → Google Tasks登録 (オプション)
            └─ Native Messaging (stdio, JSON)
                 └─ native/lms_saver_host.py
                      └─ <保存先>/<授業名>/<第NN回>/<ファイル名>
```

## 目次

- [配布形式の概要](#配布形式の概要)
- [エンドユーザー向け: インストール](#エンドユーザー向け-インストール)
- [開発者向け: ビルド](#開発者向け-ビルド)
- [Google Tasks連携のセットアップ](#google-tasks連携のセットアップ)
- [アップデート手順](#アップデート手順)
- [保存の仕組み](#保存の仕組み-v02--セッション保護設計)
- [保存ルール](#保存ルール)
- [対応ページ](#対応ページ-contentts-の検出対象)
- [テスト](#テスト)
- [ファイル構成](#ファイル構成)
- [既知の注意点](#既知の注意点)
- [トラブルシューティング](#トラブルシューティング)

---

## 配布形式の概要

この拡張はストアには非公開。配布方法は2系統:

| ブラウザ | 配布形式 | 署名 | 恒久インストール |
|---|---|---|---|
| Chrome / Edge | ビルドディレクトリをそのまま読み込み | 不要 (デベロッパーモード) | ✅ |
| Firefox | AMOで「自己配布 (unlisted)」署名したXPI | Mozilla署名 必須 | ✅ |
| Firefox (開発用) | 一時読み込み (`about:debugging`) | 不要 | ❌ 再起動で消える |

**Firefoxでの通常利用はAMO署名版が必須。** 手順は[開発者向けビルド](#firefox用の配布-amo署名)参照。

Native Messagingホスト (Python) はブラウザとは別にインストールが必要 ([エンドユーザー向け手順](#エンドユーザー向け-インストール))。

---

## エンドユーザー向け: インストール

### 共通: Python 3.10+ のインストール

Native MessagingホストはPythonで動く。

- **macOS**: `brew install python@3.12` または [python.org](https://www.python.org/downloads/) から
- **Windows**: [python.org](https://www.python.org/downloads/) からインストールし、**「Add python.exe to PATH」にチェック**

### macOS

```bash
# 1) ビルド済みディレクトリ (chrome-mv3-prod/) を受け取った場合はスキップ。
#    リポジトリからの場合:
pnpm install && pnpm build

# 2) Native Messaging ホストの登録 (Chrome/Edge/Chromium/Firefox 全部まとめて)
bash native/install.sh build/chrome-mv3-prod
```

### Windows

```powershell
# 1) ビルド済みディレクトリを受け取った場合はスキップ。
#    リポジトリからの場合:
pnpm install; pnpm build

# 2) Native Messaging ホストの登録
powershell -ExecutionPolicy Bypass -File native\install.ps1 -BuildDir build\chrome-mv3-prod
```

`install.ps1` はPythonの自動検出、`.bat`ラッパ生成、Chrome/Edge/Chromium/Firefoxへの登録まで全部やる。

### ブラウザへの拡張読み込み

**Chrome / Edge:**

1. `chrome://extensions` (Edgeは `edge://extensions`) を開く
2. 「デベロッパーモード」をON
3. 「パッケージされていない拡張機能を読み込む」→ `build/chrome-mv3-prod` を選択
4. 拡張ポップアップの「接続テスト」で疎通確認

> 新しめの Google Chrome (v137+) は `--load-extension` フラグを無視するため、上記の手動読み込みが必要。

**Firefox (AMO署名済みXPIを受け取った場合):**

1. 署名済み `.xpi` ファイルをFirefoxのウィンドウにドラッグ&ドロップ (または `about:addons` → 歯車アイコン → 「ファイルからアドオンをインストール」)
2. Firefoxを再起動しても消えない
3. 拡張ポップアップの「接続テスト」で疎通確認

**Firefox (一時お試し):**

1. `about:debugging#/runtime/this-firefox` → 「一時的なアドオンを読み込み…」→ `build/firefox-prod/manifest.json`
2. **Firefoxを終了すると消える** (動作確認用)

### 初期設定

保存先は既定で:

- macOS: `~/Documents/WebClass資料`
- Windows: `%USERPROFILE%\Documents\WebClass資料`

変更する場合は拡張ポップアップの「保存先」から (または `~/.lms_saver/config.json` を直接編集)。

Google Tasks連携は[別途セットアップ](#google-tasks連携のセットアップ)が必要 (各ユーザー自身のGoogleアカウント/Cloudプロジェクト)。

---

## 開発者向け: ビルド

```bash
pnpm install

# Chrome/Edge (MV3)
pnpm build                       # → build/chrome-mv3-prod/

# Firefox (MV2に自動変換)
pnpm build -- --target=firefox   # → build/firefox-prod/
```

> **重要**: バージョンを上げたら必ず `rm -rf build/firefox-prod` してからビルドする。
> 古いビルドディレクトリが残っていると manifest に前のバージョンが焼き付いたままになり、
> AMOへ「同一バージョン」として弾かれる。

`package.json` の `manifest` フィールドがビルド時に manifest.json へ反映される。バージョンもここを編集する。

### Firefox用の配布 (AMO署名)

1. `package.json` の `version` を上げる
2. `rm -rf build/firefox-prod && pnpm build -- --target=firefox`
3. `cd build/firefox-prod && npx web-ext build` → `web-ext-artifacts/lms_saver-X.X.X.zip`
4. [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) にログイン
5. 「Submit a New Add-on」→「**On your own server**」(自己配布。ストアには公開されない)
6. ZIPをアップロード → 自動チェック (数分〜、手動審査なら1-5日) → **署名済みXPIをダウンロード**
7. そのXPIを配布する

manifest に必須の設定 (package.json の `manifest.browser_specific_settings`):

```json
"browser_specific_settings": {
  "gecko": {
    "id": "lms-saver@kanazawa-u.example",
    "strict_min_version": "115.0",
    "data_collection_permissions": { "required": ["none"] }
  }
}
```

`data_collection_permissions` はAMO申請で必須。この拡張はデータ収集なしで `"none"`。

### Firefox版の実装差分 (保守用メモ)

- `chrome.*` APIはFirefoxではPromiseを返さない → `lib/storage.ts` の互換レイヤを必ず使う (直接 `await chrome.storage...` と書くと `undefined` が返って壊れる)
- `chrome.identity.getAuthToken` はFirefoxに存在しない → `lib/auth.ts` が `launchWebAuthFlow` にフォールバック
- Firefox版のOAuthは「ウェブ アプリケーション」型クライアントIDを使う ([下記参照](#firefox-の認証))

---

## Google Tasks連携のセットアップ

コーストップを開くと「利用可能期間」付きのコンテンツ (課題・レポート・試験・資料すべて) を検出し、
専用タスクリスト「WebClass課題」に自動登録する。締め切りは利用可能期間の**終了日時** (JST)。

**各ユーザーが自分のGoogle CloudプロジェクトでOAuthクライアントを作る必要がある**
(共有クライアントは使わない設計。拡張にクライアントIDは埋め込まれていない)。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 「APIとサービス」→「ライブラリ」→ **Tasks API** を有効化
3. 「認証情報」→「認証情報を作成」→「OAuthクライアントID」

   **Chrome / Edge の場合:**
   - アプリケーションの種類: **Chrome アプリケーション**
   - 拡張IDを入力 (`chrome://extensions` で確認。ビルドディレクトリの絶対パスから自動計算される)
   - 発行されたクライアントIDを `package.json` の `oauth2.client_id` に設定して `pnpm build`

   **Firefox の場合:**
   - アプリケーションの種類: **ウェブ アプリケーション**
     (Chromeアプリケーション型はredirect URIを追加できないため使えない)
   - 「承認済みリダイレクトURI」に、拡張ポップアップ →「Firefox用 OAuth 設定」に表示されるURLを登録
     (AMO署名版なら `https://lms-saver@kanazawa-u.example.extensions.allizom.org/` のような固定URL)
   - 発行されたクライアントIDを、拡張ポップアップ →「Firefox用 OAuth 設定」→「ウェブ用クライアントID」に貼り付けて保存
     (ブラウザの拡張ストレージに保存される。manifestを書き換える必要はない)

4. OAuth同意画面: Publishing status「Testing」で自分のアカウントをテストユーザーに追加

> ⚠️ 個人アカウントでUser Type「Internal」を選ぶと
> `This client is restricted to users within its organization` エラーになる。**External** を選ぶ。

### 使い方

ポップアップの「課題をGoogle Tasksに登録」をON → 初回はGoogle認証ダイアログが出るので
個人アカウントで承認。以降、コーストップを開くたびに新しい課題だけが登録される
(contentsIdのハッシュで重複判定、ローカルに直近500件を記憶)。

タスクは「マイタスク」ではなく専用リスト「**WebClass課題**」に入る。

---

## アップデート手順

### Chrome / Edge

1. 新しい `chrome-mv3-prod/` を受け取る (または自分で `pnpm build`)
2. `chrome://extensions` → 拡張カードの「更新」ボタン (🔄)
3. Native Messagingホスト側に変更がある場合のみ `install.sh` / `install.ps1` を再実行

> **注意**: ビルドディレクトリの場所を移動すると拡張IDが変わる (パスのSHA256から自動計算のため)。
> 移動したら `install.sh` / `install.ps1` の再実行とOAuthクライアントへの拡張ID再登録が必須。

### Firefox

1. 新しい署名済みXPIを受け取る (開発者がAMOで新バージョンを申請→署名したもの)
2. `about:addons` → 古いのを削除して新XPIをインストール (または「ファイルからアドオンをインストール」)
3. 設定 (`~/.lms_saver/`、Tasks連携の重複履歴・クライアントID) はブラウザが保持し続けるので引き継がれる

### Native Messagingホストのみの更新

`lms_saver_host.py` を差し替えるだけ。ブラウザの再起動が確実 (接続中のホストプロセスは再起動されるまで旧バージョンのまま)。

---

## 保存の仕組み (v0.2 — セッション保護設計)

**拡張は一切、自動でLMSにリクエストを投げない。** これはLMS側の「複数資料を同時に開くと
セッションが壊れる」問題への根本対策で、3つの経路に分かれる:

1. **一覧ページ** (`course.php` 等): 資料リンクの「地図」(URL ↔ 授業名/第N回/ラベル) を
   登録するだけ。fetchは一切しない
2. **開いたページ自身** (`mbl.php` = インライン表示の資料): そのページを開いた = ユーザーの
   操作なので、その1リクエストのレスポンスを保存して終了
3. **ダウンロード型資料** (`loadit.php` 等, `Content-Disposition: attachment`):
   **Chromium本来のダウンロード機構に全部任せる**。拡張は `chrome.downloads` を監視し、
   完了したLMSファイルを `~/Downloads` から `<保存先>/<授業名>/<第NN回>/` へ移動して
   リネームするだけ。同一file_idの再DLは上書き (重複しない)

この設計なら、course.phpを開いた瞬間に全資料へリクエストが飛ぶようなことがなく、
LMSのセッションを壊さない。

## 保存ルール

- `<保存先>/<授業名>/<第NN回>/<ファイル名>` (既定の保存先: `~/Documents/WebClass資料`)
- 「第N回」は `第1回`/`第１２回` (全角数字は半角化してゼロ埋め) など。見つからなければ `その他`
- ファイル名は `Content-Disposition` を優先、無ければリンクテキスト + MIME/URLから推定した拡張子
- 同一ファイルIDの再取得は `~/.lms_saver/ledger.json` 台帳で判定し、ファイルが存在すれば**スキップ** (ポップアップの「同名ファイルをスキップ」でON/OFF)
- 同名ファイルが別内容ならハッシュ付きでリネーム保存
- 設定: `~/.lms_saver/config.json` (保存先)。ポップアップからも変更可能

## 対応ページ (content.ts の検出対象)

| URLパターン | 役割 | 拡張の動作 |
|---|---|---|
| `course.php` | コーストップ: 資料リンク一覧 | 地図登録のみ (fetchなし) + 課題検出 |
| `txtbk_frame.php` | 教材一覧 | 地図登録のみ |
| `mbl.php` | 個別教材 (本文+添付/埋め込みiframe) | 開いたページ自身を保存 |
| `loadit.php` | 資料本体 (file_id直指定, attachment) | ブラウザDLに任せ完了後に整理 |
| `show_frame.php` / `do_contents.php` | リンク置き場 / 遷移 | 地図登録のみ |

## テスト

```bash
python3 tests/test_host.py          # ホスト単体 (Native Messagingフレーミング込み)
python3 tests/mock_lms.py 8765      # モックLMSサーバー起動
npx tsc --noEmit                    # 型チェック
```

## ファイル構成

```
content.ts            コンテンツスクリプト (検出/取得)
background/index.ts   Service Worker (キュー/重複排除/Native Messagingクライアント)
popup.tsx/.css        ポップアップ (保存先/設定/Google連携/ログ)
lib/messages.ts       型定義
lib/gtasks.ts         Google Tasks APIクライアント (Chrome/Firefox両対応)
lib/auth.ts           OAuth互換レイヤ (getAuthToken / launchWebAuthFlow)
lib/storage.ts        chrome.storage互換レイヤ (FirefoxのPromise非対応吸収)
native/lms_saver_host.py    Native Messaging ホスト (Python, stdlibのみ, macOS/Windows/Linux対応)
native/install.sh     ホスト登録スクリプト (macOS/Linux)
native/install.ps1    ホスト登録スクリプト (Windows)
native/lms_saver_host.bat   Windows用ラッパ (install.ps1が生成)
tests/mock_lms.py     WebClass風モックLMS
tests/test_host.py    ホストE2Eテスト
FIREFOX.md            Firefoxポーティングの詳細ノート
```

## 既知の注意点

- **一括取得モードは廃止**。開いた資料だけが保存される (セッション保護)。一括で集めたい日はLMSで資料を順に開くか、一覧ページから手動DL (拡張が自動整理する)
- LMSは複数の資料/コースを同時に開くと強制ログアウトされる仕様 — 拡張は開いたページしか触らないが、ユーザー自身も複数タブで資料を開かないこと
- `check_exists` の重複判定は「同じfile_id」が軸。LMS側でファイルが更新されてもIDが同じなら上書きされる (常に最新版が保存される)
- ダウンロード後整理 (`adopt_download`) は`~/Downloads` のファイルを移動する。ブラウザの「ダウンロードごとに保存先を確認」がONだと干渉するのでOFF推奨
- 45MB超のファイルはNative Messagingの1メッセージ上限を超えるため未対応
- Firefox版: 拡張の更新はAMO再申請が必要 (ストア非公開でも)。Chrome版はファイル差し替えだけでOK

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| 「接続テスト」が失敗する | Native Messagingホスト未登録 → `install.sh` / `install.ps1` を実行し、ブラウザを完全再起動 |
| 保存されない | ポップアップの「自動保存」がONか確認。ホストログ `~/.lms_saver/host.log` を見る |
| 「不明な授業」フォルダに保存される | コーストップを先に開いてから資料を開く (コース名・回の学習はコーストップで行う) |
| 課題がTasksに登録されない | ポップアップのログに認証エラーが出てないか確認。OAuth同意画面のテストユーザー設定を確認 |
| Firefoxで `e is undefined` | 古いビルド。最新版に入れ直す (storage互換レイヤ追加済み) |
| `redirect_uri_mismatch` | OAuthクライアントの種類/URI不一致。Chrome版=Chromeアプリケーション型、Firefox版=ウェブアプリケーション型+`extensions.allizom.org`のURI登録 |
| `This client is restricted to users within its organization` | OAuth同意画面のUser TypeがInternal。**External**に変更してテストユーザーに自分を追加 |
| AMOで「version already exists」 | `package.json`のversionを上げ、`rm -rf build/firefox-prod` してから再ビルド |
| `data_collection_permissions` missing | manifestに `browser_specific_settings.gecko.data_collection_permissions: {required: ["none"]}` を追加 |
