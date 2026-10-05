"""Run with Python 3.10+: python server.py. No third-party packages required."""
from collections import defaultdict, deque
from datetime import datetime
from functools import partial
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs, unquote, urlsplit
import argparse
import hashlib
import hmac
import json
import logging
from logging.handlers import RotatingFileHandler
import mimetypes
import os
import re
import secrets
import sqlite3
import time

from backend.assistant import Assistant
from backend.db import Database, SHANGHAI, now_iso, password_hash, password_matches
from backend.service import APIError, Service, integer, text

ROOT = Path(__file__).resolve().parent


def load_environment():
    env_file = ROOT / '.env'
    if env_file.exists():
        for line in env_file.read_text(encoding='utf-8-sig').splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            if re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
                os.environ.setdefault(key, value.strip().strip('"').strip("'"))


class Application:
    def __init__(self, db, web_root=None):
        self.db, self.web_root = db, Path(web_root or ROOT / 'web').resolve()
        self.service, self.limit_lock = Service(db), Lock()
        self.assistant = Assistant(self.service)
        self.limits = defaultdict(deque)
        self.dummy_hash = password_hash('not-a-real-user-' + secrets.token_hex(12))

    def limit(self, key, count=30, window=60):
        now = time.monotonic()
        with self.limit_lock:
            queue = self.limits[key]
            while queue and queue[0] < now - window:
                queue.popleft()
            if len(queue) >= count:
                raise APIError(429, '请求过于频繁，请稍后重试', 'rate_limited')
            queue.append(now)
            if len(self.limits) > 10000:
                for old_key in list(self.limits):
                    if not self.limits[old_key] or self.limits[old_key][-1] < now - window:
                        self.limits.pop(old_key, None)


