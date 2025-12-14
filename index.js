#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Новые импорты из MCP-движка
import { docs, project, watchProjectIndex } from "./mcp-docs-server.js";

watchProjectIndex(["*/**"]);

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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    /* ----------- DOCS ----------- */
    {
      name: "docs.get_sources",
      description: "Get external documentation sources and profiles",
      inputSchema: { type: "object" },
    },
    {
      name: "docs.search",
      description:
        "Search external documentation index (web docs, frameworks, libraries)",
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
      description:
        "Build context from external documentation for a given query",
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
      description: "Refresh external documentation index",
      inputSchema: {
        type: "object",
        properties: {
          wipe: { type: "boolean" },
        },
      },
    },

    /* ----------- PROJECT ----------- */
    {
      name: "project.search",
      description:
        "Search indexed project source code, comments, and public APIs",
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
      description:
        "Build context from project source code (API, comments, structure)",
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
      description: "Refresh project source code index",
      inputSchema: {
        type: "object",
        properties: {
          wipe: { type: "boolean" },
        },
      },
    },
  ],
}));

/* ================= TOOL CALLS ================= */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    /* ---------- DOCS ---------- */

    case "docs.get_sources":
      return { content: [{ type: "json", json: await docs.get_sources() }] };

    case "docs.search":
      return {
        content: [
          { type: "json", json: await docs.search(args.query, args.topK) },
        ],
      };

    case "docs.build_context":
      return {
        content: [
          {
            type: "json",
            json: await docs.build_context(args.query, args.budgetTokens),
          },
        ],
      };

    case "docs.refresh_index":
      await docs.refresh_index();
      return { content: [{ type: "json", json: { ok: true } }] };

    /* ---------- PROJECT ---------- */

    case "project.search":
      return {
        content: [
          { type: "json", json: await project.search(args.query, args.topK) },
        ],
      };

    case "project.build_context":
      return {
        content: [
          {
            type: "json",
            json: await project.build_context(args.query, args.budgetTokens),
          },
        ],
      };

    case "project.refresh_index":
      await project.refresh_index();
      return { content: [{ type: "json", json: { ok: true } }] };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

/* ================= START ================= */

const transport = new StdioServerTransport();
await server.connect(transport);
