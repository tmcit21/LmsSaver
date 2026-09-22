import type {
  MaterialItem,
  ToBackground
} from "~lib/messages"

import { pushTasks, ensureAuth, signOutGoogle, type TaskDraft } from "~lib/gtasks"
import { oauthRedirectUri } from "~lib/auth"
import { storageSet } from "~lib/storage"

// ---------------------------------------------------------------------------
// Native Messaging host
// ---------------------------------------------------------------------------

const HOST_NAME = "jp.ac.kanazawa_u.lms_saver"
const PORT = chrome.runtime.connectNative(HOST_NAME)

type Pending = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let portHealthy = true
const pending = new Map<number, Pending>()
let reqSeq = 1
let portError = ""

PORT.onMessage.addListener((msg: any) => {
  const id = msg?.id
  if (typeof id === "number" && pending.has(id)) {
    const p = pending.get(id)!
    pending.delete(id)
    clearTimeout(p.timer)
    portHealthy = true
    if (msg.ok) {
      p.resolve(msg)
    } else {
      p.reject(new Error(msg.error ?? "native host error"))
    }
  } else {
    // unsolicited log line from host
    console.log("[lms-saver host]", msg)
  }
})

PORT.onDisconnect.addListener(() => {
  portHealthy = false
  const err = chrome.runtime.lastError?.message ?? "native host disconnected"
  portError = err
  console.warn("[lms-saver] native port disconnected:", err)
  for (const [, p] of pending) {
    clearTimeout(p.timer)
    p.reject(new Error(`native host disconnected: ${err}`))
  }
  pending.clear()
})

function callHost(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!portHealthy) {
      reject(new Error(`native host unavailable: ${portError || "disconnected"}`))
      return
    }
    const id = reqSeq++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`native host timeout: ${method}`))
    }, 60_000)
    pending.set(id, { resolve, reject, timer })
    try {
      PORT.postMessage({ id, method, params })
    } catch (e: any) {
      clearTimeout(timer)
      pending.delete(id)
      reject(new Error(`port.postMessage failed: ${e?.message ?? e}`))
    }
  })
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type Settings = {
  autoScan: boolean
  skipExisting: boolean
  gtaskEnabled: boolean
}

let settings: Settings = { autoScan: true, skipExisting: true, gtaskEnabled: false }
chrome.storage.local.get(["autoScan", "skipExisting", "gtaskEnabled"], (d: any) => {
  settings = {
    autoScan: d?.autoScan !== false,
    skipExisting: d?.skipExisting !== false,
    gtaskEnabled: d?.gtaskEnabled === true
  }
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return
  }
  if (changes.autoScan) {
    settings.autoScan = changes.autoScan.newValue !== false
  }
  if (changes.skipExisting) {
    settings.skipExisting = changes.skipExisting.newValue !== false
  }
  if (changes.gtaskEnabled) {
    settings.gtaskEnabled = changes.gtaskEnabled.newValue === true
  }
})

function log(line: string): void {
  const stamp = new Date().toLocaleTimeString("ja-JP", { hour12: false })
  const entry = `[${stamp}] ${line}`
  console.log(entry)
  chrome.storage.local.get("saveLog", (d: any) => {
    const arr: string[] = Array.isArray(d?.saveLog) ? d.saveLog : []
    arr.push(entry)
    chrome.storage.local.set({ saveLog: arr.slice(-200) })
  })
}

function toastAllTabs(_text: string, _ok: boolean): void {
  // ページ内トースト表示は廃止 (うるさいので)。ログ (ポップアップの保存ログ) で確認できる。
}

self.addEventListener("unhandledrejection", (ev: any) => {
  const r = ev?.reason
  log(`‼ unhandledrejection: ${r?.message ?? String(r)} | ${r?.stack ?? "(stackなし)"}`)
  ev.preventDefault?.()
})
self.addEventListener("error", (ev: any) => {
  log(`‼ error event: ${ev?.message ?? "?"} @ ${ev?.filename ?? "?"}:${ev?.lineno ?? "?"}`)
})

// ---------------------------------------------------------------------------
// Save queue (直列実行)
// ---------------------------------------------------------------------------

