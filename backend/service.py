from datetime import date
import math
import re
import sqlite3
from urllib.parse import urlsplit
from .db import now_iso


class APIError(Exception):
    def __init__(self, status, message, code='validation_error'):
        self.status, self.message, self.code = status, message, code
        super().__init__(message)


def text(value, name, limit=200, minimum=1):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= limit:
        raise APIError(400, f'{name}需要 {minimum}～{limit} 个字符')
    return value.strip()


def number(value, name, lo, hi):
    if isinstance(value, bool):
        raise APIError(400, f'{name}必须为有效数值')
    try:
        n = float(value)
    except (ValueError, TypeError):
        raise APIError(400, f'{name}必须为有效数值') from None
    if not math.isfinite(n) or not lo <= n <= hi:
        raise APIError(400, f'{name}范围必须为 {lo}～{hi}')
    return n


def integer(value, name, lo=1, hi=1_000_000_000):
    n = number(value, name, lo, hi)
    if not n.is_integer():
        raise APIError(400, f'{name}必须为整数')
    return int(n)


def day(value, name):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise APIError(400, f'{name}必须为 YYYY-MM-DD 格式')
    try:
        date.fromisoformat(value)
    except ValueError:
        raise APIError(400, f'{name}不是有效日期') from None
    return value


def haversine(lng1, lat1, lng2, lat2):
    a, b = math.radians(lat1), math.radians(lat2)
    dlat, dlng = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    h = math.sin(dlat / 2)**2 + math.cos(a) * math.cos(b) * math.sin(dlng / 2)**2
    return 6371.0088 * 2 * math.asin(min(1, math.sqrt(h)))


EVENT_SELECT = '''SELECT e.*, v.name venue_name, v.city, v.address, v.longitude, v.latitude,
 v.description venue_description FROM events e JOIN venues v ON e.venue_id=v.id'''


