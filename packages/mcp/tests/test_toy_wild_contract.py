import importlib.util
import os
import unittest
from pathlib import Path

os.environ.setdefault('MCP_TOKEN', 'test-token')
os.environ['RIFUGIO_ENABLE_TOY'] = 'true'
SERVER_FILE = Path(__file__).resolve().parents[1] / 'server.py'
spec = importlib.util.spec_from_file_location('rifugio_mcp_toy_contract', SERVER_FILE)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class ToyWildContractTest(unittest.TestCase):
    def test_schema_and_defaults_match_the_frontend(self):
        tool = next(item for item in server.TOOLS if item['name'] == 'toy_wild')
        duration = tool['inputSchema']['properties']['duration_sec']
        self.assertEqual(duration['default'], 600)
        self.assertEqual(duration['maximum'], 1800)

    def test_validation_allows_30_minutes_and_rejects_more(self):
        original = server._toy_api
        calls = []
        server._toy_api = lambda path, method='GET', body=None, timeout=30: calls.append((path, method, body, timeout)) or {'ok': True}
        try:
            server.tool_toy_wild(1800, ['suck'], 80)
            self.assertEqual(calls[0][2]['duration'], 1800)
            with self.assertRaises(ValueError):
                server.tool_toy_wild(1801, ['suck'], 80)
        finally:
            server._toy_api = original


if __name__ == '__main__':
    unittest.main()
