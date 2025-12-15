#!/usr/bin/env node
/**
 * Unified MCP Docs Engine (Vectra-backed)
 * - Web docs indexing (HTML → text → chunks)
 * - Project indexing (AST → symbols → structured chunks)
 * - Vector-based semantic search (Vectra)
 * - Separate indexes per engineId: web | project
 * - High-precision context builder for LLMs
 * - Incremental autorefresh via chokidar
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
import { LocalIndex } from "vectra";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ===================== CONFIG ===================== */

const ROOT = __dirname;
const INDEX_ROOT = path.join(ROOT, ".docs-index");

const idx = new LocalIndex(INDEX_ROOT);
if (!(await idx.isIndexCreated())) {
  await idx.createIndex();
}

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
};

const TOKEN_ESTIMATE = {
  charsPerToken: 4,
  defaultBudget: 2500,
  maxBudget: 6000,
};

const PERSIST_FILES = {
  projectFileIndex: path.join(
    INDEX_ROOT,
    ENGINES.project.indexDir,
    "project-file-index.json"
  ),
};

/* ===================== VECTOR INDEX ===================== */

const vectorIndexes = {};

async function getVectorIndex(engineId) {
  if (!vectorIndexes[engineId]) {
    const dir = path.join(INDEX_ROOT, ENGINES[engineId].indexDir, "vectra");
    fssync.mkdirSync(dir, { recursive: true });

    const idx = new LocalIndex(dir);

    // гарантируем существование на диске
    if (!(await idx.isIndexCreated())) {
      await idx.createIndex();
    }

    vectorIndexes[engineId] = idx;
  }
  return vectorIndexes[engineId];
}

/* ===================== STORAGE ===================== */

async function ensureEngineStore(engineId) {
  const dir = path.join(INDEX_ROOT, ENGINES[engineId].indexDir);
  await fs.mkdir(dir, { recursive: true });
}

/* ===================== UTILS ===================== */

async function ensureVectraIndex(index, folderPath, vectorSize) {
  const indexFile = path.join(folderPath, "index.json");

  // ✅ если файл есть — индекс точно существует
  if (fssync.existsSync(indexFile)) return;

  // ✅ жёсткое создание индекса
  await index.insertItem({
    id: "__vectra_init__",
    vector: new Array(vectorSize).fill(0),
    content: "",
    metadata: { __init__: true },
  });

  await index.deleteItem("__vectra_init__");
}

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

function chunkText(text, size, overlap) {
  if (/```[\s\S]*?```/.test(text)) {
    return [text.trim()];
  }
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = "";

  for (const s of sentences) {
    if ((current + s).length > size) {
      if (current.length) chunks.push(current.trim());
      if (overlap && current.length > overlap) {
        current = current.slice(current.length - overlap);
      } else {
        current = "";
      }
    }
    current += s + " ";
  }

  if (current.trim().length) chunks.push(current.trim());
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

/* ===================== PERSIST ===================== */

const projectFileIndex = new Map();

/* 🔧 FIX: debounce + atomic persist, чтобы избежать гонок */
let persistTimer = null;

function schedulePersistSave(delay = 1000) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    saveProjectFileIndex().catch((e) =>
      console.warn("[persist] save failed:", e.message)
    );
  }, delay);
}

async function loadProjectFileIndex() {
  try {
    const raw = await fs.readFile(PERSIST_FILES.projectFileIndex, "utf8");
    const data = JSON.parse(raw);
    projectFileIndex.clear();
    for (const [file, hashes] of Object.entries(data)) {
      projectFileIndex.set(file, new Set(hashes));
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.warn("[project-index] persist load failed:", e.message);
    }
  }
}

async function saveProjectFileIndex() {
  const data = {};
  for (const [file, hashes] of projectFileIndex.entries()) {
    data[file] = [...hashes];
  }

  await fs.mkdir(path.dirname(PERSIST_FILES.projectFileIndex), {
    recursive: true,
  });

  const tmp = PERSIST_FILES.projectFileIndex + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, PERSIST_FILES.projectFileIndex); // atomic
}

/* ===================== UPSERT ===================== */
const engineLocks = new Map(); // engineId -> Promise queue

