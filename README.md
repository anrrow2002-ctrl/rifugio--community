# Rifugio Community

A self-hostable home for AI conversations, long-term memory, and MCP tools.

This is a clean-room community edition: application code and empty templates only. Production memories, chat logs, health data, media, credentials, private domains, and private Git history do not belong here.

## What stays private

- `.env`: credentials and cryptographic secrets
- `private/profile.json`: names and relationship identity
- `private/features.json`: optional personal integrations
- `private/persona.md`: optional private persona prompt
- `data/`: SQLite databases and generated files

All of them are ignored by Git.

## Quick start (computer or NAS)

```sh
node scripts/setup.mjs
# edit private/profile.json
npm run privacy:scan
docker compose up -d --build
```

Open `http://localhost:8080`. The API creates empty databases and schemas on first start. Its health endpoint performs a rolled-back SQLite read/write probe, so it verifies storage without leaving test data.

Android phone-only hosting is documented in [Termux deployment](docs/TERMUX.md). See [deployment](docs/DEPLOYMENT.md), [architecture](docs/ARCHITECTURE.md), and the [safe publishing checklist](docs/PUBLISHING.md).

## Layout

- `apps/web` — installable PWA frontend
- `apps/api` — HTTP API and provider orchestration
- `packages/mcp` — canonical remote MCP server
- `config` — public example configuration
- `private` — ignored local identity and secrets
- `data` — ignored databases and generated media

## Security defaults

Arbitrary shell execution is not part of the Community MCP. Health, radio, image, voice, toy, and CLI bridge integrations are off by default. The API bridge uses an allowlist. MCP accepts a bearer token at `/mcp`; legacy token-in-path transport remains compatible but should not be placed in proxy access logs.

## License and attribution

Rifugio-authored code is available under the Apache License 2.0 in [LICENSE](LICENSE). UI or virtual-phone portions that may be adapted from [SullyOS / 手抓糯米机](https://github.com/qegj567-cloud/SullyOS) remain subject to the PolyForm Noncommercial License 1.0.0. See [NOTICE](NOTICE) and [the included PolyForm license](LICENSES/PolyForm-Noncommercial-1.0.0.md).

Required Notice: Copyright (c) 2024-2026 NMJ (SullyOS / 手抓糯米机)

Redistributors must preserve all three files and the Required Notice. Commercial use is not authorized for SullyOS-derived portions without separate permission or a provenance audit that removes/replaces them.

Community builds ship emoji/character App launcher defaults rather than third-party photo icons. The installable PWA icons are separate project assets.