const taskQueue: Array<() => Promise<void>> = []
let queueRunning = false
const inFlight = new Set<string>()

function enqueue(task: () => Promise<void>): void {
  taskQueue.push(task)
  if (!queueRunning) {
    queueRunning = true
    void runQueue()
  }
}

async function runQueue(): Promise<void> {
  while (taskQueue.length > 0) {
    const task = taskQueue.shift()!
    try {
      await task()
    } catch (e: any) {
      log(`⚠ キュー処理エラー: ${e?.message ?? e}`)
    }
  }
  queueRunning = false
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function sanitizeName(s?: string | null): string {
  const t = (s ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
  return t.slice(0, 180)
}

function guessExt(mime: string, url: string): string {
  const m = (url.split(/[?#]/)[0] ?? "").match(/\.([A-Za-z0-9]{1,8})$/)
  const byMime: Record<string, string> = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.ms-excel": ".xls",
    "application/msword": ".doc",
    "application/vnd.ms-powerpoint": ".ppt",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "text/html": ".html",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif"
  }
  const fromMime = byMime[mime.split(";")[0].trim().toLowerCase()]
  if (fromMime) {
    return fromMime
  }
  if (m && /^[A-Za-z0-9]+$/.test(m[1])) {
    return `.${m[1].toLowerCase()}`
  }
  return ".bin"
}

function extractFilenameFromCD(cd: string): string {
  const star = cd.match(/filename\*\s*=\s*(?:utf-8|UTF-8)''([^;]+)/)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/"/g, ""))
    } catch {
      // fall through
    }
  }
  const q = cd.match(/filename\s*=\s*"([^"]+)"/)
  if (q) {
    return q[1]
  }
  const raw = cd.match(/filename\s*=\s*([^;]+)/)
  return raw ? raw[1].trim().replace(/"/g, "") : ""
}

function fileIdOf(url: string): string {
  try {
    const u = new URL(url)
    const fid = u.searchParams.get("file_id")
    if (fid) {
      return `fid:${fid}`
    }
    const cid = u.searchParams.get("content_id")
    if (cid) {
      return `cid:${cid}`
    }
    // loadit.php?file=/webclass/data/.../<hash>.pdf → fileパス末尾のハッシュがID
    const file = u.searchParams.get("file")
    if (file) {
      const tail = decodeURIComponent(file).split("/").pop() ?? file
      return `pdf:${tail}`
    }
    return u.pathname + u.search
  } catch {
    return url
  }
}

/** Chromiumが付けた "(1)" などの重複サフィックスを除く */
function stripDupSuffix(name: string): string {
  return name.replace(/\s*\(\d+\)(?=\.[^.]+$|$)/, "")
}

/**
 * 一覧スキャンで登録したURL群から「file= パラメータが pdfPath と一致する
 * loadit URL」を探す。実LMSのframesetはfile_idを持たないため、
 * top framesetのURLの file= から一覧地図を逆引きするのに使う。
 */
function loaditUrlByPdfPath(topUrl: string): string | undefined {
  try {
    const u = new URL(topUrl)
    const file = u.searchParams.get("file")
    if (!file) {
      return undefined
    }
    let pdfPath: string
    try {
      pdfPath = decodeURIComponent(file)
    } catch {
      pdfPath = file
    }
    return pdfPathToLoaditUrl.get(pdfPath)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 一覧ページの資料リンク → 「保存済みかどうか」の地図登録
// 取得は一切行わない (セッション保護)
// ---------------------------------------------------------------------------

type SavedMapEntry = {
  saved: boolean
  path?: string
  course?: string
  session?: string
  label?: string
}

const savedMap = new Map<string, SavedMapEntry>()

// コースID (course.php/<id>/ または ?course_id=) → コース名。一覧スキャン時に学習。
// storage.localに永続化 (Chrome再起動でも保持)。
const courseIdNames = new Map<string, string>()
// コースID → 最後にスキャンした資料群 (file_id → {session,label})
const courseFileMap = new Map<string, Map<string, { session?: string; label?: string; course?: string }>>()
// PDFのfile=パス末尾 → fileId (framesetのfile_id) 対応。pdfViewer→一覧地図の橋渡し。
const pdfTailToFileId = new Map<string, string>()
// PDFのfile=パス (デコード済み) → 一覧スキャンで登録されたloadit URL
const pdfPathToLoaditUrl = new Map<string, string>()

chrome.storage.session?.get?.(["savedMap"], (d: any) => {
  const m = d?.savedMap
  if (m && typeof m === "object") {
    for (const [k, v] of Object.entries(m)) {
      savedMap.set(k, v as SavedMapEntry)
    }
  }
})
chrome.storage.local?.get?.(["courseIdNames", "courseFileMapData"], (d: any) => {
  if (d.courseIdNames && typeof d.courseIdNames === "object") {
    for (const [k, v] of Object.entries(d.courseIdNames)) {
      courseIdNames.set(k, String(v))
    }
  }
  if (d.courseFileMapData && typeof d.courseFileMapData === "object") {
    for (const [cid, items] of Object.entries(d.courseFileMapData)) {
      if (items && typeof items === "object") {
        courseFileMap.set(cid, new Map(Object.entries(items as any)))
      }
    }
  }
})

function persistCourseMaps(): void {
  try {
    const names: Record<string, string> = {}
    for (const [k, v] of courseIdNames) {
      names[k] = v
    }
    const fileData: Record<string, Record<string, any>> = {}
    for (const [cid, m] of courseFileMap) {
      fileData[cid] = Object.fromEntries(m)
    }
    chrome.storage.local?.set?.({ courseIdNames: names, courseFileMapData: fileData })
  } catch {
    // ignore
  }
}

function persistSavedMap(): void {
  try {
    const obj: Record<string, SavedMapEntry> = {}
    for (const [k, v] of savedMap) {
      obj[k] = v
    }
    chrome.storage.session?.set?.({ savedMap: obj })
  } catch {
    // storage.session unavailable (older Chromium)
  }
}

async function checkSaved(
  url: string,
  fid: string,
  courseName?: string,
  sessionLabel?: string
): Promise<SavedMapEntry> {
  // 1) 明示的な保存済み記録
  if (savedMap.has(fid) && savedMap.get(fid)!.saved) {
    return savedMap.get(fid)!
  }
  // 2) ホストの台帳に問い合わせ
  try {
    const r = await callHost("check_exists", {
      fid,
      course_name: courseName ?? "",
      session_label: sessionLabel ?? ""
    })
    if (r.exists) {
      const entry = { saved: true, path: r.rel_path, course: courseName, session: sessionLabel }
      savedMap.set(fid, entry)
      persistSavedMap()
      return entry
    }
  } catch {
    // host unavailable → 未保存として扱う
  }
  return { saved: false }
}

// ---------------------------------------------------------------------------
// メッセージハンドラ
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (msg: ToBackground & { [k: string]: any }, sender, sendResponse) => {
    switch (msg.type) {
      case "MATERIALS": {
        // 地図登録のみ。fetchは一切しない。
        void (async () => {
          const items: MaterialItem[] = msg.items ?? []
          let savedCount = 0
          // スキャン元ページからコースIDを引き取る
          // 実LMS: course.php/<id>/ (パス引数) と course.php?course_id= の両形
          const srcUrl = msg.url ?? ""
          let courseId: string | undefined
          try {
            const su = new URL(srcUrl, "https://x.invalid")
            courseId =
              su.searchParams.get("course_id") ??
              /\/course\.php\/(\d+)/.exec(su.pathname)?.[1] ??
              undefined
          } catch {
            courseId = undefined
          }
          if (courseId && msg.courseName) {
            courseIdNames.set(courseId, msg.courseName)
            persistCourseMaps()
          }
          if (courseId) {
            courseFileMap.set(courseId, new Map())
          }
          for (const item of items) {
            const fid = fileIdOf(item.url)
            const entry = await checkSaved(
              item.url,
              fid,
              msg.courseName,
              item.sessionLabel
            )
            if (entry.saved) {
              savedCount++
            }
            const enriched: SavedMapEntry = {
              ...entry,
              course: msg.courseName ?? entry.course,
              session: item.sessionLabel ?? entry.session,
              label: item.label ?? entry.label
            }
            savedMap.set(item.url, enriched)
            savedMap.set(fid, enriched)
            // loadit URLの file= パラメータを抽出し PDFパス対応を学習
            // (実LMS: framesetが file_id を持たないため、file= での逆引きが必要)
            try {
              const itemUrl = new URL(item.url)
              const fileParam = itemUrl.searchParams.get("file")
              if (fileParam) {
                let pdfPath: string
                try {
                  pdfPath = decodeURIComponent(fileParam)
                } catch {
                  pdfPath = fileParam
                }
                if (!pdfPathToLoaditUrl.has(pdfPath)) {
                  pdfPathToLoaditUrl.set(pdfPath, item.url)
                }
              }
            } catch {
              // not a valid URL
            }
            // file_id 形式なら コースIDごとの資料地図にも登録
            const mFid = /^fid:(\d+)$/.exec(fid)
            if (courseId && mFid) {
              courseFileMap.get(courseId)!.set(mFid[1], {
                session: item.sessionLabel,
                label: item.label,
                course: msg.courseName
              })
            }
          }
          persistSavedMap()
          persistCourseMaps()
          log(
            `一覧スキャン: ${items.length}件 (保存済み ${savedCount}件)` +
              (courseId && msg.courseName ? ` [${msg.courseName}]` : "")
          )
        })()
        break
      }
      case "CHECK_SAVED": {
        void (async () => {
          const fid = fileIdOf(msg.url)
          const entry = await checkSaved(
            msg.url,
            fid,
            msg.courseName,
            msg.sessionLabel
          )
          sendResponse({ saved: entry.saved, path: entry.path })
        })()
        return true
      }
      case "SAVE_BLOB": {
        // コンテンツスクリプトが取得した本文を受け取って保存
        // (pdfViewerフレーム → 実PDF / mbl → 自フレームのHTML)
        void (async () => {
          const url: string = msg.url
          const fid: string = msg.fidOverride || fileIdOf(url)
          if (inFlight.has(fid)) {
            sendResponse({ ok: true, skipped: "in-flight" })
            return
          }
          // pdfViewer由来: courseId候補 (file=パス) + fileId (親frameset) で一覧地図を引く
          const candidates: string[] = msg.courseIdCandidates ?? []
          const mapFid: string | undefined = msg.fileId
          let courseName: string | undefined = msg.courseName || undefined
          let sessionLabel: string | undefined = msg.sessionLabel
          let label: string | undefined = msg.label
          // コースID候補のどれかが学習済みコース名にヒットすれば採用
          for (const cid of candidates) {
            if (courseIdNames.has(cid)) {
              courseName = courseName || courseIdNames.get(cid)
              break
            }
          }
          // 親framesetのfile_idから 回/ラベル/コース名 を取る
          if (mapFid) {
            const meta =
              [...courseFileMap.values()]
                .map((m) => m.get(mapFid))
                .find((v) => v) ?? savedMap.get(`fid:${mapFid}`)
            if (meta) {
              courseName = courseName ?? meta.course
              sessionLabel = sessionLabel ?? meta.session
              label = label ?? meta.label
            }
          }
          // framesetにfile_idが無い場合 (実LMS): set_contents_id で一覧地図を逆引き
          if (msg.setContentsId) {
            const inv = savedMap.get(
              `/webclass/do_contents.php?reset_status=1&set_contents_id=${msg.setContentsId}`
            )
            const inv2 = savedMap.get(
              `https://lms-wc.el.kanazawa-u.ac.jp/webclass/do_contents.php?reset_status=1&set_contents_id=${msg.setContentsId}`
            )
            const meta = inv?.saved || inv?.course ? inv : inv2
            if (meta && (meta.course || meta.session || meta.label)) {
              courseName = courseName ?? meta.course
              sessionLabel = sessionLabel ?? meta.session
              label = label ?? meta.label
            }
          }
          // topUrl の file= パラメータから一覧スキャン地図を逆引き (補助)
          if (!label && msg.topUrl) {
            const inv = loaditUrlByPdfPath(msg.topUrl)
            if (inv) {
              const meta = savedMap.get(inv)
              if (meta) {
                courseName = courseName ?? meta.course
                sessionLabel = sessionLabel ?? meta.session
                label = label ?? meta.label
              }
            }
          }
          // 予備: PDF末尾名 → fileId 対応 (前回学習分)
          const tailKey = url.split("/").pop() ?? ""
          const learnedFid = pdfTailToFileId.get(tailKey)
          if (!label && learnedFid) {
            const meta = savedMap.get(learnedFid)
            if (meta) {
              courseName = courseName ?? meta.course
              sessionLabel = sessionLabel ?? meta.session
              label = label ?? meta.label
            }
          }
          // ハッシュ名 (英数字のみの長い名前) はlabelにしない
          const tailName = msg.fileTail ?? ""
          const isHashName = /^[a-f0-9]{16,}\./i.test(tailName)
          if (label && /^[a-f0-9]{16,}\./i.test(label)) {
            label = undefined
          }
          label = label ?? (isHashName ? undefined : tailName || undefined)
          const mime: string = msg.mime || "application/octet-stream"
          const cd: string = msg.cd || ""
          const b64: string = msg.b64 || ""

          enqueue(async () => {
            if (settings.skipExisting) {
              const entry = await checkSaved(url, fid, courseName, sessionLabel)
              if (entry.saved) {
                log(`⏭ スキップ(保存済み): ${entry.path}`)
                toastAllTabs(`スキップ: ${label ?? url}`, true)
                return
              }
            }
            let filename = extractFilenameFromCD(cd) || msg.filename || ""
            if (!filename) {
              filename = `${sanitizeName(label ?? "資料")}${guessExt(mime, url)}`
            }
            // 二重拡張子ガード: "xxx.pdf" にさらに ".pdf" を付けない。
            // 拡張子なしの stem にだけ mime/URL 由来の拡張子を補完する。
            const dot = filename.lastIndexOf(".")
            const ext = dot > 0 ? filename.slice(dot) : ""
            const wanted = guessExt(mime, url)
            const stem = sanitizeName(dot > 0 ? filename.slice(0, dot) : filename) || "資料"
            const finalName =
              ext !== "" ? `${stem}${ext}` : `${stem}${wanted}`
            try {
              const r = await callHost("save", {
                fid,
                course_name: courseName ?? "",
                session_label: sessionLabel ?? "",
                filename: finalName,
                b64,
                mime
              })
              savedMap.set(fid, {
                saved: true,
                path: r.rel_path,
                course: courseName,
                session: sessionLabel,
                label
              })
              savedMap.set(url, {
                saved: true,
                path: r.rel_path,
                course: courseName,
                session: sessionLabel,
                label
              })
              if (mapFid) {
                savedMap.set(`fid:${mapFid}`, savedMap.get(url)!)
                // 次回以降はPDF末尾名でも引けるように学習
                pdfTailToFileId.set(tailKey, `fid:${mapFid}`)
              }
              persistSavedMap()
              log(`✅ 保存: ${r.rel_path}${courseName ? ` [${courseName}]` : ""}`)
              toastAllTabs(`保存: ${finalName}`, true)
            } catch (e: any) {
              log(`⚠ 保存失敗: ${finalName}: ${e?.message ?? e}`)
              toastAllTabs(`保存失敗: ${finalName}`, false)
            }
          })
          sendResponse({ ok: true, queued: true })
        })()
        return true
      }
      case "CAPTURE": {
        void callHost("capture", {
          url: msg.url,
          page: msg.page,
          html: msg.html
        })
          .then((r) => log(`📸 キャプチャ: ${r.rel_path}`))
          .catch(() => {})
        break
      }
      case "ASSIGNMENTS": {
        // コーストップで検出した「利用可能期間あり」のコンテンツ → Google Tasksへ登録
        if (!settings.gtaskEnabled) {
          break
        }
        void (async () => {
          const drafts: TaskDraft[] = []
          for (const item of msg.items ?? []) {
            drafts.push({
              dedupeKey: `wc:${msg.courseName ?? ""}:${item.contentsId}`,
              title: `[${msg.courseName ?? "WebClass"}] ${item.title}`,
              due: item.due ?? null,
              notes: `カテゴリ: ${item.category}${item.session ? `\n${item.session}` : ""}${item.dueText ? `\n利用可能期間: ${item.dueText}` : ""}\nURL: ${item.url}`
            })
          }
          if (drafts.length === 0) {
            return
          }
          try {
            const r = await pushTasks(drafts)
            log(
              `📝 課題Tasks登録: ${r.added}件追加 / ${r.skipped}件スキップ` +
                (r.errors.length ? ` / エラー${r.errors.length}件` : "")
            )
            for (const e of r.errors) {
              log(`⚠ Tasks: ${e}`)
            }
          } catch (e: any) {
            log(`⚠ Tasks登録失敗: ${e?.message ?? e}`)
          }
        })()
        break
      }
      case "POPUP_STATUS": {
        void (async () => {
          let root = ""
          try {
            const r = await callHost("get_root")
            root = r.root ?? ""
          } catch {
            root = `(${portHealthy ? "native host error" : "未接続"})`
          }
          sendResponse({
            root,
            hostOk: portHealthy,
            autoScan: settings.autoScan,
            skipExisting: settings.skipExisting
          })
        })()
        return true
      }
      case "POPUP_PING": {
        callHost("ping")
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: e.message }))
        return true
      }
      case "POPUP_REVEAL": {
        callHost("reveal", { rel_path: msg.rel_path ?? "" })
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: e.message }))
        return true
      }
      case "POPUP_SET_ROOT": {
        callHost("set_root", { root: msg.root })
          .then((r) => {
            log(`保存先を変更: ${r.root}`)
            sendResponse({ ok: true, root: r.root })
          })
          .catch((e) => sendResponse({ ok: false, error: e.message }))
        return true
      }
      case "POPUP_SETTING": {
        const key = msg.key as "autoScan" | "skipExisting"
        chrome.storage.local.set({ [key]: msg.value }, () => {
          sendResponse({ ok: true })
        })
        return true
      }
      case "POPUP_CAPTURE": {
        chrome.storage.local.set({ captureMode: msg.value }, () => {
          log(`デバッグキャプチャ: ${msg.value ? "ON" : "OFF"}`)
          sendResponse({ ok: true })
        })
        return true
      }
      case "POPUP_GTASK_AUTH": {
        void (async () => {
          const r = await ensureAuth()
          if (r.ok) {
            await storageSet({ gtaskEmail: r.email ?? "", gtaskEnabled: true })
            settings.gtaskEnabled = true
            log(`📝 Google連携: ${r.email ?? "(メール取得不可)"}`)
          } else {
            await storageSet({ gtaskEnabled: false })
            settings.gtaskEnabled = false
            log(`⚠ Google認証失敗: ${r.error}`)
          }
          sendResponse(r)
        })()
        return true
      }
      case "POPUP_GTASK_REDIRECT_URI": {
        // Google Cloud Consoleに登録すべきリダイレクトURLを返す
        sendResponse({ ok: true, redirectUri: oauthRedirectUri() })
        return
      }
      case "POPUP_GTASK_SET_CLIENT_ID": {
        void (async () => {
          const cid = String(msg.clientId ?? "").trim()
          if (!cid || !cid.endsWith(".apps.googleusercontent.com")) {
            sendResponse({ ok: false, error: "クライアントIDの形式が正しくありません" })
            return
          }
          await storageSet({ gtaskClientId: cid })
          log(`📝 OAuthクライアントIDを設定 (Firefox用)`)
          sendResponse({ ok: true })
        })()
        return true
      }
      case "POPUP_GTASK_SIGNOUT": {
        void (async () => {
          await signOutGoogle()
          settings.gtaskEnabled = false
          log("📝 Google連携を解除しました")
          sendResponse({ ok: true })
        })()
        return true
      }
      case "POPUP_CLEAR_LOG": {
        chrome.storage.local.set({ saveLog: [] }, () => {
          sendResponse({ ok: true })
        })
        return true
      }
      default:
        break
    }
    return false
  }
)

