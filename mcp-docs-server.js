#!/usr/bin/env node
/**
 * Unified MCP Docs Engine
 * - Web docs indexing (HTML → text → chunks)
 * - Project indexing (AST → symbols → structured chunks)
 * - Single BM25-based search core
 * - Separate indexes per engineId: web | project
 * - High-precision context builder for LLMs
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import glob from "fast-glob";
import * as babel from "@babel/parser";
import traverse from "@babel/traverse";
import chokidar from "chokidar";

/* ===================== CONFIG ===================== */

const ROOT = process.cwd();
const INDEX_ROOT = path.join(ROOT, "docs-index");

const ENGINES = {
  web: {
    sourcesFile: "docs_sources.json",
    indexDir: "web",
    chunkDefaults: { size: 3500, overlap: 200 },
  },
  project: {
    sourcesFile: "docs_project.json",
    indexDir: "project",
    chunkDefaults: { size: 2500, overlap: 200 },
  },
};

const SEARCH_CONFIG = {
  topK: 12,
  k1: 1.5,
  b: 0.75,
};

const TOKEN_ESTIMATE = {
  charsPerToken: 4,
  defaultBudget: 2500,
  maxBudget: 6000,
};

/* ===================== STORAGE ===================== */

async function ensureEngineStore(engineId) {
  const dir = path.join(INDEX_ROOT, ENGINES[engineId].indexDir);
  await fs.mkdir(dir, { recursive: true });
  await initJson(path.join(dir, "chunks.json"), { chunks: [] });
}

function enginePath(engineId, file) {
  return path.join(INDEX_ROOT, ENGINES[engineId].indexDir, file);
}

async function initJson(file, initial) {
  if (!fssync.existsSync(file)) {
    await fs.writeFile(file, JSON.stringify(initial, null, 2));
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, obj) {
  await fs.writeFile(file, JSON.stringify(obj, null, 2));
}

/* ===================== UTILS ===================== */

function cleanText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
}

function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function estimateTokens(text) {
  return Math.ceil(text.length / TOKEN_ESTIMATE.charsPerToken);
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-zа-яё0-9_]+/gi) || []).filter(Boolean);
}

function chunkText(text, size, overlap) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + size, text.length);
    chunks.push(text.slice(i, end));
    i = Math.max(0, end - overlap);
  }
  return chunks;
}

