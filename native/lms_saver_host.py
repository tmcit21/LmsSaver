#!/opt/homebrew/bin/python3.12
"""LMS Saver Native Messaging host.

Chrome/Edge 拡張 (lms-saver) と stdio で通信し、LMS資料を
  <root>/<授業名>/<第N回>/<ファイル名>
に保存する。設定は ~/.lms_saver/config.json。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import unquote

CONFIG_DIR = Path.home() / ".lms_saver"
CONFIG_PATH = CONFIG_DIR / "config.json"
LEDGER_PATH = CONFIG_DIR / "ledger.json"
CAPTURE_DIR = CONFIG_DIR / "captures"
DEFAULT_ROOT = str(Path.home() / "Documents" / "WebClass資料")

BAD_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def log(msg: str) -> None:
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_DIR / "host.log", "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except Exception:
        pass


def send(obj: dict) -> None:
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def read_message() -> dict | None:
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    if length == 0 or length > 64 * 1024 * 1024:
        return None
    data = sys.stdin.buffer.read(length)
    if len(data) < length:
        return None
    return json.loads(data.decode("utf-8"))


class Config:
    def __init__(self) -> None:
        self.root = DEFAULT_ROOT
        self.load()

    def load(self) -> None:
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            root = cfg.get("root")
            if isinstance(root, str) and root:
                self.root = os.path.abspath(os.path.expanduser(root))
        except FileNotFoundError:
            pass
        except Exception as e:
            log(f"config load error: {e}")

    def save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps({"root": self.root}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def sanitize(name: str) -> str:
    name = BAD_CHARS.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip()
    name = name.strip(". ")
    return name[:180]


def safe_subdir(name: str) -> str:
    """LMS由来の文字列を1段の安全なフォルダ名にする。"""
    return sanitize(name) or "不明"


def parse_session(label: str | None) -> str:
    """'第N回' を抽出。無ければ 'その他'。"""
    if not label:
        return "その他"
    m = re.search(
        r"第\s*([0-9０-９一二三四五六七八九十百]+)\s*(?:回|講|週)", label
    )
    if not m:
        return "その他"
    n = m.group(1)
    table = str.maketrans("０１２３４５６７８９", "0123456789")
    n = n.translate(table)
    if re.fullmatch(r"[0-9]+", n):
        return f"第{int(n):02d}回"
    return f"第{n}回"


def file_hash(b64: str) -> str:
    return hashlib.sha256(b64.encode("ascii")).hexdigest()[:16]


def load_ledger() -> dict:
    try:
        d = json.loads(LEDGER_PATH.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:
        log(f"ledger load error: {e}")
        return {}


def save_ledger(ledger: dict) -> None:
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        LEDGER_PATH.write_text(
            json.dumps(ledger, ensure_ascii=False, indent=1), encoding="utf-8"
        )
    except Exception as e:
        log(f"ledger save error: {e}")


def save_file(cfg: Config, params: dict) -> dict:
    fid = str(params.get("fid", ""))
    course = sanitize(str(params.get("course_name", ""))) or "不明な授業"
    session = parse_session(params.get("session_label"))
    filename = sanitize(str(params.get("filename", ""))) or "資料"
    b64 = str(params.get("b64", ""))
    mime = str(params.get("mime", ""))

    data = base64.b64decode(b64) if b64 else b""
    if not data:
        return {"ok": False, "error": "empty file body"}

    dest_dir = Path(cfg.root) / safe_subdir(course) / session
    dest_dir.mkdir(parents=True, exist_ok=True)

    dest = dest_dir / filename
    if dest.exists():
        h = file_hash(b64)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = dest_dir / f"{dest.stem}_{h or stamp}{dest.suffix}"
        if dest.exists():
            i = 1
            while dest.exists():
                dest = dest_dir / f"{dest.stem}_{i}{dest.suffix}"
                i += 1

    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    # Windows: os.replace は同一ボリュームのみ。別ボリューム設定でも動くよう
    # 失敗時に copyfile へフォールバック
    try:
        os.replace(tmp, dest)
    except OSError:
        shutil.copyfile(tmp, dest)
        Path(tmp).unlink(missing_ok=True)
    # 台帳に登録 (fid -> 保存パス)。同名fidの再取得をスキップできるようにする
    ledger = load_ledger()
    ledger[fid] = {"rel_path": str(dest), "bytes": len(data),
                   "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
    save_ledger(ledger)
    log(f"saved: {dest} ({len(data)} bytes, {mime})")
    return {"ok": True, "rel_path": str(dest), "bytes": len(data)}


def check_exists(cfg: Config, params: dict) -> dict:
    fid = str(params.get("fid", ""))
    course = sanitize(str(params.get("course_name", ""))) or "不明な授業"
    session = parse_session(params.get("session_label"))
    ledger = load_ledger()
    entry = ledger.get(fid)
    if isinstance(entry, dict) and entry.get("rel_path"):
        p = Path(entry["rel_path"])
        if p.exists():
            return {"ok": True, "exists": True, "rel_path": entry["rel_path"]}
        # move/rename後: 台帳から落下 (次のsaveで再登録される)
    return {"ok": True, "exists": False, "rel_path": ""}


def get_root(cfg: Config, _params: dict) -> dict:
    return {"ok": True, "root": cfg.root}


def set_root(cfg: Config, params: dict) -> dict:
    root = str(params.get("root", "")).strip()
    if not root:
        return {"ok": False, "error": "root is empty"}
    root = os.path.abspath(os.path.expanduser(root))
    try:
        Path(root).mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return {"ok": False, "error": f"cannot create dir: {e}"}
    cfg.root = root
    cfg.save()
    return {"ok": True, "root": root}


def reveal(cfg: Config, params: dict) -> dict:
    rel = str(params.get("rel_path", ""))
    target = Path(rel) if rel and Path(rel).exists() else Path(cfg.root)
    try:
        target.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            # Windows: os.startfile がエクスプローラで開く
            os.startfile(str(target))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.run(["open", str(target)], check=False)
        else:
            subprocess.run(["xdg-open", str(target)], check=False)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def capture(cfg: Config, params: dict) -> dict:
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    url = str(params.get("url", ""))
    page = str(params.get("page", "page"))
    html = str(params.get("html", ""))
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", url.split("/")[-1] or "page")[:80]
    p = CAPTURE_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}_{page}_{name}.html"
    p.write_text(html, encoding="utf-8")
    log(f"capture: {p}")
    return {"ok": True, "rel_path": str(p)}


def adopt_download(cfg: Config, params: dict) -> dict:
    """ChromiumがDownloadsに落としたLMSファイルを <root>/<授業>/<第NN回>/ へ移動。"""
    tmp_path = str(params.get("tmp_path", ""))
    fid = str(params.get("fid", ""))
    course = sanitize(str(params.get("course_name", ""))) or "不明な授業"
    session = parse_session(params.get("session_label"))
    filename = sanitize(str(params.get("filename", ""))) or "資料"
    if not tmp_path or not Path(tmp_path).exists():
        return {"ok": False, "error": f"download not found: {tmp_path}"}

    dest_dir = Path(cfg.root) / safe_subdir(course) / session
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    if dest.exists():
        # 同一fidの再ダウンロード → 上書き。別fidならリネーム
        # 台帳キーはフルパスで比較するため (macOSとWindowsのパス区切り差異を吸収)
        dest_str = str(dest)
        ledger = load_ledger()
        if ledger.get(fid, {}).get("rel_path") != dest_str:
            h = hashlib.sha256(str(fid).encode()).hexdigest()[:8]
            dest = dest_dir / f"{dest.stem}_{h}{dest.suffix}"
            i = 1
            while dest.exists():
                dest = dest_dir / f"{dest.stem}_{h}_{i}{dest.suffix}"
                i += 1
    try:
        os.replace(tmp_path, dest)
    except Exception as e:
        # 別ボリューム等: copyで代替
        try:
            shutil.copyfile(tmp_path, dest)
            Path(tmp_path).unlink(missing_ok=True)
        except Exception as e2:
            return {"ok": False, "error": f"{e}; copy also failed: {e2}"}
    ledger = load_ledger()
    ledger[fid] = {"rel_path": str(dest), "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
    save_ledger(ledger)
    log(f"adopted: {dest}")
    return {"ok": True, "rel_path": str(dest), "bytes": dest.stat().st_size}


HANDLERS = {
    "ping": lambda cfg, p: {"ok": True, "pong": True, "version": "0.2.0"},
    "get_root": get_root,
    "set_root": set_root,
    "reveal": reveal,
    "save": save_file,
    "check_exists": check_exists,
    "adopt_download": adopt_download,
    "capture": capture,
}


def main() -> None:
    log(f"host started pid={os.getpid()} argv={sys.argv[1:]}")
    cfg = Config()
    lock = threading.Lock()
    while True:
        try:
            msg = read_message()
        except Exception as e:
            log(f"read error: {e}")
            break
        if msg is None:
            break
        mid = msg.get("id")
        method = str(msg.get("method", ""))
        params = msg.get("params") or {}
        handler = HANDLERS.get(method)
        with lock:
            if handler is None:
                send({"id": mid, "ok": False, "error": f"unknown method: {method}"})
            else:
                try:
                    resp = handler(cfg, params)
                except Exception as e:
                    log(f"handler error ({method}): {e}")
                    resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                resp["id"] = mid
                send(resp)
    log("host exit")


if __name__ == "__main__":
    main()
