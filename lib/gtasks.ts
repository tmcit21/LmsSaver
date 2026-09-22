/**
 * Google Tasks 連携 (lms-saver)
 *
 * 認証: chrome.identity.getAuthToken (Chromeアカウントベース)
 *  - manifest oauth2.scopes: tasks API
 *  - 個人@gmail.comアカウントで動作
 *
 * 重複防止: dedupeKey (course + contentsId) のFNV-1aハッシュを chrome.storage.local
 * の gtaskSynced に記録し、同一ハッシュはスキップ。
 * 競合対策: pushTasks内はセマフォで直列化し、実行前にstorageから最新のsynced setを
 * 再取得する (content scriptからの複数回送信・SW再起動でも二重登録しない)。
 */

import { storageGet, storageSet, storageRemove } from "~lib/storage"
import {
  getGoogleAccessToken,
  isFirefox,
  extensionId
} from "~lib/auth"

const TASKS_API = "https://tasks.googleapis.com/tasks/v1"

/** lms-saver専用タスクリストのタイトル */
const TASK_LIST_TITLE = "WebClass課題"

let cachedToken: string | null = null
let cachedTokenExp = 0

async function getAuthToken(interactive = false): Promise<string> {
  if (cachedToken && Date.now() < cachedTokenExp) {
    return cachedToken
  }
  const SCOPES = [
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
  const { accessToken, expiresInSec } = await getGoogleAccessToken(
    interactive,
    SCOPES
  )
  cachedToken = accessToken
  cachedTokenExp = Date.now() + Math.min(expiresInSec - 300, 50 * 60) * 1000
  return accessToken
}

export function extensionInfo(): { browser: "chrome" | "firefox"; id: string } {
  return { browser: isFirefox() ? "firefox" : "chrome", id: extensionId() }
}

export async function ensureAuth(): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const token = await getAuthToken(true)
    // ユーザー確認用に email を取得
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) {
      return { ok: true } // email取得失敗してもタスク登録は可能
    }
    const info = (await res.json()) as { email?: string }
    return { ok: true, email: info.email }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

export async function signOutGoogle(): Promise<void> {
  try {
    await getAuthToken(false)
  } catch {
    // トークン無しでもクリアする
  }
  if (!isFirefox()) {
    await new Promise<void>((resolve) => {
      chrome.identity.clearAllCachedAuthTokens(() => resolve())
    })
  }
  cachedToken = null
  cachedTokenExp = 0
  await storageRemove(["gtaskSynced"])
}

export interface TaskDraft {
  /** 一意なキー (courseId + contentsId + dueなどから生成) */
  dedupeKey: string
  title: string
  /** RFC3339 (例: 2026-07-22T23:59:00+09:00)。nullなら期限なし */
  due?: string | null
  notes?: string
  /** WebClassのURL (notesに入れる) */
  url?: string
}

function taskKeyHash(key: string): string {
  // 簡易ハッシュ (SHA-256の代わりにFNV-1a)
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0") + key.length.toString(16)
}

async function getSyncedSet(): Promise<Set<string>> {
  const d = await storageGet<{ gtaskSynced?: string[] }>("gtaskSynced")
  const arr: string[] = Array.isArray(d.gtaskSynced) ? d.gtaskSynced : []
  return new Set(arr)
}

async function markSynced(hash: string): Promise<void> {
  const set = await getSyncedSet()
  set.add(hash)
  // 直近500件に制限
  const arr = Array.from(set).slice(-500)
  await storageSet({ gtaskSynced: arr })
}

async function getDefaultTaskList(token: string): Promise<string> {
  // 専用リスト「WebClass課題」を探す (無ければ作成)
  const res = await fetch(`${TASKS_API}/users/@me/lists?maxResults=100`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (res.ok) {
    const data = (await res.json()) as { items?: Array<{ id: string; title: string }> }
    const found = data.items?.find(l => l.title === TASK_LIST_TITLE)
    if (found) {
      return found.id
    }
  }
  // 無ければ作成
  const create = await fetch(`${TASKS_API}/users/@me/lists`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ title: TASK_LIST_TITLE })
  })
  if (!create.ok) {
    throw new Error(`tasklist create failed: ${create.status}`)
  }
  const list = (await create.json()) as { id: string }
  return list.id
}

/**
 * pushTasksの直列化セマフォ。
 * content scriptは同じコーストップで複数回 (0s/2.5s後等) ASSIGNMENTSを送ってくる。
 * 1回目のAPI登録が完了する前に2回目がsynced setを読むと、markSynced前の参照が
 * 同じハッシュを通過して二重登録になるため、全体を直列化する。
 */
let pushQueue: Promise<unknown> = Promise.resolve()

export async function pushTasks(drafts: TaskDraft[]): Promise<{
  added: number
  skipped: number
  errors: string[]
}> {
  const run = pushQueue.then(() => pushTasksInner(drafts))
  // 失敗してもキューは継続させる
  pushQueue = run.catch(() => undefined)
  return run
}

async function pushTasksInner(drafts: TaskDraft[]): Promise<{
  added: number
  skipped: number
  errors: string[]
}> {
  const errors: string[] = []
  let added = 0
  let skipped = 0
  if (drafts.length === 0) {
    return { added, skipped, errors }
  }
  let token: string
  try {
    token = await getAuthToken(false)
  } catch (e: any) {
    // 対話的ログインが必要
    try {
      token = await getAuthToken(true)
    } catch (e2: any) {
      return { added: 0, skipped: 0, errors: [`auth: ${e2?.message ?? e2}`] }
    }
  }
  let listId: string
  try {
    listId = await getDefaultTaskList(token)
  } catch (e: any) {
    return { added: 0, skipped: 0, errors: [`tasklist: ${e?.message ?? e}`] }
  }
  // 実行直前に最新のsynced setを取得 (並列実行は起きないがSW再起動対策)
  const synced = await getSyncedSet()
  for (const draft of drafts) {
    const hash = taskKeyHash(draft.dedupeKey)
    if (synced.has(hash)) {
      skipped++
      continue
    }
    const body: Record<string, unknown> = {
      title: draft.title,
      notes: draft.notes ?? (draft.url ? `URL: ${draft.url}` : undefined)
    }
    if (draft.due) {
      body.due = draft.due
    }
    try {
      const res = await fetch(`${TASKS_API}/lists/${listId}/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        const text = await res.text()
        errors.push(`${draft.title}: HTTP ${res.status} ${text.slice(0, 80)}`)
        continue
      }
      await markSynced(hash)
      added++
    } catch (e: any) {
      errors.push(`${draft.title}: ${e?.message ?? e}`)
    }
  }
  return { added, skipped, errors }
}
