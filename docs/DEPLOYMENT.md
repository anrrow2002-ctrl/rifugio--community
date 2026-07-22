# Deployment

## No VPS required

The supported default is Docker Compose on a computer, NAS, or VPS you control. The database stays in `./data`; identity and secrets stay in `./private` and `.env`. GitHub contains code only.

Android can also host the backend and keep its databases on the phone through Termux; see [Android / Termux](TERMUX.md). A normal mobile browser alone still cannot host the Node + Python backend. On iOS, use a computer, NAS, VPS, or container host and install the PWA as the client.

## Local computer, NAS, or VPS

1. Install Docker and Node.js 22.18 or newer.
2. Run `node scripts/setup.mjs`.
3. Edit `private/profile.json`.
4. Set the public URL, CORS origin, and passkey origin to the exact URL users will open.
5. Run `npm run privacy:scan`.
6. Run `docker compose up -d --build`.
7. Open `http://localhost:8080` for the default local setup.

The web and MCP ports bind to `127.0.0.1` by default. This is intentional.

## MCP access

A client running on the same host can connect to:

```text
http://127.0.0.1:3456/mcp
Authorization: Bearer <RIFUGIO_MCP_TOKEN from .env>
```

For a remote MCP client, terminate TLS in a trusted reverse proxy and forward only the `/mcp` path to `127.0.0.1:3456`. Keep bearer authentication enabled. Do not expose token-in-path URLs in access logs.

The API container also reaches the canonical MCP container internally. This lets OpenAI-compatible Talk and Room requests use the allowlisted Rifugio tools when “Rifugio experience” is enabled. Arbitrary shell, VPS, and filesystem administration are not part of the Community MCP.

## Public URL and passkeys

For the default local URL, the generated example uses:

```dotenv
RIFUGIO_PUBLIC_URL=http://localhost:8080
RIFUGIO_CORS_ORIGINS=http://localhost:8080
PASSKEY_RP_ID=localhost
PASSKEY_ORIGINS=http://localhost:8080
```

For internet access, replace all four values with the real HTTPS hostname before starting the containers. `PASSKEY_RP_ID` is the hostname only, without scheme or path. A mismatched `localhost:3457` origin makes the web UI appear healthy while passkey registration fails, so keep these values aligned with the web port.

## What “all features” means

Core PWA, password login, SQLite memory, pet, books, OpenAI-compatible Talk/Room, and MCP work on a normal Docker VPS.

Optional flags do not supply external services by themselves:

- `RIFUGIO_ENABLE_HEALTH`: enables health integration surfaces; ingestion still needs a trusted source.
- `RIFUGIO_ENABLE_RADIO`: requires outbound network access to media providers.
- `RIFUGIO_ENABLE_IMAGE`: requires a configured image provider and key.
- `RIFUGIO_ENABLE_VOICE`: requires a configured TTS/STT provider and key.
- `RIFUGIO_ENABLE_TOY`: requires the separate supported BLE bridge and physical device.
- `RIFUGIO_ENABLE_CLI_BRIDGE`: requires a separately installed and authenticated compatible CLI/runtime. The standard API container does not bundle Claude Code, tmux, or host terminal sessions.

Server-side long-chat image export additionally needs Chromium at `RIFUGIO_CHROMIUM`; the standard image does not bundle it, and the web app keeps a browser-side fallback.

## Backups

Stop writes or use SQLite's online backup mechanism, then back up `data/` and `private/` separately. Encrypt backups. Never commit either directory.

## Managed hosting

A container host with a persistent volume can run the same services. Static GitHub Pages alone cannot run this backend. Serverless edge workers are not a drop-in target because this edition uses a long-running Node API, Python MCP service, and persistent SQLite files.

## 设置登录密码与 AUTH_SECRET

```bash
bash scripts/set-auth-password.sh
```

脚本会交互式设置访问密码（写入 `.env` 的 `AUTH_PASSWORD_HASH`），并在缺失时自动生成 `AUTH_SECRET`。
Passkey（指纹/FaceID）在首次登录后于设置页自行注册，存于你自己的数据库，与他人无关。