async function withEngineLock(engineId, fn) {
  const prev = engineLocks.get(engineId) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  engineLocks.set(
    engineId,
    prev.then(() => next)
  );

  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (engineLocks.get(engineId) === next) {
      engineLocks.delete(engineId);
    }
  }
}

async function upsertVectorItem(index, engineId, item) {
  return await withEngineLock(engineId, async () => {
    const existing = await index.getItem(item.id);
    if (existing) await index.deleteItem(item.id);
    await index.insertItem(item);
  });
}

/* ===================== INCREMENTAL PROJECT INDEX ===================== */

async function removeFileFromIndex(index, filePath) {
  const hashes = projectFileIndex.get(filePath);
  if (!hashes) return;

  for (const h of hashes) {
    try {
      await index.deleteItem(h);
    } catch {}
  }

  projectFileIndex.delete(filePath);
  schedulePersistSave(); // 🔧 FIX
}
const fileVersions = new Map();
async function indexProjectFile(filePath, root) {
  const version = Date.now();
  fileVersions.set(filePath, version);
  const index = await getVectorIndex("project");
  const abs = path.join(root, filePath);

  await removeFileFromIndex(index, filePath);

  let code;
  try {
    code = await fs.readFile(abs, "utf8");
  } catch {
    return;
  }

  let symbols;
  try {
    symbols = extractProjectSymbols(code, filePath);
  } catch (e) {
    // 🔧 FIX: защита от бинарных / невалидных файлов
    console.warn("[project-index] skip file:", filePath);
    return;
  }

  const hashes = new Set();

  /* 🔧 FIX: batching embeddings на уровень файла */
  const embeddings = await Promise.all(symbols.map((s) => embedQueued(s.text)));

  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    const estimatedTokens = estimateTokens(s.text);
    // 🔧 FIX: hard limit на символ
    if (estimatedTokens > TOKEN_ESTIMATE.maxBudget) {
      continue;
    }
    const hash = hashText(s.text);
    hashes.add(hash);
    if (await index.getItem(hash)) continue;
    await upsertVectorItem(index, "project", {
      id: hash,
      vector: embeddings[i],
      content: s.text,
      metadata: {
        engineId: "project",
        source: filePath,
        section: s.section,
        estimatedTokens,
      },
    });
  }

  if (fileVersions.get(filePath) !== version) {
    fileVersions.delete(filePath);
    return;
  } // ❗ отмена
  projectFileIndex.set(filePath, hashes);
  schedulePersistSave(); // 🔧 FIX
}

async function removeProjectFile(filePath) {
  const index = await getVectorIndex("project");
  await removeFileFromIndex(index, filePath);
  fileVersions.delete(filePath);
}

/* ===================== EMBEDDINGS ===================== */

async function embed(text, retries = 3) {
  try {
    const res = await fetch("http://localhost:11434/api/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mxbai-embed-large",
        prompt: text.slice(0, 8000),
      }),
    });

    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    return json.embedding;
  } catch (e) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 500));
      return embed(text, retries - 1);
    }
    throw e;
  }
}
/* ===================== EMBEDDING QUEUE ===================== */

const EMBED_CONCURRENCY = 2;

// простая очередь: максимум EMBED_CONCURRENCY embed() одновременно
let activeEmbeds = 0;
const embedWaiters = [];

async function embedQueued(text) {
  if (activeEmbeds >= EMBED_CONCURRENCY) {
    await new Promise((resolve) => embedWaiters.push(resolve));
  }

  activeEmbeds++;

  try {
    return await embed(text);
  } finally {
    activeEmbeds--;
    const next = embedWaiters.shift();
    if (next) next();
  }
}

/* ===================== SEARCH ===================== */
/* 🔧 FIX: отсутствовала реализация */