// ---------------------------------------------------------------------------
// ダウンロード型資料 (Content-Disposition: attachment) の後処理
// Chromium本来のダウンロードに任せ、完了後にホストへリネーム依頼。
// 拡張自身は一切fetchしないのでLMSセッションに余計な負荷をかけない。
// ---------------------------------------------------------------------------

const movingIds = new Set<number>()

chrome.downloads?.onCreated?.addListener((item) => {
  const url = item.finalUrl || item.url || ""
  if (!/lms-wc\.el\.kanazawa-u\.ac\.jp|localhost:8765/.test(url)) {
    return
  }
  // 拡張が既に attach: 経由で保存済みの添付資料なら、手動DLを整理せず破棄する
  // (download.php URL には file=<hash> が入る → attach:<contents_id>:<hash> と対応)
  const fileHash = (() => {
    try {
      return new URL(url).searchParams.get("file") ?? ""
    } catch {
      return ""
    }
  })()
  if (fileHash) {
    const dup = [...savedMap.entries()].find(
      ([k, v]) => k.startsWith("attach:") && k.endsWith(`:${fileHash}`) && v.saved
    )
    if (dup) {
      log(`⏭ 手動DLを破棄 (拡張が保存済み): ${fileHash}`)
      chrome.downloads.erase({ id: item.id })
      return
    }
  }
  const fid = fileIdOf(url)
  void (async () => {
    const entry = savedMap.get(url) ?? (await checkSaved(url, fid, undefined, undefined))
    if (entry.course) {
      downloadCourseMap.set(fid, {
        course: entry.course,
        session: entry.session,
        label: entry.label
      })
    }
    log(`⬇ ダウンロード開始: ${item.filename?.split("/").pop() ?? url}`)
    movingIds.add(item.id)
  })()
})

