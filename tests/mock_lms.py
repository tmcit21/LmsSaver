#!/opt/homebrew/bin/python3.12
"""金沢大学WebClass風モックLMSサーバー (stdlibのみ)。

拡張機能のE2Eテスト用。http://localhost:8765/webclass/course.php?course_id=999
に、実LMSと同じURLパターンで擬似資料を配置する。認証はダミーCookie。

実LMS v0.2調査で判明した構造を再現:
- loadit.php?file_id=N → frameset (3層: providePDF / pdfViewer)
- pdfViewerフレーム内に var DEFAULT_URL = '/webclass/data/course/...pdf'
- PDF本体は /webclass/data/... から配信
"""
from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

COURSE_HTML = """<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<title>テスト授業A - WebClass</title></head>
<body>
<div class="header">WebClass</div>
<div class="course-name">テスト授業A（前期・情報基礎）</div>
<div class="container">
  <div class="tab-content">
    <section id="week1"><h3>第1回 ガイダンス</h3>
      <a class="material" href="loadit.php?lang=JAPANESE&file=%2Fwebclass%2Fdata%2Fcourse%2F26%2F26035511005000%2F859b44c39f95cf9f4808d0d7f41682f2%2F4808d0d7f41682f2.pdf">第1回 講義資料（スライド）</a>
      <a class="material" href="mbl.php?content_id=201">第1回 説明テキスト</a>
    </section>
    <section id="week2"><h3>第2回 基礎理論</h3>
      <a class="material" href="loadit.php?lang=JAPANESE&file=%2Fwebclass%2Fdata%2Fcourse%2F26%2F26035511005000%2F8e24e7224160cc7cc7a98908998aa52c%2F561920393f2b7206.pdf">第2回 演習問題.pdf</a>
      <a class="material" href="loadit.php?lang=JAPANESE&file=%2Fwebclass%2Fdata%2Fcourse%2F26%2F26035511005000%2F8e9999888877776666555544443333222%2Fd1111111111111.pdf">配布資料・第2回分</a>
    </section>
    <section id="week3"><h3>おまけ</h3>
      <a class="material" href="loadit.php?lang=JAPANESE&file=%2Fwebclass%2Fdata%2Fcourse%2F26%2F26035511005000%2F8e7777666655554444333322221111000%2Fe2222222222222.pdf">第1回補足資料（再掲）</a>
    </section>
  </div>
</div>
</body></html>"""

TXTBK_HTML = COURSE_HTML

MBL_HTML = """<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>教材 - WebClass</title></head>
<body><div class="ui-content">
  <p>第1回 説明テキストの本文です。</p>
</div></body></html>"""

# file_id → (PDF bytes, shard, course_dir, name)
# 実LMS構造: /webclass/data/course/<shard>/<courseDir>/<hashDir>/<hash>.pdf
#  - frameset URL は file_id を持たず file=<PDF path> のみ
#  - 一覧リンクは loadit.php?lang=JAPANESE&file=<PDF path> 形式
PDF_FILES = {
    "101": (b"%PDF-1.4 fake pdf slide for week 1 " + b"A" * 2000,
            "26", "26035511005000", "859b44c39f95cf9f4808d0d7f41682f2",
            "4808d0d7f41682f2.pdf"),
    "102": (b"%PDF-1.4 fake pdf exercise week 2 " + b"B" * 1500,
            "26", "26035511005000", "8e24e7224160cc7cc7a98908998aa52c",
            "561920393f2b7206.pdf"),
    "103": (b"%PDF-1.4 handout week2 " + b"C" * 900,
            "26", "26035511005000", "8e9999888877776666555544443333222",
            "d1111111111111.pdf"),
    "104": (b"%PDF-1.4 supplement " + b"D" * 400,
            "26", "26035511005000", "8e7777666655554444333322221111000",
            "e2222222222222.pdf"),
}

# PDFパス → bytes (直接 /webclass/data/... アクセス用)
PDF_BY_PATH: dict[str, tuple[bytes, str]] = {}
for fid, (body, shard, cdir, hdir, name) in PDF_FILES.items():
    PDF_BY_PATH[f"/webclass/data/course/{shard}/{cdir}/{hdir}/{name}"] = (body, name)


