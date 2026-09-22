import type { PlasmoCSConfig } from "plasmo"

import type { MaterialItem, PageType } from "~lib/messages"

export const config: PlasmoCSConfig = {
  matches: [
    "https://lms-wc.el.kanazawa-u.ac.jp/webclass/*",
    "http://localhost:8765/*"
  ],
  all_frames: true,
  run_at: "document_idle"
}

const PAGE_PATTERNS: Array<[PageType, RegExp]> = [
  ["txtbk", /txtbk_(frame|show_chapter|show_text|title_simple)\.php/],
  ["qstn", /qstn_frame\.php/],
  ["loadit", /loadit\.php/],
  ["show", /show_frame\.php/],
  ["mbl", /mbl\.php/],
  ["do_contents", /do_contents\.php/],
  ["course", /course\.php/]
]

const FILE_LINK_RE = /loadit\.php|mbl\.php|show_frame\.php|do_contents\.php/
const GENERIC_TITLES = new Set([
  "webclass",
  "pdf.js viewer",
  "教材",
  "資料",
  "メニュー",
  "ホーム",
  "メイン",
  "menu",
  "home",
  "main",
  "top"
])
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

function sanitizeName(s?: string | null): string {
  const t = (s ?? "")
    .replace(BAD_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
  return t.slice(0, 180)
}

function detectPage(): PageType | null {
  for (const [page, re] of PAGE_PATTERNS) {
    if (re.test(location.href)) {
      return page
    }
  }
  return null
}

function getCourseName(): string | undefined {
  const sels = [".course-name", "#course-name", ".course_title", ".courseName"]
  for (const s of sels) {
    const el = document.querySelector(s)
    const t = el?.textContent?.replace(/\s+/g, " ").trim()
    if (t) {
      return t.slice(0, 120)
    }
  }
  const h1 = document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()
  if (h1 && !GENERIC_TITLES.has(h1.toLowerCase())) {
    return h1.slice(0, 120)
  }
  const t = (document.title || "")
    .replace(/\s*[-–—|]\s*WebClass.*$/i, "")
    .trim()
  if (t && !GENERIC_TITLES.has(t.toLowerCase())) {
    return t.slice(0, 120)
  }
  return undefined
}

function positionBefore(x: Element, y: Element): boolean {
  // true if y follows x in document order
  return !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING)
}

function extractMaterials(): MaterialItem[] {
  const anchors = Array.from(
    document.querySelectorAll<HTMLAnchorElement>("a[href]")
  ).filter((a) => /^https?:/i.test(a.href) && FILE_LINK_RE.test(a.href))

  if (anchors.length === 0) {
    return itemsFromHtml()
  }

  // find "第N回" group headers, in document order
  const headerPat = /第\s*[0-9０-９一二三四五六七八九十百]+\s*(?:回|講|週)/
  const headers = Array.from(
    document.querySelectorAll(
      "td, th, div, p, h1, h2, h3, h4, h5, h6, li, b, strong, span"
    )
  ).filter((el) => {
    const t = (el.textContent ?? "").trim()
    return t.length > 0 && t.length <= 40 && headerPat.test(t) && el.children.length <= 2
  })

  const out: MaterialItem[] = []
  const seen = new Set<string>()
  let hi = 0
  let currentSession = ""
  for (const a of anchors) {
    while (hi < headers.length && positionBefore(headers[hi], a)) {
      const t = (headers[hi].textContent ?? "").trim()
      if (t) {
        currentSession = t
      }
      hi++
    }
    if (seen.has(a.href)) {
      continue
    }
    seen.add(a.href)
    const label = (a.textContent ?? "").trim() || a.title || "資料"
    out.push({
      url: a.href,
      label: sanitizeName(label) || "資料",
      sessionLabel: currentSession || undefined
    })
  }
  return out
}

// fallback: pick material URLs out of raw HTML (javascript: links etc.)
function itemsFromHtml(): MaterialItem[] {
  const html = document.documentElement.outerHTML
  const re = /(?:loadit|mbl|show_frame|do_contents)\.php\?[^"'<>\s)]+/g
  const out = new Map<string, MaterialItem>()
  for (const m of html.matchAll(re)) {
    // PDFビューアの内部フレームURLは資料リンクではないので除外
    if (/action=(?:providePDF|pdfViewer)/.test(m[0])) {
      continue
    }
    try {
      const u = new URL(m[0], location.href).href
      if (!out.has(u)) {
        out.set(u, { url: u, label: "資料" })
      }
    } catch {
      // ignore malformed URL
    }
  }
  return Array.from(out.values())
}

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ""
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  }
  return btoa(bin)
}

