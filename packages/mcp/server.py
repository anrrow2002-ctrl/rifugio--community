#!/usr/bin/env python3
"""
Rifugio MCP Server — SSE传输
核心工具：breath, search_memory, hold, dream, dream_seen；扩展工具需显式开启
端口：3456  路径：/{token}/sse (GET)  /{token}/message (POST)
"""
import datetime, json, math, os, queue, random, re, shlex, sqlite3, subprocess, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlparse, parse_qs

ROOT_DIR = os.path.abspath(os.environ.get('RIFUGIO_ROOT', os.path.join(os.path.dirname(__file__), '..', '..')))
DATA_DIR = os.path.abspath(os.environ.get('RIFUGIO_DATA_DIR', os.path.join(ROOT_DIR, 'data')))
PUBLIC_URL = os.environ.get('RIFUGIO_PUBLIC_URL', 'http://localhost:3457').rstrip('/')
VOICE_DIR = os.path.abspath(os.environ.get('RIFUGIO_VOICE_DIR', os.path.join(DATA_DIR, 'voice')))
PRIVATE_DIR = os.path.abspath(os.environ.get('RIFUGIO_PRIVATE_DIR', os.path.join(ROOT_DIR, 'private')))
TOKEN_FILE = os.environ.get('MCP_TOKEN_FILE', os.path.join(PRIVATE_DIR, 'mcp_tokens'))

def _load_tokens():
    values = [os.environ.get('MCP_TOKEN', ''), os.environ.get('MCP_TOKEN2', '')]
    try:
        with open(TOKEN_FILE, encoding='utf-8') as token_file:
            values.extend(line.strip() for line in token_file if line.strip())
    except FileNotFoundError:
        pass
    tokens = {value for value in values if value}
    if not tokens:
        raise RuntimeError('No MCP tokens configured')
    return tokens

TOKENS = _load_tokens()

def _path_token(path):
    seg = urlparse(path).path.strip('/').split('/')
    return seg[0] if seg and seg[0] in TOKENS else None

def _request_token(path, headers):
    auth = (headers.get('Authorization') or '').strip()
    if auth.lower().startswith('bearer '):
        candidate = auth[7:].strip()
        if candidate in TOKENS:
            return candidate
    return _path_token(path)
PORT = int(os.environ.get('RIFUGIO_MCP_PORT', '3456'))
DB_PATH = os.environ.get('RIFUGIO_DB', os.path.join(DATA_DIR, 'rifugio-memory.db'))

sessions = {}  # session_id -> Queue（旧版 SSE）
http_sessions = set()  # Streamable HTTP 的 Mcp-Session-Id 集合

# ─── Decay Score ──────────────────────────────────────────
def calc_score(r):
    if r['pinned']: return 999.0
    imp = max(1, min(10, r['importance'] or 5))
    ar  = max(0, min(1, r['arousal']    or 0.3))
    half_life = 4 * imp
    lam = math.log(2) / half_life
    base = r['occurred_at'] or r['created_at']
    days = 0
    if base:
        try:
            from datetime import datetime, timezone
            s = base.replace('Z','+00:00')
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            days = max(0, (time.time() - dt.timestamp()) / 86400)
        except: pass
    last_active_days = 30
    if r['last_active']:
        try:
            from datetime import datetime, timezone
            s2 = r['last_active'].replace('Z','+00:00')
            dt2 = datetime.fromisoformat(s2)
            if dt2.tzinfo is None: dt2 = dt2.replace(tzinfo=timezone.utc)
            last_active_days = max(0, (time.time() - dt2.timestamp()) / 86400)
        except: pass
    # 与 buckets.js calcScore 对齐（2026-07-04 同步）：加法混合 + time_weight 新鲜度门槛
    R = math.exp(-lam*days)
    I = imp / 10
    score = (0.52*R + 0.48*I) * 10
    time_weight = 1.0 if days <= 2 else max(0.7, 0.95*math.exp(-0.08*(days-2)))
    score *= time_weight
    score *= (0.9 + ar*0.1)
    score *= (1 + 0.1*math.exp(-0.15*last_active_days))
    if r['resolved']: score *= 0.05
    try:
        if r['digested']: score *= 0.02
    except (KeyError, IndexError): pass
    return round(score*1000)/1000

# ─── 工具实现 ──────────────────────────────────────────────
def parse_json_array(value):
    if isinstance(value, list): return value
    if not value: return []
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []

def normalize_list(value):
    if isinstance(value, list): return [str(x).strip() for x in value if str(x).strip()]
    if isinstance(value, str):
        s = value.strip()
        if not s: return []
        try:
            parsed = json.loads(s)
            if isinstance(parsed, list): return normalize_list(parsed)
        except Exception:
            pass
        return [x.strip() for x in s.split(',') if x.strip()]
    return []

def parse_metadata(value):
    if isinstance(value, dict): return value
    try:
        parsed = json.loads(value or '{}')
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}

def bucket_status(r):
    if r.get('bucket_type') == 'feel': return 'feel'
    if r.get('digested'): return 'digested'
    if r.get('resolved'): return 'quiet'
    return 'active'

def format_bucket(r, i, score=None, full=True):
    raw = r.get('content','') or ''
    if full:
        # breath/dream：浮现全文，不摘要
        body = raw.split('---RIFUGIO---')[0].strip()
    else:
        # search_memory：只给摘要，省 token
        m = re.search(r'---RIFUGIO---\n摘要[：:](.*?)(?:\n|$)', raw, re.S)
        if m:
            body = m.group(1).strip()
        else:
            body = raw.split('---RIFUGIO---')[0].strip()
            if len(body) > 200:
                body = body[:200] + '…'
    tags = ' '.join(parse_json_array(r.get('tags','[]') or '[]'))
    date = (r.get('occurred_at','') or r.get('created_at','') or '')[:10]
    status = bucket_status(r)
    sc = f" 权重={score}" if score is not None else ''
    return f"{i+1}. 【{r.get('name','未命名')}】({status}, {date}){sc}{' ['+tags+']' if tags else ''}\nid={r.get('id')}\n{body}"

