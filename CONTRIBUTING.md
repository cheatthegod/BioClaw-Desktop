# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Skills

Two places, two purposes:

- **`container/skills/<name>/`** — Loaded by the **chat agent** (Docker). Use for anything users should have at runtime (API guides, plot scripts, domain skills). Can include `SKILL.md` plus nested files (e.g. `bio-tools/templates/*.py`). Sync is **recursive**.

- **`.claude/skills/<name>/`** — For **Claude Code on the repo**: setup, adding channels, converting to Docker, scaffolding. Usually instructions-only; see `/convert-to-docker`.

A PR that contributes a **developer** skill under `.claude/skills/` should not modify source files. Your skill should contain the **instructions** Claude follows—not pre-built app code. See `/convert-to-docker` for a good example.

Runtime skills under `container/skills/` may ship markdown + assets together; those PRs may touch `container/` only or include small host changes if justified.

### Why?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Testing

Test your skill by running it on a fresh clone before submitting.