class Service:
    def __init__(self, db):
        self.db = db

    def venues(self):
        with self.db.connection() as con:
            return [dict(row) for row in con.execute('SELECT * FROM venues ORDER BY city,id')]

    def rules(self):
        with self.db.connection() as con:
            return [dict(row) for row in con.execute('SELECT * FROM rules ORDER BY id')]

    def events(self, filters=None, user_id=None, admin=False):
        f = filters or {}
        clauses, args = [], []
        if not admin:
            clauses.append("e.status='published'")
        elif f.get('status'):
            if f['status'] not in ('draft', 'published'):
                raise APIError(400, '无效的发布状态')
            clauses.append('e.status=?'); args.append(f['status'])
        if f.get('city'):
            clauses.append('v.city=?'); args.append(text(f['city'], '城市', 40))
        if f.get('q'):
            keyword = text(f['q'], '搜索词', 100).replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
            clauses.append("(e.title LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\')")
            args.extend([f'%{keyword}%'] * 2)
        start = day(f['start_date'], '开始日期') if f.get('start_date') else None
        end = day(f['end_date'], '结束日期') if f.get('end_date') else None
        if start and end and end < start:
            raise APIError(400, '结束日期不能早于开始日期')
        if start:
            clauses.append('e.end_date>=?'); args.append(start)
        if end:
            clauses.append('e.start_date<=?'); args.append(end)
        favorite_only = str(f.get('favorites', '')).lower() in ('1', 'true')
        if favorite_only:
            if not user_id:
                raise APIError(401, '请先登录后查看收藏', 'unauthorized')
            clauses.append('EXISTS (SELECT 1 FROM favorites f WHERE f.event_id=e.id AND f.user_id=?)'); args.append(user_id)
        has_lng, has_lat = f.get('longitude') not in (None, ''), f.get('latitude') not in (None, '')
        if has_lng != has_lat:
            raise APIError(400, '经度和纬度需要同时提供')
        lng = number(f['longitude'], '经度', -180, 180) if has_lng else None
        lat = number(f['latitude'], '纬度', -85, 85) if has_lat else None
        radius = number(f['radius_km'], '半径（公里）', 0.1, 3000) if f.get('radius_km') not in (None, '') else None
        if radius is not None and lng is None:
            raise APIError(400, '距离筛选需要参考坐标')
        bbox = None
        if f.get('bbox'):
            vals = str(f['bbox']).split(',')
            if len(vals) != 4:
                raise APIError(400, '地图范围需要四个坐标')
            bbox = [number(v, '地图范围', -180 if i % 2 == 0 else -85, 180 if i % 2 == 0 else 85) for i, v in enumerate(vals)]
            if bbox[0] > bbox[2] or bbox[1] > bbox[3]:
                raise APIError(400, '地图范围的最小坐标不能超过最大坐标')
        page, page_size = integer(f.get('page', 1), '页码'), integer(f.get('page_size', 100), '每页数量', 1, 100)
        sql = EVENT_SELECT + (' WHERE ' + ' AND '.join(clauses) if clauses else '')
        with self.db.connection() as con:
            rows = [dict(row) for row in con.execute(sql, args)]
            favs = {row[0] for row in con.execute('SELECT event_id FROM favorites WHERE user_id=?', (user_id,))} if user_id else set()
        found = []
        for row in rows:
            if bbox and not (bbox[0] <= row['longitude'] <= bbox[2] and bbox[1] <= row['latitude'] <= bbox[3]):
                continue
            distance = haversine(lng, lat, row['longitude'], row['latitude']) if lng is not None else None
            if radius is not None and distance > radius:
                continue
            row['distance_km'] = round(distance, 1) if distance is not None else None
            row['is_favorite'] = row['id'] in favs
            found.append(row)
        sort = f.get('sort', 'distance' if radius else 'date')
        if sort not in ('date', 'distance', 'newest'):
            raise APIError(400, '无效排序方式')
        if sort == 'distance' and lng is None:
            raise APIError(400, '按距离排序需要参考坐标')
        found.sort(key=(lambda e: (e['distance_km'], e['start_date'], e['id'])) if sort == 'distance'
                   else (lambda e: (-e['id'],)) if sort == 'newest' else (lambda e: (e['start_date'], e['id'])))
        offset = (page - 1) * page_size
        return {'items': found[offset:offset + page_size], 'total': len(found), 'page': page, 'page_size': page_size}

    def event(self, event_id, user_id=None, admin=False):
        with self.db.connection() as con:
            row = con.execute(EVENT_SELECT + ' WHERE e.id=?', (event_id,)).fetchone()
            if not row or (row['status'] != 'published' and not admin):
                raise APIError(404, '赛事不存在或尚未发布', 'not_found')
            result = dict(row)
            result['is_favorite'] = bool(user_id and con.execute('SELECT 1 FROM favorites WHERE user_id=? AND event_id=?', (user_id, event_id)).fetchone())
            result['distance_km'] = None
            return result

    def save_venue(self, payload, venue_id=None):
        values = (text(payload.get('name'), '地点名称', 100), text(payload.get('city'), '城市', 40),
                  text(payload.get('address'), '地址', 200), number(payload.get('longitude'), '经度', -180, 180),
                  number(payload.get('latitude'), '纬度', -85, 85), text(payload.get('description', ''), '地点介绍', 1000, 0))
        with self.db.connection() as con:
            if venue_id:
                if not con.execute('SELECT 1 FROM venues WHERE id=?', (venue_id,)).fetchone():
                    raise APIError(404, '地点不存在', 'not_found')
                con.execute('UPDATE venues SET name=?,city=?,address=?,longitude=?,latitude=?,description=? WHERE id=?', (*values, venue_id))
            else:
                venue_id = con.execute('INSERT INTO venues(name,city,address,longitude,latitude,description,created_at) VALUES(?,?,?,?,?,?,?)', (*values, now_iso())).lastrowid
            return dict(con.execute('SELECT * FROM venues WHERE id=?', (venue_id,)).fetchone())

    def save_event(self, payload, user_id, event_id=None):
        start, end = day(payload.get('start_date'), '开始日期'), day(payload.get('end_date'), '结束日期')
        if end < start:
            raise APIError(400, '结束日期不能早于开始日期')
        status = payload.get('status', 'published')
        if status not in ('draft', 'published'):
            raise APIError(400, '发布状态无效')
        cover = text(payload.get('cover_image', '/assets/river.svg'), '封面路径', 500)
        parsed = urlsplit(cover)
        if not ((cover.startswith('/assets/') and '..' not in cover and not parsed.netloc and not parsed.scheme) or
                (parsed.scheme == 'https' and parsed.netloc and not parsed.username)):
            raise APIError(400, '封面必须为 /assets/ 下的本地图片或 HTTPS 图片地址')
        demo = payload.get('is_demo', True)
        if not isinstance(demo, bool):
            raise APIError(400, '示例数据标记必须为布尔值')
        venue = integer(payload.get('venue_id'), '地点 ID')
        values = (text(payload.get('title'), '赛事名称', 120), venue, start, end,
                  text(payload.get('organizer'), '主办方', 120), text(payload.get('race_distances'), '竞赛项目', 100),
                  text(payload.get('description'), '赛事介绍', 5000), cover, status, int(demo))
        with self.db.connection() as con:
            if not con.execute('SELECT 1 FROM venues WHERE id=?', (venue,)).fetchone():
                raise APIError(400, '请选择存在的比赛地点')
            if event_id:
                if not con.execute('SELECT 1 FROM events WHERE id=?', (event_id,)).fetchone():
                    raise APIError(404, '赛事不存在', 'not_found')
                con.execute('UPDATE events SET title=?,venue_id=?,start_date=?,end_date=?,organizer=?,race_distances=?,description=?,cover_image=?,status=?,is_demo=?,updated_at=? WHERE id=?', (*values, now_iso(), event_id))
            else:
                event_id = con.execute('INSERT INTO events(title,venue_id,start_date,end_date,organizer,race_distances,description,cover_image,status,is_demo,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', (*values, user_id, now_iso(), now_iso())).lastrowid
        return self.event(event_id, user_id, admin=True)

    def delete_event(self, event_id):
        with self.db.connection() as con:
            if not con.execute('DELETE FROM events WHERE id=?', (event_id,)).rowcount:
                raise APIError(404, '赛事不存在', 'not_found')

    def delete_venue(self, venue_id):
        with self.db.connection() as con:
            if con.execute('SELECT 1 FROM events WHERE venue_id=?', (venue_id,)).fetchone():
                raise APIError(409, '该地点仍关联赛事，请先调整赛事地点')
            if not con.execute('DELETE FROM venues WHERE id=?', (venue_id,)).rowcount:
                raise APIError(404, '地点不存在', 'not_found')

    def favorite(self, user_id, event_id, add=True):
        self.event(event_id, user_id)
        with self.db.connection() as con:
            if add:
                con.execute('INSERT OR IGNORE INTO favorites VALUES(?,?,?)', (user_id, event_id, now_iso()))
            else:
                con.execute('DELETE FROM favorites WHERE user_id=? AND event_id=?', (user_id, event_id))
        return {'event_id': event_id, 'is_favorite': add}

    def save_rule(self, payload, rule_id=None):
        demo = payload.get('is_demo', True)
        if not isinstance(demo, bool):
            raise APIError(400, '示例资料标记必须为布尔值')
        values = (text(payload.get('title'), '资料标题', 150), text(payload.get('content'), '资料正文', 12000),
                  text(payload.get('tags'), '关键词', 300), text(payload.get('source_label'), '资料来源', 200), int(demo), now_iso())
        with self.db.connection() as con:
            if rule_id:
                if not con.execute('UPDATE rules SET title=?,content=?,tags=?,source_label=?,is_demo=?,updated_at=? WHERE id=?', (*values, rule_id)).rowcount:
                    raise APIError(404, '知识资料不存在', 'not_found')
            else:
                rule_id = con.execute('INSERT INTO rules(title,content,tags,source_label,is_demo,updated_at) VALUES(?,?,?,?,?,?)', values).lastrowid
            return dict(con.execute('SELECT * FROM rules WHERE id=?', (rule_id,)).fetchone())
