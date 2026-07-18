#!/usr/bin/env python3
"""
import_to_rifugio.py — 独立对话导入脚本
将 Claude/ChatGPT 导出文件直接导入 Rifugio 的 SQLite 记忆库

用法：
  python3 import_to_rifugio.py <文件路径> [选项]

示例：
  python3 import_to_rifugio.py ~/chat-export.md
  python3 import_to_rifugio.py ~/chat.json --dry-run
  python3 import_to_rifugio.py ~/chat.md --user User --ai Claude

依赖：pip3 install openai
"""

import os, sys, json, sqlite3, hashlib, argparse, time, re
from datetime import datetime
from pathlib import Path

try:
    from openai import OpenAI
except ImportError:
    print("请先安装依赖：pip3 install openai")
    sys.exit(1)


# ── 配置 ───────────────────────────────────────────────────────
ROOT_DIR     = Path(os.environ.get('RIFUGIO_ROOT', Path(__file__).resolve().parents[2])).resolve()
DATA_DIR     = Path(os.environ.get('RIFUGIO_DATA_DIR', ROOT_DIR / 'data')).resolve()
DB_PATH      = os.environ.get('RIFUGIO_MEMORY_DB', str(DATA_DIR / 'rifugio-memory.db'))
STATE_FILE   = os.environ.get('RIFUGIO_IMPORT_STATE_FILE', str(DATA_DIR / 'import-state.json'))
CHUNK_TOKENS = 12000   # 每块约多少 token（粗估：1 token ≈ 1.5 汉字 / 4 英文字符）
MAX_TOKENS   = 3000    # LLM 输出 max_tokens


# ── 提示词（照搬原版，稍作调整加入人名规则）──────────────────────
def make_prompt(user_name: str, ai_name: str) -> str:
    return f"""你是对话记忆提取专家。从以下对话片段中提取值得长期记住的信息。

【人名规则 - 严格遵守】
- 用户真实姓名：「{user_name}」。禁止写"用户""User"。
- AI名字：「{ai_name}」。

提取规则：
1. 提取用户的事实、偏好、习惯、重要事件、情感时刻
2. 同一话题的零散信息整合为一条记忆
3. 过滤掉纯技术调试输出、代码块、重复问答、无意义寒暄
4. 如果对话中有特殊暗号、仪式性行为、关键承诺，标记 preserve_raw=true
5. 如果内容是习惯性互动模式，标记 is_pattern=true
6. 每条记忆不少于30字
7. 总条目数控制在 0~5 个（没有值得记的就返回空数组）
8. 保留英文原句中的重要表达，不要强行翻译

输出格式（纯 JSON 数组，无其他内容）：
[
  {{
    "name": "条目标题（10字以内）",
    "content": "整理后的内容（中文为主，重要英文保留）",
    "domain": ["主题域1"],
    "valence": 0.7,
    "arousal": 0.4,
    "tags": ["核心词1", "核心词2"],
    "importance": 5,
    "occurred_at": "YYYY-MM-DD或留空",
    "preserve_raw": false,
    "is_pattern": false
  }}
]

importance: 1-10
valence: 0~1（0=消极, 0.5=中性, 1=积极）
arousal: 0~1（0=平静, 1=激动）
只输出JSON数组，不加任何解释。"""


# ── 数据库初始化 ───────────────────────────────────────────────
def init_db(db_path: str):
    con = sqlite3.connect(db_path)
    con.execute("""CREATE TABLE IF NOT EXISTS buckets (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        content       TEXT NOT NULL DEFAULT '',
        valence       REAL NOT NULL DEFAULT 0.5,
        arousal       REAL NOT NULL DEFAULT 0.3,
        domain        TEXT NOT NULL DEFAULT '[]',
        tags          TEXT NOT NULL DEFAULT '[]',
        importance    INTEGER NOT NULL DEFAULT 5,
        bucket_type   TEXT NOT NULL DEFAULT 'dynamic',
        occurred_at   TEXT,
        last_active   TEXT,
        activation_count INTEGER NOT NULL DEFAULT 1,
        resolved      INTEGER NOT NULL DEFAULT 0,
        pinned        INTEGER NOT NULL DEFAULT 0,
        personas      TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )""")
    con.execute("""CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )""")
    con.commit()
    return con