class Handler(BaseHTTPRequestHandler):
    server_version = 'DragonboatGIS/1.0'

    def __init__(self, *args, app, **kwargs):
        self.app = app
        super().__init__(*args, **kwargs)

    def do_GET(self): self.dispatch()
    def do_POST(self): self.dispatch()
    def do_PATCH(self): self.dispatch()
    def do_DELETE(self): self.dispatch()

    def log_message(self, fmt, *args):
        logging.info('%s %s', self.client_address[0], fmt % args)

    def send_json(self, data, status=200, cookie=None):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        if self.headers.get_content_type() != 'application/json':
            raise APIError(415, '请求内容必须为 application/json')
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise APIError(400, '无效的请求长度') from None
        if length < 0 or length > 65536:
            raise APIError(413, '请求内容过大')
        try:
            obj = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, UnicodeDecodeError):
            raise APIError(400, '请求 JSON 格式无效') from None
        if not isinstance(obj, dict):
            raise APIError(400, '请求内容需要为 JSON 对象')
        return obj

    def session(self):
        jar = cookies.SimpleCookie()
        try:
            jar.load(self.headers.get('Cookie', ''))
            token = jar['dragonboat_session'].value if 'dragonboat_session' in jar else ''
        except cookies.CookieError:
            token = ''
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.app.db.connection() as con:
            row = con.execute('SELECT u.id,u.username,u.display_name,u.role,s.csrf_token,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?', (digest, int(time.time()))).fetchone()
        return dict(row) if row else None

    def require_user(self, admin=False, csrf=True):
        user = self.session()
        if not user:
            raise APIError(401, '请先登录', 'unauthorized')
        if admin and user['role'] != 'admin':
            raise APIError(403, '需要管理员权限', 'forbidden')
        if csrf and self.command != 'GET' and not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), user['csrf_token']):
            raise APIError(403, '请求校验失败，请刷新页面重试', 'csrf_failed')
        return user

    def user_response(self, user):
        if not user:
            return {'user': None, 'csrf_token': None}
        return {'user': {k: user[k] for k in ('id', 'username', 'display_name', 'role')}, 'csrf_token': user.get('csrf_token')}

    def new_session(self, user):
        old = self.session()
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with self.app.db.connection() as con:
            con.execute('DELETE FROM sessions WHERE expires_at<=?', (int(time.time()),))
            if old:
                con.execute('DELETE FROM sessions WHERE token_hash=?', (old['token_hash'],))
            con.execute('INSERT INTO sessions VALUES(?,?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), user['id'], csrf, int(time.time()) + 86400))
        secure = '; Secure' if os.environ.get('COOKIE_SECURE') == '1' else ''
        self.send_json(self.user_response({**user, 'csrf_token': csrf}), cookie=f'dragonboat_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400{secure}')

    def origin_check(self):
        if self.command == 'GET':
            return
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            raise APIError(403, '不允许跨站提交请求', 'origin_rejected')

    def dispatch(self):
        try:
            allowed_hosts = {h.strip().lower() for h in os.environ.get('APP_ALLOWED_HOSTS', 'localhost,127.0.0.1,::1').split(',') if h.strip()}
            try:
                host = urlsplit('http://' + self.headers.get('Host', '')).hostname
            except ValueError:
                host = None
            if not host or host.lower() not in allowed_hosts:
                raise APIError(403, '该访问域名未被允许', 'host_rejected')
            self.origin_check()
            self.route()
        except APIError as error:
            self.send_json({'error': {'code': error.code, 'message': error.message}}, error.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except sqlite3.IntegrityError:
            self.send_json({'error': {'code': 'conflict', 'message': '数据冲突，请检查关联数据或重试'}}, 409)
        except Exception:
            logging.exception('Unhandled request error')
            self.send_json({'error': {'code': 'internal_error', 'message': '服务暂时出错，请查看服务器日志'}}, 500)

    def route(self):
        parsed = urlsplit(self.path)
        path = parsed.path.rstrip('/') or '/'
        method = self.command
        query = {k: v[-1] for k, v in parse_qs(parsed.query).items()}
        service = self.app.service
        if path == '/api/health' and method == 'GET':
            with self.app.db.connection() as con:
                con.execute('SELECT 1').fetchone()
            return self.send_json({'status': 'ok', 'database': 'sqlite', 'time': now_iso()})
        if path == '/api/config' and method == 'GET':
            return self.send_json({'app_name': '舟行 · 龙舟赛事地图', 'today': datetime.now(SHANGHAI).date().isoformat(),
                'assistant_mode': 'llm' if all(os.environ.get(k) for k in ('LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL')) else 'local',
                'tile_url': os.environ.get('MAP_TILE_URL', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
                'tile_attribution': os.environ.get('MAP_TILE_ATTRIBUTION', '© OpenStreetMap contributors')})
        if path == '/api/auth/me' and method == 'GET':
            return self.send_json(self.user_response(self.session()))
        if path == '/api/auth/login' and method == 'POST':
            self.app.limit(('login', self.client_address[0]), 15)
            p = self.body()
            username, password = text(p.get('username'), '用户名', 32), text(p.get('password'), '密码', 128)
            with self.app.db.connection() as con:
                row = con.execute('SELECT * FROM users WHERE username=? COLLATE NOCASE', (username,)).fetchone()
            valid = password_matches(password, row['password_hash'] if row else self.app.dummy_hash)
            if not row or not valid:
                raise APIError(401, '用户名或密码不正确', 'invalid_credentials')
            return self.new_session(dict(row))
        if path == '/api/auth/register' and method == 'POST':
            self.app.limit(('register', self.client_address[0]), 5)
            p = self.body()
            username, password = text(p.get('username'), '用户名', 32, 3), text(p.get('password'), '密码', 128, 8)
            if not re.fullmatch(r'[A-Za-z0-9_]{3,32}', username):
                raise APIError(400, '用户名仅支持 3～32 位字母、数字和下划线')
            display = text(p.get('display_name'), '昵称', 40, 2)
            with self.app.db.connection() as con:
                if con.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone():
                    raise APIError(409, '用户名已存在', 'username_taken')
                uid = con.execute('INSERT INTO users(username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?)', (username, display, password_hash(password), 'user', now_iso())).lastrowid
                user = dict(con.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone())
            return self.new_session(user)
        if path == '/api/auth/logout' and method == 'POST':
            user = self.require_user()
            with self.app.db.connection() as con:
                con.execute('DELETE FROM sessions WHERE token_hash=?', (user['token_hash'],))
            return self.send_json({'ok': True}, cookie='dragonboat_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
        if path == '/api/venues' and method == 'GET':
            return self.send_json({'items': service.venues()})
        if path == '/api/rules' and method == 'GET':
            return self.send_json({'items': service.rules()})
        if path == '/api/events' and method == 'GET':
            user = self.session()
            return self.send_json(service.events(query, user['id'] if user else None))
        match = re.fullmatch(r'/api/events/(\d+)', path)
        if match and method == 'GET':
            user = self.session()
            return self.send_json(service.event(int(match[1]), user['id'] if user else None))
        match = re.fullmatch(r'/api/me/favorites/(\d+)', path)
        if match and method in ('POST', 'DELETE'):
            user = self.require_user()
            return self.send_json(service.favorite(user['id'], int(match[1]), method == 'POST'))
        if path == '/api/assistant/query' and method == 'POST':
            self.app.limit(('assistant', self.client_address[0]), 30)
            user = self.session()
            return self.send_json(self.app.assistant.ask(self.body(), user['id'] if user else None))
        if path == '/api/feedback' and method == 'POST':
            user = self.require_user()
            content = text(self.body().get('content'), '反馈内容', 2000, 5)
            with self.app.db.connection() as con:
                con.execute('INSERT INTO feedback(user_id,content,created_at) VALUES(?,?,?)', (user['id'], content, now_iso()))
            return self.send_json({'ok': True}, 201)
        if path.startswith('/api/admin/'):
            user = self.require_user(admin=True)
            if path == '/api/admin/events' and method == 'GET':
                return self.send_json(service.events(query, user['id'], admin=True))
            if path == '/api/admin/events' and method == 'POST':
                return self.send_json(service.save_event(self.body(), user['id']), 201)
            match = re.fullmatch(r'/api/admin/events/(\d+)', path)
            if match and method == 'PATCH':
                return self.send_json(service.save_event(self.body(), user['id'], int(match[1])))
            if match and method == 'DELETE':
                service.delete_event(int(match[1])); return self.send_json({'ok': True})
            if path == '/api/admin/venues' and method == 'POST':
                return self.send_json(service.save_venue(self.body()), 201)
            match = re.fullmatch(r'/api/admin/venues/(\d+)', path)
            if match and method == 'PATCH':
                return self.send_json(service.save_venue(self.body(), int(match[1])))
            if match and method == 'DELETE':
                service.delete_venue(int(match[1])); return self.send_json({'ok': True})
            if path == '/api/admin/rules' and method == 'POST':
                return self.send_json(service.save_rule(self.body()), 201)
            match = re.fullmatch(r'/api/admin/rules/(\d+)', path)
            if match and method == 'PATCH':
                return self.send_json(service.save_rule(self.body(), int(match[1])))
            if path == '/api/admin/overview' and method == 'GET':
                with self.app.db.connection() as con:
                    result = {key: con.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for key, table in [('events', 'events'), ('venues', 'venues'), ('users', 'users'), ('questions', 'assistant_logs')]}
                    result['feedback'] = [dict(r) for r in con.execute('SELECT f.id,f.content,f.created_at,u.display_name FROM feedback f JOIN users u ON f.user_id=u.id ORDER BY f.id DESC LIMIT 20')]
                    result['recent_queries'] = [dict(r) for r in con.execute('SELECT engine,elapsed_ms,event_count,source_count,token_count,created_at FROM assistant_logs ORDER BY id DESC LIMIT 10')]
                return self.send_json(result)
        if path.startswith('/api/'):
            raise APIError(404, 'API 路径不存在', 'not_found')
        if method == 'GET':
            return self.serve_static(parsed.path)
        raise APIError(405, '此路径不支持该请求方法', 'method_not_allowed')

    def serve_static(self, request_path):
        relative = unquote(request_path).lstrip('/') or 'index.html'
        file = (self.app.web_root / relative).resolve()
        if not file.is_relative_to(self.app.web_root) or not file.is_file():
            raise APIError(404, '文件不存在', 'not_found')
        mime = 'text/javascript' if file.suffix == '.js' else mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
        body = file.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mime + ('; charset=utf-8' if mime.startswith('text/') else ''))
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Cache-Control', 'no-cache' if file.suffix in ('.html', '.css', '.js') else 'public, max-age=3600')
        self.end_headers()
        self.wfile.write(body)


def create_server(db, host='127.0.0.1', port=8000, app=None):
    application = app or Application(db)
    server = ThreadingHTTPServer((host, port), partial(Handler, app=application))
    server.daemon_threads = True
    return server


def main():
    load_environment()
    parser = argparse.ArgumentParser(description='Dragonboat WebGIS local server')
    parser.add_argument('--host', default=os.environ.get('APP_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('APP_PORT', 8000)))
    parser.add_argument('--database', default=os.environ.get('DATABASE_PATH', 'data/app.sqlite3'))
    args = parser.parse_args()
    db_path = Path(args.database)
    if not db_path.is_absolute():
        db_path = ROOT / db_path
    db = Database(db_path)
    db.initialize(admin_password=os.environ.get('ADMIN_INITIAL_PASSWORD', 'Admin@12345'), user_password=os.environ.get('DEMO_INITIAL_PASSWORD', 'User@12345'))
    logs = ROOT / 'data'
    logs.mkdir(exist_ok=True)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s', handlers=[logging.StreamHandler(), RotatingFileHandler(logs / 'server.log', maxBytes=2_000_000, backupCount=2, encoding='utf-8')])
    try:
        server = create_server(db, args.host, args.port)
    except OSError as error:
        print(f'Cannot start on port {args.port}: {error}. Try --port 8001.')
        raise SystemExit(1)
    print(f'\nDragonboat WebGIS: http://127.0.0.1:{args.port}\nDatabase: {db_path}\nCtrl+C to stop.\n', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
