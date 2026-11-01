#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py - 极简纯 Python 原生 HTTP 微服务 (无任何三方依赖，极低内存消耗)
服务端口: 8090
"""

import os
import sys
import json
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn

# 引入本底层两大核心模块
from source_manager import source_hub
from song_search import search_candidates, get_song_lyric

PORT = 8090
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class SourceAppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path in ["/", "/index.html"]:
            self.path = "/index.html"
            return super().do_GET()

        if path == "/api/sources":
            ordered = source_hub.get_ordered_sources()
            data = [{
                "id": s.id, "name": s.name, "platform": s.platform,
                "status": s.status, "latency_ms": s.latency_ms,
                "consecutive_fails": s.consecutive_fails,
                "success_count": s.success_count
            } for s in ordered]
            self._send_json(data)
            return

        if path == "/api/search":
            qs = urllib.parse.parse_qs(parsed.query)
            q = qs.get("q", [""])[0]
            cands = search_candidates(q)
            self._send_json(cands)
            return

        if path == "/api/lyric":
            qs = urllib.parse.parse_qs(parsed.query)
            plat = qs.get("platform", ["kw"])[0]
            sid = qs.get("id", [""])[0]
            title = qs.get("title", [""])[0]
            artist = qs.get("artist", [""])[0]
            lines = get_song_lyric(plat, sid, title, artist)
            self._send_json(lines)
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8') if length > 0 else ""

        if path == "/api/sources/test":
            data = source_hub.test_all()
            self._send_json(data)
            return

        if path == "/api/sources/sync":
            source_hub.sync_from_lx_hub()
            data = source_hub.test_all()
            self._send_json(data)
            return

        if path == "/api/resolve":
            cand = json.loads(body) if body else {}
            res = source_hub.resolve_best_stream(cand)
            self._send_json(res)
            return

        self.send_error(404, "Not Found")

    def _send_json(self, data):
        blob = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(blob)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(blob)

    def log_message(self, format, *args):
        # 极简模式：静默或轻量记录
        pass

if __name__ == "__main__":
    import threading
    # 异步预热并发测速，零阻塞 HTTP 即时响应
    threading.Thread(target=source_hub.test_all, daemon=True).start()

    server = ThreadingHTTPServer(("0.0.0.0", PORT), SourceAppHandler)
    print(f"⚡ YY-Music 极简底层服务已启动: http://localhost:{PORT}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