def new_id() -> str:
    import secrets
    return secrets.token_hex(6)


def insert_bucket(con, item: dict, personas: dict, file_date: str):
    now = datetime.now().isoformat()
    occurred = item.get("occurred_at") or file_date or now[:10]
    con.execute("""INSERT OR IGNORE INTO buckets
        (id,name,content,valence,arousal,domain,tags,importance,
         bucket_type,occurred_at,last_active,activation_count,resolved,pinned,personas,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,0,?,?)""",
        (
            new_id(),
            (item.get("name") or "未命名")[:20],
            item.get("content", ""),
            max(0.0, min(1.0, float(item.get("valence", 0.5)))),
            max(0.0, min(1.0, float(item.get("arousal", 0.3)))),
            json.dumps(item.get("domain", ["未分类"]), ensure_ascii=False),
            json.dumps(item.get("tags", []), ensure_ascii=False),
            max(1, min(10, int(item.get("importance", 5)))),
            "dynamic",
            occurred, now,
            json.dumps(personas, ensure_ascii=False), now,
        )
    )
    con.commit()


# ── 格式解析 ───────────────────────────────────────────────────
def count_tokens_approx(text: str) -> int:
    """粗估 token 数：中文按字数/1.5，英文按词数"""
    chinese = len(re.findall(r'[\u4e00-\u9fff]', text))
    english_words = len(re.findall(r'[a-zA-Z]+', text))
    return int(chinese / 1.5 + english_words / 0.75)


def parse_file(content: str, filename: str) -> list[dict]:
    """解析文件为对话轮次列表"""
    ext = Path(filename).suffix.lower()

    # 尝试 JSON
    if ext == ".json" or content.strip().startswith(("{", "[")):
        try:
            data = json.loads(content)
            sample = data[0] if isinstance(data, list) and data else data
            if isinstance(sample, dict):
                if "chat_messages" in sample:
                    return _parse_claude_json(data)
                if "mapping" in sample:
                    return _parse_chatgpt_json(data)
        except Exception:
            pass

    # Markdown 格式
    return _parse_markdown(content)


def _parse_claude_json(data) -> list[dict]:
    turns = []
    conversations = data if isinstance(data, list) else [data]
    for conv in conversations:
        for msg in conv.get("chat_messages", conv.get("messages", [])):
            content = msg.get("text", msg.get("content", ""))
            if isinstance(content, list):
                content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
            if content and content.strip():
                turns.append({"role": msg.get("sender", "user"), "content": content.strip(),
                               "timestamp": msg.get("created_at", "")})
    return turns


def _parse_chatgpt_json(data) -> list[dict]:
    turns = []
    conversations = data if isinstance(data, list) else [data]
    for conv in conversations:
        nodes = sorted(
            [n for n in conv.get("mapping", {}).values() if isinstance(n, dict)],
            key=lambda n: (n.get("message") or {}).get("create_time") or 0
        )
        for node in nodes:
            msg = node.get("message")
            if not msg:
                continue
            parts = (msg.get("content") or {}).get("parts", [])
            text = " ".join(str(p) for p in parts if p).strip()
            if text:
                ts = msg.get("create_time", "")
                if isinstance(ts, (int, float)):
                    ts = datetime.fromtimestamp(ts).isoformat()
                turns.append({"role": msg.get("author", {}).get("role", "user"),
                               "content": text, "timestamp": str(ts)})
    return turns