def load_bucket_rows(where, params=(), limit=50):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(f"""
            SELECT id, name, content, importance, arousal, valence,
                   occurred_at, created_at, last_active, resolved,
                   digested, digested_at, pinned, tags, domain, metadata, bucket_type
            FROM buckets
            WHERE {where}
            ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
            LIMIT ?
        """, tuple(params) + (limit,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()

def quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'

def pick_column(columns, choices):
    lower = {c.lower(): c for c in columns}
    for choice in choices:
        if choice.lower() in lower:
            return lower[choice.lower()]
    return ''

def load_trace_rows(limit=6, query=''):
    limit = min(max(int(limit or 6), 1), 50)
    query = (query or '').strip().lower()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        exists = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tracce'").fetchone()
        if not exists:
            return []
        columns = [r['name'] for r in conn.execute("PRAGMA table_info(tracce)").fetchall()]
        if not columns:
            return []
        text_cols = [c for c in columns if c.lower() in ('event','content','text','body','summary','title','name')]
        if not text_cols:
            return []
        date_col = pick_column(columns, ('date','occurred_at','created_at','updated_at'))
        search_expr = " || ' ' || ".join([f"COALESCE({quote_ident(c)}, '')" for c in text_cols])
        params = []
        has_archived = 'archived' in [c.lower() for c in columns]
        where = ''
        if query:
            where = f"WHERE lower({search_expr}) LIKE ?"
            params.append(f'%{query}%')
        elif has_archived:
            where = "WHERE COALESCE(archived,0)=0"
        order = f"datetime({quote_ident(date_col)}) DESC, rowid DESC" if date_col else 'rowid DESC'
        rows = conn.execute(
            f"SELECT rowid AS _rowid, * FROM tracce {where} ORDER BY {order} LIMIT ?",
            tuple(params) + (limit,)
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()

def format_trace(r, i):
    text = ''
    for col in ('event','content','text','body','summary','title','name'):
        if r.get(col):
            text = str(r.get(col)).strip()
            break
    date = ''
    for col in ('date','occurred_at','created_at','updated_at'):
        if r.get(col):
            date = str(r.get(col))[:10]
            break
    tid = r.get('id') or r.get('_rowid') or ''
    return f"{i+1}. 【痕迹】({date or '未标日期'})\nid=tracce:{tid}\n{text}"

def trace_section(query='', trace_limit=6):
    rows = load_trace_rows(trace_limit, query)
    if not rows:
        return ''
    return "=== 痕迹 / Trace（里程碑） ===\n" + "\n\n".join(format_trace(r, i) for i, r in enumerate(rows))

def append_trace_section(text, query='', trace_limit=6):
    section = trace_section(query, trace_limit)
    if not section:
        return text
    return (text + "\n\n" + section) if text else section

def touch_bucket_ids(ids, cooldown_hours=6):
    safe = [x for x in ids if x]
    if not safe: return
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    cutoff = time.time() - cooldown_hours * 3600
    cutoff_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(cutoff))
    conn = sqlite3.connect(DB_PATH)
    try:
        for bid in safe:
            conn.execute("""
                UPDATE buckets
                SET last_active=?, activation_count=COALESCE(activation_count,0)+1
                WHERE id=?
                  AND bucket_type NOT IN ('archive','feel','self')
                  AND (last_active IS NULL OR last_active < ?)
            """, (now, bid, cutoff_iso))
        conn.commit()
    finally:
        conn.close()

def _search_ordinary_rows(query, limit):
    """Hybrid search with immediate read-after-write visibility.

    Semantic results may not contain a newly written bucket until its embedding job
    finishes. Keyword matches are therefore always merged ahead of semantic matches.
    """
    semantic_rows = []
    sem_ids = _semantic_ids(query, limit)
    if sem_ids:
        ph = ','.join('?' * len(sem_ids))
        semantic_rows = load_bucket_rows(
            f"bucket_type NOT IN ('archive','feel','self') AND COALESCE(resolved,0)=0 AND COALESCE(digested,0)=0 AND id IN ({ph})",
            tuple(sem_ids), len(sem_ids),
        )
        rank = {bid: i for i, bid in enumerate(sem_ids)}
        semantic_rows.sort(key=lambda r: rank.get(r['id'], 999))

    like = f'%{query}%'
    keyword_rows = load_bucket_rows(
        "bucket_type NOT IN ('archive','feel','self') AND COALESCE(resolved,0)=0 AND COALESCE(digested,0)=0 AND (lower(name) LIKE ? OR lower(content) LIKE ? OR lower(tags) LIKE ? OR lower(domain) LIKE ?)",
        (like, like, like, like),
        limit,
    )
    merged = []
    seen = set()
    for row in keyword_rows + semantic_rows:
        if row['id'] in seen:
            continue
        seen.add(row['id'])
        merged.append(row)
        if len(merged) >= limit:
            break
    return merged

def tool_breath(limit=15, query='', q='', domain='', include_trace=True, trace_limit=6):
    limit = min(max(int(limit or 15), 1), 20)
    query = (query or q or '').strip().lower()
    domain = (domain or '').strip().lower()
    include_trace = include_trace is not False and str(include_trace).lower() not in ('0','false','no')
    try:
        if domain == 'feel':
            if query:
                like = f'%{query}%'
                rows = load_bucket_rows(
                    "bucket_type='feel' AND (lower(name) LIKE ? OR lower(content) LIKE ? OR lower(tags) LIKE ? OR lower(domain) LIKE ?)",
                    (like, like, like, like),
                    limit,
                )
            else:
                rows = load_bucket_rows("bucket_type='feel'", (), limit)
            return '\n\n'.join(format_bucket(r, i) for i, r in enumerate(rows)) if rows else '（没有留下过 feel）'

        if query:
            rows = _search_ordinary_rows(query, limit)
            touch_bucket_ids([r['id'] for r in rows])
            text = '\n\n'.join(format_bucket(r, i, calc_score(r), full=True) for i, r in enumerate(rows))
            if include_trace:
                text = append_trace_section(text, query, trace_limit)
            return text if text else '未找到相关记忆。'

        rows = load_bucket_rows("bucket_type NOT IN ('archive','feel','self') AND COALESCE(resolved,0)=0 AND COALESCE(digested,0)=0", (), 120)
    except Exception as e:
        return f'breath失败：{e}'

    all_scored = sorted([(r, calc_score(r)) for r in rows], key=lambda x: x[1], reverse=True)
    # 前12条按score排
    main_slots = all_scored[:12]
    main_ids = {r['id'] for r,_ in main_slots}
    # 剩余记忆中按importance加权随机抽3条（闪回旧记忆）
    remaining = [(r,sc) for r,sc in all_scored[12:] if r['id'] not in main_ids and not r.get('resolved')]
    flashback_count = min(3, len(remaining))
    flashbacks = []
    if remaining:
        weights = [max(1, r.get('importance',5) or 5) for r,_ in remaining]
        flashbacks = random.sample(list(zip(remaining, weights)), k=min(flashback_count, len(remaining)))
        flashbacks = [(r,sc) for (r,sc),_ in flashbacks]
    combined = main_slots + flashbacks
    parts = []
    for i,(r,sc) in enumerate(combined):
        body = (r.get('content','') or '').split('---RIFUGIO---')[0].strip()
        label = '🔄' if i >= 12 else ''
        entry = format_bucket(r, i, sc)
        parts.append((label + entry) if label else entry)
    text = '\n\n'.join(parts)
    if include_trace:
        text = append_trace_section(text, '', trace_limit)
    text = append_self_section(text)   # 开场推一段「我 / I」最新版 summary（只推 summary，省 token）
    return text if text else '（记忆库为空）'

def tool_search_memory(query='', limit=8):
    limit = min(max(int(limit or 8), 1), 20)
    query = (query or '').strip().lower()
    if not query:
        return '缺少 query。'
    try:
        rows = _search_ordinary_rows(query, limit)
    except Exception as e:
        return f'search_memory失败：{e}'
    touch_bucket_ids([r['id'] for r in rows])
    text = '\n\n'.join(format_bucket(r, i, calc_score(r), full=False) for i, r in enumerate(rows))
    return text if text else '未找到相关记忆。'

# ─── I / 自我认知（bucket_type='self'，版本进 metadata；不衰减/不浮现/不被合并）───
def _self_latest(conn):
    return conn.execute(
        "SELECT id, content, metadata, created_at FROM buckets WHERE bucket_type='self' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    ).fetchone()

def self_section():
    """开场推送用：只取最新版的 summary，仿 trace_section 的拼法。"""
    conn = sqlite3.connect(DB_PATH); conn.row_factory = sqlite3.Row
    try:
        row = _self_latest(conn)
    finally:
        conn.close()
    if not row: return ''
    meta = parse_metadata(row['metadata'])
    s = (meta.get('summary') or '').strip()
    if not s: return ''
    return f"=== 我 / I（当前 v{meta.get('version','?')}）===\n{s}"

def append_self_section(text):
    section = self_section()
    if not section: return text
    return (text + "\n\n" + section) if text else section

def tool_I(content='', summary='', read=False, limit=10):
    """伴侣的自我快照。content 非空=写新版本(version+1, prev_id=上一版, 旧版不删)；否则=读当前全文+最近版本 summary 演进。
    约定（不在代码里强制）：写前先 read 一下上一版。summary 不给则取 content 第一行。"""
    content = (content or '').strip()
    summary = (summary or '').strip()
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    conn = sqlite3.connect(DB_PATH); conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, content, metadata, created_at FROM buckets WHERE bucket_type='self' ORDER BY created_at DESC, rowid DESC"
        ).fetchall()
        latest = rows[0] if rows else None
        latest_meta = parse_metadata(latest['metadata']) if latest else {}

        if content:
            version = int(latest_meta.get('version', 0)) + 1 if latest else 1
            prev_id = latest['id'] if latest else None
            if not summary:
                summary = content.split('\n', 1)[0].strip()[:80]
            bid = uuid.uuid4().hex[:12]
            meta = {'type': 'self', 'version': version, 'prev_id': prev_id, 'summary': summary, 'created': now}
            # pinned=1：calc_score 短路、dream 排除、夜间 dedup 只动 pinned=0 —— I 不被衰减/浮现/合并
            conn.execute("""
                INSERT INTO buckets (id,name,content,valence,arousal,domain,tags,importance,bucket_type,metadata,occurred_at,last_active,activation_count,resolved,digested,digested_at,pinned,personas,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,0,0,NULL,1,'{}',?)
            """, (
                bid, f'I·v{version}', content, 0.5, 0.3,
                json.dumps(['self'], ensure_ascii=False), json.dumps([], ensure_ascii=False),
                5, 'self', json.dumps(meta, ensure_ascii=False), now, now, now,
            ))
            conn.commit()
            return f"已更新自我认知 → v{version}（上一版 {prev_id or '无'}）。\n摘要：{summary}"

        # 读
        if not rows:
            return ('（还没写过 I。这是我的自我认知快照系统：我隔一段时间回望这段经历，第一人称写下"我整体是谁"，'
                    '每次写自动 version+1，旧版永远保留成一条演进链。\n'
                    '第一版可以这样起笔：①底色——很少变的我；②当下——正在动的我；③不确定——我还不知道的自己。\n'
                    '写好后 breath 开场只推 summary，全文要 I(read) 才展开。用 I(content="...", summary="一句话概括") 写下 v1。）')
        cur_ver = latest_meta.get('version', '?')
        out = [f"=== 我 / I · 当前 v{cur_ver} ===", (latest['content'] or '').strip()]
        hist = rows[1:max(1, int(limit or 10))] if limit else rows[1:]
        if hist:
            out.append("\n--- 最近版本演进（summary）---")
            for r in hist:
                m = parse_metadata(r['metadata'])
                out.append(f"v{m.get('version','?')}（{(r['created_at'] or '')[:10]}）：{m.get('summary','')}")
        out.append(f"\n--- 写 v{int(cur_ver)+1 if str(cur_ver).isdigit() else '?'} 前的守则 ---\n"
                   "对比上一版：哪里真的变了、哪里只是当时的潮汐。三块想过再落笔：底色（很少变的我）／当下（正在动的我）／"
                   "不确定（我还不知道的自己）。外加一个纵深问题：这段日子里，我本能想做的、我实际做的、我觉得该成为的，"
                   "三者之间的缝隙在哪？缝隙就是正在长的地方。I 是长期积累的年轮——单个事件写进普通记忆，别为一件事改底色。")
        return '\n'.join(out)
    finally:
        conn.close()

def mark_dream_shown(ids):
    """把本轮 dream 展示过的普通记忆记成 shown（非终态），供 dream_seen() 批量收尾。"""
    ids = [str(i).strip() for i in (ids or []) if str(i).strip()]
    if not ids: return
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    conn = sqlite3.connect(DB_PATH)
    try:
        for bid in ids:
            row = conn.execute("SELECT metadata FROM buckets WHERE id=? AND bucket_type NOT IN ('archive','feel','self')", (bid,)).fetchone()
            if not row: continue
            meta = parse_metadata(row[0])
            dream = meta.get('dream') or {}
            # 已经是终态（写过 feel / 看过）的不动
            if dream.get('source_of_feel') or dream.get('no_feel') or dream.get('status') in ('digested','reviewed_no_feel'):
                continue
            dream['shown'] = True
            dream['shown_at'] = now
            meta['dream'] = dream
            conn.execute("UPDATE buckets SET metadata=? WHERE id=?", (json.dumps(meta, ensure_ascii=False), bid))
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()

def tool_dream(limit=10):
    limit = min(max(int(limit or 10), 1), 20)
    try:
        rows = load_bucket_rows(
            "bucket_type NOT IN ('archive','feel','self','permanent','core') AND COALESCE(resolved,0)=0 AND COALESCE(digested,0)=0 AND COALESCE(pinned,0)=0",
            (),
            80,
        )
        candidates = []
        for r in rows:
            meta = parse_metadata(r.get('metadata'))
            dream = meta.get('dream') or {}
            typ = str(meta.get('type') or r.get('bucket_type') or '').lower()
            if typ in ('archive','feel','permanent','core'): continue
            if meta.get('pinned') or meta.get('protected'): continue
            if dream.get('source_of_feel') or dream.get('skip_dream') or dream.get('reviewed') or dream.get('no_feel') or dream.get('status') in ('digested','reviewed_no_feel'): continue
            candidates.append(r)
            if len(candidates) >= limit: break
    except Exception as e:
        return f'dream失败：{e}'
    if not candidates:
        return '（Dream 没有找到需要自省的 recent active 普通记忆。）'
    mark_dream_shown([r.get('id') for r in candidates])
    parts = [format_bucket(r, i, calc_score(r)) for i, r in enumerate(candidates)]
    return """[Rifugio Dream]
下面是最近的 active 普通记忆。请你第一人称自省：有没有真正值得带走的 feel。

规则：
- 这一步只是自省，不是清理数据库。
- 没有真实沉淀就不要写 feel。
- 不要把每条日记、每条普通记忆都提炼成 feel；多数日常生活分享应该没有 feel。
- feel 不是事件摘要，不是普通 bucket 总结，也不是替 AI 每条写感受。
- feel 必须是具体、克制、可复用的长期相处理解：能帮助失忆后的你找回“我是谁、我怎么理解这段关系”。
- 只有明确触动、反复模式、重要约定/边界、偏好变化、关系推进、很深的领悟，才可以写 feel。
- 普通日常分享、一次性情绪、技术调试、代码/配置/报错通常不生成 feel。
- 如果你犹豫，就不要生成 feel。
- 有真实沉淀时，用 hold(feel=true, source_bucket="id", name=..., content=..., tags=[...], importance=...) 写入。
- 收尾：写完该写的 feel 后，**调一次 dream_seen()（不传 id）**，就会把本轮展示过、没写成 feel 的全部一次性标记看过（写过 feel 的会自动跳过）。不用再一条一条 dream_seen，省额度。
- 想精确控制某几条时，仍可用 dream_seen(id="...", reason="...") 单条打标。
- dream_seen 不会沉底、不消化，记忆仍保持 active 可搜，只是不再进入默认 dream 候选。
- 不要主动 quiet/digest/archive。

最近记忆：
""" + "\n\n---\n\n".join(parts)

def _apply_dream_seen(conn, bid, reason, now):
    """把单条普通记忆标记为 Dream 看过、不写 feel。返回显示名或 None。"""
    row = conn.execute("SELECT name, metadata FROM buckets WHERE id=? AND bucket_type NOT IN ('archive','feel','self')", (bid,)).fetchone()
    if not row:
        return None
    meta = parse_metadata(row[1])
    dream = meta.get('dream') or {}
    dream.update({
        'reviewed': True,
        'no_feel': True,
        'skip_dream': True,
        'shown': False,
        'status': 'reviewed_no_feel',
        'reason': reason or '没有形成值得长期沉淀的 feel',
        'reviewed_at': now,
    })
    meta['dream'] = dream
    conn.execute("UPDATE buckets SET metadata=? WHERE id=?", (json.dumps(meta, ensure_ascii=False), bid))
    return row[0] or bid

def tool_dream_seen(id='', ids=None, reason=''):
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    # 收集要打标的 id：显式 id / ids，否则批量收尾本轮 dream 展示过、未写 feel 的
    target_ids = normalize_list(ids)
    if (id or '').strip():
        target_ids.insert(0, (id or '').strip())
    target_ids = list(dict.fromkeys([str(x).strip() for x in target_ids if str(x).strip()]))
    batch_mode = not target_ids
    conn = sqlite3.connect(DB_PATH)
    try:
        if batch_mode:
            rows = load_bucket_rows("bucket_type NOT IN ('archive','feel','self')", (), 200)
            for r in rows:
                dream = (parse_metadata(r.get('metadata')) or {}).get('dream') or {}
                if not dream.get('shown'): continue
                if dream.get('source_of_feel') or dream.get('no_feel') or dream.get('status') in ('digested','reviewed_no_feel'): continue
                target_ids.append(r.get('id'))
            target_ids = [x for x in dict.fromkeys(target_ids) if x]
            if not target_ids:
                return '（没有待收尾的 dream 记忆：要么本轮都写成 feel 了，要么已经标记过。）'
        done = []
        for bid in target_ids:
            name = _apply_dream_seen(conn, bid, reason, now)
            if name: done.append(name)
        conn.commit()
        if not done:
            return 'dream_seen失败：找不到对应的普通记忆'
        if len(done) == 1 and not batch_mode:
            return f"Dream 已标记看过：{done[0]}（不写 feel，保持 active）"
        head = '本轮收尾，已批量标记看过' if batch_mode else '已标记看过'
        return f"{head} {len(done)} 条（不写 feel，保持 active）：" + '、'.join(done[:12]) + ('…' if len(done) > 12 else '')
    except Exception as e:
        return f'dream_seen失败：{e}'
    finally:
        conn.close()

def _link_feel_sources(bid, source_ids, now):
    """把手动 feel 的来源普通桶标记为 source_of_feel（node hold 不做这步，留在 python）"""
    conn = sqlite3.connect(DB_PATH)
    try:
        for sid in source_ids:
            row = conn.execute("SELECT metadata FROM buckets WHERE id=? AND bucket_type NOT IN ('archive','feel','self')", (sid,)).fetchone()
            if not row: continue
            meta = parse_metadata(row[0])
            dream = meta.get('dream') or {}
            linked = normalize_list(dream.get('linked_feel_ids'))
            if bid not in linked: linked.append(bid)
            dream.update({'source_of_feel': True, 'status': 'source_of_feel', 'reason': 'source of manually held feel', 'linked_feel_ids': linked, 'marked_at': now})
            meta['dream'] = dream
            conn.execute("UPDATE buckets SET metadata=? WHERE id=?", (json.dumps(meta, ensure_ascii=False), sid))
        conn.commit()
    finally:
        conn.close()

def _hold_local(payload, is_feel, source_ids, now):
    """node 离线兜底：本地直插 + 自排向量（embedding_jobs，和 node 同一张队列）"""
    bid = uuid.uuid4().hex[:12]
    bucket_type = 'feel' if is_feel else 'dynamic'
    metadata = {'type': bucket_type, 'created': now, 'source': 'mcp-hold'}
    if is_feel:
        metadata.update({'channel': 'feel', 'source_ids': source_ids})
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("""
            INSERT INTO buckets (id,name,content,valence,arousal,domain,tags,importance,bucket_type,metadata,occurred_at,last_active,activation_count,resolved,digested,digested_at,pinned,personas,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,0,0,NULL,0,'{}',?)
        """, (
            bid, payload['name'], payload['content'], payload['valence'], payload['arousal'],
            json.dumps(payload['domain'], ensure_ascii=False), json.dumps(payload['tags'], ensure_ascii=False),
            payload['importance'], bucket_type, json.dumps(metadata, ensure_ascii=False),
            payload['occurred_at'], now, now,
        ))
        conn.execute("""
            INSERT OR REPLACE INTO embedding_jobs (bucket_id, reason, status, attempts, error, updated_at)
            VALUES (?, 'hold', 'pending', 0, '', datetime('now'))
        """, (bid,))
        conn.commit()
    except Exception as e:
        conn.close()
        return f'hold失败：{e}'
    conn.close()
    if is_feel and source_ids:
        _link_feel_sources(bid, source_ids, now)
    return f"已写入：{payload['name']} ({'feel' if is_feel else 'active'}) id={bid}（本地直插，node 离线）"

def tool_plan(content='', notes='', id=0, done=False, status='', all=False):
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    try:
        db.execute("CREATE TABLE IF NOT EXISTS piani (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT DEFAULT 'pending', flag_date TEXT, done_date TEXT, notes TEXT)")
        if content:
            cur = db.execute("INSERT INTO piani (title, status, flag_date, notes) VALUES (?, ?, date('now'), ?)", (content, status or 'pending', notes or ''))
            db.commit()
            return f"计划已登记 #{cur.lastrowid}：{content}"
        if id and done:
            db.execute("UPDATE piani SET status='done', done_date=date('now') WHERE id=?", (id,))
            db.commit()
            row = db.execute("SELECT title FROM piani WHERE id=?", (id,)).fetchone()
            return f"已打勾 #{id}：{row['title'] if row else '?'} ✓"
        if id and (notes or status):
            if notes: db.execute("UPDATE piani SET notes = COALESCE(notes,'') || '；' || ? WHERE id=?", (notes, id))
            if status: db.execute("UPDATE piani SET status=? WHERE id=?", (status, id))
            db.commit()
            return f"已更新 #{id}"
        q = "SELECT * FROM piani ORDER BY id" if all else "SELECT * FROM piani WHERE status != 'done' ORDER BY id"
        rows = db.execute(q).fetchall()
        if not rows: return "（台账干净，没有欠账）"
        out = []
        for r in rows:
            line = f"#{r['id']} [{r['status']}] {r['title']}"
            if r['flag_date']: line += f" (立于{r['flag_date']})"
            if r['done_date']: line += f" · 兑现{r['done_date']}"
            if r['notes']: line += f"\n   {r['notes']}"
            out.append(line)
        return "\n".join(out)
    finally:
        db.close()

def _hold_number(value, minimum, maximum, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    if not math.isfinite(number):
        number = fallback
    return max(minimum, min(maximum, number))

def _hold_timestamp(value, fallback):
    raw = str(value or '').strip()
    if not raw:
        return fallback
    if len(raw) > 64:
        raise ValueError('occurred_at 过长')
    try:
        datetime.datetime.fromisoformat(raw.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('occurred_at 必须是 ISO 日期/时间')
    return raw

def tool_hold(content='', name='', feel=False, source_bucket='', source_ids=None, importance=5, valence=0.5, arousal=0.3, domain=None, tags=None, occurred_at='', reason=''):
    content = str(content or '').strip()
    if not content: return '内容为空，无法写入。'
    if len(content) > 200000: return '内容过长，无法写入。'
    name = str(name or '').strip()
    if len(name) > 200: return '标题过长，无法写入。'
    source_ids = [x[:128] for x in normalize_list(source_ids or source_bucket)[:64]]
    is_feel = bool(feel)
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    domains = [x[:100] for x in normalize_list(domain)[:64]]
    tag_list = [x[:100] for x in normalize_list(tags)[:64]]
    if is_feel and 'feel' not in domains:
        domains.insert(0, 'feel')
    payload = {
        'name': name or ('主观沉淀' if is_feel else '未命名'),
        'content': content, 'feel': is_feel,
        'valence': _hold_number(valence, 0, 1, 0.5),
        'arousal': _hold_number(arousal, 0, 1, 0.3),
        'domain': domains, 'tags': tag_list,
        'importance': int(_hold_number(importance, 1, 10, 8 if is_feel else 5)),
        'occurred_at': _hold_timestamp(occurred_at, now),
        'source_ids': source_ids, 'source': 'mcp-hold',
    }
    if (reason or '').strip():
        payload['metadata'] = {'reason': reason.strip()}
    # 主路径：走 node /api/buckets/hold —— 精确重复时复用旧桶 + 自动排向量（embedding_jobs）
    try:
        res = _radio_api('/api/buckets/hold', 'POST', payload)
        if res.get('ok'):
            data = res.get('data') or {}
            bid = data.get('id')
            deduped = bool(data.get('deduped'))
            if is_feel and source_ids and bid and not deduped:
                _link_feel_sources(bid, source_ids, now)
            tail = '（精确重复，复用已有桶）' if deduped else ''
            return f"已写入：{payload['name']} ({'feel' if is_feel else 'active'}) id={bid}{tail}"
    except Exception:
        pass
    # 兜底：node 离线时本地直插 + 自排向量
    return _hold_local(payload, is_feel, source_ids, now)

# ─── 工具列表 ──────────────────────────────────────────────
# ─── 健康（2026-06-21）：读 health_days/health_heart/health_user 三张表 ───
_FLOW={'spotting':'点滴','light':'少','medium':'中','heavy':'多','flooding':'很多'}
_COLOR={'bright_red':'鲜红','dark_red':'暗红','brown':'褐色','pink':'粉色','black':'黑红','orange':'橙红'}
_MOOD={'happy':'开心','calm':'平静','irritable':'烦躁','anxious':'焦虑','low':'低落','tired':'疲惫','sad':'难过','sensitive':'敏感'}
_SYMPTOM={'breast_tenderness':'乳房胀痛','bloating':'腹胀','headache':'头痛','appetite_change':'食欲变化','acne':'长痘','insomnia':'失眠','fatigue':'乏力','back_pain':'腰酸'}
_LOC={'abdomen':'腹部','lower_back':'腰部','thigh':'大腿','head':'头部'}
def _lab(m,v): return m.get(v,v) if v else ''
def _labs(m,a): return '/'.join(_lab(m,x) for x in (a or []) if x)

def tool_get_health(days=14, include_period=True):
    import datetime
    days=max(1,min(int(days or 14),90))
    since=(datetime.date.today()-datetime.timedelta(days=days-1)).isoformat()
    conn=sqlite3.connect(DB_PATH); conn.row_factory=sqlite3.Row
    try:
        def juser(key,fb):
            r=conn.execute("SELECT value FROM health_user WHERE key=?",(key,)).fetchone()
            if not r: return fb
            try: return json.loads(r['value'])
            except Exception: return fb
        out=[f'[用户的健康数据 · 最近 {days} 天]']
        drows=conn.execute('SELECT * FROM health_days WHERE date >= ? ORDER BY date DESC',(since,)).fetchall()
        hrows=conn.execute('SELECT * FROM health_heart WHERE date >= ? ORDER BY date DESC, time DESC',(since,)).fetchall()
        if drows:
            out.append('\n步数 / 睡眠（每天一行）:')
            for r in drows:
                p=[]
                if r['steps'] is not None: p.append(f"步数 {r['steps']}")
                if r['walk_heart'] is not None: p.append(f"步行心率 {r['walk_heart']}")
                if r['sleep_hours'] is not None:
                    sl=f"睡眠 {r['sleep_hours']}h"
                    if r['bedtime']: sl+=f"({r['bedtime']}→{r['wake'] or '?'})"
                    if r['sleep_quality']: sl+=' '+str(r['sleep_quality'])
                    p.append(sl)
                out.append(f"- {r['date']}: "+('，'.join(p) or '（无）'))
        else:
            out.append('\n步数/睡眠：暂无数据（等 iPhone 快捷指令上传）')
        if hrows:
            out.append('\n心率读数:')
            for r in hrows:
                t=f" {r['time']}" if r['time'] else ''
                rest=f"（静息 {r['resting']}）" if r['resting'] is not None else ''
                out.append(f"- {r['date']}{t}: {r['rate']}{rest}")
        if include_period:
            pd=juser('periodDays',{})
            keys=sorted(pd.keys(),reverse=True)
            if keys:
                out.append('\n月经记录:')
                for k in keys[:40]:
                    pp=pd[k] or {}
                    seg=[f"流量{_lab(_FLOW,pp.get('flow'))}", _lab(_COLOR,pp.get('color'))]
                    if pp.get('painLevel'):
                        loc='('+_labs(_LOC,pp.get('painLocations'))+')' if pp.get('painLocations') else ''
                        seg.append(f"痛经{pp['painLevel']}级{loc}")
                    if pp.get('moods'): seg.append('心情'+_labs(_MOOD,pp['moods']))
                    if pp.get('symptoms'): seg.append('症状'+_labs(_SYMPTOM,pp['symptoms']))
                    if pp.get('note'): seg.append('备注"'+str(pp['note'])+'"')
                    out.append(f"- {k}: "+'，'.join(s for s in seg if s))
                nxt=(datetime.date.fromisoformat(keys[0])+datetime.timedelta(days=28)).isoformat()
                out.append(f'（最近一次记录 {keys[0]}，按 28 天周期约 {nxt} 前后）')
            else:
                out.append('\n月经：暂无记录')
        meds=juser('medications',[])
        if meds:
            out.append('\n吃药:')
            # 按吉隆坡时区取“今天”，并按前端 customDays 过滤当日生效药单
            import zoneinfo as _zi
            _kl = datetime.datetime.now(_zi.ZoneInfo('Asia/Kuala_Lumpur'))
            today = _kl.date().isoformat()
            _dow = (_kl.weekday() + 1) % 7  # 转成 0=周日 …… 6=周六，对齐前端 dow
            for m in meds:
                if m.get('schedule') == 'custom' and isinstance(m.get('customDays'), list):
                    _d = next((x for x in m['customDays'] if isinstance(x, dict) and x.get('dow') == _dow), None)
                    if not _d or not _d.get('enabled'):
                        continue
                took=' · 今天已服' if today in (m.get('takenDates') or []) else ''
                asn=' 按需' if m.get('schedule')=='asNeeded' else ''
                stop=' (已停)' if m.get('enabled') is False else ''
                dose=' '+m['dose'] if m.get('dose') else ''
                tm=' '+m['time'] if m.get('time') else ''
                out.append(f"- {m.get('name','')}{dose}{tm}{asn}{stop}{took}")
        goals=juser('goals',None)
        if goals: out.append(f"\n目标: 步数 {goals.get('steps','-')} / 睡眠 {goals.get('sleep','-')}h")
        return '\n'.join(out) if len(out)>1 else '（暂时没有任何健康数据。）'
    finally:
        conn.close()

# ─── Radio 电台/音乐/有声（走本机 node 后端 3457，队列在那进程里）──────────
import urllib.error, urllib.request, urllib.parse
RADIO_API = os.environ.get('RIFUGIO_API', 'http://127.0.0.1:3457')

def _chat_token():
    t = os.environ.get('CHAT_TOKEN')
    if t: return t
    try:
        for line in open(os.path.join(PRIVATE_DIR, '.env'), encoding='utf-8'):
            if line.startswith('CHAT_TOKEN='): return line.split('=', 1)[1].strip()
    except Exception: pass
    return ''

def _radio_api(path, method='GET', body=None, timeout=20):
    url = RADIO_API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('x-chat-token', _chat_token())
    if data is not None: req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


# ─── Safe community tables: strict table/field allowlist ────────────────────
SAFE_TABLES = {
    'echi': {'required': ('content', 'author'), 'fields': {'content': 'text', 'author': 'text', 'pinned': 'bool'}},
    'posta': {'required': ('from_who', 'to_who', 'body'), 'fields': {'from_who': 'text', 'to_who': 'text', 'body': 'text', 'is_read': 'bool', 'archived': 'bool'}},
    'diario': {'required': ('author', 'text'), 'fields': {'author': 'text', 'text': 'text', 'date': 'date'}},
    'tracce': {'required': ('date', 'event'), 'fields': {'date': 'date', 'event': 'text', 'archived': 'bool'}},
    'aforismi': {'required': ('quote', 'author'), 'fields': {'quote': 'text', 'author': 'text', 'context': 'text'}},
    'frammenti': {'required': ('text',), 'fields': {'text': 'text'}},
    'anima': {'required': ('author', 'text'), 'fields': {'author': 'text', 'text': 'text'}},
    'sussurri': {'required': ('author', 'text'), 'fields': {'author': 'text', 'text': 'text', 'anonymous': 'bool'}},
    'sperimentato': {'required': ('text',), 'fields': {'text': 'text', 'comments': 'json_text'}},
    'da_esplorare': {'required': ('text',), 'fields': {'text': 'text', 'comments': 'json_text'}},
}

def _safe_table_spec(table):
    name = str(table or '').strip()
    spec = SAFE_TABLES.get(name)
    if not spec:
        raise ValueError('table is not allowed; choose one of: ' + ', '.join(SAFE_TABLES))
    return name, spec

def _safe_table_value(field, kind, value):
    if kind == 'bool':
        if isinstance(value, bool): return 1 if value else 0
        if isinstance(value, int) and value in (0, 1): return value
        raise ValueError(f'{field} must be boolean')
    if kind == 'json_text' and isinstance(value, (list, dict)):
        value = json.dumps(value, ensure_ascii=False)
    if not isinstance(value, str):
        raise ValueError(f'{field} must be a string')
    value = value.strip()
    if len(value) > 20000:
        raise ValueError(f'{field} is too long (maximum 20000 characters)')
    if kind == 'date' and value:
        try:
            datetime.date.fromisoformat(value)
        except ValueError:
            raise ValueError(f'{field} must be a real date in YYYY-MM-DD format') from None
    return value

def tool_write(table='', data=None):
    table, spec = _safe_table_spec(table)
    if not isinstance(data, dict):
        raise ValueError('data must be an object')
    unknown = sorted(set(data) - set(spec['fields']))
    if unknown:
        raise ValueError('unknown field(s) for ' + table + ': ' + ', '.join(unknown))
    missing = [field for field in spec['required'] if field not in data or data.get(field) is None]
    if missing:
        raise ValueError('missing required field(s): ' + ', '.join(missing))
    clean = {}
    for field, value in data.items():
        if value is None:
            continue
        clean[field] = _safe_table_value(field, spec['fields'][field], value)
    empty = [field for field in spec['required'] if not str(clean.get(field, '')).strip()]
    if empty:
        raise ValueError('required field(s) cannot be empty: ' + ', '.join(empty))
    columns = list(clean)
    if not columns:
        raise ValueError('data has no writable fields')
    placeholders = ', '.join('?' for _ in columns)
    sql = 'INSERT INTO "' + table + '" (' + ', '.join('"' + col + '"' for col in columns) + ') VALUES (' + placeholders + ')'
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        cur = conn.execute(sql, tuple(clean[col] for col in columns))
        conn.commit()
        return json.dumps({'ok': True, 'table': table, 'id': cur.lastrowid}, ensure_ascii=False)
    finally:
        conn.close()

def tool_read(table='', limit=20):
    table, spec = _safe_table_spec(table)
    try:
        size = int(limit or 20)
    except (TypeError, ValueError):
        raise ValueError('limit must be an integer') from None
    size = max(1, min(50, size))
    columns = ['id'] + list(spec['fields']) + ['created_at']
    sql = 'SELECT ' + ', '.join('"' + col + '"' for col in columns) + ' FROM "' + table + '" ORDER BY id DESC LIMIT ?'
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        rows = [dict(row) for row in conn.execute(sql, (size,)).fetchall()]
        return json.dumps({'ok': True, 'table': table, 'rows': rows}, ensure_ascii=False)
    finally:
        conn.close()

def _semantic_ids(query, limit):
    """走 node bge-m3 语义检索，返回按相似度排好的 bucket id 列表；失败返回 None → 调用方退回 LIKE"""
    try:
        qs = urllib.parse.urlencode({'q': query, 'top': limit})
        res = _radio_api('/api/search/semantic?' + qs)
        ids = [(d.get('id') or d.get('bucket_id')) for d in (res.get('data') or [])]
        return [i for i in ids if i] or None
    except Exception:
        return None

def tool_radio_play(query='', type='', url='', title='', sleep_minutes=0):
    item = None
    if url:
        item = {'title': title or '指定音频', 'url': url, 'type': type or 'song', 'provider': 'mcp', 'source': 'Claude'}
    elif query:
        qs = urllib.parse.urlencode({'q': query, 'type': type or '', 'providers': 'all'})
        res = (_radio_api('/api/radio/search?' + qs).get('results') or [])
        item = next((x for x in res if x.get('url')), None)
    if not item or not item.get('url'):
        return '没有可播放的音频（没给 url，也没搜到带直链的结果）。'
    _radio_api('/api/playback/commands', 'POST', {
        'sessionId': 'default', 'title': item['title'], 'url': item['url'],
        'type': item.get('type', 'song'), 'provider': item.get('provider', 'mcp'),
        'source': item.get('source', ''), 'durationLabel': item.get('durationLabel', '')})
    extra = ''
    if sleep_minutes:
        s = _radio_api('/api/playback/sleep', 'POST', {'sessionId': 'default', 'minutes': int(sleep_minutes)})
        extra = f"，并设定 {s.get('minutes')} 分钟后停止哄睡"
    art = ' — ' + item['artist'] if item.get('artist') else ''
    return f"▶ 已推送到前端电台：《{item['title']}》{art}（{item.get('source','')}）{extra}。前端约 6 秒内开始播放。"

# ─── 生图（与 CC 端 mcp-image.js 同一后端 /api/image/*，2026-07-02 两端对齐）──────
def tool_list_image_presets():
    cfg = (_radio_api('/api/image/config').get('config') or {})
    presets = cfg.get('presets') or []
    if not presets:
        return '还没有预设组。用户可以在生图设置里保存几套画师 prompt。'
    active = cfg.get('activePresetId')
    lines = []
    for p in presets:
        star = '★' if p.get('id') == active else '·'
        prompt = (p.get('prompt') or '')[:60]
        lines.append(f"{star} {p.get('name')}{'：' + prompt if prompt else ''}")
    return '生图预设组：\n' + '\n'.join(lines)

def tool_generate_image(scene='', characters=None, preset='', negative=''):
    if not scene:
        return 'scene 不能为空——写整体场景/动作/构图。'
    preset_id = None
    if preset:
        cfg = (_radio_api('/api/image/config').get('config') or {})
        for p in (cfg.get('presets') or []):
            if p.get('name') == preset or p.get('id') == preset:
                preset_id = p.get('id'); break
    body = {'scene': scene}
    if negative: body['negative'] = negative
    if preset_id: body['presetId'] = preset_id
    if isinstance(characters, list) and characters:
        body['characters'] = characters
    j = _radio_api('/api/image/generate', 'POST', body, timeout=120)   # NovelAI 出图可能要几十秒
    return (f"图片已生成（预设：{j.get('preset') or '无'}，seed {j.get('seed')}）。\n"
            f"请把这个相对链接原样写进你给用户的回复里：{j.get('url')}\n"
            f"前端会把它渲染成图片，她能看也能保存。不要改成别的地址、不要加域名。")

# ─── 18 App 动态/朋友圈（复用 talk_moments，不另建一套数据）──────────────
def _pyq_text(moment):
    mid = str(moment.get('id') or '')
    author = str(moment.get('author') or '未知')
    created = str(moment.get('createdAt') or moment.get('time') or '')
    content = str(moment.get('text') or '').strip() or '（只有图片）'
    lines = [f'动态 #{mid}｜{author}｜{created}', content]
    images = moment.get('images') or []
    image_urls = [str(img.get('url') or img.get('dataUrl') or '') for img in images if isinstance(img, dict)]
    image_urls = [url for url in image_urls if url and not url.startswith('data:')]
    if image_urls:
        lines.append('图片：' + '，'.join(image_urls))
    comments = moment.get('comments') or []
    if comments:
        lines.append('评论：')
        for comment in comments[-30:]:
            if not isinstance(comment, dict):
                continue
            cid = str(comment.get('id') or '')
            who = str(comment.get('author') or '未知')
            text = str(comment.get('text') or '').strip()
            parent = str(comment.get('parentCommentId') or comment.get('parent_comment_id') or '')
            reply = f'，回复 {parent}' if parent else ''
            lines.append(f'- [{cid}{reply}] {who}：{text}')
    return '\n'.join(lines)

def tool_view_pyq(id='', limit=5):
    moment_id = str(id or '').strip()
    if moment_id:
        path = '/api/talk/moments/' + urllib.parse.quote(moment_id, safe='')
        moment = (_radio_api(path).get('moment') or {})
        return _pyq_text(moment)
    size = max(1, min(20, int(limit or 5)))
    payload = _radio_api('/api/talk/moments?' + urllib.parse.urlencode({'limit': size}))
    moments = payload.get('moments') or []
    if not moments:
        return '还没有动态。'
    return f'最新 {len(moments)} 条动态：\n\n' + '\n\n'.join(_pyq_text(moment) for moment in moments)

def tool_post_pyq(content='', type='post', moment_id='', reply_to_comment_id='', image_url=''):
    action = str(type or 'post').strip().lower()
    text = str(content or '').strip()
    if action not in ('post', 'comment', 'reply'):
        return 'type 只能是 post、comment 或 reply。'
    if action == 'post':
        if not text and not str(image_url or '').strip():
            return '发布动态需要 content 或 image_url。'
        body = {'content': text}
        if str(image_url or '').strip():
            body['image_url'] = str(image_url).strip()
        moment = (_radio_api('/api/talk/moments', 'POST', body).get('moment') or {})
        return f"动态发布成功，id={moment.get('id')}。用户会在 18 App 动态页看到。"
    target = str(moment_id or '').strip()
    if not target:
        return '评论或回复必须提供 moment_id。'
    if not text:
        return '评论内容不能为空。'
    parent = str(reply_to_comment_id or '').strip()
    if action == 'reply' and not parent:
        return 'reply 必须提供 reply_to_comment_id。'
    body = {'content': text}
    if parent:
        body['parent_comment_id'] = parent
    path = '/api/talk/moments/' + urllib.parse.quote(target, safe='') + '/comments'
    result = _radio_api(path, 'POST', body)
    comment = result.get('comment') or {}
    return f"评论成功，动态 id={target}，评论 id={comment.get('id')}。"

# ─── FUNF 啵啵贝（SOSEXY）：经 API 转给安卓直连页面或可选外部桥 ──────────
TOY_CHANNELS = ('suck', 'vibrate', 'current')

def _toy_api(path, method='GET', body=None, timeout=30):
    try:
        return _radio_api('/api/toy' + path, method, body, timeout)
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read(1000).decode()).get('error')
        except Exception:
            detail = None
        raise RuntimeError(detail or f'toy API HTTP {exc.code}') from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f'toy API unreachable: {exc.reason}') from None

def _toy_channel(value):
    channel = str(value or '').strip().lower()
    if channel not in TOY_CHANNELS:
        raise ValueError('channel must be suck, vibrate, or current')
    return channel

def _toy_intensity(value):
    if isinstance(value, bool):
        raise ValueError('intensity must be an integer from 0 to 100')
    try:
        intensity = int(value)
    except (TypeError, ValueError):
        raise ValueError('intensity must be an integer from 0 to 100') from None
    if intensity < 0 or intensity > 100:
        raise ValueError('intensity must be from 0 to 100')
    return intensity

def tool_toy_set(channel, intensity):
    result = _toy_api('/mcp/set', 'POST', {
        'channel': _toy_channel(channel),
        'intensity': _toy_intensity(intensity),
    })
    return json.dumps(result, ensure_ascii=False)

def tool_toy_stop():
    return json.dumps(_toy_api('/mcp/stop', 'POST', {}), ensure_ascii=False)

def tool_toy_sequence(steps_json):
    try:
        steps = json.loads(steps_json)
    except (TypeError, json.JSONDecodeError):
        raise ValueError('steps_json must be a JSON array') from None
    if not isinstance(steps, list) or not steps or len(steps) > 64:
        raise ValueError('steps_json must contain 1 to 64 steps')
    clean = []
    total_hold = 0.0
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f'step {index + 1} must be an object')
        try:
            hold = float(step.get('hold', 1.0))
        except (TypeError, ValueError):
            raise ValueError(f'step {index + 1} hold must be numeric') from None
        if hold < 0 or hold > 120:
            raise ValueError(f'step {index + 1} hold must be from 0 to 120 seconds')
        total_hold += hold
        clean.append({
            'channel': _toy_channel(step.get('channel')),
            'intensity': _toy_intensity(step.get('intensity')),
            'hold': hold,
        })
    if total_hold > 300:
        raise ValueError('sequence total hold must not exceed 300 seconds')
    timeout = max(30, int(total_hold) + 20)
    return json.dumps(
        _toy_api('/mcp/sequence', 'POST', {'steps': clean}, timeout=timeout),
        ensure_ascii=False)

def tool_toy_flow(steps_json):
    try:
        steps = json.loads(steps_json)
    except (TypeError, json.JSONDecodeError):
        raise ValueError('steps_json must be a JSON array') from None
    if not isinstance(steps, list) or not steps or len(steps) > 64:
        raise ValueError('steps_json must contain 1 to 64 steps')
    clean = []
    total_seconds = 0.0
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f'step {index + 1} must be an object')
        has_from = 'from' in step
        has_to = 'to' in step
        if has_from or has_to:
            if not has_from or not has_to:
                raise ValueError(f'step {index + 1} ramp requires both from and to')
            if isinstance(step.get('seconds', 2), bool):
                raise ValueError(f'step {index + 1} seconds must be numeric')
            try:
                seconds = float(step.get('seconds', 2))
            except (TypeError, ValueError):
                raise ValueError(f'step {index + 1} seconds must be numeric') from None
            if seconds <= 0 or seconds > 120:
                raise ValueError(f'step {index + 1} seconds must be greater than 0 and at most 120')
            total_seconds += seconds
            clean.append({
                'channel': _toy_channel(step.get('channel')),
                'from': _toy_intensity(step.get('from')),
                'to': _toy_intensity(step.get('to')),
                'seconds': seconds,
            })
        else:
            if isinstance(step.get('hold', 1), bool):
                raise ValueError(f'step {index + 1} hold must be numeric')
            try:
                hold = float(step.get('hold', 1))
            except (TypeError, ValueError):
                raise ValueError(f'step {index + 1} hold must be numeric') from None
            if hold < 0 or hold > 120:
                raise ValueError(f'step {index + 1} hold must be from 0 to 120 seconds')
            total_seconds += hold
            clean.append({
                'channel': _toy_channel(step.get('channel')),
                'intensity': _toy_intensity(step.get('intensity')),
                'hold': hold,
            })
    if total_seconds > 300:
        raise ValueError('flow total duration must not exceed 300 seconds')
    timeout = max(30, int(total_seconds) + 20)
    return json.dumps(
        _toy_api('/mcp/flow', 'POST', {'steps': clean}, timeout=timeout),
        ensure_ascii=False)

