import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "../..");
const sandbox = await mkdtemp(resolve(tmpdir(), "codex-work-bridge-mcp-"));
await cp(resolve(root, "bridge.py"), resolve(sandbox, "bridge.py"));
await cp(resolve(root, ".gitignore"), resolve(sandbox, ".gitignore"));
await writeFile(resolve(sandbox, "PROJECT_STATE.md"), "# Test state\n", "utf8");
await mkdir(resolve(sandbox, "exchange/ide-to-work"), { recursive: true });
await mkdir(resolve(sandbox, "exchange/work-to-ide"), { recursive: true });

// --- git setup so publish_handoff / sync_handoffs can be exercised end-to-end ---
const bareRemote = await mkdtemp(resolve(tmpdir(), "codex-work-bridge-remote-"));
function gitIn(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || "").trim();
}
gitIn(bareRemote, ["init", "--bare", "-b", "main"]);
gitIn(sandbox, ["init", "-b", "main"]);
gitIn(sandbox, ["config", "user.name", "smoke"]);
gitIn(sandbox, ["config", "user.email", "smoke@example.com"]);
gitIn(sandbox, ["add", "."]);
gitIn(sandbox, ["commit", "-m", "seed"]);
gitIn(sandbox, ["remote", "add", "origin", bareRemote]);
gitIn(sandbox, ["push", "--set-upstream", "origin", "main"]);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "mcp-server/src/index.js")],
  env: { ...process.env, CODEX_WORK_BRIDGE_ROOT: sandbox },
  stderr: "pipe",
});

