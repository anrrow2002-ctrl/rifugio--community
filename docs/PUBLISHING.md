# Safe publishing checklist

- Publish only this clean-room repository, never a mirror of the private repository.
- Run `npm run privacy:scan` before every push.
- Review `git status --ignored`; databases, media, `.env`, and `private/` must remain ignored.
- Search the full Git history before making the repository public.
- Use a new public repository with no inherited private commits.
- Rotate any credential that ever appeared in source, logs, screenshots, issues, or commits.
- Keep optional personal/device integrations disabled by default.
- Keep the Apache-2.0 license and required notices when redistributing.
- Test from an empty `data/` directory.