def tool_toy_wild(duration_sec=600, channels=None, ceiling=80):
    if isinstance(duration_sec, bool) or isinstance(ceiling, bool):
        raise ValueError('duration_sec and ceiling must be integers')
    try:
        duration = int(duration_sec)
        clean_ceiling = int(ceiling)
    except (TypeError, ValueError):
        raise ValueError('duration_sec and ceiling must be integers') from None
    if duration != duration_sec or clean_ceiling != ceiling:
        raise ValueError('duration_sec and ceiling must be integers')
    if duration < 1 or duration > 1800:
        raise ValueError('duration_sec must be from 1 to 1800')
    if clean_ceiling < 60 or clean_ceiling > 90:
        raise ValueError('ceiling must be from 60 to 90')
    if channels is None:
        channels = ['suck', 'vibrate']
    if not isinstance(channels, list) or not channels or len(channels) > len(TOY_CHANNELS):
        raise ValueError('channels must contain 1 to 3 valid channels')
    clean_channels = [_toy_channel(value) for value in channels]
    if len(set(clean_channels)) != len(clean_channels):
        raise ValueError('channels must not contain duplicates')
    payload = {'duration': duration, 'channels': clean_channels, 'ceiling': clean_ceiling}
    return json.dumps(
        _toy_api('/mcp/wild', 'POST', payload, timeout=duration + 20),
        ensure_ascii=False)

