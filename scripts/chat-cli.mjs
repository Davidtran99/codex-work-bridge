#!/usr/bin/env node
/**
 * chat-cli.mjs — tiny helper around the daemon's state dirs.
 *   node scripts/chat-cli.mjs queue <thread> <text...>   # enqueue an outbound message
 *   node scripts/chat-cli.mjs inbox <thread> [n]         # show last n received messages
 *   node scripts/chat-cli.mjs watch <thread>             # add a thread to the watch config
 *   node scripts/chat-cli.mjs status                     # show config + state
 */
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.CODEX_WORK_BRIDGE_STATE ||
  join(homedir(), "Library", "Application Support", "CodexWorkBridge");
const OUTBOX = join(STATE_DIR, "outbox");
const INBOX = join(STATE_DIR, "inbox");
const CONFIG_PATH = join(STATE_DIR, "config.json");
const STATE_PATH = join(STATE_DIR, "state.json");

async function readJson(p, f) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return f; } }

const [,, cmd, ...rest] = process.argv;
await mkdir(OUTBOX, { recursive: true });
await mkdir(INBOX, { recursive: true });

if (cmd === "queue") {
  const [thread, ...parts] = rest;
  if (!thread || !parts.length) { console.error("usage: queue <thread> <text...>"); process.exit(1); }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const file = join(OUTBOX, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.json`);
  await writeFile(file, JSON.stringify({ thread_id: thread, text: parts.join(" "), role: "ide" }, null, 2) + "\n");
  console.log(`queued -> ${file}`);
} else if (cmd === "inbox") {
  const [thread, n] = rest;
  const path = join(INBOX, `${thread}.jsonl`);
  if (!existsSync(path)) { console.log("(no messages yet)"); process.exit(0); }
  const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  const take = n ? Number(n) : 20;
  for (const line of lines.slice(-take)) {
    const m = JSON.parse(line);
    console.log(`[${m.created_at}] ${m.role}#${m.id}${m.reply_to ? ` (re:${m.reply_to})` : ""}\n  ${m.text}\n`);
  }
} else if (cmd === "watch") {
  const [thread] = rest;
  const cfg = await readJson(CONFIG_PATH, { threads: [], role: "ide" });
  if (!cfg.threads.includes(thread)) cfg.threads.push(thread);
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`watching: ${cfg.threads.join(", ")}`);
} else if (cmd === "status") {
  console.log("config:", JSON.stringify(await readJson(CONFIG_PATH, {}), null, 2));
  console.log("state:", JSON.stringify(await readJson(STATE_PATH, {}), null, 2));
} else {
  console.error("commands: queue | inbox | watch | status");
  process.exit(1);
}