const send = (msg: unknown): void => {
  try {
    void chrome.runtime.sendMessage(msg).catch(() => {})
  } catch {
    // extension context invalidated etc.
  }
}

// ---------------------------------------------------------------
// 保存済みかどうかをbackgroundに問い合わせる
// ---------------------------------------------------------------
function checkSavedMsg(msg: {
  url: string
  courseName?: string
  sessionLabel?: string
}): Promise<{ saved?: boolean; path?: string } | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "CHECK_SAVED", ...msg }, (r) =>
        resolve(chrome.runtime.lastError ? null : r)
      )
    } catch {
      resolve(null)
    }
  })
}

// ---------------------------------------------------------------
// 保存対象は「開いたページ自身」だけ。
//  - loadit (pdfViewerフレーム): file= パラメータの実PDFを1リクエストで取得・保存
//  - loadit (frameset / providePDF): 保存しない
//  - mbl: 追加リクエスト無しでDOMのHTMLを保存
//  - 一覧ページ: リンク地図の登録のみ (scanAndReport)
async function saveThisPage(page: PageType): Promise<void> {
  if (page === "loadit") {
    const action = new URLSearchParams(location.search).get("action")
    if (action === "pdfViewer") {
      await savePdfFrame()
    }
  } else if (page === "mbl") {
    await saveMblPage()
  }
  // 添付資料リンク (file_down.php) はどのフレームに現れるか分からない。
  // 子フレームへのcontent script注入が漏れることがあるため、
  // 自分のフレーム + 同一オリジン子フレームを走査して収集する。
  // フレームの読み込み順序は不定なため、時間をおいて3回試す。
  if (page !== "course" && page !== "qstn") {
    const run = () => {
      const links = collectAttachmentsFromFrames()
      if (links.length) {
        return saveAttachments(links)
      }
      return saveAttachments()
    }
    await run()
    setTimeout(() => void run(), 2500)
    setTimeout(() => void run(), 6000)
  }
}

/**
 * loadit系フレームでは course.php 由来のコース名が取れない。
 * 親フレーム (frameset) のURLに file_id があるので、同じタブのどれかのフレーム
 * (通常はtop) から top.location の file_id / course_id を引き継ぐ。
 * 同一オリジンなので top へのアクセスは可能。
 */
function loaditContextFromTop(): {
  fileId?: string
  courseId?: string
  courseName?: string
} {
  try {
    const top = window.top
    if (!top || top === window) {
      return {}
    }
    const sp = new URLSearchParams(top.location.search)
    return {
      fileId: sp.get("file_id") ?? undefined,
      courseId: sp.get("course_id") ?? undefined
    }
  } catch {
    return {}
  }
}

/**
 * 親フレーム (txtbk_frame等) のURLから set_contents_id を引き抜く。
 * 実LMS: do_contents → txtbk_frame?set_contents_id=... → (iframe) loadit?file=...
 * set_contents_id は一覧スキャンで学習した do_contents URL のキーなので、
 * これがコース名・回・ラベル復元の決定手がかりになる。
 */
function setContentsIdFromTop(): string | undefined {
  try {
    const top = window.top
    if (!top || top === window) {
      return undefined
    }
    const m = top.location.href.match(/set_contents_id=([a-f0-9]+)/)
    return m ? m[1] : undefined
  } catch {
    return undefined
  }
}

/** pdfViewerフレーム: file= パラメータ (または DEFAULT_URL) の実PDFを取得して保存 */
async function savePdfFrame(): Promise<void> {
  const sp = new URLSearchParams(location.search)
  const fileParam = sp.get("file") ?? extractDefaultUrl()
  if (!fileParam) {
    return
  }
  let pdfPath: string
  try {
    pdfPath = decodeURIComponent(fileParam)
  } catch {
    pdfPath = fileParam
  }
  let pdfUrl: string
  try {
    pdfUrl = new URL(pdfPath, location.origin).href
  } catch {
    return
  }
  const tail = pdfPath.split("/").pop() || "資料.pdf"
  // /webclass/data/course/<数字>/<数字>/<hash>/<file>.pdf — 数字セグメントは
  // 複数 (shard id / course id 等) あり得るので全部送って background 側で照合する
  const afterCourse = pdfPath.split("/webclass/data/course/")[1] ?? ""
  const courseIdCandidates = afterCourse
    .split("/")
    .filter((s) => /^\d+$/.test(s))
  const courseDir = courseIdCandidates[courseIdCandidates.length - 1] ?? ""
  const topCtx = loaditContextFromTop()
  // 保存済みなら取得しない
  const pre = await checkSavedMsg({ url: pdfUrl })
  if (pre?.saved) {
    return
  }

  const res = await fetch(pdfUrl, { credentials: "include" })
  if (!res.ok) {
    return
  }
  const buf = await res.arrayBuffer()
  if (buf.byteLength > 45 * 1024 * 1024) {
    return
  }
  const cd = res.headers.get("content-disposition") ?? ""
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim()
  send({
    type: "SAVE_BLOB",
    url: pdfUrl,
    b64: bufToB64(buf),
    mime,
    cd,
    fileTail: tail,
    courseIdCandidates,
    courseDir,
    fileId: topCtx.fileId,
    setContentsId: setContentsIdFromTop(),
    topUrl: window.top && window.top !== window ? window.top.location.href : undefined
  })
}

