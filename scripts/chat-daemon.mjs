#!/usr/bin/env node
/**
 * chat-daemon.mjs — auto send + receive for the codex-work-bridge chat layer.
 *
 * One run (launchd calls it on an interval):
 *   1) Sends every queued message in <state>/outbox/*.json via chat_send.
 *   2) Polls every thread in <state>/config.json via chat_read (since_id) and
 *      appends new messages to <state>/inbox/<thread>.jsonl.
 *
 * State lives OUTSIDE the git repo so it never dirties the worktree (a dirty
 * worktree would make chat_send refuse). Talks to the same MCP server the IDE
 * uses, so all safety guards (secret scan, scope, no-force, ff-only) apply.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, writeFile, mkdir, readdir, rename, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = process.env.CODEX_WORK_BRIDGE_STATE ||
  join(homedir(), "Library", "Application Support", "CodexWorkBridge");
const OUTBOX = join(STATE_DIR, "outbox");
const SENT = join(STATE_DIR, "sent");
const FAILED = join(STATE_DIR, "failed");
const INBOX = join(STATE_DIR, "inbox");
const CONFIG_PATH = join(STATE_DIR, "config.json");
const STATE_PATH = join(STATE_DIR, "state.json");
const LOG_PATH = join(STATE_DIR, "daemon.log");

async function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  try { await appendFile(LOG_PATH, line); } catch { /* ignore */ }
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function ensureLayout() {
  for (const d of [STATE_DIR, OUTBOX, SENT, FAILED, INBOX]) await mkdir(d, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    await writeFile(CONFIG_PATH, JSON.stringify({ threads: ["codex-work-chat"], role: "ide" }, null, 2) + "\n");
  }
}

function parseTool(res) {
  const block = res.content?.find((b) => b.type === "text");
  let data = null;
  if (block) { try { data = JSON.parse(block.text); } catch { data = null; } }
  return { isError: !!res.isError, data, raw: block?.text };
}

async function main() {
  await ensureLayout();
  const config = await readJson(CONFIG_PATH, { threads: [], role: "ide" });
  const state = await readJson(STATE_PATH, { lastSeen: {} });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(REPO_ROOT, "mcp-server", "src", "index.js")],
    env: { ...process.env, CODEX_WORK_BRIDGE_ROOT: REPO_ROOT },
    stderr: "pipe",
  });
  const client = new Client({ name: "chat-daemon", version: "1.0.0" });
  await client.connect(transport);

  try {
    // 1) SEND: drain the outbox.
    let outboxFiles = [];
    try { outboxFiles = (await readdir(OUTBOX)).filter((f) => f.endsWith(".json")).sort(); } catch { /* none */ }
    for (const file of outboxFiles) {
      const src = join(OUTBOX, file);
      const msg = await readJson(src, null);
      if (!msg || !msg.thread_id || !msg.text) { await rename(src, join(FAILED, file)); await log(`SEND skip malformed ${file}`); continue; }
      const res = parseTool(await client.callTool({
        name: "chat_send",
        arguments: { thread_id: msg.thread_id, text: msg.text, role: msg.role || config.role || "ide", ...(msg.reply_to ? { reply_to: msg.reply_to } : {}) },
      }));
      if (res.isError) { await rename(src, join(FAILED, file)); await log(`SEND FAIL ${file}: ${res.raw}`); }
      else { await rename(src, join(SENT, file)); await log(`SEND ok thread=${msg.thread_id} id=${res.data?.id}`); }
    }

    // 2) RECEIVE: poll each watched thread, append new messages to inbox.
    for (const thread of config.threads || []) {
      const since = state.lastSeen?.[thread];
      const res = parseTool(await client.callTool({
        name: "chat_read",
        arguments: { thread_id: thread, ...(since ? { since_id: since } : {}), limit: 200 },
      }));
      if (res.isError) { await log(`READ FAIL thread=${thread}: ${res.raw}`); continue; }
      const messages = res.data?.messages || [];
      if (messages.length) {
        const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
        await appendFile(join(INBOX, `${thread}.jsonl`), lines);
        await log(`RECV thread=${thread} new=${messages.length}`);
      }
      if (res.data?.last_id) { state.lastSeen = state.lastSeen || {}; state.lastSeen[thread] = res.data.last_id; }
    }

    await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  } finally {
    await client.close();
  }
}

main().catch(async (e) => { await log(`FATAL ${e?.message || e}`); process.exit(1); });
