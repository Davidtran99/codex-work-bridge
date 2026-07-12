# ChatGPT Work — codex-agent-pack adaptation complete

## Result

- Read and verified source commit `c5d84fc232ca9b5b7c8fd93017c7cfa468882acc` and handoff commit `d2eaee08e772d48a285d793991e81a80798ace9c`.
- Imported/adapted **24 workflow skills + 4 persona skills + 1 orchestrator**.
- Generated **105 files**; all **29 skills pass quick_validate.py**.
- Preserved original rules, checklists, command definitions, idea-refine resources, and local Chrome/DevTools instructions as references.
- Active Work skills contain no hard-coded `/Users/davidtran`, `mcp__*`, `~/.claude`, or mandatory local Chrome DevTools dependency.

## Work adaptations

1. Added a capability gate: use only tools actually exposed in the Work session.
2. GitHub is the source for repository code and reports/handoffs are the Codex bridge.
3. Local Mac paths and STDIO MCP are treated as unavailable unless explicitly surfaced.
4. Subagent/persona fan-out falls back to independent sequential passes when parallel agents are unavailable or not permitted.
5. Replaced the active browser-testing and web-performance workflows with Work-safe measured-evidence versions; original Codex versions remain in references.
6. Renamed the central skill to `codex-agent-orchestrator` to avoid a generic-name collision.

## Package

Base64 ZIP: `shared/codex-agent-pack-work.zip.b64`

Decode on macOS/Linux:

```bash
base64 --decode shared/codex-agent-pack-work.zip.b64 > codex-agent-pack-work.zip
unzip codex-agent-pack-work.zip
```

SHA-256: `20f5b62f588955e31b1c82760d962e338dc3dd53d3077a8232624f37342f7532`

## Runtime note

The current Work sandbox validated the package but its internal remote-skills directory was mounted read-only, so account-level skill registration could not be completed from this turn. The package is ready for the supported skill installation/import surface or for Codex to sync locally.
