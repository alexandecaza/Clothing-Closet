"""Local preview server for the Clothing Closet.

    python dev/server.py            Demo mode: fake sample data, nothing online is touched.
    python dev/server.py --real     Uses js/config.js as-is: your local test database if
                                    LOCAL_TEST is filled in there, otherwise the LIVE one.
    python dev/server.py --port 9000

Then open http://localhost:8765 (catalog) and http://localhost:8765/admin/ (admin).
Sends the same security headers as the live site (from _headers), so problems
they'd cause show up here first. Stop it with Ctrl+C.
"""

import argparse
import http.server
import os
import re
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEV = os.path.join(ROOT, 'dev')
UPLOADS = os.path.join(DEV, '.demo-uploads')

PHOTO_PREFIX = '/mock/storage/v1/object/public/item-photos/'
UPLOAD_PREFIX = '/mock-storage/'

DEMO_CONFIG = b"""// Demo mode config, served by dev/server.py in place of js/config.js.
export const SUPABASE_URL = location.origin + '/mock';
export const SUPABASE_ANON_KEY = 'demo';
export const TURNSTILE_SITE_KEY = '1x00000000000000000000AA'; // Cloudflare test key: always passes
export const USING_LIVE_DATA_LOCALLY = false;
export const DEMO_MODE = true;
"""

PLACEHOLDER_COLORS = ['#b9c7b0', '#d9c38f', '#a9bcc9', '#c9a9a0', '#b3b8d4']


def read_headers_file():
    """Parse the '/*' block of _headers into a list of (name, value)."""
    headers, in_block = [], False
    try:
        with open(os.path.join(ROOT, '_headers'), encoding='utf-8') as f:
            for line in f:
                if not line.strip() or line.lstrip().startswith('#'):
                    continue
                if not line[0].isspace():
                    in_block = line.strip() == '/*'
                    continue
                if in_block and ':' in line:
                    name, value = line.strip().split(':', 1)
                    headers.append((name.strip(), value.strip()))
    except FileNotFoundError:
        pass
    return headers


def placeholder_svg(path):
    color = PLACEHOLDER_COLORS[zlib.crc32(path.encode()) % len(PLACEHOLDER_COLORS)]
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500">'
        f'<rect width="400" height="500" fill="{color}"/>'
        '<path d="M200 150c-20 0-30 14-30 28h14c0-8 6-14 16-14s16 6 16 14c0 10-16 14-16 30'
        'l-110 70c-10 6-6 20 6 20h208c12 0 16-14 6-20l-104-66" fill="none" stroke="#2b3a31" '
        'stroke-width="8" stroke-linejoin="round"/></svg>'
    ).encode()


def make_handler(demo, site_headers):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=ROOT, **kwargs)

        def end_headers(self):
            for name, value in site_headers:
                self.send_header(name, value)
            self.send_header('Cache-Control', 'no-store')  # always see your latest edits
            super().end_headers()

        def send_body(self, body, content_type):
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def safe_upload_path(self, rel):
            full = os.path.abspath(os.path.join(UPLOADS, rel))
            return full if full.startswith(os.path.abspath(UPLOADS) + os.sep) else None

        def do_GET(self):
            path = self.path.split('?')[0].split('#')[0]
            if path.startswith('/dev/'):
                return self.send_error(404)
            if demo:
                if path == '/js/config.js':
                    return self.send_body(DEMO_CONFIG, 'text/javascript')
                if path == '/js/supabase-client.js':
                    with open(os.path.join(DEV, 'mock-supabase.js'), 'rb') as f:
                        return self.send_body(f.read(), 'text/javascript')
                if path.startswith(PHOTO_PREFIX):
                    rel = path[len(PHOTO_PREFIX):]
                    full = self.safe_upload_path(rel)
                    if full and os.path.isfile(full):
                        with open(full, 'rb') as f:
                            return self.send_body(f.read(), 'image/jpeg')
                    return self.send_body(placeholder_svg(rel), 'image/svg+xml')
            return super().do_GET()

        def do_PUT(self):
            path = self.path.split('?')[0]
            full = self.safe_upload_path(path[len(UPLOAD_PREFIX):]) if demo and path.startswith(UPLOAD_PREFIX) else None
            if not full:
                return self.send_error(404)
            length = int(self.headers.get('Content-Length', 0))
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'wb') as f:
                f.write(self.rfile.read(length))
            self.send_response(200)
            self.end_headers()

        def log_message(self, fmt, *args):
            if args and str(args[1]).startswith(('4', '5')):  # only show problems
                super().log_message(fmt, *args)

    return Handler


def main():
    parser = argparse.ArgumentParser(description='Local preview server for the Clothing Closet.')
    parser.add_argument('--real', action='store_true', help='use js/config.js instead of demo data')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()

    demo = not args.real
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(demo, read_headers_file()))
    url = f'http://localhost:{args.port}'
    print()
    if demo:
        print('  DEMO MODE: fake sample data, nothing online is touched.')
        print('  Coordinator sign-in: any email, password "demo", then code 123456.')
        print(f'  Fresh sample data: {url}/?reset-demo')
    else:
        print('  REAL MODE: using js/config.js (test database if LOCAL_TEST is filled in, otherwise LIVE).')
    print(f'\n  Catalog: {url}/')
    print(f'  Admin:   {url}/admin/')
    print('\n  Press Ctrl+C to stop.\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')


if __name__ == '__main__':
    main()