async function search(engineId, query, topK = SEARCH_CONFIG.topK) {
  const index = await getVectorIndex(engineId);
  const vector = await embedQueued(query);
  const results = await index.queryItems(vector, topK);

  return results.map((r) => ({
    id: r.item.id,
    score: r.score,
    text: r.item.content,
    source: r.item.metadata.source,
    section: r.item.metadata.section,
    estimatedTokens: r.item.metadata.estimatedTokens,
  }));
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
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"],
  });

  const chunks = [];
  const imports = new Set();
  const exports = new Set();

  traverse.default(ast, {
    enter(path) {
      const n = path.node;

      if (n.type === "ImportDeclaration" && n.source?.value)
        imports.add(n.source.value);

      if (n.type === "ExportNamedDeclaration" && n.declaration?.declarations)
        n.declaration.declarations.forEach(
          (d) => d.id?.name && exports.add(d.id.name)
        );

      if (n.type === "ExportDefaultDeclaration") exports.add("default");

      // ===== EXISTING LOGIC — НЕ ТРОНУТА =====
      if (
        n.type === "FunctionDeclaration" ||
        n.type === "ClassDeclaration" ||
        n.type === "TSInterfaceDeclaration" ||
        n.type === "TSTypeAliasDeclaration" ||
        n.type === "TSDeclareFunction"
      ) {
        const name = n.id?.name;
        if (!name) return;

        const comment = n.leadingComments?.map((c) => c.value).join("\n") || "";
        const signature = code.slice(n.start, n.body?.start || n.end);
        const text = cleanText(
          `\n${comment}\n${signature}\nFile: ${filePath}\n`
        );
        if (text.length > 50) chunks.push({ text, section: name });
      }

      if (
        n.type === "VariableDeclarator" &&
        n.init?.type === "ArrowFunctionExpression" &&
        n.id?.type === "Identifier"
      ) {
        const name = n.id.name;
        const comment =
          path.parentPath?.parent?.leadingComments
            ?.map((c) => c.value)
            .join("\n") || "";
        const signature = code.slice(n.start, n.end);
        const text = cleanText(
          `\n${comment}\n${signature}\nFile: ${filePath}\n`
        );
        if (text.length > 50) chunks.push({ text, section: name });
      }

      if (n.type === "ClassMethod" && n.key?.type === "Identifier") {
        const className = path.parentPath?.parent?.id?.name || "AnonymousClass";
        const name = `${className}.${n.key.name}`;
        const comment = n.leadingComments?.map((c) => c.value).join("\n") || "";
        const signature = code.slice(n.start, n.end);
        const text = cleanText(
          `\n${comment}\n${signature}\nFile: ${filePath}\n`
        );
        if (text.length > 50) chunks.push({ text, section: name });
      }
    },
  });

  if (exports.size) {
    chunks.push({
      section: "__exports__",
      text: cleanText(
        `Exports:\n${[...exports].join("\n")}\nFile: ${filePath}`
      ),
    });
  }

  if (imports.size) {
    chunks.push({
      section: "__imports__",
      text: cleanText(
        `Imports:\n${[...imports].join("\n")}\nFile: ${filePath}`
      ),
    });
  }

  return chunks;
}

/* ===================== INDEXING ===================== */
let watcher = null;
export async function indexEngine(engineId) {
  await ensureEngineStore(engineId);

  // ✅ ЖЁСТКАЯ ГАРАНТИЯ: индекс существует ДО ЛЮБОЙ РАБОТЫ

  const index = await getVectorIndex(engineId);

  if (engineId === "project" && watcher) {
    await watcher.close();
    watcher = null;
  }

  if (engineId === "project") {
    await loadProjectFileIndex();
  }

  const cfg = JSON.parse(
    await fs.readFile(ENGINES[engineId].sourcesFile, "utf8")
  );

  if (engineId === "web") {
    for (const p of Object.values(cfg.web_recurses || {})) {
      for (const url of p.seedUrls || []) {
        const text = await loadWebSource(url);
        const chunks = chunkText(text, p.chunk?.size, p.chunk?.overlap);

        // 1️⃣ подготовка чанков
        const prepared = chunks
          .map((c, i) => {
            const cleaned = cleanText(c);
            const estimatedTokens = estimateTokens(cleaned);

            if (estimatedTokens > TOKEN_ESTIMATE.maxBudget) return null;

            return {
              cleaned,
              estimatedTokens,
              hash: hashText(cleaned),
              seq: i,
            };
          })
          .filter(Boolean);

        // 2️⃣ батч embed
        const embeddings = await Promise.all(
          prepared.map((p) => embedQueued(p.cleaned))
        );

        // 3️⃣ вставка в vectra
        for (let i = 0; i < prepared.length; i++) {
          const pchunk = prepared[i];

          await upsertVectorItem(index, "web", {
            id: pchunk.hash,
            vector: embeddings[i],
            content: pchunk.cleaned,
            metadata: {
              engineId: "web",
              source: url,
              seq: pchunk.seq,
              section: detectSection(pchunk.cleaned),
              estimatedTokens: pchunk.estimatedTokens,
            },
          });
        }
      }
    }
  }

  if (engineId === "project") {
    for (const p of Object.values(cfg.local_recurses || {})) {
      const files = await glob(p.include, { cwd: p.root, ignore: p.exclude });
      for (const file of files) {
        if (!/\.(js|ts|jsx|tsx)$/.test(file)) continue; // 🔧 FIX
        await indexProjectFile(file, p.root);
      }
    }
  }
}

