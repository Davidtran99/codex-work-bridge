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
          if (buf.length <= MAX_TEXT_BYTES && hasLikelySecret(buf)) {
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
        if (push) {
          // Never force. Set upstream on first push of this fresh branch.
          await git(["push", "--set-upstream", "origin", branch]);
          pushed = true;
        }
        return text({ handoff: id, direction, branch, commit: sha, files: staged, pushed, validation, message: commitMessage });
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`codex-work-bridge MCP running for ${ROOT}`);

