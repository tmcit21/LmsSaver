import { useEffect, useState } from "react"

import "./popup.css"

type Status = {
  root: string
  hostOk: boolean
  autoScan: boolean
  skipExisting: boolean
}

function sendPopup(msg: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : resp)
    })
  })
}

function IndexPopup() {
  const [status, setStatus] = useState<Status | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [rootDraft, setRootDraft] = useState("")
  const [captureMode, setCaptureMode] = useState(false)
  const [gtaskEnabled, setGtaskEnabled] = useState(false)
  const [gmail, setGmail] = useState("")
  const [redirectUri, setRedirectUri] = useState("")
  const [clientIdDraft, setClientIdDraft] = useState("")
  const [clientIdSaved, setClientIdSaved] = useState("")

  const refresh = () => {
    void sendPopup({ type: "POPUP_STATUS" }).then((s) => {
      if (s) {
        setStatus(s)
        setRootDraft(s.root)
      }
    })
    void sendPopup({ type: "POPUP_GTASK_REDIRECT_URI" }).then((r: any) => {
      if (r?.ok) {
        setRedirectUri(r.redirectUri)
      }
    })
    chrome.storage.local.get(
      ["saveLog", "captureMode", "gtaskEnabled", "gtaskEmail", "gtaskClientId"],
      (d) => {
        setLog(Array.isArray(d.saveLog) ? d.saveLog.slice(-40).reverse() : [])
        setCaptureMode(!!d.captureMode)
        setGtaskEnabled(!!d.gtaskEnabled)
        setGmail(d.gtaskEmail ?? "")
        setClientIdDraft(d.gtaskClientId ?? "")
        setClientIdSaved(d.gtaskClientId ? "保存済み" : "")
      }
    )
  }

  useEffect(refresh, [])

  return (
    <div className="wrap">
      <h1>
        LMS Saver{" "}
        <span className={status?.hostOk ? "ok" : "err"}>
          {status?.hostOk ? "●" : "●"}
        </span>
      </h1>

      <div className="row">
        <span className="label">保存先</span>
        <input
          value={rootDraft}
          onChange={(e) => setRootDraft(e.target.value)}
          spellCheck={false}
          placeholder="/Users/.../WebClass資料"
        />
      </div>
      <div className="row">
        <button
          onClick={() =>
            void sendPopup({ type: "POPUP_SET_ROOT", root: rootDraft }).then(refresh)
          }>
          保存先を変更
        </button>
        <button onClick={() => void sendPopup({ type: "POPUP_REVEAL" }).then(refresh)}>
          フォルダを開く
        </button>
      </div>

      <div className="row toggles">
        <label>
          <input
            type="checkbox"
            checked={status?.autoScan ?? true}
            onChange={(e) =>
              void sendPopup({
                type: "POPUP_SETTING",
                key: "autoScan",
                value: e.target.checked
              }).then(refresh)
            }
          />
          自動保存
        </label>
        <label>
          <input
            type="checkbox"
            checked={status?.skipExisting ?? true}
            onChange={(e) =>
              void sendPopup({
                type: "POPUP_SETTING",
                key: "skipExisting",
                value: e.target.checked
              }).then(refresh)
            }
          />
          同名ファイルをスキップ
        </label>
      </div>

      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={captureMode}
            onChange={(e) =>
              void sendPopup({ type: "POPUP_CAPTURE", value: e.target.checked }).then(
                refresh
              )
            }
          />
          デバッグ: 開いたページのHTMLを保存
        </label>
      </div>

      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={gtaskEnabled}
            onChange={(e) => {
              const next = e.target.checked
              chrome.storage.local.set({ gtaskEnabled: next }, () => {
                if (next) {
                  // 初回有効化時にGoogle認証を起動
                  void sendPopup({ type: "POPUP_GTASK_AUTH" }).then((r: any) => {
                    if (r?.ok) {
                      setGmail(r.email ?? "")
                    } else {
                      setGmail(`(認証失敗: ${r?.error ?? "?"})`)
                      // 認証失敗時はトグルを戻す
                      chrome.storage.local.set({ gtaskEnabled: false }, refresh)
                      return
                    }
                    refresh()
                  })
                } else {
                  void sendPopup({ type: "POPUP_GTASK_SIGNOUT" }).then(refresh)
                }
              })
            }}
          />
          課題をGoogle Tasksに登録
        </label>
        {gtaskEnabled && (
          <span className="dim">{gmail || "(アカウント確認中…)"}</span>
        )}
      </div>

      <details className="row advanced">
        <summary>Firefox用 OAuth 設定</summary>
        <div className="advanced-body">
          <div className="dim">
            リダイレクトURL (Google Cloud Consoleの「ウェブ アプリケーション」型
            OAuthクライアントの「承認済みリダイレクトURI」に登録):
          </div>
          <code id="redirect-uri">{redirectUri || "(取得中…)"}</code>
          <div className="dim">ウェブ用クライアントID:</div>
          <div className="row">
            <input
              value={clientIdDraft}
              onChange={(e) => setClientIdDraft(e.target.value)}
              spellCheck={false}
              placeholder="xxxx.apps.googleusercontent.com"
            />
            <button
              onClick={() =>
                void sendPopup({ type: "POPUP_GTASK_SET_CLIENT_ID", clientId: clientIdDraft }).then(
                  (r: any) => {
                    if (r?.ok) {
                      setClientIdSaved(clientIdDraft)
                    } else {
                      setClientIdSaved(`(エラー: ${r?.error ?? "?"})`)
                    }
                  }
                )
              }>
              保存
            </button>
          </div>
          {clientIdSaved && <div className="dim">{clientIdSaved || "(未保存)"}</div>}
        </div>
      </details>

      <div className="row">
        <button onClick={() => void sendPopup({ type: "POPUP_PING" }).then(refresh)}>
          接続テスト
        </button>
        <button onClick={refresh}>更新</button>
        <button onClick={() => void sendPopup({ type: "POPUP_CLEAR_LOG" }).then(refresh)}>
          ログ消去
        </button>
      </div>

      <div className="log">
        {log.length === 0 ? (
          <div className="dim">ログはまだありません</div>
        ) : (
          log.map((l, i) => <div key={i}>{l}</div>)
        )}
      </div>
    </div>
  )
}

export default IndexPopup
