export type PageType =
  | "course"
  | "txtbk"
  | "mbl"
  | "qstn"
  | "loadit"
  | "show"
  | "do_contents"

export interface MaterialItem {
  url: string
  label: string
  sessionLabel?: string
}

/**
 * content → background
 * - MATERIALS: 資料リンクの「地図」登録のみ。取得は一切しない。
 * - CHECK_SAVED: 保存済みか問い合わせ (保存済みならfetchを避ける)
 * - SAVE_BLOB: 開いているページ自身がfetchした本文を保存依頼
 * - CAPTURE: デバッグ用HTML収集
 */
export type ContentToBackground =
  | {
      type: "PAGE_INFO"
      page: PageType
      url: string
      courseName?: string
      embeddedUrl?: string
    }
  | { type: "MATERIALS"; url: string; items: MaterialItem[]; courseName?: string }
  | {
      type: "CHECK_SAVED"
      url: string
      courseName?: string
      sessionLabel?: string
    }
  | {
      type: "SAVE_BLOB"
      url: string
      b64: string
      mime: string
      cd: string
      label?: string
      filename?: string
      courseName?: string
      sessionLabel?: string
      /** loadit.php?file=... のPDFパス末尾 (ファイル名候補) */
      fileTail?: string
      /** /webclass/data/course/<a>/<b>/... の数字セグメント候補 (shard/course id等) */
      courseIdCandidates?: string[]
      /** 候補の最後 (ディレクトリ照合用) */
      courseDir?: string
      /** 親framesetの file_id (一覧スキャン地図との照合キー)。実LMSは無い場合もある */
      fileId?: string
      /** 親フレームURLの set_contents_id (実LMS: 一覧スキャン地図のdo_contentsキー) */
      setContentsId?: string
      /** 添付資料用の安定fid (attach:<contents_id>:<filehash>) */
      fidOverride?: string
      /** 親framesetのURL (デバッグ用)。file= パラメータからPDFパスを逆引きするのに使う */
      topUrl?: string
    }
  | { type: "CAPTURE"; page: string; url: string; html: string }
  | {
      type: "ASSIGNMENTS"
      url: string
      courseName?: string
      items: Array<{
        contentsId: string
        title: string
        category: string
        url: string
        session?: string
        dueText?: string
        /** 終了日時のISO文字列 */
        due?: string | null
      }>
    }

/** background → content (フレームへトースト表示させる) */
export type BackgroundToContent = { type: "TOAST"; text: string; ok: boolean }

export type PopupToBackground =
  | { type: "POPUP_STATUS" }
  | { type: "POPUP_PING" }
  | { type: "POPUP_REVEAL"; rel_path?: string }
  | { type: "POPUP_SET_ROOT"; root: string }
  | { type: "POPUP_SETTING"; key: "autoScan" | "skipExisting"; value: boolean }
  | { type: "POPUP_CAPTURE"; value: boolean }
  | { type: "POPUP_CLEAR_LOG" }
  | { type: "POPUP_GTASK_AUTH" }
  | { type: "POPUP_GTASK_SIGNOUT" }
  | { type: "POPUP_GTASK_REDIRECT_URI" }
  | { type: "POPUP_GTASK_SET_CLIENT_ID"; clientId: string }

export type ToBackground = ContentToBackground | PopupToBackground