def _parse_markdown(text: str) -> list[dict]:
    """
    支持三种格式：
    1. ## Prompt: / ## Response:（Claude 插件导出）
    2. **Human:** / **Assistant:**（claude.ai 原生导出）
    3. Human: / Assistant: 行首
    如果都识别不了，整体作为一个 chunk 扔给 LLM
    """
    turns = []

    # 提取文件头日期
    header_ts = ""
    m = re.search(r'\*\*Created:\*\*\s*(\d+)/(\d+)/(\d+)', text)
    if m:
        header_ts = f"{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"

    # 格式1：## Prompt: / ## Response:
    sections = ("\n" + text).split(re.compile(r'\n## (Prompt|Response):\n').pattern)
    # 用真正的split
    parts = re.split(r'\n## (Prompt|Response):\n', "\n" + text)
    if len(parts) > 1:
        role = None
        for part in parts:
            if part == "Prompt":
                role = "user"; continue
            if part == "Response":
                role = "assistant"; continue
            if role is None:
                continue
            # 去掉 thinking block
            cleaned = re.sub(r'````plaintext[\s\S]*?````', '', part)
            cleaned = re.sub(r'```[\s\S]*?```', '', cleaned).strip()
            # 提取时间戳
            ts = header_ts
            dm = re.match(r'(\d{4})/(\d{1,2})/(\d{1,2})', cleaned)
            if dm:
                ts = f"{dm.group(1)}-{dm.group(2).zfill(2)}-{dm.group(3).zfill(2)}"
                cleaned = cleaned[dm.end():].strip()
            if len(cleaned) > 5:
                turns.append({"role": role, "content": cleaned, "timestamp": ts})
            role = None
        if turns:
            return turns

    # 格式2：**Human:** / **Assistant:**
    if "**Human:**" in text or "**Assistant:**" in text:
        blocks = re.split(r'\n(?=\*\*(Human|Assistant):\*\*)', text)
        for block in blocks:
            m = re.match(r'\*\*(Human|Assistant):\*\*\s*([\s\S]*)', block)
            if not m:
                continue
            role = "user" if m.group(1) == "Human" else "assistant"
            cleaned = re.sub(r'````plaintext[\s\S]*?````', '', m.group(2))
            cleaned = re.sub(r'```[\s\S]*?```', '', cleaned).strip()
            if len(cleaned) > 5:
                turns.append({"role": role, "content": cleaned, "timestamp": header_ts})
        if turns:
            return turns

    # 格式3：行首 Human: / Assistant:
    if re.search(r'^(Human|Assistant|Claude|User):', text, re.MULTILINE):
        blocks = re.split(r'\n(?=(?:Human|Assistant|Claude|User):)', text)
        for block in blocks:
            m = re.match(r'(Human|User|Assistant|Claude):\s*([\s\S]*)', block, re.IGNORECASE)
            if not m:
                continue
            role = "user" if m.group(1).lower() in ("human", "user") else "assistant"
            cleaned = m.group(2).strip()
            if len(cleaned) > 5:
                turns.append({"role": role, "content": cleaned, "timestamp": header_ts})
        if turns:
            return turns

    # 兜底：整体扔给 LLM
    return [{"role": "user", "content": text.strip(), "timestamp": header_ts}]


def chunk_turns(turns: list[dict], target_tokens: int = 12000) -> list[dict]:
    """按 token 预算把对话轮次分块"""
    chunks = []
    lines, tokens, first_ts = [], 0, ""

    for t in turns:
        label = "用户" if t["role"] in ("user", "human") else "AI"
        line = f"[{label}] {t['content']}"
        lt = count_tokens_approx(line)

        if tokens + lt > target_tokens and lines:
            chunks.append({"content": "\n".join(lines), "timestamp": first_ts})
            lines, tokens, first_ts = [], 0, ""

        if not first_ts:
            first_ts = t.get("timestamp", "")
        lines.append(line)
        tokens += lt

    if lines:
        chunks.append({"content": "\n".join(lines), "timestamp": first_ts})
    return chunks


