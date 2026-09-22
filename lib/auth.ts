import { storageGet, storageSet } from "~lib/storage"

/**
 * ブラウザ判定と認証の互換レイヤ
 *
 * Chrome: chrome.identity.getAuthToken (manifest oauth2 クライアントID使用)
 * Firefox: chrome.identity.getAuthToken が存在しないため launchWebAuthFlow で
 *          自前実装 (redirect_url は https://<extension-id>.chromiumapp.org/)
 */

export function isFirefox(): boolean {
  return (
    typeof chrome !== "undefined" &&
    !!chrome.runtime?.getURL &&
    chrome.runtime.getURL("/").startsWith("moz-extension://")
  )
}

/** moz-extension://<uuid> → uuid部分 */
function geckoId(): string {
  const url = chrome.runtime.getURL("/")
  return new URL(url).host
}

/** Chromeの拡張ID (chrome-extension://<id>/) */
function chromeExtId(): string {
  const url = chrome.runtime.getURL("/")
  return new URL(url).host
}

const REDIRECT_HOST = "chromiumapp.org"

export interface AuthResult {
  accessToken: string
  expiresInSec: number
}

/**
 * OAuth トークン取得 (Chrome / Firefox 両対応)。
 * - Chrome: chrome.identity.getAuthToken
 * - Firefox: launchWebAuthFlow で authorization code flow (PKCE 無し, client secret 無しの
 *   Chrome App スタイル。Google の Chrome 拡張用クライアントは redirect_uri として
 *   https://<ext-id>.chromiumapp.org/ を受け付けるが、Firefox では extension id が
 *   UUID なのでクライアント側にその redirect_uri を事前登録しておく必要がある)
 */
export async function getGoogleAccessToken(
  interactive: boolean,
  scopes: string[]
): Promise<AuthResult> {
  if (!isFirefox()) {
    // Chrome: 標準API
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive, scopes }, (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(new Error(chrome.runtime.lastError?.message ?? "no token"))
          return
        }
        // 有効期限は取得できないので 50分固定
        resolve({ accessToken: token, expiresInSec: 50 * 60 })
      })
    })
  }

  // Firefox: launchWebAuthFlow
  // redirect URLは各ブラウザの getRedirectURL() に任せる
  // (Firefox: https://<id>.extensions.allizom.org/, Chrome: https://<id>.chromiumapp.org/)
  const redirectUri = oauthRedirectUri()
  const clientId = await getOauthClientId()
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  authUrl.searchParams.set("client_id", clientId)
  authUrl.searchParams.set("response_type", "token") // implicit flow (client secret不要)
  authUrl.searchParams.set("redirect_uri", redirectUri)
  authUrl.searchParams.set("scope", scopes.join(" "))
  if (interactive) {
    authUrl.searchParams.set("prompt", "consent select_account")
  } else {
    // non-interactive: セッションがある場合のみ成功
    authUrl.searchParams.set("prompt", "none")
  }

  const redirectUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.href, interactive },
      (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message ?? "auth flow failed"))
          return
        }
        resolve(responseUrl)
      }
    )
  })

  // redirect URLのハッシュフラグメントからaccess_tokenを取り出す
  const hash = new URL(redirectUrl).hash.slice(1)
  const params = new URLSearchParams(hash)
  const accessToken = params.get("access_token")
  const expiresIn = Number(params.get("expires_in") || "3600")
  if (!accessToken) {
    const err = params.get("error")
    throw new Error(`oauth: ${err ?? "no access_token in redirect"}`)
  }
  return { accessToken, expiresInSec: expiresIn }
}

/**
 * Firefox用: OAuth クライアントIDを取得。
 * Firefoxでは redirect URL が extensions.allizom.org になるため、
 * Chromeアプリケーション型クライアントは使えない。storageに保存された
 * 「ウェブ アプリケーション」型クライアントIDを優先する。
 */
async function getOauthClientId(): Promise<string> {
  // Firefoxでは chrome.storage のPromiseラッパが動かないのでコールバック互換の
  // storageGet を使う (Chromeでも動く)
  const st = await storageGet<{ gtaskClientId?: string }>("gtaskClientId")
  if (isFirefox() && st.gtaskClientId) {
    return st.gtaskClientId
  }
  // manifestから取れる場合はそれを使う (Chromeではmanifest oauth2が正)
  const mf: any = (chrome as any).runtime.getManifest()
  const fromManifest = mf?.oauth2?.client_id
  if (fromManifest && !fromManifest.startsWith("YOUR_")) {
    return fromManifest
  }
  const cid = st.gtaskClientId
  if (!cid) {
    throw new Error(
      "OAuthクライアントIDが未設定です。ポップアップから設定してください。"
    )
  }
  return cid
}

/** OAuthフローのリダイレクトURL (Google Cloud Consoleに登録する文字列) */
export function oauthRedirectUri(): string {
  try {
    if (typeof (chrome as any).identity?.getRedirectURL === "function") {
      return (chrome as any).identity.getRedirectURL() as string
    }
  } catch {
    // fallthrough
  }
  return `https://${geckoId()}.${REDIRECT_HOST}/`
}

/** Firefox用にOAuth client idを保存 (デバッグ用) */
export async function setOauthClientId(clientId: string): Promise<void> {
  await storageSet({ gtaskClientId: clientId })
}

/** 現在の拡張origin (デバッグ表示用) */
export function extensionOrigin(): string {
  return chrome.runtime.getURL("/").replace(/\/$/, "")
}

/** Chrome拡張ID (chromeビルド時) / Gecko ID (firefoxビルド時) */
export function extensionId(): string {
  return geckoId() || chromeExtId()
}