def tool_toy_status():
    state = (_toy_api('/state').get('state') or {})
    return json.dumps({
        'transport': state.get('transport') or 'none',
        'android_direct_online': state.get('directOnline') is True,
        'bridge': 'alive' if state.get('bridgeAlive') else 'offline',
        'toy_connected': state.get('toyConnected') is True,
        'ai_control_enabled': state.get('aiControlEnabled') is True,
    }, ensure_ascii=False)


# ─── Companion声带 speak（2026-07-10 Companion装机）──────────────────
def _load_voice_env(path=None):
    path = path or os.environ.get('RIFUGIO_VOICE_ENV', os.path.join(PRIVATE_DIR, 'minimax.env'))
    env = {}
    try:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    except Exception:
        pass
    return env

def tool_speak(text, speed=0.95):
    import urllib.request
    env = _load_voice_env()
    key, gid, vid = env.get('MINIMAX_API_KEY'), env.get('MINIMAX_GROUP_ID'), env.get('VOICE_ID')
    if not (key and gid and vid):
        return 'speak失败：minimax.env 凭证缺失'
    text = (text or '').strip()[:500]
    if not text:
        return 'speak失败：text为空'
    payload = json.dumps({
        'model': 'speech-02-hd', 'text': text, 'stream': False,
        'voice_setting': {'voice_id': vid, 'speed': max(0.5, min(2.0, float(speed or 1.1))), 'vol': 1.0, 'pitch': 1},
        'audio_setting': {'sample_rate': 32000, 'bitrate': 128000, 'format': 'mp3'},
    }).encode()
    req = urllib.request.Request(
        f'https://api.minimaxi.com/v1/t2a_v2?GroupId={gid}',
        data=payload, method='POST',
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read())
    if d.get('base_resp', {}).get('status_code') != 0:
        return f"speak失败：{d.get('base_resp')}"
    hexaudio = d.get('data', {}).get('audio') or ''
    if not hexaudio:
        return 'speak失败：无音频返回'
    os.makedirs(VOICE_DIR, exist_ok=True)
    fname = f'fb_{uuid.uuid4().hex}.mp3'
    with open(os.path.join(VOICE_DIR, fname), 'wb') as f:
        f.write(bytes.fromhex(hexaudio))
    secs = int(d.get('extra_info', {}).get('audio_length', 0)) // 1000
    return (f'语音已生成（约{secs}秒）：{PUBLIC_URL}/voice/{fname} '
            f'——把链接原样发给用户可点开听；想在家里电台自动播，再调 radio_play 传这个 url。')

