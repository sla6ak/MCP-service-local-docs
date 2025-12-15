#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Новые импорты из MCP-движка
import { docs, project } from "./mcp-docs-server.js";

/* ================= помошники ================= */
function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/* ================= SERVER ================= */

const server = new Server(
  {
    name: "local-docs-mcp",
    version: "2.2",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/* ================= TOOLS LIST ================= */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "docs.get_sources",
        description: "Get external documentation sources",
        inputSchema: { type: "object" },
      },
      {
        name: "docs.search",
        description: "Search external documentation",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            topK: { type: "number" },
          },
          required: ["query"],
        },
      },
      {
        name: "docs.build_context",
        description: "Build context from docs",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            budgetTokens: { type: "number" },
          },
          required: ["query"],
        },
      },
      {
        name: "docs.refresh_index",
        description: "Refresh docs index",
        inputSchema: { type: "object" },
      },
      {
        name: "project.search",
        description: "Search project code",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            topK: { type: "number" },
          },
          required: ["query"],
        },
      },
      {
        name: "project.build_context",
        description: "Build context from project",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            budgetTokens: { type: "number" },
          },
          required: ["query"],
        },
      },
      {
        name: "project.refresh_index",
        description: "Refresh project index",
        inputSchema: { type: "object" },
      },
    ],
  };
});

/* ================= TOOL CALLS ================= */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args = {} } = request.params;

    switch (name) {
      case "docs.get_sources":
        return textResult(await docs.get_sources());

      case "docs.search":
        return textResult(await docs.search(args.query, args.topK));

      case "docs.build_context":
        return textResult(
          await docs.build_context(args.query, args.budgetTokens)
        );

      case "docs.refresh_index":
        await docs.refresh_index();
        return textResult("Docs index refreshed");

      case "project.search":
        return textResult(await project.search(args.query, args.topK));

      case "project.build_context":
        return textResult(
          await project.build_context(args.query, args.budgetTokens)
        );

      case "project.refresh_index":
        await project.refresh_index();
        return textResult("Project index refreshed");

      default:
        return textResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return textResult(err?.stack || err?.message || String(err));
  }
});

/* ================= START ================= */

const transport = new StdioServerTransport();
await server.connect(transport);
