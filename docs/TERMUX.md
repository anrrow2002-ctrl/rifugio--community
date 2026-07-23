# Android / Termux deployment

Rifugio Community can host its core web, API, SQLite databases, and MCP server on an Android phone through Termux. Optional provider and hardware features still need their own keys, services, or devices; see “Capability limits” below.

## Requirements

Install Termux and any Termux add-ons from F-Droid or the official GitHub releases, not the obsolete Play Store build.

```sh
pkg update
pkg upgrade
pkg install git nodejs-lts npm python caddy
node --version
node -e "require('node:sqlite'); console.log('node:sqlite ok')"
```

Node must be **22.18.0 or newer** and the `node:sqlite` check must pass. Current Termux packages may install npm separately from Node, which is why both packages are listed.

## Install

```sh
git clone https://github.com/YOUR_ACCOUNT/rifugio--community.git
cd rifugio--community
RIFUGIO_SETUP_PASSWORD='choose-a-long-password' node scripts/setup.mjs
# Edit private/profile.json and .env
npm --prefix apps/api ci --omit=dev --omit=optional
```

The setup command creates random internal tokens. Do not copy `.env`, `private/`, or `data/` to GitHub. The Termux command deliberately omits optional native packages. Core Rifugio still starts; custom App-icon upload and server-side image normalization stay unavailable on this deployment.

Keep these local-origin values aligned when using the default Caddy address:

```dotenv
RIFUGIO_PUBLIC_URL=http://localhost:8080
RIFUGIO_CORS_ORIGINS=http://localhost:8080
PASSKEY_RP_ID=localhost
PASSKEY_ORIGINS=http://localhost:8080
RIFUGIO_ENABLE_TOY=true
```

## Start the API and MCP

Open two Termux sessions. In each session load the private environment first:

```sh
cd rifugio--community
set -a
. ./.env
set +a
```

Session 1:

```sh
python3 packages/mcp/server.py
```

Session 2:

```sh
cd apps/api
node server.js
```

## Serve the PWA and MCP

Save this as `Caddyfile` in the repository root, changing the root path if needed:

```caddy
:8080 {
    handle /api/* {
        reverse_proxy 127.0.0.1:3457
    }
    handle /memory-api/* {
        reverse_proxy 127.0.0.1:3457
    }
    handle /mcp* {
        reverse_proxy 127.0.0.1:3456
    }
    handle {
        root * /data/data/com.termux/files/home/rifugio--community/apps/web
        try_files {path} /index.html
        file_server
    }
}
```

Start it from a third Termux session:

```sh
caddy run --config ./Caddyfile
```

Open `http://localhost:8080` on that Android phone and install the PWA from the browser menu.

## Android direct Bluetooth for SOSEXY

On Android, the Toy app uses Chrome/Chromium Web Bluetooth to connect directly to
the nearby `SOSEXY` BLE device. A Mac is not required.

1. Open Rifugio from `http://localhost:8080` in current Chrome or Edge on Android.
2. Turn on the toy and Android Bluetooth.
3. Open **Toy**, tap **连接安卓蓝牙**, and choose `SOSEXY` in the system picker.
4. Keep the Toy page open and the phone awake while a local sequence, flow, wild
   mode, or MCP command is running.

The first device selection must be initiated by a tap; browsers do not permit a
site to silently claim a Bluetooth device. Android direct mode writes BLE locally,
so the API key, MCP token, and any optional bridge token are never sent to the
toy. If Web Bluetooth is unavailable, an explicitly configured external bridge
remains a fallback.

## Connect an MCP client

The Streamable HTTP endpoint is:

```text
http://localhost:8080/mcp
Authorization: Bearer <RIFUGIO_MCP_TOKEN from .env>
```

A client on another device needs a trusted private tunnel or an HTTPS hostname that proxies `/mcp` to Caddy. Keep the bearer token private. Do not publish port 3456 or a token-in-path URL in screenshots, logs, or a public repository.

A successful client connection performs `initialize`, `tools/list`, then `tools/call`. Core memory tools work without an external model key. Provider-backed tools only appear when their feature flag is enabled and still require the corresponding service configuration.

## Capability limits

| Capability | Termux result |
| --- | --- |
| PWA, login, SQLite memory, pet, books, Talk/Room with OpenAI-compatible APIs | Supported |
| Canonical MCP memory/read/write tools | Supported |
| OpenAI model list and chat calls | Supported through the Rifugio backend; the browser no longer calls OpenAI directly |
| Health, radio, image, TTS/STT | Conditional: enable the feature and configure the provider/device |
| Browser speech recognition and notifications | Browser/Android dependent |
| Long-chat server-side screenshot | Chromium is not bundled for Termux; the browser fallback remains |
| Claude Code / terminal subscription bridge | Not a portable Termux guarantee; use OpenAI-compatible API mode unless you have separately validated a compatible CLI |
| SOSEXY toy control | Android Chrome/Edge connects directly with Web Bluetooth; external BLE bridge is optional |
| 24/7 background uptime | Android may stop Termux; disable battery optimization and use a wake lock if appropriate |

This is phone-local storage: databases remain under `data/` on that Android device. To reach it from other devices, use a trusted LAN or private tunnel and HTTPS; do not expose ports or SQLite files directly to the public internet. Passkeys on other devices require an HTTPS origin whose hostname matches `PASSKEY_RP_ID`.
