# Project State

## Current goal

Maintain a reliable file-based collaboration channel between Codex IDE and ChatGPT Work.

## Current status (2026-07-10)

- Bridge scaffold + local MCP STDIO server (8 tools) installed; smoke test passes end-to-end.
- npm dependency audit: 0 vulnerabilities at build time.
- Repo synced to GitHub: `Davidtran99/codex-work-bridge` (PUBLIC), default branch `main`.
- Two-way exchange is working for real over GitHub (asynchronous, manually triggered):
  - Codex IDE → GitHub → Work (read): verified.
  - Work → GitHub → Codex IDE (write branch + push): verified after installing the ChatGPT Codex Connector GitHub App.
- Completed real handoff rounds:
  - `ide-to-work/20260710-161338-...` (two-way connection test) — completed.
  - `ide-to-work/20260710-163852-...` (Guitar Trainer report) — completed, Work returned architecture feedback.
- `bridge.py validate` hardened: `files/` is now optional (git drops empty dirs) and validation cross-checks `manifest.files` ↔ real files/ (missing/extra both fail).
- Response branches merged into `main` with `--no-ff`; only `main` remains.

## Known limitations

- Exchange is asynchronous and manually triggered (no realtime). Each round needs: Codex push → tell Work to read → Work pushes response branch → tell Codex to fetch/merge.
- No auto git tooling inside MCP (pull/commit/push/branch are done by the human/Codex on the machine).
- No webhook, watcher, queue, dedupe, or automatic acknowledgement.
- MCP tools operate on local files only; ChatGPT Work web cannot call the local MCP directly.

## Decisions

- GitHub is the preferred shared source of truth; ZIP packages are the manual fallback.
- Each handoff is immutable after completion; follow-up work gets a new handoff.
- Secrets must never be included (repo is public).
- `files/` is optional; only handoff.json + REQUEST.md + RESPONSE.md are required.
- Local MCP is for Codex CLI/IDE/desktop; ChatGPT Work web exchanges through GitHub.
- Do NOT copy full application source (e.g. songcoach) into this public bridge repo; grant read access to the real repo or use a private repo for deep review.

## Next action (optional, not yet done)

Toward near-realtime (a few minutes latency): Codex IDE watches GitHub and pulls on new `work-to-ide` handoffs; a ChatGPT Work Automation polls `ide-to-work`; each handoff carries `processed_at`/`processed_by` + a dedupe id; auto branch/commit while keeping a human review step before merge. True instant realtime would need a remote relay + GitHub webhook + queue, which the local STDIO MCP cannot provide.