chrome.downloads?.onChanged?.addListener((delta) => {
  const st = delta.state
  if (!st || (st.current !== "complete" && st.current !== "interrupted")) {
    return
  }
  const tracked = movingIds.delete(delta.id)
  if (!tracked && st.current === "interrupted") {
    return
  }
  chrome.downloads.search({ id: delta.id }, (items) => {
    const it = items?.[0]
    if (!it) {
      return
    }
    const url = it.finalUrl || it.url || ""
    if (!/lms-wc\.el\.kanazawa-u\.ac\.jp|localhost:8765/.test(url)) {
      return
    }
    if (st.current === "complete") {
      void moveDownload(it, url)
    }
  })
})

// 一覧スキャン時に fid → 授業/回/ラベル を記憶しておく
const downloadCourseMap = new Map<
  string,
  { course?: string; session?: string; label?: string }
>()

async function moveDownload(
  item: chrome.downloads.DownloadItem,
  url: string
): Promise<void> {
  const fid = fileIdOf(url)
  const meta = downloadCourseMap.get(fid) ?? savedMap.get(fid) ?? {}
  const rawName = (item.filename?.split("/").pop() ?? "").replace(/\.crdownload$/, "")
  const filename = stripDupSuffix(rawName)
  if (!filename) {
    return
  }
  // file_down.php由来 (file=<hash>) の場合、attach:<contents_id>:<hash> で
  // 学習済みコース/回を引く。add: attach側で pdfTailToFileId 相当の対応も作る
  let course = meta.course
  let session = meta.session
  if ((!course || !session) && fileHashOf(url)) {
    const attachEntry = [...savedMap.entries()].find(
      ([k, v]) => k.startsWith("attach:") && k.endsWith(`:${fileHashOf(url)}`) && v.saved
    )
    if (attachEntry) {
      course = course ?? attachEntry[1].course
      session = session ?? attachEntry[1].session
    }
  }
  try {
    const r = await callHost("adopt_download", {
      tmp_path: item.filename,
      fid,
      course_name: course ?? "",
      session_label: session ?? "",
      filename,
      url
    })
    savedMap.set(fid, { saved: true, path: r.rel_path })
    persistSavedMap()
    log(`📁 整理: ${r.rel_path}`)
    toastAllTabs(`保存: ${filename}`, true)
  } catch (e: any) {
    log(`⚠ 整理失敗: ${filename}: ${e?.message ?? e}`)
  }
}

/** URLの file= パラメータ (添付DLのhash) */
function fileHashOf(url: string): string {
  try {
    return new URL(url).searchParams.get("file") ?? ""
  } catch {
    return ""
  }
}

log("background service worker 起動")
