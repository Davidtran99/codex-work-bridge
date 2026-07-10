# Project State

## Current goal

Maintain a reliable file-based collaboration channel between Codex IDE and ChatGPT Work.

## Current status

- Bridge scaffold created.
- End-to-end handoff test executed on 2026-07-10.
- Codex IDE → Work request was received.
- Work → Codex IDE response and file were created.
- Local MCP STDIO server added with 8 tools.
- MCP end-to-end smoke test passed: create, write, update, validate and pack.
- npm dependency audit reported 0 vulnerabilities at build time.

## Decisions

- GitHub is the preferred shared source of truth.
- ZIP packages are the manual fallback.
- Each handoff is immutable after completion; follow-up work gets a new handoff.
- Secrets must never be included.
- Local MCP is for Codex CLI/IDE/desktop; ChatGPT Work web exchanges through GitHub or ZIP.

## Next action

Have Codex IDE read the test response, then create the first handoff from an actual project.