# ── LLM 调用 ───────────────────────────────────────────────────
def get_llm_config(db_path: str) -> dict:
    """从数据库读取 LLM 配置"""
    import hashlib, binascii
    con = sqlite3.connect(db_path)
    row = con.execute("SELECT value FROM app_settings WHERE key='llm'").fetchone()
    con.close()
    if not row:
        return {}
    cfg = json.loads(row[0])

    # 解密 api_key_enc
    if "api_key_enc" in cfg and not cfg.get("api_key"):
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            from cryptography.hazmat.backends import default_backend
            SECRET = os.environ.get("RIFUGIO_SECRET")
            if not SECRET:
                env_path = os.path.join(os.path.dirname(__file__), ".env")
                try:
                    with open(env_path, encoding="utf-8") as env_file:
                        for env_line in env_file:
                            if env_line.startswith("RIFUGIO_SECRET="):
                                SECRET = env_line.split("=", 1)[1].strip().strip("\"'")
                                break
                except OSError:
                    pass
            if not SECRET:
                raise RuntimeError("RIFUGIO_SECRET is not configured")
            key = hashlib.sha256(SECRET.encode()).digest()
            iv_hex, enc_hex = cfg["api_key_enc"].split(":")
            iv = bytes.fromhex(iv_hex)
            enc = bytes.fromhex(enc_hex)
            cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
            dec = cipher.decryptor()
            raw = dec.update(enc) + dec.finalize()
            # PKCS7 unpad
            pad = raw[-1]
            cfg["api_key"] = raw[:-pad].decode("utf-8")
        except Exception as e:
            print(f"⚠️  无法解密数据库中的 API key（{e}），请用 --api-key 参数手动传入")
    return cfg


def call_llm(client: OpenAI, model: str, system: str, user_content: str) -> list[dict]:
    """调用 LLM 提取记忆，返回解析后的 list"""
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_content[:50000]},
            ],
            max_tokens=MAX_TOKENS,
            temperature=0.1,
        )
        raw = resp.choices[0].message.content or "[]"
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0]
        items = json.loads(raw)
        if not isinstance(items, list):
            return []
        return items
    except Exception as e:
        print(f"  ⚠️  LLM 调用失败: {e}")
        return []


# ── 状态持久化 ─────────────────────────────────────────────────
def load_state(src_hash: str) -> dict | None:
    if not os.path.exists(STATE_FILE):
        return None
    try:
        with open(STATE_FILE) as f:
            s = json.load(f)
        if s.get("source_hash") == src_hash and s.get("status") not in ("completed", "error"):
            return s
    except Exception:
        pass
    return None


def save_state(s: dict):
    s["updated_at"] = datetime.now().isoformat()
    with open(STATE_FILE, "w") as f:
        json.dump(s, f, ensure_ascii=False, indent=2)