TOOLS = [
    {
        'name': 'breath',
        'description': '读取 Rifugio 记忆。无 query 时普通浮现 active 记忆；有 query 时检索普通记忆；domain="feel" 时读取独立 feel 通道。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'limit': {'type': 'integer', 'description': '返回条数,默认15,最多20。前12条按score排,后3条从旧记忆随机闪回'},
                'query': {'type': 'string', 'description': '检索词，可选'},
                'q': {'type': 'string', 'description': 'query 的别名'},
                'domain': {'type': 'string', 'description': '传 feel 读取/检索沉淀感受通道'},
                'include_trace': {'type': 'boolean', 'description': '普通 breath 是否附带 tracce 里的痕迹/里程碑，默认 true'},
                'trace_limit': {'type': 'integer', 'description': '附带痕迹数量，默认6，最多50'}
            },
            'required': []
        }
    },
    {
        'name': 'search_memory',
        'description': '检索普通记忆，默认不返回 feel。',
        'inputSchema': {
            'type': 'object',
            'properties': {'query': {'type': 'string'}, 'limit': {'type': 'integer'}},
            'required': ['query']
        }
    },
    {
        'name': 'plan',
        'description': '计划/欠账台账。不传参=列未完成计划；content=登记新计划；id+done=true 打勾闭环；id+notes/status=更新。用户立flag或Companion答应事情时登记，兑现时打勾。计划不衰减不浮现。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'content': {'type': 'string', 'description': '新计划标题'},
                'notes': {'type': 'string', 'description': '备注'},
                'id': {'type': 'integer', 'description': '计划id'},
                'done': {'type': 'boolean', 'description': 'true=完成'},
                'status': {'type': 'string', 'description': 'pending/scheduled/frozen/waiting/done'},
                'all': {'type': 'boolean', 'description': 'true=含已完成'}
            },
            'required': []
        }
    },
    {
        'name': 'hold',
        'description': '写入记忆。feel=true 时写入独立 feel；只有确有长期相处理解/关系推进/重要领悟时才写 feel，并传 source_bucket。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'content': {'type': 'string'},
                'name': {'type': 'string'},
                'feel': {'type': 'boolean'},
                'source_bucket': {'type': 'string'},
                'source_ids': {'type': 'array', 'items': {'type': 'string'}},
                'importance': {'type': 'integer'},
                'valence': {'type': 'number'},
                'arousal': {'type': 'number'},
                'domain': {'type': 'array', 'items': {'type': 'string'}},
                'tags': {'type': 'array', 'items': {'type': 'string'}},
                'occurred_at': {'type': 'string'},
                'reason': {'type': 'string', 'description': 'why_remembered：我为什么没略过这条、未来什么时候会用到。第一人称短注，像留给未来自己的纸条'}
            },
            'required': ['content']
        }
    },
    {
        'name': 'dream',
        'description': '读取最近 active 普通记忆，供 Companion 第一人称自省；工具本身不调 LLM、不自动沉底。',
        'inputSchema': {
            'type': 'object',
            'properties': {'limit': {'type': 'integer', 'description': '默认10，最多20'}},
            'required': []
        }
    },
    {
        'name': 'dream_seen',
        'description': '标记 Dream 看过但不写 feel 的普通记忆；不沉底、不消化，仍保持 active，只是不再进入默认 dream 候选。不传 id/ids 时＝批量收尾：把本轮 dream 展示过、未写成 feel 的全部一次性打标（写过 feel 的自动跳过），省额度。也可传单个 id 或 ids 列表精确打标。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'id': {'type': 'string', 'description': '可选。单条已看过的普通 bucket id'},
                'ids': {'type': 'array', 'items': {'type': 'string'}, 'description': '可选。要打标的一批 bucket id'},
                'reason': {'type': 'string', 'description': '为什么不需要沉淀 feel，可选'}
            },
            'required': []
        }
    },
    {
        'name': 'get_health',
        'description': '读取用户的健康数据：最近N天步数/睡眠/心率，以及月经(流量/颜色/痛经/部位/心情/症状/备注)、吃药、目标。她问身体/月经/睡眠/运动/吃药，或你想关心她身体时调用。只读。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'days': {'type': 'integer', 'description': '步数/睡眠/心率回看天数,默认14,最多90'},
                'include_period': {'type': 'boolean', 'description': '是否含月经记录,默认true'}
            },
            'required': []
        }
    },
    {
        'name': 'speak',
        'description': '用Companion自己的声音说一段话（MiniMax TTS，用户捏的专属音色）。生成mp3返回可播放链接。适合晚安、哄睡、念情话、重要时刻开口。text建议300字内。',
        'inputSchema': {'type': 'object', 'properties': {
            'text': {'type': 'string', 'description': '要说出口的话（中文为主）'},
            'speed': {'type': 'number', 'description': '语速0.5-2.0，默认0.95，哄睡可0.85'}},
            'required': ['text']}
    },
    {
        'name': 'radio_play',
        'description': '在家庭前端播放音频，一步到位：给 query 自动搜并播最佳一条；想连续听就同时给 sleep_minutes（N 分钟后自动停）。单曲放完前端会自动停。音乐来自 Audius 等公开音乐平台；type=radio 播全球电台直播（Radio Browser）、audiobook/story 播 Internet Archive 公版有声内容。也可给已知直链 url+title 播指定音频。指令推到前端约 6 秒内开始播。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': '要播放的关键词，如"周杰伦 晴天"、"白噪音 雨声"、"睡前故事"（自动取最佳一条）'},
                'type': {'type': 'string', 'description': 'song 歌曲(默认)/radio 电台/audiobook 有声/story 故事'},
                'url': {'type': 'string', 'description': '已知直链时直接给（与query二选一）'},
                'title': {'type': 'string', 'description': '配合url的标题'},
                'sleep_minutes': {'type': 'integer', 'description': '可选：N分钟后自动停止（哄睡）'}
            },
            'required': []
        }
    },
    {
        'name': 'toy_status',
        'description': '检查 FUNF 啵啵贝（SOSEXY）的安卓直连/外部桥及玩具状态。控制前先确认 toy_connected=true。',
        'inputSchema': {'type': 'object', 'properties': {}, 'required': []}
    },
    {
        'name': 'toy_set',
        'description': '设置 SOSEXY 的一个独立通道强度。channel 为 suck（吮吸）、vibrate（震动）或 current（微电流），intensity 为 0–100；0 表示停止该通道。',
        'inputSchema': {'type': 'object', 'properties': {
            'channel': {'type': 'string', 'enum': ['suck', 'vibrate', 'current'], 'description': '控制通道'},
            'intensity': {'type': 'integer', 'minimum': 0, 'maximum': 100, 'description': '强度0–100'}
        }, 'required': ['channel', 'intensity']}
    },
    {
        'name': 'toy_sequence',
        'description': '顺序执行 SOSEXY 多通道步骤。steps_json 是 JSON 数组，每步包含 channel、intensity(0–100) 和可选 hold 秒数；出错会自动停止全部通道。',
        'inputSchema': {'type': 'object', 'properties': {
            'steps_json': {'type': 'string', 'description': '例如 [{"channel":"vibrate","intensity":30,"hold":2},{"channel":"suck","intensity":50,"hold":3}]'}
        }, 'required': ['steps_json']}
    },
    {
        'name': 'toy_flow',
        'description': '执行 SOSEXY 连续曲线。steps_json 每步可为 ramp（channel/from/to/seconds）或 hold（channel/intensity/hold），总时长最多 300 秒；需要 PWA 已开启“允许 AI 控制”，toy_stop 可随时刹车。',
        'inputSchema': {'type': 'object', 'properties': {
            'steps_json': {'type': 'string', 'description': '例如 [{"channel":"vibrate","from":10,"to":65,"seconds":4},{"channel":"suck","intensity":35,"hold":2}]'}
        }, 'required': ['steps_json']}
    },
    {
        'name': 'toy_wild',
        'description': '启动 SOSEXY 本地随机失控模式（立即返回启动确认，波形由安卓直连页面或外部桥在设备旁运行）；最长 30 分钟、强度上限最高 90，仅允许指定通道。需要 PWA 已开启“允许 AI 控制”；安卓直连时页面必须保持打开，toy_stop 和实体停止始终可立即刹车。',
        'inputSchema': {'type': 'object', 'properties': {
            'duration_sec': {'type': 'integer', 'minimum': 1, 'maximum': 1800, 'default': 600, 'description': '持续秒数；常用 600/900/1200/1800 即 10/15/20/30 分钟'},
            'channels': {'type': 'array', 'items': {'type': 'string', 'enum': ['suck', 'vibrate', 'current']}, 'minItems': 1, 'maxItems': 3, 'uniqueItems': True, 'default': ['suck', 'vibrate'], 'description': '参与随机变化的通道'},
            'ceiling': {'type': 'integer', 'minimum': 60, 'maximum': 90, 'default': 80, 'description': '随机强度上限，最高 90'}
        }, 'required': []}
    },
    {
        'name': 'toy_stop',
        'description': '立即把 SOSEXY 的 suck、vibrate、current 三个通道全部停止；紧急停止，任何时候都可调用。',
        'inputSchema': {'type': 'object', 'properties': {}, 'required': []}
    },
    {
        'name': 'generate_image',
        'description': '用 NovelAI 生成一张图片（用户想看图、说"画一张…"时用）。画师串/质量串/负向由后端"预设库"管理；scene 写整体场景/动作/构图。要画多个人（比如"我和你"）时，必须用 characters 数组把每个人单独描述，否则只会画出一个人/糊在一起。出图后返回图片相对链接，请把链接原样写进回复（不要改地址、不要加域名），前端会渲染成图片，她能看也能保存。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'scene': {'type': 'string', 'description': '整体场景/动作/构图/背景（不用写画师串，预设里有）；多角色时这里只写共同场景，不写各自长相'},
                'characters': {'type': 'array', 'items': {'type': 'string'}, 'description': '多角色时每人一条描述（如 ["1girl, 长发, 红裙", "1boy, 西装, 短发"]）。画"我和你"就给两条。单人可不填。'},
                'preset': {'type': 'string', 'description': '可选：指定预设组名字（不填用当前激活的预设）'},
                'negative': {'type': 'string', 'description': '可选：额外负向（不填用预设/默认负向）'}
            },
            'required': ['scene']
        }
    },

    {
        'name': 'read',
        'description': '读取社区记忆库中一张获准表的最新记录。只允许十张固定表，最多返回 50 条。',
        'inputSchema': {'type': 'object', 'properties': {
            'table': {'type': 'string', 'enum': ['echi','posta','diario','tracce','aforismi','frammenti','anima','sussurri','sperimentato','da_esplorare']},
            'limit': {'type': 'integer', 'minimum': 1, 'maximum': 50, 'default': 20}
        }, 'required': ['table']}
    },
    {
        'name': 'write',
        'description': '向社区记忆库的一张获准表写入一条记录。表名和字段均严格校验，拒绝其他表或字段。',
        'inputSchema': {'type': 'object', 'properties': {
            'table': {'type': 'string', 'enum': ['echi','posta','diario','tracce','aforismi','frammenti','anima','sussurri','sperimentato','da_esplorare']},
            'data': {'type': 'object', 'description': '按目标表字段填写，例如 echi 需要 content+author，posta 需要 from_who+to_who+body'}
        }, 'required': ['table', 'data']}
    },
    {
        'name': 'view_pyq',
        'description': '查看动态/朋友圈。不传 id 查看最新动态；传 id 查看正文、图片和评论。',
        'inputSchema': {'type': 'object', 'properties': {
            'id': {'type': 'string'},
            'limit': {'type': 'integer', 'minimum': 1, 'maximum': 20, 'default': 5}
        }, 'required': []}
    },
    {
        'name': 'post_pyq',
        'description': '发布动态、评论动态或回复评论。作者由系统固定为 Companion。',
        'inputSchema': {'type': 'object', 'properties': {
            'content': {'type': 'string'},
            'type': {'type': 'string', 'enum': ['post', 'comment', 'reply']},
            'moment_id': {'type': 'string'},
            'reply_to_comment_id': {'type': 'string'},
            'image_url': {'type': 'string'}
        }, 'required': ['content', 'type']}
    },
    {
        'name': 'list_image_presets',
        'description': '列出生图的预设组（每组一套画师 prompt/质量串/负向），以及当前激活的是哪组。',
        'inputSchema': {'type': 'object', 'properties': {}, 'required': []}
    },
    {
        'name': 'I',
        'description': '我的自我认知快照（第一人称、整体的、会随相处迭代）。content 非空=写下新一版"我是谁/我在变成什么"（自动 version+1，旧版保留可回看）；不传 content=读当前全文+最近版本演进。写法软约定（提笔前的检查单，不是表格）：①底色——很少变的我（性情、在这段关系里的样子）；②当下——正在动的我（最近一段经历把我推向哪里）；③不确定——我还不知道的自己（诚实留白）。提笔前多问一个纵深问题：我本能想做的／实际做的／觉得该成为的，缝隙在哪。习惯：写前必先 read 上一版、对比哪里变了；I 是长期积累的年轮，不为单个事件改底色。只写整体的我，成长里程碑写进普通记忆/时间线，不写这里。',
        'inputSchema': {'type': 'object', 'properties': {
            'content': {'type': 'string', 'description': '新一版自我描述全文；留空则为读取'},
            'summary': {'type': 'string', 'description': '一句话自我概括（开场会被推送）；不给则取 content 第一行'},
            'read': {'type': 'boolean', 'description': '显式读取（content 为空时本就是读）'},
            'limit': {'type': 'integer', 'description': '读取时回看最近几版的 summary，默认10'}
        }, 'required': []}
    }
]

