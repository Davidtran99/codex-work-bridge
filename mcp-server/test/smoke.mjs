import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "../..");
const sandbox = await mkdtemp(resolve(tmpdir(), "codex-work-bridge-mcp-"));
await cp(resolve(root, "bridge.py"), resolve(sandbox, "bridge.py"));
await writeFile(resolve(sandbox, "PROJECT_STATE.md"), "# Test state\n", "utf8");
await mkdir(resolve(sandbox, "exchange/ide-to-work"), { recursive: true });
await mkdir(resolve(sandbox, "exchange/work-to-ide"), { recursive: true });

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

  console.log(`MCP end-to-end smoke test passed: ${names.length} tools available; create, write, update, validate and pack succeeded.`);
} finally {
  await client.close();
  await rm(sandbox, { recursive: true, force: true });
}
