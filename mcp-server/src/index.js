#!/usr/bin/env node

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(THIS_DIR, "../..");
const ROOT = resolve(process.env.CODEX_WORK_BRIDGE_ROOT || DEFAULT_ROOT);
const EXCHANGE = join(ROOT, "exchange");
const DIRECTIONS = ["ide-to-work", "work-to-ide"];
const STATUSES = ["open", "in_progress", "blocked", "ready_for_review", "completed"];
const MAX_TEXT_BYTES = 1024 * 1024;

function text(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError };
}

function assertInsideRoot(path) {
  const absolute = resolve(path);
  const rel = relative(ROOT, absolute);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return absolute;
  throw new Error("Path escapes the bridge root");
}

function handoffPath(direction, id) {
  if (!DIRECTIONS.includes(direction)) throw new Error("Invalid direction");
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Invalid handoff id");
  return assertInsideRoot(join(EXCHANGE, direction, id));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function runBridge(args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("python3", [join(ROOT, "bridge.py"), ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(stderr.trim() || `bridge.py exited with ${code}`));
    });
  });
}

async function findHandoff(id) {
  for (const direction of DIRECTIONS) {
    const path = handoffPath(direction, id);
    if (existsSync(join(path, "handoff.json"))) return { direction, path };
  }
  throw new Error(`Handoff not found: ${id}`);
}

async function runGit(args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function git(args) {
  const r = await runGit(args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  return r.stdout;
}

async function assertGitRepo() {
  const r = await runGit(["rev-parse", "--is-inside-work-tree"]);
  if (r.code !== 0 || r.stdout !== "true") throw new Error("Bridge root is not a git working tree");
}

async function currentBranch() {
  return await git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

async function isWorktreeDirty() {
  const out = await git(["status", "--porcelain"]);
  return out.length > 0;
}

// Entries ALREADY STAGED in the index that fall OUTSIDE exchange/<dir>/<id>/.
// Only staged paths matter for publish safety: a scoped `git add` never touches
// untracked/unstaged files elsewhere, but anything pre-staged would be swept
// into the commit, so we refuse when that happens.
async function stagedOutsideScope(scopeRel) {
  const out = await git(["diff", "--cached", "--name-only"]);
  if (!out) return [];
  const prefix = scopeRel.endsWith("/") ? scopeRel : `${scopeRel}/`;
  return out.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => path !== scopeRel && !path.startsWith(prefix));
}

function hasLikelySecret(content) {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s]{8,}/i,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
  ];
  return patterns.some((pattern) => pattern.test(content));
}

// ---- Chat layer (threaded, async, over GitHub branches) --------------------
// A chat thread lives on branch bridge/chat/<thread_id>. Each message is its
// own JSON file under chat/<thread_id>/ so appends never collide and message
// ids give natural dedupe. chat_read fetches and reads straight from the
// remote-tracking ref WITHOUT merging into the working branch.
const CHAT_DIR = "chat";
const CHAT_ROLES = ["ide", "work"];
const THREAD_ID_RE = /^[a-zA-Z0-9._-]{1,120}$/;

function chatBranch(threadId) {
  if (!THREAD_ID_RE.test(threadId)) throw new Error("Invalid thread_id");
  return `bridge/chat/${threadId}`;
}

function newMessageId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// List "<name> <sha>"-style entries of a directory in a remote ref, without checkout.
async function readRemoteThreadMessages(threadId) {
  const branch = chatBranch(threadId);
  const ref = `origin/${branch}`;
  const exists = (await runGit(["rev-parse", "--verify", "--quiet", ref])).code === 0;
  if (!exists) return { branch, exists: false, messages: [] };
  const dir = `${CHAT_DIR}/${threadId}`;
  const tree = await runGit(["ls-tree", "--name-only", ref, `${dir}/`]);
  if (tree.code !== 0) return { branch, exists: true, messages: [] };
  const files = tree.stdout.split("\n").map((x) => x.trim()).filter((f) => f.endsWith(".json"));
  files.sort();
  const messages = [];
  for (const file of files) {
    const show = await runGit(["show", `${ref}:${file}`]);
    if (show.code !== 0) continue;
    try { messages.push(JSON.parse(show.stdout)); } catch { /* skip malformed */ }
  }
  messages.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  return { branch, exists: true, messages };
}

