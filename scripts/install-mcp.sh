#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/mcp-server/src/index.js"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required; found $(node --version)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI is required. Install/update Codex, then rerun this script." >&2
  exit 1
fi

cd "$ROOT"
npm install
npm run mcp:smoke

codex mcp remove codex-work-bridge >/dev/null 2>&1 || true
codex mcp add codex-work-bridge \
  --env "CODEX_WORK_BRIDGE_ROOT=$ROOT" \
  -- node "$SERVER"

echo
echo "Installed codex-work-bridge MCP."
echo "Run: codex mcp list"
echo "Then restart the Codex IDE extension and type /mcp in a new task."

