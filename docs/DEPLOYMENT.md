# Deployment

## No VPS required

The supported default is Docker Compose on a computer or NAS you control. The database stays in `./data`; identity and secrets stay in `./private` and `.env`. GitHub contains code only.

Android can also host the backend and keep its databases on the phone through Termux; see [Android / Termux](TERMUX.md). A normal mobile browser alone still cannot host the Node + Python backend. On iOS, use a computer, NAS, VPS, or container host and install the PWA as the client.

## Local computer or NAS

1. Install Docker and Node.js 22.18 or newer.
2. Run `node scripts/setup.mjs`.
3. Edit `private/profile.json`.
4. Run `npm run privacy:scan`.
5. Run `docker compose up -d --build`.
6. Open `http://localhost:8080`.

The web and MCP ports bind to `127.0.0.1` by default. To reach the app from a phone on your LAN, change the web port mapping deliberately and keep login enabled. For internet access, put a TLS reverse proxy in front; never expose SQLite files, `.env`, or `private/`.

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