def frameset_html(fid: str) -> str:
    # 実LMS同様、framesetには file_id 無し。file=<PDF path> のみ。
    body, shard, cdir, hdir, name = PDF_FILES[fid]
    pdf = quote(f"/webclass/data/course/{shard}/{cdir}/{hdir}/{name}", safe="")
    return f"""<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN" "http://www.w3.org/TR/html4/frameset.dtd">
<html>
<head></head>
<frameset frameborder="0" border="0" framespacing="0" rows="40,*">
  <frame src="/webclass/loadit.php?action=providePDF&amp;file={pdf}&amp;lang=JAPANESE">
  <frame src="/webclass/loadit.php?action=pdfViewer&amp;file={pdf}&amp;lang=JAPANESE" noresize>
</frameset>
</html>"""


def frameset_html_by_path(file_param: str) -> str:
    # file_param はエンコードされたPDFパス。そのまま各フレームに渡す
    pdf = quote(file_param, safe="")
    return f"""<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN" "http://www.w3.org/TR/html4/frameset.dtd">
<html>
<head></head>
<frameset frameborder="0" border="0" framespacing="0" rows="40,*">
  <frame src="/webclass/loadit.php?action=providePDF&amp;file={pdf}&amp;lang=JAPANESE">
  <frame src="/webclass/loadit.php?action=pdfViewer&amp;file={pdf}&amp;lang=JAPANESE" noresize>
</frameset>
</html>"""


def provide_pdf_html(pdf_path: str) -> str:
    return f"""<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
<html>
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta http-equiv="Content-Style-Type" content="text/css">
  <meta http-equiv="Content-Script-Type" content="text/javascript">
<style type="text/css">
body {{
    padding: 0;
    margin: 0;
    text-align:center;
    padding-top: 5px;
    padding-bottom: 5px;
    font-size: 11pt;
    background-color: #eeeeee;
    color: #333333;
}}
</style>
</head>
<body>
表示に問題があるときは <a href="{pdf_path}" target="_blank">別ウインドウ</a>
で開いてください。</body>
</html>"""


def pdf_viewer_html(pdf_path: str) -> str:
    # 実LMSのpdf.jsビューアを模倣: DEFAULT_URL に実PDFパスを持つ
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>PDF.js viewer</title>
<link rel="resource" type="application/l10n" href="/webclass/js/pdf.js/web/locale/locale.json" />
<script src="/webclass/js/pdf.js/core/pdf.mjs" type="module"></script>
</head>
<body>
<div id="viewerContainer">
  <div id="viewer" class="pdfViewer"></div>
</div>
<script>
        var DEFAULT_URL = '{pdf_path}';
        var TOP_URL = '/';
</script>
</body>
</html>"""


def data_pdf_headers(self, body: bytes, name: str) -> None:
    # 実LMS同様、PDF本体は Content-Disposition 無しで返す
    self.send_response(200)
    self.send_header("Content-Type", "application/pdf")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[mock-lms] %s\n" % (fmt % args))

    def _html(self, body: str) -> None:
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _bytes(self, body: bytes, mime: str, name: str | None = None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", mime)
        if name:
            self.send_header("Content-Disposition", f'inline; filename="{name}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path
        if path.endswith("login.php"):
            self.send_response(302)
            self.send_header("Set-Cookie", "wc_session=dummy123; Path=/")
            self.send_header("Location", "/webclass/course.php?course_id=999")
            self.end_headers()
        elif path.endswith("course.php"):
            self._html(COURSE_HTML)
        elif path.endswith("txtbk_frame.php"):
            self._html(TXTBK_HTML)
        elif path.endswith("mbl.php"):
            self._html(MBL_HTML)
        elif path.endswith("loadit.php"):
            action = (q.get("action") or [""])[0]
            file_param = (q.get("file") or [""])[0]
            if not action and file_param:
                # 一覧リンク → frameset (実LMS同様 file_id は持たない)
                self._html(frameset_html_by_path(file_param))
            elif action == "providePDF":
                self._html(provide_pdf_html(file_param))
            elif action == "pdfViewer":
                self._html(pdf_viewer_html(file_param))
            else:
                self._html("<html><body>unknown loadit</body></html>")
        elif path.startswith("/webclass/data/"):
            hit = PDF_BY_PATH.get(path)
            if hit:
                self._bytes(hit[0], "application/pdf", hit[1])
            else:
                self.send_response(404)
                self.end_headers()
        else:
            self._html("<html><body><h1>WebClass mock: unknown path "
                       + path + "</h1></body></html>")


if __name__ == "__main__":
    print(f"mock LMS on http://localhost:{PORT}/webclass/login.php")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
