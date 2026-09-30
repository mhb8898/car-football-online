"""Dev server: like `python3 -m http.server`, but tells the browser never to
cache, so an edited ES module is picked up on a plain reload."""
import http.server, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, *a):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
http.server.ThreadingHTTPServer(("", port), NoCache).serve_forever()