function detectSection(text) {
  const head = text.slice(0, 2000);
  const md = head.match(/^#{1,6}\s+(.+)$/m);
  if (md) return md[1].trim();
  const first = head.split("\n")[0]?.trim();
  if (first && first.length > 8 && first.length < 120) return first;
  return null;
}

/* ===================== WEB LOADER ===================== */

function extractVisibleText(html) {
  const dom = new JSDOM(html);
  dom.window.document
    .querySelectorAll("script, style, noscript")
    .forEach((e) => e.remove());
  return cleanText(dom.window.document.body?.textContent || "");
}

async function loadWebSource(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const ct = res.headers.get("content-type") || "";
  const body = await res.text();
  return ct.includes("html") ? extractVisibleText(body) : cleanText(body);
}

/* ===================== PROJECT AST LOADER ===================== */

function extractProjectSymbols(code, filePath) {
  const ast = babel.parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  const chunks = [];

  traverse.default(ast, {
    enter(path) {
      const n = path.node;

      if (
        n.type === "FunctionDeclaration" ||
        n.type === "ClassDeclaration" ||
        n.type === "TSInterfaceDeclaration" ||
        n.type === "TSTypeAliasDeclaration"
      ) {
        const name = n.id?.name;
        if (!name) return;

        const comment = n.leadingComments?.map((c) => c.value).join("\n") || "";

        const signature = code.slice(n.start, n.body?.start || n.end);
        const text = cleanText(
          `
${comment}
${signature}
File: ${filePath}
`
        );

        if (text.length > 50) {
          chunks.push({
            text,
            section: name,
          });
        }
      }
    },
  });

  return chunks;
}

/* ===================== INDEXING ===================== */

async function indexEngine(engineId) {
  await ensureEngineStore(engineId);
  const cfg = JSON.parse(
    await fs.readFile(ENGINES[engineId].sourcesFile, "utf8")
  );

  const storeFile = enginePath(engineId, "chunks.json");
  const store = await readJson(storeFile);
  const existing = new Set(store.chunks.map((c) => c.hash));

  if (engineId === "web") {
    for (const [profile, p] of Object.entries(cfg.web_recurses || {})) {
      for (const url of p.seedUrls || []) {
        const text = await loadWebSource(url);
        const chunks = chunkText(text, p.chunk?.size, p.chunk?.overlap);
        for (let i = 0; i < chunks.length; i++) {
          const cleaned = cleanText(chunks[i]);
          const hash = hashText(cleaned);
          if (existing.has(hash)) continue;
          store.chunks.push({
            engineId,
            source: url,
            seq: i,
            text: cleaned,
            hash,
            section: detectSection(cleaned),
            estimatedTokens: estimateTokens(cleaned),
          });
        }
      }
    }
  }

  if (engineId === "project") {
    for (const p of Object.values(cfg.local_recurses || {})) {
      const files = await glob(p.include, {
        cwd: p.root,
        ignore: p.exclude,
      });

      for (const file of files) {
        const abs = path.join(p.root, file);
        const code = await fs.readFile(abs, "utf8");
        const symbols = extractProjectSymbols(code, file);

        for (const s of symbols) {
          const hash = hashText(s.text);
          if (existing.has(hash)) continue;
          store.chunks.push({
            engineId,
            source: file,
            seq: 0,
            text: s.text,
            hash,
            section: s.section,
            estimatedTokens: estimateTokens(s.text),
          });
        }
      }
    }
  }

  await writeJson(storeFile, store);
}

/* ===================== SEARCH CORE ===================== */

function scoreChunks(chunks, query) {
  const qTokens = tokenize(query);
  const N = chunks.length || 1;

  const df = new Map();
  for (const c of chunks) {
    for (const t of new Set(tokenize(c.text))) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  const avgLen = chunks.reduce((s, c) => s + c.text.length, 0) / N;

  return chunks
    .map((c) => {
      const tf = new Map();
      for (const t of tokenize(c.text)) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }

      let score = 0;
      for (const t of qTokens) {
        const f = tf.get(t) || 0;
        const idf = Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
        const denom =
          f +
          SEARCH_CONFIG.k1 *
            (1 - SEARCH_CONFIG.b + SEARCH_CONFIG.b * (c.text.length / avgLen));
        score += idf * ((f * (SEARCH_CONFIG.k1 + 1)) / denom);
      }

      if (c.section) {
        if (tokenize(c.section).some((t) => qTokens.includes(t))) score *= 1.25;
      }

      if (c.seq < 3) score *= 1.12;

      if (qTokens.some((t) => c.text.slice(0, 300).toLowerCase().includes(t)))
        score *= 1.15;

      return { c, score };
    })
    .sort((a, b) => b.score - a.score);
}

/* ===================== API ===================== */
/* ===================== HIGH-LEVEL API ===================== */

export const docs = {
  search: async (query, topK) => search("web", query, topK),
  build_context: async (query, budget) => buildContext("web", query, budget),
  get_sources: async () => JSON.parse(await readJson(ENGINES.web.sourcesFile)),
  refresh_index: async () => refresh("web"),
};

export const project = {
  search: async (query, topK) => search("project", query, topK),
  build_context: async (query, budget) =>
    buildContext("project", query, budget),
  refresh_index: async () => refresh("project"),
};

// +++++autorefresh+++++++++++++

let watcher = null;

export function watchProjectIndex(rootPaths, debounceMs = 5000) {
  if (watcher) watcher.close(); // закрываем предыдущий watcher
  watcher = null;

  watcher = chokidar.watch(rootPaths, {
    ignored: /node_modules|\.git/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000, // ждём завершения записи файлов
      pollInterval: 1000,
    },
  });

  let timer = null;

  const scheduleRefresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      await refresh("project");
    }, debounceMs);
  };

  watcher
    .on("add", scheduleRefresh)
    .on("change", scheduleRefresh)
    .on("unlink", scheduleRefresh);
}