/** pdf.jsビューアのインラインスクリプトから DEFAULT_URL を抜く (フォールバック用) */
function extractDefaultUrl(): string | null {
  for (const s of document.querySelectorAll("script")) {
    const t = s.textContent ?? ""
    const m = t.match(/var\s+DEFAULT_URL\s*=\s*['"]([^'"]+)['"]/)
    if (m) {
      return m[1]
    }
  }
  return null
}

/** mbl (インライン教材ページ): DOMのHTMLをそのまま保存 (追加リクエスト無し) */
async function saveMblPage(): Promise<void> {
  const label = (
    document.querySelector(".ui-content")?.textContent ??
    document.body.textContent ??
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
  const html = document.documentElement.outerHTML
  if (!html || html.length < 50) {
    return
  }
  const bytes = new TextEncoder().encode(html.slice(0, 2_000_000))
  send({
    type: "SAVE_BLOB",
    url: location.href,
    b64: bufToB64(bytes),
    mime: "text/html",
    cd: "",
    label: label || undefined,
    courseName: getCourseName()
  })
}

/**
 * 添付資料 (file_down.php 経由のダウンロード型):
 *   file_down.php?target_type=attach&file=<hash>&contents_id=<id>&file_name=<name>
 *     → 中間HTML (時間トークン付き download.php/<name>?... リンク)
 *     → download.php/<file_name>?... が実ファイルを返す
 * 2リクエストで保存できる。fidは contents_id+file_name で安定させる。
 * 「添付資料」リンクは txtbk_show_chapter / txtbk_show_text 等のサブフレームに現れる。
 * ただしChromiumは拡張リロード後等に子フレームへのcontent script注入を
 * 漏らすことがあるため、attachLinks 引数に別フレームから収集したリンクも渡せる。
 */
async function saveAttachments(attachLinks?: Array<{ href: string; fid: string; fileName: string }>): Promise<void> {
  let targets: Array<{ href: string; fid: string; fileName: string }> = attachLinks ?? []
  if (!targets.length) {
    targets = [...document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="file_down.php?"][href*="target_type=attach"]'
    )].map(a => {
      const href = a.getAttribute("href") ?? ""
      try {
        const u = new URL(href, location.origin)
        const fileHash = u.searchParams.get("file") ?? ""
        const contentsId = u.searchParams.get("contents_id") ?? ""
        return {
          href: u.href,
          fid: `attach:${contentsId}:${fileHash}`,
          fileName: u.searchParams.get("file_name") ?? "添付資料.pdf"
        }
      } catch {
        return null
      }
    }).filter((x): x is { href: string; fid: string; fileName: string } => !!x)
  }
  for (const t of targets) {
    try {
      const u = new URL(t.href, location.origin)
      const fid = t.fid || `attach:${u.searchParams.get("contents_id")}:${u.searchParams.get("file")}`
      const fileName = t.fileName || u.searchParams.get("file_name") || "添付資料.pdf"
      const fileDownUrl = u.href

      // 保存済みなら何もしない
      const pre = await checkSavedMsg({ url: fileDownUrl })
      if (pre?.saved) {
        continue
      }

      // 1) 中間ページを取得して最終 download.php URL を抜く
      //    acs_ トークンが古いと404になるので数回リトライする
      let html: string | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const res1 = await fetch(fileDownUrl, { credentials: "include" })
        if (res1.ok) {
          html = await res1.text()
          break
        }
        await new Promise(r => setTimeout(r, 2000))
      }
      if (!html) {
        continue
      }
      const m =
        html.match(/href='([^']*download\.php[^']*)'/i) ??
        html.match(/href="([^"]*download\.php[^"]*)"/i)
      if (!m) {
        continue
      }
      const finalUrl = new URL(m[1].replace(/&amp;/g, "&"), location.origin).href

      // 2) 実ファイル取得
      const res2 = await fetch(finalUrl, { credentials: "include" })
      if (!res2.ok) {
        continue
      }
      const buf = await res2.arrayBuffer()
      if (buf.byteLength > 45 * 1024 * 1024) {
        continue
      }
      const cd = res2.headers.get("content-disposition") ?? ""
      const mime = (res2.headers.get("content-type") ?? "").split(";")[0].trim()
      send({
        type: "SAVE_BLOB",
        url: fileDownUrl,
        b64: bufToB64(buf),
        mime,
        cd,
        fileTail: fileName,
        filename: extractFilenameFromCD(cd) || fileName,
        setContentsId: setContentsIdFromTop() ?? u.searchParams.get("contents_id") ?? undefined,
        fidOverride: fid
      })
    } catch {
      // 添付1個の失敗は握りつぶす
    }
  }
}