const server = new McpServer(
  { name: "codex-work-bridge", version: "1.0.0" },
  {
    instructions:
      "Use this server for structured file handoffs between Codex IDE and ChatGPT Work. Read PROJECT_STATE.md and list_handoffs before acting. Never place credentials, tokens, cookies, .env contents, private keys, or authentication codes in a handoff. Use ide-to-work for requests sent to Work and work-to-ide for results returned to Codex IDE. Validate before packing.",
  },
);

server.registerTool(
  "bridge_status",
  {
    title: "Bridge status",
    description: "Read project state and summarize all current handoffs. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {},
  },
  async () => {
    try {
      const projectState = await readFile(join(ROOT, "PROJECT_STATE.md"), "utf8");
      const status = await runBridge(["status"]);
      return text({ root: ROOT, project_state: projectState, handoffs: status });
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "list_handoffs",
  {
    title: "List handoffs",
    description: "List handoff metadata, optionally filtered by direction or status. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      direction: z.enum(DIRECTIONS).optional(),
      status: z.enum(STATUSES).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ direction, status: wantedStatus, limit }) => {
    try {
      const directions = direction ? [direction] : DIRECTIONS;
      const items = [];
      for (const currentDirection of directions) {
        const base = join(EXCHANGE, currentDirection);
        await mkdir(base, { recursive: true });
        for (const entry of await readdir(base, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const manifestPath = join(base, entry.name, "handoff.json");
          if (!existsSync(manifestPath)) continue;
          const manifest = await readJson(manifestPath);
          if (!wantedStatus || manifest.status === wantedStatus) items.push(manifest);
        }
      }
      items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return text(items.slice(0, limit));
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "read_handoff",
  {
    title: "Read handoff",
    description: "Read a handoff manifest, request, response, and attachment list. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { id: z.string().min(1).max(120) },
  },
  async ({ id }) => {
    try {
      const { direction, path } = await findHandoff(id);
      const filesDir = join(path, "files");
      const files = existsSync(filesDir)
        ? (await readdir(filesDir, { recursive: true, withFileTypes: true }))
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
        : [];
      return text({
        direction,
        manifest: await readJson(join(path, "handoff.json")),
        request: await readFile(join(path, "REQUEST.md"), "utf8"),
        response: await readFile(join(path, "RESPONSE.md"), "utf8"),
        files,
      });
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "create_handoff",
  {
    title: "Create handoff",
    description: "Create a new structured handoff. This writes files under exchange/.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      direction: z.enum(DIRECTIONS),
      title: z.string().min(1).max(160),
      request_markdown: z.string().max(200000).optional(),
    },
  },
  async ({ direction, title, request_markdown }) => {
    try {
      if (request_markdown && hasLikelySecret(request_markdown)) throw new Error("Request appears to contain a secret; remove it before creating the handoff");
      const relativePath = await runBridge(["new", direction, title]);
      const path = assertInsideRoot(join(ROOT, relativePath));
      if (request_markdown) await writeFile(join(path, "REQUEST.md"), `${request_markdown.trim()}\n`, "utf8");
      return text({ id: path.split(sep).at(-1), direction, path: relative(ROOT, path) });
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "write_handoff_text_file",
  {
    title: "Write handoff text file",
    description: "Write a UTF-8 text attachment inside one handoff's files/ directory. Rejects path traversal and likely secrets.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      id: z.string().min(1).max(120),
      relative_path: z.string().min(1).max(240),
      content: z.string().max(MAX_TEXT_BYTES),
      overwrite: z.boolean().default(false),
    },
  },
  async ({ id, relative_path, content, overwrite }) => {
    try {
      if (hasLikelySecret(content)) throw new Error("Content appears to contain a secret; remove it before writing");
      const { path } = await findHandoff(id);
      const filesRoot = join(path, "files");
      const destination = resolve(filesRoot, relative_path);
      const rel = relative(filesRoot, destination);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Attachment path escapes files/");
      if (existsSync(destination) && !overwrite) throw new Error("File exists; set overwrite=true only after reviewing it");
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
      return text({ id, file: relative(path, destination), bytes: Buffer.byteLength(content) });
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "update_handoff",
  {
    title: "Update handoff",
    description: "Update response Markdown and/or handoff status. This writes existing handoff files.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      id: z.string().min(1).max(120),
      response_markdown: z.string().max(200000).optional(),
      status: z.enum(STATUSES).optional(),
    },
  },
  async ({ id, response_markdown, status: nextStatus }) => {
    try {
      if (!response_markdown && !nextStatus) throw new Error("Provide response_markdown or status");
      if (response_markdown && hasLikelySecret(response_markdown)) throw new Error("Response appears to contain a secret; remove it before updating");
      const { path } = await findHandoff(id);
      if (response_markdown) await writeFile(join(path, "RESPONSE.md"), `${response_markdown.trim()}\n`, "utf8");
      const manifestPath = join(path, "handoff.json");
      const manifest = await readJson(manifestPath);
      if (nextStatus) manifest.status = nextStatus;
      manifest.updated_at = new Date().toISOString();
      const filesRoot = join(path, "files");
      if (existsSync(filesRoot)) {
        const fileNames = [];
        async function walk(dir) {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const item = join(dir, entry.name);
            if (entry.isDirectory()) await walk(item);
            else if (entry.isFile()) fileNames.push(relative(path, item));
          }
        }
        await walk(filesRoot);
        manifest.files = fileNames.sort();
      }
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      return text(manifest);
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "validate_bridge",
  {
    title: "Validate bridge",
    description: "Validate every handoff or one handoff using bridge.py. Read-only except for ordinary process metadata.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { id: z.string().min(1).max(120).optional() },
  },
  async ({ id }) => {
    try {
      const args = ["validate"];
      if (id) {
        const { path } = await findHandoff(id);
        args.push(relative(ROOT, path));
      }
      return text(await runBridge(args));
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "pack_handoff",
  {
    title: "Pack handoff",
    description: "Validate and create a ZIP package for one handoff. Writes under .bridge/packages/.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: { id: z.string().min(1).max(120) },
  },
  async ({ id }) => {
    try {
      const { path } = await findHandoff(id);
      const output = await runBridge(["pack", relative(ROOT, path)]);
      const packagePath = assertInsideRoot(join(ROOT, output));
      const info = await stat(packagePath);
      return text({ id, package: relative(ROOT, packagePath), bytes: info.size });
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "sync_handoffs",
  {
    title: "Sync handoffs (safe pull)",
    description:
      "Fetch + prune the current branch and fast-forward ONLY. Refuses if the worktree is dirty or the branch has diverged. Never merges, resets, or force-updates. Read-mostly: only advances the branch pointer when a clean fast-forward is possible.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {},
  },
  async () => {
    try {
      await assertGitRepo();
      if (await isWorktreeDirty()) {
        return text("Refusing to sync: the worktree has uncommitted changes. Commit or stash them first.", true);
      }
      const branch = await currentBranch();
      if (branch === "HEAD") return text("Refusing to sync: detached HEAD. Checkout a branch first.", true);

      const upstreamProbe = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
      if (upstreamProbe.code !== 0) {
        return text(`Refusing to sync: branch '${branch}' has no upstream tracking branch.`, true);
      }
      const upstream = upstreamProbe.stdout;

      await git(["fetch", "--prune", "origin"]);

      const local = await git(["rev-parse", "HEAD"]);
      const remote = await git(["rev-parse", upstream]);
      if (local === remote) {
        return text({ branch, upstream, result: "already-up-to-date", head: local });
      }
      const base = await git(["merge-base", "HEAD", upstream]);
      if (base !== local) {
        // Local has commits not on upstream => diverged or ahead. Do not touch.
        const ahead = base === remote ? "ahead" : "diverged";
        return text(`Refusing to sync: branch '${branch}' is ${ahead} of '${upstream}'. Fast-forward not possible; resolve manually.`, true);
      }
      // base === local && local !== remote => strictly behind: fast-forward is safe.
      await git(["merge", "--ff-only", upstream]);
      const newHead = await git(["rev-parse", "HEAD"]);
      return text({ branch, upstream, result: "fast-forwarded", from: local, to: newHead });
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "publish_handoff",
  {
    title: "Publish handoff (safe commit + branch)",
    description:
      "Validate one handoff, commit ONLY that handoff's directory onto a fresh branch bridge/<direction>/<id>, and push it. Never commits files outside the handoff dir. Never pushes to main. Never force-pushes. Returns branch, commit SHA, and committed files.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      id: z.string().min(1).max(120),
      message: z.string().min(1).max(500).optional(),
      push: z.boolean().default(true),
    },
  },
  async ({ id, message, push }) => {
    try {
      await assertGitRepo();
      const { direction, path } = await findHandoff(id);
      const scopeRel = relative(ROOT, path).split(sep).join("/");

      // 1) Refuse if anything is ALREADY STAGED outside this handoff dir; a
      //    scoped add ignores untracked files elsewhere, but a pre-staged file
      //    would be swept into the commit.
      const outside = await stagedOutsideScope(scopeRel);
      if (outside.length > 0) {
        return text({ error: "Refusing to publish: staged changes exist outside the handoff scope. Unstage them first.", scope: scopeRel, outside }, true);
      }

      // 2) Validate the handoff via bridge.py before committing.
      const validation = await runBridge(["validate", scopeRel]);

      // 3) Secret scan across the handoff's text files.
      const scanRoot = path;
      async function scan(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const item = join(dir, entry.name);
          if (entry.isDirectory()) { await scan(item); continue; }
          if (!entry.isFile()) continue;
          if (entry.name === ".gitkeep") continue;
          let buf;
          try { buf = await readFile(item, "utf8"); } catch { continue; }
          // Scan large files too, but only their leading MAX_TEXT_BYTES so a big
          // attachment cannot smuggle a secret past the check by being oversized.
          const head = buf.length > MAX_TEXT_BYTES ? buf.slice(0, MAX_TEXT_BYTES) : buf;
          if (hasLikelySecret(head)) {
            throw new Error(`Refusing to publish: '${relative(path, item)}' appears to contain a secret.`);
          }
        }
      }
      await scan(scanRoot);

      // 4) Fresh branch bridge/<direction>/<id>. Never main. Refuse if it already exists.
      const branch = `bridge/${direction}/${id}`;
      if (/^(main|master)$/.test(branch)) return text("Refusing: computed branch resolves to a protected branch.", true);
      const localExists = (await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
      const remoteExists = (await runGit(["ls-remote", "--exit-code", "--heads", "origin", branch])).code === 0;
      if (localExists || remoteExists) {
        return text({ error: `Refusing to publish: branch '${branch}' already exists (${localExists ? "local" : ""}${localExists && remoteExists ? "+" : ""}${remoteExists ? "remote" : ""}). One handoff = one branch.`, branch }, true);
      }

      const startBranch = await currentBranch();
      await git(["checkout", "-b", branch]);
      try {
        // 5) Stage ONLY the handoff dir (add-and-remove within scope).
        await git(["add", "--all", "--", scopeRel]);
        // Guard: staged set must be entirely within scope.
        const staged = (await git(["diff", "--cached", "--name-only"])).split("\n").map((x) => x.trim()).filter(Boolean);
        const prefix = scopeRel.endsWith("/") ? scopeRel : `${scopeRel}/`;
        const strayStaged = staged.filter((f) => f !== scopeRel && !f.startsWith(prefix));
        if (strayStaged.length > 0) {
          await git(["reset", "-q"]);
          await git(["checkout", startBranch]);
          await runGit(["branch", "-D", branch]);
          return text({ error: "Refusing to publish: staging escaped the handoff scope.", stray: strayStaged }, true);
        }
        if (staged.length === 0) {
          await git(["checkout", startBranch]);
          await runGit(["branch", "-D", branch]);
          return text("Nothing to publish: no changes in the handoff directory.", true);
        }

        const commitMessage = message || `bridge(${direction}): publish handoff ${id}`;
        await git(["commit", "-m", commitMessage]);
        const sha = await git(["rev-parse", "HEAD"]);

        let pushed = false;
        let pushError = null;
        if (push) {
          // Never force. Set upstream on first push of this fresh branch.
          const pr = await runGit(["push", "--set-upstream", "origin", branch]);
          if (pr.code === 0) pushed = true;
          else pushError = pr.stderr || pr.stdout || `git push exited ${pr.code}`;
        }
        // Always return the worktree to the base branch; the new branch keeps
        // the commit so a failed push can be retried without losing work.
        await git(["checkout", startBranch]);
        const result = { handoff: id, direction, branch, base: startBranch, commit: sha, files: staged, pushed, validation, message: commitMessage };
        if (pushError) { result.push_error = pushError; return text(result, true); }
        return text(result);
      } catch (error) {
        // Best-effort cleanup: return to the starting branch; keep the new branch for inspection.
        await runGit(["checkout", startBranch]);
        throw error;
      }
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "chat_send",
  {
    title: "Chat send (threaded, async over GitHub)",
    description:
      "Post a chat message from Codex IDE to ChatGPT Work on branch bridge/chat/<thread_id>. Each message is a separate JSON file (id = dedupe key). Fetches the thread branch first, fast-forwards a local copy, appends one message, commits ONLY the chat/<thread_id> dir, and pushes. Never touches main, never force-pushes. Returns thread_id, message id, branch and commit.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      thread_id: z.string().min(1).max(120),
      text: z.string().min(1).max(200000),
      role: z.enum(CHAT_ROLES).default("ide"),
      reply_to: z.string().max(120).optional(),
    },
  },
  async ({ thread_id, text: body, role, reply_to }) => {
    try {
      await assertGitRepo();
      if (hasLikelySecret(body)) return text("Refusing to send: message appears to contain a secret.", true);
      const branch = chatBranch(thread_id);
      const startBranch = await currentBranch();
      if (await isWorktreeDirty()) return text("Refusing to send: commit or stash your changes first (worktree is dirty).", true);

      await runGit(["fetch", "--prune", "origin"]);
      const remoteRef = `origin/${branch}`;
      const remoteExists = (await runGit(["rev-parse", "--verify", "--quiet", remoteRef])).code === 0;

      // Prepare the thread branch locally without disturbing the base branch.
      const localExists = (await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
      if (remoteExists) {
        // Point a clean local branch at the remote tip, then check it out.
        await runGit(["branch", "-f", branch, remoteRef]);
        await git(["checkout", branch]);
      } else {
        if (localExists) await runGit(["branch", "-D", branch]);
        // New thread: branch off the current HEAD; we only ever commit chat files.
        await git(["checkout", "-b", branch]);
      }

      try {
        const id = newMessageId();
        const now = new Date().toISOString();
        const dirRel = `${CHAT_DIR}/${thread_id}`;
        const fileRel = `${dirRel}/${now.replace(/[:.]/g, "-")}_${role}_${id}.json`;
        const abs = assertInsideRoot(join(ROOT, fileRel));
        await mkdir(dirname(abs), { recursive: true });
        const message = { schema_version: 1, id, thread_id, role, reply_to: reply_to || null, created_at: now, text: body };
        await writeFile(abs, `${JSON.stringify(message, null, 2)}\n`, "utf8");

        await git(["add", "--", dirRel]);
        const staged = (await git(["diff", "--cached", "--name-only"])).split("\n").map((x) => x.trim()).filter(Boolean);
        const strayStaged = staged.filter((f) => !f.startsWith(`${dirRel}/`));
        if (strayStaged.length > 0) {
          await git(["reset", "-q"]);
          await git(["checkout", startBranch]);
          return text({ error: "Refusing to send: staging escaped the chat thread scope.", stray: strayStaged }, true);
        }
        await git(["commit", "-m", `chat(${role}): ${thread_id} ${id}`]);
        const sha = await git(["rev-parse", "HEAD"]);
        const pr = await runGit(["push", "--set-upstream", "origin", branch]);
        await git(["checkout", startBranch]);
        if (pr.code !== 0) return text({ thread_id, branch, id, commit: sha, pushed: false, push_error: pr.stderr || pr.stdout }, true);
        return text({ thread_id, branch, id, role, reply_to: reply_to || null, commit: sha, pushed: true, file: fileRel });
      } catch (error) {
        await runGit(["checkout", startBranch]);
        throw error;
      }
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

server.registerTool(
  "chat_read",
  {
    title: "Chat read (threaded, no merge)",
    description:
      "Fetch and read a chat thread from bridge/chat/<thread_id> straight off the remote-tracking ref WITHOUT merging into your working branch. Returns messages in order. Pass since_id to get only messages after a known id (dedupe / avoid re-processing). Read-only for the working tree.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      thread_id: z.string().min(1).max(120),
      since_id: z.string().max(120).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
  },
  async ({ thread_id, since_id, limit }) => {
    try {
      await assertGitRepo();
      await runGit(["fetch", "--prune", "origin"]);
      const { branch, exists, messages } = await readRemoteThreadMessages(thread_id);
      if (!exists) return text({ thread_id, branch, exists: false, messages: [], note: "No such thread yet. Use chat_send to start it." });
      let out = messages;
      if (since_id) {
        const idx = messages.findIndex((m) => m.id === since_id);
        out = idx >= 0 ? messages.slice(idx + 1) : messages;
      }
      const sliced = out.slice(-limit);
      const last = messages.length ? messages[messages.length - 1] : null;
      return text({ thread_id, branch, exists: true, count: sliced.length, total: messages.length, last_id: last ? last.id : null, messages: sliced });
    } catch (error) {
      return text(String(error.message || error), true);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`codex-work-bridge MCP running for ${ROOT}`);

