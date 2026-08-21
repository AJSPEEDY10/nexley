"""Nexley — local dev server.

Serves the app over http so IndexedDB, the service worker and PWA install all work
(none of them work reliably from a file:// URL).

Sends no-cache headers on every response, so an edit to any file shows up on the next
refresh. Combined with the network-first service worker, that means the app is never
serving you a stale build while you're working on it.

Threaded on purpose: the browser opens several connections at once (html, css, js,
manifest, icons, plus the service worker's own fetches). A single-threaded server
handles those one at a time and visibly stalls.

Run:  python serve.py                 (or just double-click Summit.bat)
      python serve.py --no-browser    (don't auto-open a tab)
"""

import http.server
import os
import socket
import sys
import threading
import webbrowser

PORT = 8770
# 0.0.0.0 so an iPad on the same Wi-Fi can reach it — this app is aimed at tablets and
# pen-capable machines, so it has to be openable from a device that isn't this PC.
HOST = "0.0.0.0"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")


def lan_ip() -> str:
    """Best guess at this machine's address on the local network."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.4)
            s.connect(("10.255.255.255", 1))  # no packets sent; just picks the route
            return s.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


class Handler(http.server.SimpleHTTPRequestHandler):
    # keep-alive so the browser isn't reopening a socket per asset
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # never let the browser cache anything while we're building
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # let the service worker control the whole scope
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt, *args):
        # keep the console quiet; real errors still surface through log_error
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex((host, port)) != 0


def main() -> int:
    open_browser = "--no-browser" not in sys.argv

    if not os.path.isdir(ROOT):
        print(f"Cannot find the app folder: {ROOT}", flush=True)
        return 1

    url = f"http://127.0.0.1:{PORT}/index.html"
    tablet_url = f"http://{lan_ip()}:{PORT}/index.html"

    if not port_free("127.0.0.1", PORT):
        # already running — just point at it rather than failing
        print(f"Nexley is already running at {url}", flush=True)
        if open_browser:
            webbrowser.open(url)
        return 0

    with Server((HOST, PORT), Handler) as httpd:
        print("=" * 62, flush=True)
        print("  Nexley", flush=True)
        print("", flush=True)
        print(f"  On this PC     {url}", flush=True)
        print(f"  On your iPad   {tablet_url}", flush=True)
        print("", flush=True)
        print("  iPad: open that address in Safari, then Share > Add to Home Screen.", flush=True)
        print("  Both devices must be on the same Wi-Fi.", flush=True)
        print("", flush=True)
        print("  Your data stays on each device. Nothing is uploaded anywhere.", flush=True)
        print("  Close this window to stop the app.", flush=True)
        print("=" * 62, flush=True)
        if open_browser:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
