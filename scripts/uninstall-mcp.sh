#!/usr/bin/env bash
set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI is not available. Remove [mcp_servers.codex-work-bridge] manually from ~/.codex/config.toml." >&2
  exit 1
fi

codex mcp remove codex-work-bridge
echo "Removed codex-work-bridge MCP configuration. Project files were not deleted."