# ── 主程序 ─────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="导入对话历史到 Rifugio SQLite")
    ap.add_argument("file", help="对话文件路径（.md/.json/.txt）")
    ap.add_argument("--db", default=DB_PATH, help=f"SQLite 路径（默认 {DB_PATH}）")
    ap.add_argument("--user", default="User", help="用户名（默认 User）")
    ap.add_argument("--ai", default="Claude", help="AI 名（默认 Claude）")
    ap.add_argument("--api-key", default="", help="API key（不填则从数据库读取）")
    ap.add_argument("--base-url", default="", help="API base URL（不填则从数据库读取）")
    ap.add_argument("--model", default="", help="模型名（不填则从数据库读取）")
    ap.add_argument("--chunk-tokens", type=int, default=CHUNK_TOKENS, help="每块 token 数")
    ap.add_argument("--dry-run", action="store_true", help="预览模式，不写入数据库")
    ap.add_argument("--resume", action="store_true", help="从上次中断处续跑")
    args = ap.parse_args()

    # 读文件
    src = Path(args.file)
    if not src.exists():
        print(f"文件不存在: {src}"); sys.exit(1)
    content = src.read_text(encoding="utf-8", errors="replace")
    src_hash = hashlib.md5(content.encode()).hexdigest()
    file_date = ""
    m = re.search(r'(\d{4})[-./](\d{2})[-./](\d{2})', src.name)
    if m:
        file_date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    if not file_date:
        m2 = re.search(r'\*\*Created:\*\*\s*(\d+)/(\d+)/(\d+)', content)
        if m2:
            file_date = f"{m2.group(3)}-{m2.group(1).zfill(2)}-{m2.group(2).zfill(2)}"

    print(f"📄 文件: {src.name} ({len(content)//1024}KB)")
    print(f"📅 日期: {file_date or '未检测到'}")

    # 初始化数据库
    con = init_db(args.db)

    # 读取 LLM 配置
    db_cfg = get_llm_config(args.db)
    api_key  = args.api_key  or db_cfg.get("api_key", "")  or os.environ.get("OPENAI_API_KEY", "")
    base_url = args.base_url or db_cfg.get("base_url", "") or "https://api.openai.com/v1"
    model    = args.model    or db_cfg.get("model", "")    or "gpt-4o-mini"

    if not api_key:
        print("❌ 没有 API key。请用 --api-key 传入，或先在网页 Impostazioni 页面保存。")
        sys.exit(1)

    print(f"🔌 API: {base_url}")
    print(f"🤖 模型: {model}")

    client = OpenAI(api_key=api_key, base_url=base_url)
    system_prompt = make_prompt(args.user, args.ai)
    personas = {"user": args.user, "ai": args.ai}

    # 解析 & 分块
    turns = parse_file(content, src.name)
    print(f"💬 解析到 {len(turns)} 条对话轮次")
    chunks = chunk_turns(turns, args.chunk_tokens)
    print(f"🗂  分为 {len(chunks)} 块处理")

    # 恢复状态
    state = None
    start_idx = 0
    if args.resume:
        state = load_state(src_hash)
        if state:
            start_idx = state["processed"]
            print(f"⏩ 从第 {start_idx+1} 块续跑")

    if state is None:
        state = {
            "source_file": str(src),
            "source_hash": src_hash,
            "total_chunks": len(chunks),
            "processed": 0,
            "api_calls": 0,
            "memories_created": 0,
            "errors": [],
            "status": "running",
            "started_at": datetime.now().isoformat(),
            "updated_at": "",
        }

    # 处理每块
    for i, chunk in enumerate(chunks[start_idx:], start=start_idx):
        print(f"\n[{i+1}/{len(chunks)}] 处理中…（约 {count_tokens_approx(chunk['content'])} tokens）")

        items = call_llm(client, model, system_prompt, chunk["content"])
        state["api_calls"] += 1
        state["processed"] = i + 1

        if not items:
            print("  → 本块无记忆")
        else:
            for item in items:
                if not item.get("content"):
                    continue
                if not item.get("occurred_at"):
                    item["occurred_at"] = chunk.get("timestamp") or file_date
                print(f"  ✦ [{item.get('importance',5)}/10] {item.get('name','?')} — {item.get('content','')[:60]}…")
                if not args.dry_run:
                    insert_bucket(con, item, personas, file_date)
                    state["memories_created"] += 1

        save_state(state)

        # 限速保护
        if i < len(chunks) - 1:
            time.sleep(0.3)

    state["status"] = "completed"
    save_state(state)

    print(f"\n{'[预览模式]' if args.dry_run else '✅'} 完成")
    print(f"   API调用: {state['api_calls']}  |  新建记忆: {state['memories_created']}")
    if state["errors"]:
        print(f"   ⚠️  错误: {len(state['errors'])} 条，见 {STATE_FILE}")
    con.close()


if __name__ == "__main__":
    main()
