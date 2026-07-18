import importlib.util
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault('MCP_TOKEN', 'test-token')
SERVER_FILE = Path(__file__).resolve().parents[1] / 'server.py'
spec = importlib.util.spec_from_file_location('rifugio_mcp_server', SERVER_FILE)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

SCHEMA = """
CREATE TABLE buckets (
  id TEXT PRIMARY KEY,
  name TEXT,
  content TEXT,
  importance INTEGER DEFAULT 5,
  arousal REAL DEFAULT 0.3,
  valence REAL DEFAULT 0.5,
  occurred_at TEXT,
  created_at TEXT,
  last_active TEXT,
  resolved INTEGER DEFAULT 0,
  digested INTEGER DEFAULT 0,
  digested_at TEXT,
  pinned INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  domain TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  bucket_type TEXT DEFAULT 'dynamic'
);
"""

class HybridSearchConsistencyTest(unittest.TestCase):
    def test_keyword_match_is_visible_even_when_semantic_search_has_other_results(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / 'memory.db')
            conn = sqlite3.connect(db_path)
            conn.executescript(SCHEMA)
            conn.execute(
                "INSERT INTO buckets (id,name,content,created_at) VALUES (?,?,?,datetime('now'))",
                ('semantic-old', 'Older result', 'unrelated semantic result',),
            )
            marker = 'fresh-write-visible-immediately'
            conn.execute(
                "INSERT INTO buckets (id,name,content,created_at) VALUES (?,?,?,datetime('now'))",
                ('fresh', 'Fresh result', marker,),
            )
            conn.commit()
            conn.close()

            previous_db = server.DB_PATH
            previous_semantic = server._semantic_ids
            try:
                server.DB_PATH = db_path
                server._semantic_ids = lambda _query, _limit: ['semantic-old']
                rows = server._search_ordinary_rows(marker, 8)
            finally:
                server.DB_PATH = previous_db
                server._semantic_ids = previous_semantic

            self.assertEqual(rows[0]['id'], 'fresh')
            self.assertEqual({row['id'] for row in rows}, {'fresh', 'semantic-old'})

if __name__ == '__main__':
    unittest.main()