const client = new Client({ name: "bridge-smoke-test", version: "1.0.0" });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  const expected = [
    "bridge_status",
    "list_handoffs",
    "read_handoff",
    "create_handoff",
    "write_handoff_text_file",
    "update_handoff",
    "validate_bridge",
    "pack_handoff",
    "sync_handoffs",
    "publish_handoff",
    "chat_send",
    "chat_read",
  ];
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
  }

  const created = await client.callTool({
    name: "create_handoff",
    arguments: {
      direction: "ide-to-work",
      title: "MCP smoke test",
      request_markdown: "# MCP smoke test\n\nCreate, update, validate and pack this handoff.",
    },
  });
  if (created.isError) throw new Error("create_handoff returned an error");
  const createdText = created.content.find((block) => block.type === "text")?.text;
  const createdData = JSON.parse(createdText);

  const written = await client.callTool({
    name: "write_handoff_text_file",
    arguments: { id: createdData.id, relative_path: "result.txt", content: "MCP write tool works.\n" },
  });
  if (written.isError) throw new Error("write_handoff_text_file returned an error");

  const updated = await client.callTool({
    name: "update_handoff",
    arguments: {
      id: createdData.id,
      status: "ready_for_review",
      response_markdown: "# Result\n\nMCP end-to-end smoke test passed.",
    },
  });
  if (updated.isError) throw new Error("update_handoff returned an error");

  const result = await client.callTool({ name: "validate_bridge", arguments: {} });
  if (result.isError) throw new Error("validate_bridge returned an error");

  const packed = await client.callTool({ name: "pack_handoff", arguments: { id: createdData.id } });
  if (packed.isError) throw new Error("pack_handoff returned an error");
  const resultFile = resolve(sandbox, createdData.path, "files/result.txt");
  if ((await readFile(resultFile, "utf8")) !== "MCP write tool works.\n") {
    throw new Error("Written attachment content did not match");
  }

  // --- publish_handoff: validate + commit-onto-branch + push to bare remote ---
  const published = await client.callTool({ name: "publish_handoff", arguments: { id: createdData.id } });
  if (published.isError) throw new Error(`publish_handoff returned an error: ${published.content?.[0]?.text}`);
  const pub = JSON.parse(published.content.find((b) => b.type === "text")?.text);
  if (pub.branch !== `bridge/ide-to-work/${createdData.id}`) throw new Error(`Unexpected branch: ${pub.branch}`);
  if (!pub.pushed || !pub.commit) throw new Error("publish_handoff did not push/commit");
  if (pub.files.some((f) => !f.startsWith(`exchange/ide-to-work/${createdData.id}/`))) {
    throw new Error("publish_handoff staged files outside the handoff scope");
  }

  // publishing the same handoff again must be refused (branch already exists)
  const dup = await client.callTool({ name: "publish_handoff", arguments: { id: createdData.id } });
  if (!dup.isError) throw new Error("publish_handoff should refuse an existing branch");

  // --- sync_handoffs: on main (which has an upstream) it must fast-forward or be up-to-date ---
  gitIn(sandbox, ["checkout", "main"]);
  const synced = await client.callTool({ name: "sync_handoffs", arguments: {} });
  if (synced.isError) throw new Error(`sync_handoffs returned an error: ${synced.content?.[0]?.text}`);
  const sync = JSON.parse(synced.content.find((b) => b.type === "text")?.text);
  if (!["already-up-to-date", "fast-forwarded"].includes(sync.result)) {
    throw new Error(`Unexpected sync result: ${sync.result}`);
  }

  // --- sync_handoffs must refuse a dirty worktree ---
  await writeFile(resolve(sandbox, "dirty.txt"), "uncommitted\n", "utf8");
  const dirtySync = await client.callTool({ name: "sync_handoffs", arguments: {} });
  if (!dirtySync.isError) throw new Error("sync_handoffs should refuse a dirty worktree");
  await rm(resolve(sandbox, "dirty.txt"), { force: true });

  // --- chat_send / chat_read: threaded async round-trip over the bare remote ---
  gitIn(sandbox, ["checkout", "main"]);
  const thread = "smoke-thread";

  // reading a non-existent thread is not an error
  const empty = await client.callTool({ name: "chat_read", arguments: { thread_id: thread } });
  if (empty.isError) throw new Error(`chat_read (empty) errored: ${empty.content?.[0]?.text}`);
  if (JSON.parse(empty.content[0].text).exists !== false) throw new Error("empty thread should report exists=false");

  const s1 = await client.callTool({ name: "chat_send", arguments: { thread_id: thread, text: "hello from ide", role: "ide" } });
  if (s1.isError) throw new Error(`chat_send #1 errored: ${s1.content?.[0]?.text}`);
  const m1 = JSON.parse(s1.content[0].text);
  if (m1.branch !== `bridge/chat/${thread}` || !m1.pushed) throw new Error("chat_send #1 did not push to the thread branch");

  // must return to main after sending
  const cur = gitIn(sandbox, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (cur !== "main") throw new Error(`chat_send left us on ${cur}, expected main`);

  const s2 = await client.callTool({ name: "chat_send", arguments: { thread_id: thread, text: "second message", role: "ide", reply_to: m1.id } });
  if (s2.isError) throw new Error(`chat_send #2 errored: ${s2.content?.[0]?.text}`);
  const m2 = JSON.parse(s2.content[0].text);

  const readAll = await client.callTool({ name: "chat_read", arguments: { thread_id: thread } });
  const all = JSON.parse(readAll.content[0].text);
  if (all.total !== 2) throw new Error(`expected 2 messages, got ${all.total}`);
  if (all.messages[0].text !== "hello from ide" || all.messages[1].reply_to !== m1.id) {
    throw new Error("chat_read returned unexpected message ordering/content");
  }

  // since_id must return only newer messages (dedupe)
  const readSince = await client.callTool({ name: "chat_read", arguments: { thread_id: thread, since_id: m1.id } });
  const since = JSON.parse(readSince.content[0].text);
  if (since.count !== 1 || since.messages[0].id !== m2.id) throw new Error("since_id dedupe failed");

  // secret guard on chat
  const leak = await client.callTool({ name: "chat_send", arguments: { thread_id: thread, text: "token sk-abcdefghijklmnopqrstuvwxyz012345", role: "ide" } });
  if (!leak.isError) throw new Error("chat_send should refuse a message containing a secret");

  await rm(bareRemote, { recursive: true, force: true });

  console.log(`MCP end-to-end smoke test passed: ${names.length} tools available; create, write, update, validate, pack, publish, sync and threaded chat succeeded.`);
} finally {
  await client.close();
  await rm(sandbox, { recursive: true, force: true });
}
