#!/usr/bin/env node
/**
 * mcp-docs-server.js v3
 * MCP (STDIO) wrapper for your index.js engine.
 *
 * - Content-Length framed JSON-RPC (MCP) for Continue/Cursor
 * - Tools: search_chunks, build_context, refresh_index, get_sources, preload_docs, list_tools
 * - CLI mode: call with a command name to run legacy CLI behavior
 * - Auto-preload: --auto-preload or AUTO_PRELOAD=1
 *
 * Place this file next to your index.js (the engine you already provided).
 * package.json must contain "type": "module" (you're using ESM).
 */

import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import util from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// import engine functions (your index.js)
import {
  list_tools,
  get_sources,
  search_chunks,
  build_context,
  refresh_index,
  preloadDocs,
} from "./index.js";

/* ---------- Helpers ---------- */
function stderr(...args) {
  console.error("[mcp-docs-server]", ...args);
}
function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify(util.inspect(obj, { depth: 3 }));
  }
}

/* ---------- CLI fallback (if invoked with a command) ---------- */
async function runCliFallback() {
  const cmd = process.argv[2];
  try {
    if (!cmd || cmd === "help") {
      console.log("mcp-docs-server — available commands:");
      console.log("  list_tools");
      console.log("  get_sources");
      console.log("  search_chunks <jsonPayload>");
      console.log("  build_context <jsonPayload>");
      console.log("  refresh_index <jsonPayload>");
      console.log("  preload_docs");
      console.log("\nExamples:");
      console.log(
        '  node mcp-docs-server.js search_chunks \'{"query":"auth middleware","topK":8}\''
      );
      console.log(
        '  node mcp-docs-server.js build_context \'{"profile":"myProfile","query":"jwt","budgetTokens":1200}\''
      );
      return;
    }

    if (cmd === "list_tools") {
      console.log(JSON.stringify(list_tools(), null, 2));
      return;
    }

    if (cmd === "get_sources") {
      const res = await get_sources();
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "preload_docs") {
      await preloadDocs(true);
      console.log("preload done");
      return;
    }

    if (cmd === "refresh_index") {
      const payload = JSON.parse(process.argv[3] || "{}");
      await refresh_index(payload);
      console.log("refresh complete");
      return;
    }

    if (cmd === "search_chunks") {
      const payload = JSON.parse(process.argv[3] || "{}");
      if (!payload.query) {
        console.error(
          "search_chunks expects JSON with { query: string, topK?: number, profile?: string }"
        );
        process.exit(2);
      }
      const res = await search_chunks(payload);
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "build_context") {
      const payload = JSON.parse(process.argv[3] || "{}");
      if (!payload.query) {
        console.error(
          "build_context expects JSON with { query: string, profile?: string, budgetTokens?: number }"
        );
        process.exit(2);
      }
      const res = await build_context(
        payload.profile,
        payload.query,
        payload.budgetTokens
      );
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    console.error("Unknown command:", cmd);
    process.exit(2);
  } catch (e) {
    console.error("Error:", e && e.stack ? e.stack : String(e));
    process.exit(1);
  }
}

/* ---------- MCP framing (Content-Length) ---------- */
let readBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  readBuffer += chunk;
  try {
    processBuffer();
  } catch (e) {
    stderr("processBuffer error:", e && e.stack ? e.stack : String(e));
  }
});
process.stdin.on("end", () => {
  stderr("stdin end");
});

function sendFramed(obj) {
  const json = JSON.stringify(obj);
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
  process.stdout.write(header + json);
}

/* ---------- JSON-RPC helpers ---------- */
function makeResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function makeError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/* ---------- Tool spec ---------- */
function getToolSpec() {
  return [
    {
      name: "list_tools",
      description: "List available tools",
      inputSchema: { type: "object" },
    },
    {
      name: "get_sources",
      description: "Get configured doc sources",
      inputSchema: { type: "object" },
    },
    {
      name: "search_chunks",
      description: "Search documentation chunks using BM25-like ranking",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          topK: { type: "number" },
          profile: { type: ["string", "null"] },
        },
        required: ["query"],
      },
    },
    {
      name: "build_context",
      description: "Build context from docs respecting token budget",
      inputSchema: {
        type: "object",
        properties: {
          profile: { type: ["string", "null"] },
          query: { type: "string" },
          budgetTokens: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "refresh_index",
      description: "Rebuild or refresh index",
      inputSchema: {
        type: "object",
        properties: {
          wipe: { type: "boolean" },
          progress: { type: "boolean" },
        },
      },
    },
    {
      name: "preload_docs",
      description: "Download and chunk all sources from docs_sources.json",
      inputSchema: { type: "object" },
    },
  ];
}