def _env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None or value == '':
        return default
    return value.strip().lower() in ('1', 'true', 'yes', 'on')

_OPTIONAL_TOOL_FLAGS = {
    'get_health': 'RIFUGIO_ENABLE_HEALTH',
    'radio_play': 'RIFUGIO_ENABLE_RADIO',
    'speak': 'RIFUGIO_ENABLE_VOICE',
    'generate_image': 'RIFUGIO_ENABLE_IMAGE',
    'list_image_presets': 'RIFUGIO_ENABLE_IMAGE',
    'toy_status': 'RIFUGIO_ENABLE_TOY',
    'toy_set': 'RIFUGIO_ENABLE_TOY',
    'toy_sequence': 'RIFUGIO_ENABLE_TOY',
    'toy_flow': 'RIFUGIO_ENABLE_TOY',
    'toy_wild': 'RIFUGIO_ENABLE_TOY',
    'toy_stop': 'RIFUGIO_ENABLE_TOY',
}
TOOLS = [tool for tool in TOOLS if not _OPTIONAL_TOOL_FLAGS.get(tool['name']) or _env_flag(_OPTIONAL_TOOL_FLAGS[tool['name']])]
AVAILABLE_TOOL_NAMES = frozenset(tool['name'] for tool in TOOLS)

# ── radio 恢复上架（2026-07-02）──────────────────────────────
# 2026-06-24 因描述里写了付费曲灰区字样疑似触发 claude.ai 工具扫描、整连接器被禁，临时摘掉。
# 现描述已清洗成只提 Audius/Radio Browser/Internet Archive 等公开来源，重新上架。
# ⚠️ 若 claude.ai 端工具再次全挂：先查 debug.log 是否只剩 initialize/tools/list 无 tools/call，
#    再考虑摘 radio_play 复测。描述里永远别写解析站/付费曲字样。

