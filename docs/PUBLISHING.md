# Safe publishing checklist

- Publish only this clean-room repository, never a mirror of the private repository.
- Run `npm run privacy:scan` before every push.
- Review `git status --ignored`; databases, media, `.env`, and `private/` must remain ignored.
- Search the full Git history before making the repository public.
- Use a new public repository with no inherited private commits.
- Rotate any credential that ever appeared in source, logs, screenshots, issues, or commits.
- Keep optional personal/device integrations disabled by default.
- Keep `LICENSE`, `NOTICE`, `LICENSES/PolyForm-Noncommercial-1.0.0.md`, and every `Required Notice:` line when redistributing.
- Do not describe the whole distribution as Apache-only: SullyOS-derived portions are noncommercial unless separately relicensed or removed after a provenance audit.
- Do not add third-party App launcher photos without documented redistribution permission; community defaults must remain emoji/character icons.
- Test from an empty `data/` directory.