/* ---------- Tool executor ---------- */
async function executeTool(tool, args = {}) {
  // normalize boolean shorthand for preload
  if (tool === "preload_docs") {
    // allow preload_docs(true) -> progress=true
    if (typeof args === "boolean") {
      return await preloadDocs(args);
    }
    if (args && typeof args === "object" && args.progress !== undefined) {
      return await preloadDocs(!!args.progress);
    }
    return await preloadDocs(false);
  }

  switch (tool) {
    case "list_tools":
      return list_tools();
    case "get_sources":
      return await get_sources();
    case "search_chunks":
      return await search_chunks(args);
    case "build_context":
      return await build_context(args.profile, args.query, args.budgetTokens);
    case "refresh_index":
      return await refresh_index(args);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

/* ---------- Message parsing ---------- */
function processBuffer() {
  while (true) {
    const headerEnd = readBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = readBuffer.slice(0, headerEnd);
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      stderr("Missing Content-Length in header; clearing buffer");
      readBuffer = "";
      return;
    }
    const contentLength = parseInt(m[1], 10);
    const totalNeeded = headerEnd + 4 + contentLength;
    if (readBuffer.length < totalNeeded) return; // wait for more data
    const body = readBuffer.slice(headerEnd + 4, totalNeeded);
    readBuffer = readBuffer.slice(totalNeeded);
    void handleMessage(body).catch((e) =>
      stderr(
        "handleMessage top-level error:",
        e && e.stack ? e.stack : String(e)
      )
    );
  }
}

async function handleMessage(body) {
  let msg;
  try {
    msg = JSON.parse(body);
  } catch (e) {
    stderr("Invalid JSON:", e && e.message);
    return;
  }

  // initialize handshake
  if (msg.method === "initialize") {
    const resp = makeResult(msg.id, {
      serverInfo: {
        name: "local-docs-mcp",
        version: "v3",
        description:
          "Local documentation search and context builder (MCP STDIO)",
      },
      tools: getToolSpec(),
    });
    sendFramed(resp);
    return;
  }

  // tools/execute request
  if (msg.method === "tools/execute") {
    const params = msg.params || {};
    const tool =
      params.tool || params.name || (params.arguments && params.arguments.tool);
    const args = params.arguments || params.args || params.arguments || {};
    if (!tool) {
      sendFramed(makeError(msg.id, -32602, "No tool specified in params"));
      return;
    }

    try {
      const result = await executeTool(tool, args);
      // Return result under "output" (Continue often expects output wrapper)
      sendFramed(makeResult(msg.id, { output: result }));
    } catch (e) {
      stderr("Tool execution error:", e && e.stack ? e.stack : String(e));
      sendFramed(makeError(msg.id, -32000, String(e)));
    }
    return;
  }

  // simple ping/echo or unknown methods
  if (msg.method === "ping") {
    sendFramed(makeResult(msg.id, { ok: true }));
    return;
  }

  sendFramed(makeError(msg.id, -32601, `Unknown method: ${msg.method}`));
}

/* ---------- Startup ---------- */
stderr("mcp-docs-server v3 starting, cwd:", process.cwd());

// If invoked with a CLI command (positional arg) — run CLI fallback and exit
if (process.argv.length > 2 && !process.argv.includes("--mcp")) {
  // run CLI style (legacy) if user passed explicit command
  void runCliFallback().then(() => process.exit(0));
} else {
  // MCP STDIO mode: keep process running and listen on stdin
  stderr("Entering MCP STDIO mode (listening on stdin/stdout).");

  // auto preload if requested by flag or env
  const autoPreload =
    process.env.AUTO_PRELOAD === "1" ||
    process.argv.includes("--auto-preload") ||
    process.argv.includes("--preload");

  if (autoPreload) {
    (async () => {
      try {
        stderr("Auto-preload enabled: starting preloadDocs(true) ...");
        await preloadDocs(true);
        stderr("Auto-preload finished.");
      } catch (e) {
        stderr("Auto-preload failed:", e && e.stack ? e.stack : String(e));
      }
    })();
  }

  // ensure process keeps running even if stdin is not closed
  process.stdin.resume();
}
