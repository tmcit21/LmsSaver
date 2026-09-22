# Firefox版 lms-saver セットアップ

Chrome版と同じ機能（資料の自動保存・Google Tasks連携）をFirefoxで使うための手順。

## ビルド

```bash
pnpm build -- --target=firefox   # → build/firefox-prod/ (MV2に自動変換される)
```

## インストール方法は2択

### 方法A: AMOで「自己配布 (unlisted)」署名を取る — 通常版Firefoxで永続化できる

1. https://addons.mozilla.org/developers/ にFirefoxアカウントでログイン
2. 「Submit a New Add-on」→ **「On your own server」(自己配布)** を選択
   - ストアには公開されない（検索にも出ない）
3. `web-ext build` で作ったZIPをアップロード
   ```bash
   cd build/firefox-prod && npx web-ext build
   # → ./web-ext-artifacts/*.zip
   ```
4. 自動チェック（数秒〜数分、あるいは手動審査で1〜5日）→ **署名済みXPIがダウンロードできる**
5. そのXPIをFirefoxで開くと恒久インストールされる

### 方法B: Firefox Developer Edition / Nightly を使う

未署名のまま `xpinstall.signatures.required=false`（about:config）で永続インストール可。
普段使いをDeveloper Editionにする場合のみ推奨。

### （お試し・一時的）通常Firefoxにそのまま読み込む

- `about:debugging#/runtime/this-firefox` → 「一時的なアドオンを読み込み」→ `build/firefox-prod/manifest.json`
- **Firefoxを終了すると消える**（動作確認用）

## Native Messagingホスト

既に `native/install.sh` 実行時に `~/Library/Application Support/Mozilla/NativeMessagingHosts/jp.ac.kanazawa_u.lms_saver.json` へ登録済み。
`allowed_extensions` に gecko ID `lms-saver@kanazawa-u.example` を指定済み。

## Google Tasks連携のFirefox特有手順

`chrome.identity.getAuthToken` はFirefoxに存在しないため、`lib/auth.ts` が
`launchWebAuthFlow` に自動フォールバックする。

### 手順

1. **Google Cloud Console で「ウェブ アプリケーション」型 OAuthクライアントを新規作成**
   - 既存の「Chromeアプリケーション」型は redirect URL を追加できないため使えない
   - 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」→ アプリケーションの種類: **ウェブ アプリケーション**
2. 「承認済みリダイレクトURI」に、拡張ポップアップの
   「Firefox用 OAuth 設定」に表示されている URL を登録
   - 形式: `https://<UUID>.extensions.allizom.org/`
   - AMO署名済み版では gecko ID 固定なので、表示されるURLをそのまま登録する
   - ※ 一時読み込み (about:debugging) の場合、Firefox再起動ごとにUUIDが変わり、
     その都度URIの再登録が必要 (実運用はAMO署名版を推奨)
3. 発行されたクライアントID (`....apps.googleusercontent.com`) をコピー
4. 拡張ポップアップ →「Firefox用 OAuth 設定」→「ウェブ用クライアントID」に貼り付け→「保存」
5. 「課題をGoogle Tasksに登録」をONにして認証

- クライアントIDは `chrome.storage.local.gtaskClientId` に保存され、
  Firefoxビルドでは manifest の `oauth2.client_id` より優先される
- Chrome ビルドでは従来どおり manifest のクライアントID (Chromeアプリケーション型) を使う

## 既知の制限

- `identity.getAuthToken` / `clearAllCachedAuthTokens` 非対応 → auth.ts で分岐
- Firefox 115+ 対応 (`strict_min_version`)
- 一時読み込みは再起動で消える／UUIDが変わるため、実運用は方法A推奨
