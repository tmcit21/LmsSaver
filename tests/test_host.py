#!/opt/homebrew/bin/python3.12
"""lms_saver_host.py のE2Eテスト (Native Messagingフレーミング込み)。"""
from __future__ import annotations

import base64
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HOST = Path(__file__).resolve().parent.parent / "native" / "lms_saver_host.py"


def send(proc, obj: dict) -> None:
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    proc.stdin.write(struct.pack("<I", len(data)))
    proc.stdin.write(data)
    proc.stdin.flush()


def recv(proc) -> dict:
    raw = proc.stdout.read(4)
    assert len(raw) == 4, "host closed"
    (n,) = struct.unpack("<I", raw)
    return json.loads(proc.stdout.read(n).decode("utf-8"))


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="lms_saver_test_"))
    env_root = tmp / "保存先"
    proc = subprocess.Popen(
        ["/opt/homebrew/bin/python3.12", str(HOST)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env={"HOME": str(tmp), "PATH": "/usr/bin:/bin"},
    )
    failures: list[str] = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        print(("✅" if cond else "❌"), name, detail)
        if not cond:
            failures.append(name)

    # ping
    send(proc, {"id": 1, "method": "ping"})
    r = recv(proc)
    check("ping", r.get("ok") is True and r.get("pong") is True)

    # set_root
    send(proc, {"id": 2, "method": "set_root", "params": {"root": str(env_root)}})
    r = recv(proc)
    check("set_root", r.get("ok") is True and r["root"] == str(env_root))

    # get_root (config persist)
    send(proc, {"id": 3, "method": "get_root"})
    r = recv(proc)
    check("get_root", r.get("root") == str(env_root))

    # save: course + session label extraction
    pdf = base64.b64encode(b"%PDF-1.4 test").decode()
    send(proc, {
        "id": 4, "method": "save",
        "params": {
            "fid": "101", "course_name": "テスト授業A（前期・情報基礎）",
            "session_label": "第1回 ガイダンス",
            "filename": "第1回 講義資料（スライド）.pdf", "b64": pdf,
            "mime": "application/pdf",
        },
    })
    r = recv(proc)
    expected = env_root / "テスト授業A（前期・情報基礎）" / "第01回" / "第1回 講義資料（スライド）.pdf"
    check("save 第01回", r.get("ok") is True and Path(r["rel_path"]) == expected,
          f"-> {r.get('rel_path')}")
    check("save bytes", Path(r["rel_path"]).read_bytes() == b"%PDF-1.4 test")

    # ledger: same fid -> exists=true with the saved path
    send(proc, {
        "id": 13, "method": "check_exists",
        "params": {"fid": "101", "course_name": "テスト授業A（前期・情報基礎）",
                   "session_label": "第1回 ガイダンス"},
    })
    r = recv(proc)
    check("check_exists 台帳ヒット", r.get("exists") is True
          and r.get("rel_path") == str(expected), f"-> {r.get('rel_path')}")

    # save: no session label -> その他
    send(proc, {
        "id": 5, "method": "save",
        "params": {"fid": "x", "course_name": "テスト授業B", "session_label": "",
                   "filename": "メモ.txt", "b64": base64.b64encode(b"hello").decode(),
                   "mime": "text/plain"},
    })
    r = recv(proc)
    check("save その他", Path(r["rel_path"]) == env_root / "テスト授業B" / "その他" / "メモ.txt",
          f"-> {r.get('rel_path')}")

    # save: fullwidth session number
    send(proc, {
        "id": 6, "method": "save",
        "params": {"fid": "y", "course_name": "テスト授業B",
                   "session_label": "第１２回 まとめ", "filename": "資料.docx",
                   "b64": base64.b64encode(b"doc").decode(), "mime": "text/plain"},
    })
    r = recv(proc)
    check("save 第12回", Path(r["rel_path"]).parent.name == "第12回",
          f"-> {r.get('rel_path')}")

    # save: kanji session number
    send(proc, {
        "id": 7, "method": "save",
        "params": {"fid": "z", "course_name": "テスト授業B",
                   "session_label": "第三回 演習", "filename": "x.pdf",
                   "b64": base64.b64encode(b"kanji").decode(), "mime": "text/plain"},
    })
    r = recv(proc)
    check("save 第三回はそのまま", Path(r["rel_path"]).parent.name == "第三回",
          f"-> {r.get('rel_path')}")

    # save: same filename again -> dedup rename
    send(proc, {
        "id": 8, "method": "save",
        "params": {"fid": "101", "course_name": "テスト授業A（前期・情報基礎）",
                   "session_label": "第1回 ガイダンス",
                   "filename": "第1回 講義資料（スライド）.pdf",
                   "b64": base64.b64encode(b"DIFFERENT").decode(), "mime": "application/pdf"},
    })
    r = recv(proc)
    p2 = Path(r["rel_path"])
    check("重複リネーム", p2 != expected and p2.parent == expected.parent,
          f"-> {p2.name}")

    # save: unsafe filename sanitized
    send(proc, {
        "id": 9, "method": "save",
        "params": {"fid": "w", "course_name": '悪/意*的な?名前', "session_label": "",
                   "filename": 'a:b<c>|d".txt', "b64": base64.b64encode(b"s").decode(),
                   "mime": "text/plain"},
    })
    r = recv(proc)
    p3 = Path(r["rel_path"])
    check("無害化", r.get("ok") is True and "/" not in p3.parent.parent.name
          and p3.name.count(":") == 0, f"-> {p3}")

    # (ledger hit already checked right after the first save)

    # capture
    send(proc, {"id": 10, "method": "capture",
                "params": {"url": "http://x/course.php?course_id=999",
                           "page": "course", "html": "<html>x</html>"}})
    r = recv(proc)
    check("capture", r.get("ok") is True and Path(r["rel_path"]).exists())

    # unknown method
    send(proc, {"id": 11, "method": "nope"})
    r = recv(proc)
    check("unknown method", r.get("ok") is False and "unknown" in r.get("error", ""))

    proc.stdin.close()
    proc.wait(timeout=10)

    # config persisted
    cfg = json.loads((tmp / ".lms_saver" / "config.json").read_text(encoding="utf-8"))
    check("config永続化", cfg.get("root") == str(env_root))

    check("host exit code", proc.returncode == 0, f"rc={proc.returncode}")

    shutil.rmtree(tmp, ignore_errors=True)
    print()
    if failures:
        print(f"FAILED: {failures}")
        sys.exit(1)
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
