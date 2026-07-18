# Architecture

Rifugio Community separates reusable code from every user's private instance.

Public code owns schemas, migrations, memory ranking, MCP tools, provider adapters, UI components, tests, and deployment templates.

A private instance owns profile values, relationship prompts, credentials, databases, health records, chat transcripts, generated media, uploaded assets, and backups. These paths are ignored by Git.

Application code reads identity and paths through `apps/api/modules/community-config.js`. Provider-specific names may appear only in provider adapters and documentation; the relationship companion is represented by configured display names.

The remote MCP server is canonical. API model seats consume an allowlisted subset. Administrative shell and filesystem capabilities are omitted from the Community MCP; device-control capabilities are disabled by default.
