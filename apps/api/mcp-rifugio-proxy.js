#!/usr/bin/env node
// Stdio transport adapter for the one canonical Rifugio MCP HTTP server.
// Business logic stays in the canonical MCP package; this file only forwards JSON-RPC.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const TOKEN_FILE = process.env.MCP_TOKEN_FILE || path.join(__dirname, '..', '..', 'private', 'mcp_tokens');
const ENDPOINT = process.env.RIFUGIO_MCP_LOOPBACK || 'http://127.0.0.1:3456';
let sessionId = '';

function token() {
  // Do not trust ambient MCP_TOKEN: rifugio-api uses the same generic name for
  // a different connector. Only an explicit proxy override may beat the file.
  if (process.env.RIFUGIO_MCP_TOKEN && process.env.RIFUGIO_MCP_TOKEN.trim()) {
    return process.env.RIFUGIO_MCP_TOKEN.trim();
  }
  try {
    const value = fs.readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/).map(x => x.trim()).find(Boolean);
    if (value) return value;
  } catch (_) {}
  throw new Error('Rifugio MCP token is not configured');
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function forward(message) {
  const response = await fetch(`${ENDPOINT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token()}`,
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const nextSession = response.headers.get('mcp-session-id');
  if (nextSession) sessionId = nextSession;
  const text = await response.text();
  if (!response.ok) throw new Error(`canonical MCP HTTP ${response.status}`);
  if (!text.trim()) return;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { write(JSON.parse(line.slice(5).trim())); } catch (_) {}
    }
    return;
  }
  try { write(JSON.parse(text)); }
  catch (_) { throw new Error('canonical MCP returned invalid JSON'); }
}

let chain = Promise.resolve();
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const raw = line.trim();
  if (!raw) return;
  let message;
  try { message = JSON.parse(raw); }
  catch (_) { return; }
  chain = chain.then(() => forward(message)).catch(error => {
    if (message && message.id !== undefined && message.id !== null) {
      write({ jsonrpc:'2.0', id:message.id, error:{ code:-32000, message:error.message } });
    }
  });
});
