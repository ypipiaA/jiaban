"""仅清理 verify-live.cjs 创建的随机测试空间，核对记录标记后才允许删除。"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cf_deploy import req, BASE, ACCOUNT, PROJECT

metadata = ROOT / '.local' / 'live-verification.json'
value = json.loads(metadata.read_text(encoding='utf-8'))
assert value['url'] == 'https://jiaban-x2m.pages.dev'
assert re.fullmatch(r'jb1_[A-Za-z0-9_-]{43}', value['code'])
assert value['marker'].startswith('jiaban-live-check-')
room = hashlib.sha256(value['code'].encode()).hexdigest()
databases = req(f'{BASE}/accounts/{ACCOUNT}/d1/database?per_page=100')['result']
db = next(d for d in databases if d['name'] == PROJECT + '-sync')
url = f"{BASE}/accounts/{ACCOUNT}/d1/database/{db['uuid']}/query"
rows = req(url, 'POST', {'sql': 'SELECT data FROM sync_rooms WHERE room = ?', 'params': [room]})['result'][0]['results']
if rows:
    data = json.loads(rows[0]['data'])
    assert all(r.get('note', '').startswith(value['marker']) for r in data['records'].values())
    assert not data['adjust']
    req(url, 'POST', {'sql': 'DELETE FROM sync_history WHERE room = ?', 'params': [room]})
    req(url, 'POST', {'sql': 'DELETE FROM sync_rooms WHERE room = ?', 'params': [room]})
    assert not req(url, 'POST', {'sql': 'SELECT room FROM sync_rooms WHERE room = ?', 'params': [room]})['result'][0]['results']
metadata.write_text(json.dumps({'url': value['url'], 'marker': value['marker'], 'cleaned': True}), encoding='utf-8')
print('Temporary live verification room and its history removed; user spaces untouched.')
