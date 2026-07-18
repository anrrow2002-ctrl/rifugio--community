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

See [deployment](docs/DEPLOYMENT.md), [architecture](docs/ARCHITECTURE.md), and the [safe publishing checklist](docs/PUBLISHING.md).

## Layout

- `apps/web` — installable PWA frontend
- `apps/api` — HTTP API and provider orchestration
- `packages/mcp` — canonical remote MCP server
- `config` — public example configuration
- `private` — ignored local identity and secrets
- `data` — ignored databases and generated media

## Security defaults

Arbitrary shell execution is not part of the Community MCP. Health, radio, image, voice, toy, and CLI bridge integrations are off by default. The API bridge uses an allowlist. MCP accepts a bearer token at `/mcp`; legacy token-in-path transport remains compatible but should not be placed in proxy access logs.

## License

Apache License 2.0. See LICENSE.
