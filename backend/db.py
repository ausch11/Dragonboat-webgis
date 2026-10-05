from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
import hashlib
import hmac
import secrets
import sqlite3

SHANGHAI = timezone(timedelta(hours=8))


def now_iso():
    return datetime.now(SHANGHAI).isoformat(timespec='seconds')


def password_hash(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 600_000)
    return f'pbkdf2_sha256$600000${salt.hex()}${digest.hex()}'


def password_matches(password, encoded):
    try:
        algorithm, rounds, salt, digest = encoded.split('$')
        if algorithm != 'pbkdf2_sha256':
            return False
        calculated = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(calculated.hex(), digest)
    except (ValueError, TypeError):
        return False


class Database:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def connection(self):
        con = sqlite3.connect(str(self.path), timeout=10)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA foreign_keys = ON')
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def initialize(self, seed=True, admin_password='Admin@12345', user_password='User@12345'):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as con:
            con.execute('PRAGMA journal_mode = WAL')
            con.executescript(Path(__file__).with_name('schema.sql').read_text(encoding='utf-8'))
            if not con.execute('SELECT 1 FROM schema_version WHERE version=1').fetchone():
                if seed:
                    self._seed(con, admin_password, user_password)
                con.execute('INSERT INTO schema_version VALUES(1,?)', (now_iso(),))

    def _seed(self, con, admin_password, user_password):
        stamp = now_iso()
        for username, label, password, role in [
            ('admin', '赛事管理员', admin_password, 'admin'),
            ('demo', '龙舟体验用户', user_password, 'user'),
        ]:
            con.execute('INSERT INTO users(username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?)',
                        (username, label, password_hash(password), role, stamp))
        places = [
            ('南京秦淮河训练水域', '南京', '南京市秦淮区秦淮河沿岸（示例地点）', 118.792, 32.023, '城市水域与龙舟文化体验。'),
            ('无锡太湖滨湖水域', '无锡', '无锡市滨湖区太湖沿岸（示例地点）', 120.227, 31.492, '开阔湖面，适合展示地图筛选。'),
            ('杭州西溪体验水域', '杭州', '杭州市西湖区西溪湿地附近（示例地点）', 120.062, 30.267, '湿地与传统龙舟文化场景。'),
            ('苏州金鸡湖展示水域', '苏州', '苏州工业园区金鸡湖附近（示例地点）', 120.696, 31.312, '湖区赛事与城市文旅活动。'),
            ('上海淀山湖水上中心', '上海', '上海市青浦区淀山湖附近（示例地点）', 120.969, 31.081, '长三角水上运动交流场景。'),
            ('武汉东湖展示水域', '武汉', '武汉市东湖风景区附近（示例地点）', 114.396, 30.552, '湖泊水上运动与团队训练。'),
            ('福州闽江展示水域', '福州', '福州市闽江沿岸（示例地点）', 119.302, 26.048, '江面龙舟与城市文化场景。'),
            ('盐城串场河展示水域', '盐城', '盐城市串场河附近（示例地点）', 120.139, 33.365, '河流赛事与地方文化场景。'),
        ]
        for p in places:
            con.execute('INSERT INTO venues(name,city,address,longitude,latitude,description,created_at) VALUES(?,?,?,?,?,?,?)', (*p, stamp))
        races = [
            ('秦淮秋日龙舟邀请赛', 1, '2026-10-17', '2026-10-18', '南京水上运动交流中心', '200米 / 500米', 'river'),
            ('太湖周末龙舟训练公开日', 2, '2026-10-24', '2026-10-24', '太湖团队运动工作室', '200米体验', 'lake'),
            ('西溪龙舟文化交流赛', 3, '2026-11-07', '2026-11-08', '西溪龙舟文化社', '200米 / 500米', 'wetland'),
            ('金鸡湖城市龙舟挑战赛', 4, '2026-10-31', '2026-11-01', '苏州城市运动联盟', '500米', 'city'),
            ('淀山湖青年龙舟友谊赛', 5, '2026-11-14', '2026-11-15', '淀山湖青年运动社', '200米 / 500米', 'lake'),
            ('东湖水上团队邀请赛', 6, '2026-11-21', '2026-11-22', '东湖水上运动社', '500米 / 1000米', 'sunset'),
            ('闽江秋季龙舟交流赛', 7, '2026-10-18', '2026-10-18', '闽江文化交流社', '200米 / 500米', 'river'),
            ('串场河冬日训练杯', 8, '2026-11-28', '2026-11-29', '盐城龙舟交流中心', '500米', 'sunset'),
            ('秦淮冬季团队训练日', 1, '2026-12-05', '2026-12-05', '南京水上运动交流中心', '200米体验', 'wetland'),
            ('盐城龙舟历史资料展示赛', 8, '2023-06-10', '2023-06-11', '课程资料整理小组', '200米 / 500米', 'city'),
        ]
        for title, venue, start, end, organizer, distances, cover in races:
            description = f'{title}是用于项目演示的虚构赛事，展示日期筛选、附近查询和收藏流程。可浏览赛事地点、了解团队运动与龙舟文化。正式报名、队伍人数、安全要求和竞赛规则以实际主办方文件为准。'
            con.execute('INSERT INTO events(title,venue_id,start_date,end_date,organizer,race_distances,description,cover_image,status,is_demo,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                        (title, venue, start, end, organizer, distances, description, f'/assets/{cover}.svg', 'published', 1, 1, stamp, stamp))
        docs = [
            ('龙舟赛事的常见距离', '体验和竞赛活动中常见短距离直道项目，例如200米、500米；部分活动也设置更长距离。项目和组别不是所有赛事统一的，应查看该场赛事的规程。平台赛事详情中的“竞赛项目”由管理员维护。', '距离,项目,200米,500米,1000米,多少米'),
            ('参赛队伍与报名', '报名通常需要提交队伍信息，并按照主办方设置的年龄、性别或其他组别参赛。桨手、鼓手和舵手的安排以及队伍人数，必须以具体赛事发布的规程为准。本示例资料不规定统一人数；需要查看正式文件或联系主办方确认。', '报名,队伍,人数,几个人,鼓手,舵手,分组,年龄'),
            ('水上活动与安全装备', '参与水上活动前应了解水域条件和天气，检查船只与个人装备，按主办方和现场工作人员要求使用救生装备。不会游泳、身体不适或遇到恶劣天气时，应先咨询活动组织方，遵守停赛或撤离安排。此段为课程示例安全提示，不能替代现场要求。', '安全,救生衣,装备,天气,游泳,停赛'),
            ('起航、航道与成绩判定', '直道竞赛通常关注起航纪律、航道秩序和终点判定。抢航、侵入航道或妨碍其他队伍的判罚细节由赛事规程及裁判决定。平台示例知识不提供固定罚秒或取消资格条件；请查询该赛事的正式竞赛文件。', '起航,抢航,航道,成绩,处罚,判罚,规则,罚秒'),
            ('如何使用附近赛事查询', '赛事地图使用经纬度定位地点。选择参考城市或输入经纬度，再设置查询半径，可以筛选附近赛事。距离是球面直线距离，单位为公里，不等于驾车距离或行程时间。日期筛选按赛事开始和结束区间是否重叠处理。', '附近,距离,地图,公里,半径,城市,日期,筛选'),
            ('龙舟文化与团队协作', '龙舟活动与传统节俗、地方文化和团队运动相联系。鼓点用于帮助队员协调节奏，舵手负责方向控制，桨手依靠配合推进船只。各地活动形式和传承故事有所差异，可以结合赛事主办方提供的文化资料了解。', '文化,历史,鼓点,协作,传统,端午,龙舟'),
        ]
        for title, content, tags in docs:
            con.execute('INSERT INTO rules(title,content,tags,source_label,is_demo,updated_at) VALUES(?,?,?,?,?,?)',
                        (title, content, tags, '项目示例知识库（非官方竞赛文件）', 1, stamp))
