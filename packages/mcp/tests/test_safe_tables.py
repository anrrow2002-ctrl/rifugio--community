import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

SERVER_PATH = Path(__file__).resolve().parents[1] / "server.py"

class SafeTablesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "memory.db"
        os.environ["MCP_TOKEN"] = "test-token"
        os.environ["RIFUGIO_DB"] = str(self.db_path)
        os.environ["RIFUGIO_DATA_DIR"] = self.tmp.name
        spec = importlib.util.spec_from_file_location("rifugio_mcp_test", SERVER_PATH)
        self.server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.server)
        conn = sqlite3.connect(self.db_path)
        conn.executescript("""
          CREATE TABLE echi (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            author TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            pinned INTEGER DEFAULT 0
          );
          CREATE TABLE posta (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_who TEXT NOT NULL,
            to_who TEXT NOT NULL,
            body TEXT NOT NULL,
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            archived INTEGER DEFAULT 0
          );
        """)
        conn.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_write_and_read_use_bound_values(self):
        payload = "hello'); DROP TABLE echi; --"
        written = json.loads(self.server.tool_write("echi", {"content": payload, "author": "Companion"}))
        self.assertTrue(written["ok"])
        rows = json.loads(self.server.tool_read("echi", 5))["rows"]
        self.assertEqual(rows[0]["content"], payload)
        conn = sqlite3.connect(self.db_path)
        self.assertIsNotNone(conn.execute("SELECT name FROM sqlite_master WHERE name='echi'").fetchone())
        conn.close()

    def test_rejects_unknown_table_field_and_missing_required(self):
        with self.assertRaises(ValueError):
            self.server.tool_write("sqlite_master", {"name": "x"})
        with self.assertRaises(ValueError):
            self.server.tool_write("echi", {"content": "x", "author": "y", "sql": "no"})
        with self.assertRaises(ValueError):
            self.server.tool_write("posta", {"from_who": "a", "to_who": "b"})
        with self.assertRaises(ValueError):
            self.server._safe_table_value("date", "date", "2026-99-99")

    def test_table_tools_are_exposed(self):
        names = {tool["name"] for tool in self.server.TOOLS}
        self.assertTrue({"read", "write", "view_pyq", "post_pyq"}.issubset(names))

if __name__ == "__main__":
    unittest.main()