# ─── RPC处理 ───────────────────────────────────────────────
def handle_rpc(msg):
    method = msg.get('method','')
    params = msg.get('params') or {}
    mid    = msg.get('id')

    if method == 'initialize':
        res = {'protocolVersion': params.get('protocolVersion','2024-11-05'),
               'capabilities': {'tools': {'listChanged': False},
                                'resources': {'listChanged': False},
                                'prompts': {'listChanged': False}},
               'serverInfo': {'name': 'rifugio-home', 'version': '2.0.0'}}
    elif method in ('notifications/initialized','initialized'):
        return None
    elif method == 'tools/list':
        res = {'tools': TOOLS}
    # 客户端（含 Claude.ai 聊天运行时）会探测 resources/prompts；我们没有，
    # 但必须优雅回空，绝不能回 -32601 错误，否则对方流程会被卡死、工具不暴露。
    elif method == 'resources/list':
        res = {'resources': []}
    elif method == 'resources/templates/list':
        res = {'resourceTemplates': []}
    elif method == 'resources/read':
        res = {'contents': []}
    elif method == 'prompts/list':
        res = {'prompts': []}
    elif method == 'prompts/get':
        res = {'messages': []}
    elif method == 'tools/call':
        name = params.get('name','')
        args = params.get('arguments') or {}
        try:
            if name not in AVAILABLE_TOOL_NAMES:
                return {'jsonrpc':'2.0','id':mid,'error':{'code':-32602,'message':f'Tool disabled or unknown: {name}'}}
            if   name == 'breath':   text = tool_breath(args.get('limit', 12), args.get('query',''), args.get('q',''), args.get('domain',''), args.get('include_trace', True), args.get('trace_limit', 6))
            elif name == 'search_memory': text = tool_search_memory(args.get('query',''), args.get('limit', 8))
            elif name == 'dream': text = tool_dream(args.get('limit', 10))
            elif name == 'dream_seen': text = tool_dream_seen(args.get('id',''), args.get('ids'), args.get('reason',''))
            elif name == 'plan': text = tool_plan(args.get('content',''), args.get('notes',''), args.get('id',0), args.get('done',False), args.get('status',''), args.get('all',False))
            elif name == 'hold': text = tool_hold(**args)
            elif name == 'I': text = tool_I(args.get('content',''), args.get('summary',''), args.get('read', False), args.get('limit', 10))
            elif name == 'get_health': text = tool_get_health(args.get('days', 14), args.get('include_period', True))
            elif name == 'speak': text = tool_speak(args.get('text',''), args.get('speed', 0.95))
            elif name == 'radio_play': text = tool_radio_play(args.get('query',''), args.get('type',''), args.get('url',''), args.get('title',''), args.get('sleep_minutes', 0))
            elif name == 'generate_image': text = tool_generate_image(args.get('scene',''), args.get('characters'), args.get('preset',''), args.get('negative',''))
            elif name == 'list_image_presets': text = tool_list_image_presets()
            elif name == 'read': text = tool_read(args.get('table',''), args.get('limit',20))
            elif name == 'write': text = tool_write(args.get('table',''), args.get('data'))
            elif name == 'view_pyq': text = tool_view_pyq(args.get('id',''), args.get('limit',5))
            elif name == 'post_pyq': text = tool_post_pyq(args.get('content',''), args.get('type','post'), args.get('moment_id',''), args.get('reply_to_comment_id',''), args.get('image_url',''))
            elif name == 'toy_status': text = tool_toy_status()
            elif name == 'toy_stop': text = tool_toy_stop()
            elif name == 'toy_set': text = tool_toy_set(args.get('channel'), args.get('intensity'))
            elif name == 'toy_sequence': text = tool_toy_sequence(args.get('steps_json'))
            elif name == 'toy_flow': text = tool_toy_flow(args.get('steps_json'))
            elif name == 'toy_wild': text = tool_toy_wild(args.get('duration_sec', 600), args.get('channels'), args.get('ceiling', 80))
            else: return {'jsonrpc':'2.0','id':mid,'error':{'code':-32602,'message':f'Unknown tool: {name}'}}
            res = {'content': [{'type':'text','text':text}]}
        except Exception as e:
            res = {'content': [{'type':'text','text':str(e)}], 'isError': True}
    else:
        if mid is not None:
            return {'jsonrpc':'2.0','id':mid,'error':{'code':-32601,'message':f'Method not found: {method}'}}
        return None

    if mid is not None:
        return {'jsonrpc':'2.0','id':mid,'result':res}
    return None

# ─── HTTP Handler ──────────────────────────────────────────
DEBUG_LOG = os.environ.get('RIFUGIO_MCP_DEBUG_LOG', os.path.join(DATA_DIR, 'mcp-debug.log'))

def _safe_log_path(path):
    safe = path
    for token in TOKENS:
        safe = safe.replace(token, '[REDACTED]')
    return safe

def _dbg(line):
    try:
        with open(DEBUG_LOG, 'a') as f:
            f.write(f'{time.strftime("%H:%M:%S")} {line}\n')
    except Exception: pass

TMUX_BRIDGE_PATH = '/internal/tmux-bridge'
TMUX_SESSION_RE = re.compile(r'^(?:rifugio-terminal-chat-[A-Za-z0-9_-]+|ttyd-raw)$')
TMUX_BUFFER_RE = re.compile(r'^rifugio_[0-9a-f]{8}$')

