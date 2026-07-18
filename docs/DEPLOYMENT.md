# Deployment

## No VPS required

The supported default is Docker Compose on a computer or NAS you control. The database stays in `./data`; identity and secrets stay in `./private` and `.env`. GitHub contains code only.

A phone can install the PWA and use it on the same network, but the current Community backend is Node + Python + SQLite and does not run purely inside a normal mobile browser. For phone-only storage, a separate local-first browser database adapter would be required.

## Local computer or NAS

1. Install Docker and Node.js 20 or newer.
2. Run `node scripts/setup.mjs`.
3. Edit `private/profile.json`.
4. Run `npm run privacy:scan`.
5. Run `docker compose up -d --build`.
6. Open `http://localhost:8080`.

The web and MCP ports bind to `127.0.0.1` by default. To reach the app from a phone on your LAN, change the web port mapping deliberately and keep login enabled. For internet access, put a TLS reverse proxy in front; never expose SQLite files, `.env`, or `private/`.

## Backups

Stop writes or use SQLite's online backup mechanism, then back up `data/` and `private/` separately. Encrypt backups. Never commit either directory.

## Managed hosting

A container host with a persistent volume can run the same services. Static GitHub Pages alone cannot run this backend. Serverless edge workers are not a drop-in target because this edition uses native Node modules, Python, and SQLite.