/**
 * 拡張リロード後等に子フレームへのcontent script注入が漏れることがあるため、
 * 注入されている側のフレーム (main/pdfViewer等) から、同一オリジンの子フレーム
 * document を直接走査して添付リンクを収集する。
 */
function collectAttachmentsFromFrames(): Array<{ href: string; fid: string; fileName: string }> {
  const out: Array<{ href: string; fid: string; fileName: string }> = []
  const seen = new Set<string>()
  const scan = (doc: Document, base: string) => {
    for (const a of doc.querySelectorAll<HTMLAnchorElement>(
      'a[href*="file_down.php?"][href*="target_type=attach"]'
    )) {
      const href = a.getAttribute("href")
      if (!href) {
        continue
      }
      try {
        const u = new URL(href, base)
        const fileHash = u.searchParams.get("file") ?? ""
        const contentsId = u.searchParams.get("contents_id") ?? ""
        const key = u.href
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        out.push({
          href: u.href,
          fid: `attach:${contentsId}:${fileHash}`,
          fileName: u.searchParams.get("file_name") ?? "添付資料.pdf"
        })
      } catch {
        // ignore
      }
    }
  }
  scan(document, location.href)
  try {
    for (let i = 0; i < window.frames.length; i++) {
      try {
        const w = window.frames[i]
        scan(w.document, w.location.href)
      } catch {
        // クロスオリジンフレームは読めない (同一オリジン前提のLMSでは起きない)
      }
    }
  } catch {
    // ignore
  }
  return out
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

// ---------------------------------------------------------------
// toast (background → このフレームに通知を表示)
// ---------------------------------------------------------------
function toast(text: string, ok: boolean): void {
  try {
    const id = "lms-saver-toast"
    let el = document.getElementById(id)
    if (!el) {
      el = document.createElement("div")
      el.id = id
      el.style.cssText = [
        "position:fixed",
        "bottom:16px",
        "right:16px",
        "z-index:2147483647",
        "padding:8px 14px",
        "border-radius:8px",
        "font:13px -apple-system, sans-serif",
        "color:#fff",
        "box-shadow:0 4px 12px rgba(0,0,0,.25)",
        "transition:opacity .3s"
      ].join(";")
      document.body.appendChild(el)
    }
    el.style.background = ok ? "rgba(22,101,52,.92)" : "rgba(153,27,27,.92)"
    el.textContent = text
    el.style.opacity = "1"
    setTimeout(() => {
      el!.style.opacity = "0"
    }, 2600)
  } catch {
    // ignore
  }
}

async function maybeCapture(page: PageType): Promise<void> {
  try {
    const d = await chrome.storage.local.get("captureMode")
    if (!d.captureMode) {
      return
    }
    const html = document.documentElement.outerHTML.slice(0, 500_000)
    send({ type: "CAPTURE", page, url: location.href, html })
  } catch {
    // ignore
  }
}

const scanned = new Set<string>()

function scanAndReport(): void {
  // 一覧ページでは「リンクの地図」を報告するだけ (取得はしない)
  let items = extractMaterials()
  if (items.length === 0) {
    items = itemsFromHtml()
  }
  const fresh = items.filter((i) => !scanned.has(i.url))
  if (fresh.length === 0) {
    return
  }
  for (const i of fresh) {
    scanned.add(i.url)
  }
  send({ type: "MATERIALS", url: location.href, items: fresh, courseName: getCourseName() })
}

/**
 * コーストップから課題・レポート・小テスト等の「締め切り付きコンテンツ」を検出し
 * Google Tasksへの登録候補として送る。
 *
 * 実LMS構造 (CDP解析より):
 *   section.panel.cl-contentsList_folder
 *     ├ .panel-heading: 「第N回」または「お知らせ」等
 *     └ .cl-contentsList_content
 *         ├ .cm-contentsList_contentName: コンテンツ名
 *         ├ .cl-contentsList_categoryLabel: 資料/レポート/試験/レポート(成績非公開)等
 *         └ .cm-contentsList_contentDetailListItem
 *             ├ [0] 「利用可能期間」
 *             └ [1] 「2026/06/18 12:00 - 2026/07/09 10:30」 (終了=閲覧/提出期限)
 *
 * 利用可能期間は資料にも付く (閲覧期限)。課題/レポート/試験だけでなく
 * 期間付き資料も同じ扱いでタスク化する (終了日時 = 締め切り)。
 */
function extractAssignments(): Array<{
  contentsId: string
  title: string
  category: string
  url: string
  courseName?: string
  session?: string
  /** 「YYYY/MM/DD HH:MM - YYYY/MM/DD HH:MM」 */
  dueText?: string
  /** 終了日時のISO文字列 (解析成功時) */
  due?: string | null
}> {
  const out: Array<{
    contentsId: string
    title: string
    category: string
    url: string
    courseName?: string
    session?: string
    dueText?: string
    due?: string | null
  }> = []
  const seen = new Set<string>()
  const courseName = getCourseName()
  for (const panel of document.querySelectorAll("section.panel")) {
    const session =
      panel.querySelector(".panel-heading")?.textContent?.trim() || undefined
    for (const block of panel.querySelectorAll(".cl-contentsList_content")) {
      const name =
        block.querySelector(".cm-contentsList_contentName")?.textContent?.trim() || ""
      const category =
        block.querySelector(".cl-contentsList_categoryLabel")?.textContent?.trim() || ""
      const link = block.querySelector('a[href*="do_contents.php"]')
      if (!name || !link) {
        continue
      }
      const href = link.getAttribute("href") ?? ""
      const m = /[?&]set_contents_id=([a-f0-9]+)/.exec(href)
      const contentsId = m ? m[1] : href
      if (seen.has(contentsId)) {
        continue
      }
      seen.add(contentsId)
      // 利用可能期間の抽出
      let dueText: string | undefined
      let due: string | null = null
      for (const item of block.querySelectorAll(".cm-contentsList_contentDetailListItem")) {
        const ch = [...item.children].map(c => c.textContent?.trim() ?? "")
        if (ch[0] === "利用可能期間" && ch[1]) {
          dueText = ch[1]
          // 「YYYY/MM/DD HH:MM - YYYY/MM/DD HH:MM」の終了側をISOに変換
          // (タイムゾーン: LMS表示はJST。+09:00を明示してからUTCのISOにする)
          const pm = ch[1].match(
            /(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*-\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/
          )
          if (pm) {
            const [, , , , , , y2, mo2, d2, h2, mi2] = pm
            due = new Date(
              `${y2}-${mo2.padStart(2, "0")}-${d2.padStart(2, "0")}T` +
              `${h2.padStart(2, "0")}:${mi2.padStart(2, "0")}:00+09:00`
            ).toISOString()
          }
          break
        }
      }
      if (!dueText) {
        continue // 期間設定の無いものは対象外
      }
      out.push({
        contentsId,
        title: name,
        category,
        url: new URL(href, location.origin).href,
        courseName,
        session,
        dueText,
        due
      })
    }
  }
  return out
}

function reportAssignments(): void {
  const items = extractAssignments()
  if (items.length === 0) {
    return
  }
  send({
    type: "ASSIGNMENTS",
    url: location.href,
    items,
    courseName: getCourseName()
  } as any)
}

async function main(): Promise<void> {
  chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type === "TOAST") {
      toast(msg.text ?? "", !!msg.ok)
      sendResponse({ ok: true })
      return
    }
    return
  })

  const page = detectPage()
  if (!page) {
    return
  }

  send({
    type: "PAGE_INFO",
    page,
    url: location.href,
    courseName: getCourseName()
  })
  void maybeCapture(page)

  // 一覧ページ: リンク地図の登録のみ
  scanAndReport()
  setTimeout(scanAndReport, 2000)
  setTimeout(scanAndReport, 6000)

  // コーストップ: 課題・レポート等の締め切り付きコンテンツ検出
  if (page === "course") {
    reportAssignments()
    setTimeout(reportAssignments, 2500)
  }

  // 資料ページ自身: 開いたページだけを保存
  void saveThisPage(page)
}

void main()