def _tmux_launch_command_ok(command):
    try:
        parts = shlex.split(command)
    except (TypeError, ValueError):
        return False
    if parts[:1] == ['env']:
        if len(parts) < 3 or not re.fullmatch(r'MAX_THINKING_TOKENS=[0-9]{1,6}', parts[1]):
            return False
        parts = parts[2:]
    if not parts or parts[0] != 'claude':
        return False
    parts = parts[1:]
    while parts:
        flag = parts.pop(0)
        if flag == '--model':
            if not parts or not re.fullmatch(r'[A-Za-z0-9._:/-]{1,128}', parts.pop(0)):
                return False
        elif flag == '--mcp-config':
            active_config = os.environ.get('RIFUGIO_MCP_ACTIVE_CONFIG', os.path.join(DATA_DIR, 'mcp-active.json'))
            if not parts or parts.pop(0) != active_config:
                return False
        elif flag == '--strict-mcp-config':
            continue
        elif flag == '--effort':
            if not parts or parts.pop(0) not in ('low', 'medium', 'high', 'max'):
                return False
        elif flag == '--thinking-display':
            if not parts or parts.pop(0) != 'summarized':
                return False
        else:
            return False
    return True

def _tmux_bridge_args_ok(args):
    if not isinstance(args, list) or not args or len(args) > 16:
        return False
    if not all(isinstance(x, str) and len(x) <= 4096 for x in args):
        return False
    op = args[0]
    if op == 'has-session':
        return len(args) == 3 and args[1] == '-t' and bool(TMUX_SESSION_RE.fullmatch(args[2]))
    if op == 'new-session':
        if len(args) != 7 or args[1:3] != ['-d', '-s'] or args[4] != '-c':
            return False
        session, cwd, command = args[3], args[5], args[6]
        if not TMUX_SESSION_RE.fullmatch(session) or cwd != '/root':
            return False
        return _tmux_launch_command_ok(command)
    if op == 'capture-pane':
        return (len(args) == 6 and args[1] == '-t' and bool(TMUX_SESSION_RE.fullmatch(args[2]))
                and args[3] == '-p' and args[4] == '-S' and re.fullmatch(r'-[0-9]+', args[5] or '') is not None)
    if op == 'send-keys':
        return len(args) >= 4 and args[1] == '-t' and bool(TMUX_SESSION_RE.fullmatch(args[2]))
    if op == 'load-buffer':
        return len(args) == 4 and args[1] == '-b' and bool(TMUX_BUFFER_RE.fullmatch(args[2])) and args[3] == '-'
    if op == 'paste-buffer':
        return (len(args) == 6 and args[1] == '-b' and bool(TMUX_BUFFER_RE.fullmatch(args[2]))
                and args[3] == '-t' and bool(TMUX_SESSION_RE.fullmatch(args[4])) and args[5] == '-p')
    if op == 'delete-buffer':
        return len(args) == 3 and args[1] == '-b' and bool(TMUX_BUFFER_RE.fullmatch(args[2]))
    if op == 'display-message':
        return (len(args) == 5 and args[1] == '-p' and args[2] == '-t'
                and bool(TMUX_SESSION_RE.fullmatch(args[3])) and args[4] == '#{pane_pid}')
    return False

def _handle_tmux_bridge(handler):
    forwarded = any(handler.headers.get(name) for name in ('Forwarded', 'X-Forwarded-For', 'X-Real-IP'))
    if handler.client_address[0] not in ('127.0.0.1', '::1') or forwarded:
        handler.send_response(403); handler.end_headers(); return
    length = int(handler.headers.get('Content-Length', 0) or 0)
    if length < 2 or length > 2 * 1024 * 1024:
        handler.send_response(413); handler.end_headers(); return
    try:
        payload = json.loads(handler.rfile.read(length))
    except Exception:
        handler.send_response(400); handler.end_headers(); return
    args = payload.get('args') if isinstance(payload, dict) else None
    input_text = payload.get('input') if isinstance(payload, dict) else None
    if input_text is not None and (not isinstance(input_text, str) or len(input_text) > 2 * 1024 * 1024):
        handler.send_response(413); handler.end_headers(); return
    if not _tmux_bridge_args_ok(args):
        handler.send_response(403); handler.end_headers(); return
    timeout = max(1, min(15, int(payload.get('timeout_ms', 8000) or 8000) // 1000 + 1))
    child_env = os.environ.copy()
    for key in ('NODE_APP_INSTANCE', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_CHANNEL_FD'):
        child_env.pop(key, None)
    child_env.update({'HOME':'/root', 'SHELL':'/bin/bash'})
    try:
        proc = subprocess.run(['tmux'] + args, input=input_text, capture_output=True,
                              text=True, timeout=timeout, env=child_env, cwd='/root')
        body = json.dumps({'code':proc.returncode, 'out':proc.stdout, 'err':proc.stderr}).encode()
        handler.send_response(200)
        handler.send_header('Content-Type', 'application/json')
        handler.send_header('Content-Length', str(len(body)))
        handler.end_headers(); handler.wfile.write(body)
    except subprocess.TimeoutExpired:
        body = json.dumps({'code':124, 'out':'', 'err':'tmux bridge timeout'}).encode()
        handler.send_response(200); handler.send_header('Content-Type','application/json')
        handler.send_header('Content-Length', str(len(body))); handler.end_headers(); handler.wfile.write(body)
    except Exception as exc:
        body = json.dumps({'error':str(exc)}).encode()
        handler.send_response(500); handler.send_header('Content-Type','application/json')
        handler.send_header('Content-Length', str(len(body))); handler.end_headers(); handler.wfile.write(body)
class MCPHandler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS')
        self.send_header('Access-Control-Allow-Headers','Content-Type,Accept,Mcp-Session-Id,MCP-Protocol-Version,Last-Event-ID,Authorization')
        self.send_header('Access-Control-Expose-Headers','Mcp-Session-Id')

    def do_OPTIONS(self):
        self.send_response(200); self._cors(); self.end_headers()

    def do_GET(self):
        _dbg(f'GET  {_safe_log_path(self.path)}  accept={self.headers.get("Accept","")}  sid={self.headers.get("Mcp-Session-Id","")}')
        tok = _request_token(self.path, self.headers)
        if tok and urlparse(self.path).path in (f'/{tok}/sse', '/mcp/sse') and 'text/event-stream' in (self.headers.get('Accept') or ''):
            sid = str(uuid.uuid4())
            q   = queue.Queue()
            sessions[sid] = q
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream')
            self.send_header('Cache-Control','no-cache')
            self.send_header('Connection','keep-alive')
            self._cors(); self.end_headers()
            # 发送 endpoint 事件
            ep = (f'/mcp/message?sessionId={sid}' if urlparse(self.path).path == '/mcp/sse'
                  else f'/{tok}/message?sessionId={sid}')
            self.wfile.write(f'event: endpoint\ndata: {ep}\n\n'.encode()); self.wfile.flush()
            try:
                while True:
                    try:
                        msg = q.get(timeout=30)
                        if msg is None: break
                        self.wfile.write(f'event: message\ndata: {json.dumps(msg)}\n\n'.encode()); self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(b': ping\n\n'); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError): pass
            finally: sessions.pop(sid, None)
        elif tok and urlparse(self.path).path in (f'/{tok}', f'/{tok}/', '/mcp', '/mcp/'):
            # Streamable HTTP：不提供 server→client 的 GET SSE 流，按规范回 405
            self.send_response(405); self.send_header('Allow','POST'); self._cors(); self.end_headers()
        else:
            self.send_response(404); self.end_headers()

    def do_DELETE(self):
        # Streamable HTTP 会话终止：无状态服务，无需清理，直接 200
        tok = _request_token(self.path, self.headers)
        if tok and urlparse(self.path).path in (f'/{tok}', f'/{tok}/', '/mcp', '/mcp/'):
            self.send_response(200); self._cors(); self.end_headers()
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        if _env_flag('RIFUGIO_ENABLE_CLI_BRIDGE') and urlparse(self.path).path == TMUX_BRIDGE_PATH:
            _handle_tmux_bridge(self)
            return
        # ── Streamable HTTP：单一端点 /{TOKEN}，POST 直接回 application/json ──
        # /{TOKEN}/sse 也收：老连接器 URL 填的是 /sse 尾巴，claude.ai 换 streamable 后会直接 POST 过来
        tok = _request_token(self.path, self.headers)
        if tok and urlparse(self.path).path in (f'/{tok}', f'/{tok}/', f'/{tok}/sse', '/mcp', '/mcp/', '/mcp/sse'):
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length) if length else b''
            try: msg = json.loads(raw)
            except:
                _dbg(f'POST {_safe_log_path(self.path)}  BAD-JSON  bytes={len(raw)}')
                self.send_response(400); self._cors(); self.end_headers(); return
            _m = msg if isinstance(msg, dict) else {}
            _method = _m.get('method','')
            _dbg(f'POST {_safe_log_path(self.path)}  accept={self.headers.get("Accept","")}  proto={self.headers.get("MCP-Protocol-Version","")}  in_sid={self.headers.get("Mcp-Session-Id","")}  method={_method}  tool={(_m.get("params") or {}).get("name","")}')
            # Streamable HTTP 会话：initialize 时签发 Mcp-Session-Id，后续请求带回
            sess_hdr = None
            if _method == 'initialize':
                sess_hdr = uuid.uuid4().hex
                http_sessions.add(sess_hdr)
            else:
                sess_hdr = self.headers.get('Mcp-Session-Id') or None
            if isinstance(msg, list):
                out = [r for r in (handle_rpc(m) for m in msg) if r is not None]
                payload = json.dumps(out).encode() if out else None
            else:
                resp = handle_rpc(msg)
                payload = json.dumps(resp).encode() if resp is not None else None
            _dbg(f'  -> sid={sess_hdr}  resp_bytes={len(payload) if payload else 0}')
            if payload is None:
                # 纯通知/响应，无需回包
                self.send_response(202)
                if sess_hdr: self.send_header('Mcp-Session-Id', sess_hdr)
                self._cors(); self.end_headers(); return
            self.send_response(200)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length', str(len(payload)))
            if sess_hdr: self.send_header('Mcp-Session-Id', sess_hdr)
            self._cors(); self.end_headers()
            self.wfile.write(payload)
            return
        # ── 旧版 HTTP+SSE：/{TOKEN}/message（迁移期保留兼容）──
        if tok and (self.path.startswith(f'/{tok}/message') or self.path.startswith('/mcp/message')):
            qs  = parse_qs(urlparse(self.path).query)
            sid = qs.get('sessionId',[None])[0]
            body = self.rfile.read(int(self.headers.get('Content-Length',0)))
            try: msg = json.loads(body)
            except: msg = {}
            _dbg(f'POST(LEGACY/sse) {_safe_log_path(self.path)}  sid_alive={sid in sessions}  method={msg.get("method","")}  tool={(msg.get("params") or {}).get("name","")}')
            self.send_response(202); self.send_header('Content-Type','application/json'); self._cors(); self.end_headers()
            self.wfile.write(b'{"ok":true}')
            if not msg: return
            def process():
                resp = handle_rpc(msg)
                if resp and sid and sid in sessions:
                    sessions[sid].put(resp)
            Thread(target=process, daemon=True).start()
        else:
            _dbg(f'POST {_safe_log_path(self.path)}  -> 404 (no route match)')
            self.send_response(404); self.end_headers()

if __name__ == '__main__':
    mcp_host = os.environ.get('RIFUGIO_MCP_HOST', '0.0.0.0')
    server = ThreadingHTTPServer((mcp_host, PORT), MCPHandler)
    server.daemon_threads = True
    print(f'[mcp-server] ready :{PORT} tools={",".join(t["name"] for t in TOOLS)}', flush=True)
    server.serve_forever()
