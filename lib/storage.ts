/**
 * storage.local の互換ヘルパ。
 *
 * Firefoxの `chrome.*` 名前空間はPromiseを返さない (callbackのみ)。
 * `await chrome.storage.local.get(...)` は undefined になり、
 * 結果オブジェクトのプロパティアクセスで TypeError になる。
 * → コールバック形式をPromiseで包んで Chrome/Firefox 両対応にする。
 */

export function storageGet<T = Record<string, any>>(
  keys: string | string[] | null
): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys as any, (d: any) => resolve((d ?? {}) as T))
  })
}

export function storageSet(obj: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve())
  })
}

export function storageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys as any, () => resolve())
  })
}