/* ===================== REFRESH ===================== */
/* 🔧 FIX: refresh отсутствовал */

async function refresh(engineId) {
  await indexEngine(engineId);
}

/* ===================== CONTEXT BUILDER ===================== */

/**
 * v3 — architecture-aware buildContext
 * - group by source file
 * - exports → imports → symbols
 */
async function buildContext(engineId, query, budget) {
  const hits = await search(engineId, query);
  const bySource = new Map();

  for (const h of hits) {
    if (!bySource.has(h.source)) bySource.set(h.source, []);
    bySource.get(h.source).push(h);
  }

  let used = 0;
  const ctx = [];

  for (const [, items] of bySource.entries()) {
    const ordered = [
      ...items.filter((i) => i.section === "__exports__"),
      ...items.filter((i) => i.section === "__imports__"),
      ...items.filter(
        (i) => i.section !== "__imports__" && i.section !== "__exports__"
      ),
    ];

    for (const h of ordered) {
      if (used + h.estimatedTokens > budget) return ctx.join("\n\n");
      ctx.push(h.text);
      used += h.estimatedTokens;
    }
  }

  return ctx.join("\n\n");
}

/* ===================== API ===================== */

export const docs = {
  search: async (query, topK) => search("web", query, topK),
  refresh_index: async () => {
    try {
      await refresh("web");

      return {
        content: [
          {
            type: "text",
            text: "Web docs index refreshed successfully",
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text:
              "Web docs index refresh failed:\n" +
              (String(err?.stack) || String(err?.message) || String(err)),
          },
        ],
      };
    }
  },
};

export const project = {
  search: async (query, topK) => search("project", query, topK),

  build_context: async (query, budget) =>
    buildContext("project", query, budget),

  refresh_index: async () => {
    try {
      await refresh("project");

      return {
        content: [
          {
            type: "text",
            text: "Project index refreshed successfully",
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text:
              "Project index refresh failed:\n" +
              (String(err?.stack) || String(err?.message) || String(err)),
          },
        ],
      };
    }
  },
};

/* ===================== AUTOREFRESH ===================== */
const cfg = JSON.parse(await fs.readFile(ENGINES.project.sourcesFile, "utf8"));
const roots = Object.values(cfg.local_recurses || {}).map((p) => p.root);
watchProjectIndex(roots);

/* 🔧 FIX: фильтрация по расширениям */
const VALID_EXT = /\.(js|ts|jsx|tsx)$/i;

function watchProjectIndex(rootPaths, debounceMs = 5000) {
  if (watcher) watcher.close();
  watcher = chokidar.watch(rootPaths, {
    ignored: /node_modules|\.git/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 1000,
    },
  });

  let timer = null;

  const scheduleFileIndex = (filePath, event) => {
    if (!VALID_EXT.test(filePath)) return; // 🔧 FIX

    if (timer) clearTimeout(timer);

    timer = setTimeout(async () => {
      const cfg = JSON.parse(
        await fs.readFile(ENGINES.project.sourcesFile, "utf8")
      );

      for (const p of Object.values(cfg.local_recurses || {})) {
        const absRoot = path.resolve(p.root);
        const absFile = path.resolve(filePath);
        if (!absFile.startsWith(absRoot)) continue;
        const rel = path.relative(p.root, filePath);

        if (event === "unlink") {
          await removeProjectFile(rel);
        } else {
          await indexProjectFile(rel, p.root);
        }
      }
    }, debounceMs);
  };

  watcher
    .on("add", (p) => scheduleFileIndex(p, "add"))
    .on("change", (p) => scheduleFileIndex(p, "change"))
    .on("unlink", (p) => scheduleFileIndex(p, "unlink"));
}
