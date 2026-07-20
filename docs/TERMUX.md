# Android / Termux deployment

Rifugio Community can run entirely on an Android phone through Termux. Its SQLite driver is Node's built-in `node:sqlite`, so installation does not compile `better-sqlite3` or require Android C++ build tools.

## Requirements

Install Termux from F-Droid or GitHub rather than the obsolete Play Store build.

```sh
pkg update
pkg install git nodejs-lts python caddy
node --version
```

Node must be **22.18.0 or newer**. If the reported version is older, update Termux packages before continuing.

## Install

```sh
git clone https://github.com/YOUR_ACCOUNT/rifugio--community.git
cd rifugio--community
node scripts/setup.mjs
# Edit private/profile.json and .env
npm --prefix apps/api ci --omit=dev
```

The setup command creates a login password and random internal tokens. Do not copy `.env`, `private/`, or `data/` to GitHub.

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

## Serve the PWA

Save this as `Caddyfile` in the repository root, changing the root path if needed:

```caddy
:8080 {
    handle /api/* {
        reverse_proxy 127.0.0.1:3457
    }
    handle /memory-api/* {
        reverse_proxy 127.0.0.1:3457
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

Open `http://127.0.0.1:8080` on that Android phone and install the PWA from the browser menu. Android may stop background processes to save battery; exclude Termux from battery optimization and use `termux-wake-lock` when you want Rifugio to remain available.

This is phone-local storage: databases remain under `data/` on that Android device. To reach it from other devices, use a trusted LAN or private tunnel and HTTPS; do not expose ports or SQLite files directly to the public internet.
