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
import { serviceLog } from "./logger.js";

function stringify(args) {
  return args.map((a) =>
    typeof a === "string" ? a : JSON.stringify(a, null, 2)
  );
}
console.log = (...args) => {
  serviceLog("[LOG]", ...stringify(args));
};
console.warn = (...args) => {
  serviceLog("[WARN]", ...stringify(args));
};
console.error = (...args) => {
  serviceLog("[ERROR]", ...stringify(args));
};
process.on("uncaughtException", (err) => {
  serviceLog("[FATAL] uncaughtException", err?.stack || err);
});

process.on("unhandledRejection", (reason) => {
  serviceLog("[FATAL] unhandledRejection", reason);
});
import fs from "node:fs/promises";
import { chunkText } from "./util/chunkText.js";
import { mmrSelect } from "./util/mmrSelect.js";
import { expandByGraph } from "./util/expandByGraph.js";
import { loadWebSource } from "./util/loadWebSource.js";
import { extractProjectSymbols } from "./util/extractProjectSymbols.js";
import {
  cleanText,
  hashText,
  estimateTokens,
  detectSection,
  TOKEN_ESTIMATE,
} from "./util/text.js";
import { embed } from "./util/embed.js";
import path from "node:path";
import glob from "fast-glob";
import chokidar from "chokidar";
import { LocalIndex } from "vectra";
import { fileURLToPath } from "node:url";
//cbcvb
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/* ===================== CONFIG ===================== */
const ROOT = path.resolve(__dirname, "..");
const INDEX_ROOT = path.join(ROOT, ".docs-index");
const ENGINES = {
  web: {
    sourcesFile: path.join(ROOT, "docs_sources.json"),
    indexDir: "web",
    chunkDefaults: { size: 3500, overlap: 200 },
  },
  project: {
    sourcesFile: path.join(ROOT, "docs_project.json"),
    indexDir: "project",
    chunkDefaults: { size: 2500, overlap: 200 },
  },
};

const SEARCH_CONFIG = {
  topK: 12,
};

const PERSIST_FILES = {
  projectFileIndex: path.join(
    INDEX_ROOT,
    ENGINES.project.indexDir,
    "project-file-index.json"
  ),
};

const GRAPH_FILE = path.join(
  INDEX_ROOT,
  ENGINES.project.indexDir,
  "graph.json"
);
const projectGraph = new Map(); // file -> { imports, exports }
const pageRank = new Map(); // file -> number
const reverseProjectGraph = new Map(); // file -> Set(importers)
const fileVersions = new Map();
const projectFileIndex = new Map();
const engineLocks = new Map(); // engineId -> Promise queue
const engineState = new Map();
/* ===================== VECTOR INDEX ===================== */
const vectorIndexes = {};
const vectorIndexInit = {};

//❌ УБРАТЬ из getVectorIndex любую бизнес-логику getVectorIndex только: открыть индекс вернуть instance ❗ НИКАКИХ: watcher scan graph persist
async function getVectorIndex(engineId) {
  if (vectorIndexes[engineId]) {
    return vectorIndexes[engineId];
  }

  const dir = path.join(INDEX_ROOT, ENGINES[engineId].indexDir, "vectra");

  const idx = new LocalIndex(dir);
  vectorIndexes[engineId] = idx;
  return idx;
}

/* ===================== STORAGE ==================== */
async function ensureEngineStore(engineId) {
  const dir = path.join(INDEX_ROOT, ENGINES[engineId].indexDir);
  const vectraDir = path.join(dir, "vectra");
  try {
    await fs.mkdir(vectraDir, { recursive: true }); // создаст и родителя, если нужно
    console.error("[ensureEngineStore] ensured", { dir, vectraDir });
  } catch (e) {
    console.error("[ensureEngineStore] mkdir failed", {
      dir,
      vectraDir,
      err: e.stack || e,
    });
    throw e;
  }
}

/* ===================== UTILS ===================== */
async function indexWeb(cfg) {
  if (engineState.get("web") !== "ready") {
    throw new Error("web engine not initialized");
  }

  const index = await getVectorIndex("web");

  const visited = new Set();

  for (const def of Object.values(cfg.web_recurses || {})) {
    const { url, depth = 1, include, exclude, maxPages = 100 } = def;

    await walkWeb(
      url,
      depth,
      { include, exclude, maxPages },
      async (pageUrl) => {
        if (visited.has(pageUrl)) return;
        visited.add(pageUrl);
        serviceLog("[WEB] load", pageUrl);
        const text = await loadWebSource(pageUrl);
        if (!text || text.length < 50) return;
        const chunks = chunkText(text, 800, 200);
        for (let i = 0; i < chunks.length; i++) {
          const raw = chunks[i];
          // ✅ 1. канонизация
          const cleaned = cleanText(raw);
          if (!cleaned) continue;
          // ✅ 2. секция — ТОЛЬКО от cleaned
          const section = detectSection(cleaned);
          // ✅ 3. embedding — ТОЛЬКО от cleaned
          const vector = await embedQueued(cleaned);
          await upsertVectorItem(index, "web", {
            id: `web:${pageUrl}#${i}`,
            vector,
            content: cleaned, // ⬅️ КРИТИЧНО
            metadata: {
              engineId: "web",
              source: pageUrl,
              section,
              order: i,
            },
          });
        }
      }
    );
  }

  serviceLog("[WEB] indexing complete", {
    pages: visited.size,
  });
}
// initEngineStrict — ЕДИНСТВЕННАЯ точка инициализации
async function initEngineStrict(engineId) {
  serviceLog("[INIT] engine start", engineId);

  const engineDir = path.join(INDEX_ROOT, ENGINES[engineId].indexDir);
  const vectraDir = path.join(engineDir, "vectra");

  // 1️⃣ директории (ЖЁСТКО)
  await fs.mkdir(vectraDir, { recursive: true });

  // 2️⃣ получаем index (БЕЗ побочек)
  const index = await getVectorIndex(engineId);

  // 3️⃣ проверяем создан ли индекс
  let created = false;
  try {
    created = await index.isIndexCreated();
  } catch (e) {
    serviceLog("[INIT] isIndexCreated failed", e);
    created = false;
  }

  // 4️⃣ если нет — создаём
  if (!created) {
    serviceLog("[INIT] createIndex", engineId);
    await index.createIndex();
  }

  // 💣 ГАРАНТИЯ: index.json будет создан
  await index.insertItem({
    id: "__init__",
    vector: new Array(256).fill(0),
    content: "init",
  });
  await index.deleteItem("__init__");
  // 6️⃣ помечаем состояние
  engineState.set(engineId, "ready");

  serviceLog("[INIT] engine ready", engineId);
}

function cleanupProjectFileState(filePath) {
  projectGraph.delete(filePath);
  reverseProjectGraph.delete(filePath);
  removeReverseEdges(filePath);
  projectFileIndex.delete(filePath);
  schedulePersistSave();
  scheduleGraphSave();
}

function computeGraphScore(hit, seedFiles) {
  if (seedFiles.includes(hit.source)) return 1.0;

  const node = projectGraph.get(hit.source);
  if (!node) return 0.6;

  // прямой импорт от seed
  if (node.imports?.some((i) => seedFiles.includes(i))) {
    return 0.8;
  }

  // seed импортирует этот файл
  for (const seed of seedFiles) {
    const seedNode = projectGraph.get(seed);
    if (seedNode?.imports?.includes(hit.source)) {
      return 0.8;
    }
  }

  return 0.6;
}

/* ===================== PageRank ===================== */
function recomputePageRank({ damping = 0.85, iterations = 20 } = {}) {
  const files = [...projectGraph.keys()];
  const N = files.length;
  if (!N) return;

  // начальное значение
  const init = 1 / N;
  files.forEach((f) => pageRank.set(f, init));

  // предрасчёт: file -> importers[]
  const incoming = new Map();
  for (const [file, node] of projectGraph.entries()) {
    for (const imp of node.imports || []) {
      if (!incoming.has(imp)) incoming.set(imp, []);
      incoming.get(imp).push(file);
    }
  }

  // итерации
  for (let i = 0; i < iterations; i++) {
    const next = new Map();

    // предварительно посчитаем сумму рангов "dangling" (узлы с нулевой исходящей степенью)
    let danglingSum = 0;
    for (const f of files) {
      const outDeg = projectGraph.get(f)?.imports?.length ?? 0;
      if (outDeg === 0) {
        danglingSum += pageRank.get(f) ?? 0;
      }
    }

    for (const file of files) {
      let sum = 0;

      const importers = incoming.get(file) || [];
      for (const other of importers) {
        const outDegree = projectGraph.get(other)?.imports?.length ?? 0;
        if (outDegree > 0) {
          sum += (pageRank.get(other) ?? 0) / outDegree;
        }
        // если outDegree == 0, вклад уходит в danglingSum и будет распределён отдельно
      }

      // распределяем dangling mass равномерно
      const danglingContribution = danglingSum / N;

      const rank = (1 - damping) / N + damping * (sum + danglingContribution);
      next.set(file, rank);
    }

    // записываем обратно
    pageRank.clear();
    for (const [f, r] of next.entries()) {
      pageRank.set(f, r);
    }
  }
}
/* ===================== PERSIST ===================== */
let graphPersistTimer = null;

function scheduleGraphSave(delay = 1000) {
  if (graphPersistTimer) clearTimeout(graphPersistTimer);
  graphPersistTimer = setTimeout(() => {
    try {
      recomputePageRank();
      saveProjectGraph();
    } catch (e) {
      console.warn("[graph] save failed:", e.message);
    }
  }, delay);
}
//++++++++ работаем с графом - задача обнаружить куда уходят экспорты++++++++++
function addReverseEdge(from, to) {
  if (!reverseProjectGraph.has(to)) {
    reverseProjectGraph.set(to, new Set());
  }
  reverseProjectGraph.get(to).add(from);
}

//++++++++ работаем с графом - задача обнаружить куда уходят экспорты++++++++++
function removeReverseEdges(file) {
  for (const set of reverseProjectGraph.values()) {
    set.delete(file);
  }
}

async function loadProjectGraph() {
  try {
    const raw = await fs.readFile(GRAPH_FILE, "utf8");
    const json = JSON.parse(raw);
    projectGraph.clear();
    reverseProjectGraph.clear();

    for (const [file, data] of Object.entries(json)) {
      projectGraph.set(file, {
        imports: data.imports || [],
        exports: data.exports || [],
      });
    }
    // rebuild reverseProjectGraph
    for (const [file, data] of projectGraph.entries()) {
      for (const imp of data.imports || []) {
        addReverseEdge(file, imp);
      }
    }
    // recompute pageRank after loading the graph so consumers get correct values
    recomputePageRank();
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.warn("[graph] load failed:", e.message);
    }
  }
}

async function saveProjectGraph() {
  const json = {};
  for (const [file, data] of projectGraph.entries()) {
    json[file] = data;
  }

  await fs.mkdir(path.dirname(GRAPH_FILE), { recursive: true });

  const tmp = GRAPH_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(json, null, 2));
  await fs.rename(tmp, GRAPH_FILE);
}

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
//hjg
async function upsertVectorItem(index, engineId, item) {
  console.log("[VECTRA UPSERT]", engineId, item.id, item.vector.length);
  return await withEngineLock(engineId, async () => {
    try {
      await index.deleteItem(item.id);
    } catch {}
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
async function indexProject(cfg) {
  const roots = Object.values(cfg.local_recurses || {}).map((p) =>
    path.resolve(ROOT, p.root)
  );
  // 1️⃣ initial scan
  for (const absRoot of roots) {
    const p = Object.values(cfg.local_recurses).find(
      (x) => path.resolve(ROOT, x.root) === absRoot
    );
    if (!p) continue;

    const files = await glob(p.include, {
      cwd: absRoot,
      ignore: p.exclude,
      absolute: true,
    });

    for (const absFile of files) {
      if (!VALID_EXT.test(absFile)) continue;
      const rel = path.relative(ROOT, absFile).replace(/\\/g, "/");
      await indexProjectFile(rel, ROOT);
    }
  }
  // 2️⃣ watcher — ТОЛЬКО ПОСЛЕ УСПЕШНОГО СКАНА
  watchProjectIndex(roots);
}
async function indexProjectFile(filePath, root) {
  if (engineState.get("project") !== "ready") {
    throw new Error("Engine not ready");
  }
  const version = Date.now();
  fileVersions.set(filePath, version);
  const index = await getVectorIndex("project");
  if (!index || !(await index.isIndexCreated())) {
    throw new Error("Vectra index not ready");
  }
  const abs = path.join(root, filePath);

  await removeFileFromIndex(index, filePath);

  let code;
  try {
    code = await fs.readFile(abs, "utf8");
  } catch {
    return;
  }

  let symbols;
  let result;
  try {
    result = extractProjectSymbols(code, filePath, root);
    symbols = result.chunks;
    // 🔗 обновляем граф
    removeReverseEdges(filePath);

    // forward graph
    projectGraph.set(filePath, {
      imports: result.imports,
      exports: result.exports,
    });

    // reverse graph
    for (const imp of result.imports) {
      addReverseEdge(filePath, imp);
    }

    scheduleGraphSave();
  } catch (e) {
    console.warn(
      "[project-index] skip file:",
      filePath,
      "\n",
      e?.message,
      "\n",
      e?.stack
    );
    return;
  }

  const hashes = new Set();

  /* 🔧 FIX: batching embeddings на уровень файла */
  const existing = new Set((await index.listItems()).map((it) => it.id));
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];

    // ✅ 1. канонизация
    const cleaned = cleanText(s.text);
    if (!cleaned) continue;

    // ✅ 2. лимит
    const estimatedTokens = estimateTokens(cleaned);
    if (estimatedTokens > TOKEN_ESTIMATE.maxBudget) continue;

    // ✅ 3. стабильный hash
    const hash = hashText(cleaned);
    hashes.add(hash);

    if (existing.has(hash)) continue;

    // ✅ 4. embedding ТОЛЬКО от cleaned
    const vector = await embedQueued(cleaned);

    await upsertVectorItem(index, "project", {
      id: hash,
      vector,
      content: cleaned, // ⬅️ ВАЖНО
      metadata: {
        engineId: "project",
        source: filePath,
        section: s.section ?? detectSection(cleaned),
        estimatedTokens,
        imports: result.imports,
        exports: result.exports,
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

  await removeFileFromIndex(index, filePath); // vectra
  cleanupProjectFileState(filePath); // graph + persist

  fileVersions.delete(filePath);
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

async function search(engineId, query, topK = SEARCH_CONFIG.topK) {
  if (engineState.get("project") !== "ready") {
    throw new Error("Engine not ready");
  }
  const index = await getVectorIndex(engineId);
  const queryVec = await embedQueued(query);
  // берем больше кандидатов
  const raw = await index.queryItems(queryVec, topK * 3);
  return {
    queryVec,
    candidates: raw.map((r) => ({
      id: r.item.id,
      score: r.score,
      finalScore: r.score,
      vector: r.item.vector,
      text: r.item.content,
      source: r.item.metadata.source,
      section: r.item.metadata.section,
      estimatedTokens: r.item.metadata.estimatedTokens,
    })),
  };
}
//hgjhj
/* ===================== INDEXING ===================== */
let watcher = null;
// indexEngine — строгая фазовая модель НЕЛЬЗЯ запускать watcher до init, читать cfg до init, делать scan если init упал
export async function indexEngine(engineId) {
  // PHASE 1 — HARD INIT
  await initEngineStrict(engineId); // ⛔ если упало — стоп

  // PHASE 2 — LOAD STATE
  if (engineId === "project") {
    await loadProjectGraph();
    await loadProjectFileIndex();
  }
  // PHASE 3 — INITIAL SCAN
  const cfg = JSON.parse(
    await fs.readFile(ENGINES[engineId].sourcesFile, "utf8")
  );

  if (engineId === "web") {
    await indexWeb(cfg);
  }

  if (engineId === "project") {
    await indexProject(cfg);
  }

  serviceLog("[ENGINE] ready", engineId);
}

/* ===================== REFRESH ===================== */
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
  //если pageRank пустой то защита
  if (!pageRank.size) {
    recomputePageRank();
  }
  // 1️⃣ semantic seed
  const { queryVec, candidates } = await search(engineId, query, 20);
  const seedFilesCandidates = [...new Set(candidates.map((c) => c.source))];

  for (const c of candidates) {
    c.graphScore = computeGraphScore(c, seedFilesCandidates);
  }
  // MMR отбор
  const seedHits = mmrSelect(
    candidates,
    queryVec,
    10, // сколько реально хотим
    0.7 // баланс релевантность / разнообразие
  );
  // 🎯 graph-aware scoring
  const seedFiles = [...new Set(seedHits.map((h) => h.source))];

  for (const h of seedHits) {
    h.graphScore = computeGraphScore(h, seedFiles);
    const pr = pageRank.get(h.source) ?? 0.0001;

    h.finalScore = h.score * h.graphScore * Math.log(1 + pr * 10);
  }

  // 3️⃣ graph expansion
  const expandedFiles = expandByGraph(seedFiles, 1);

  const index = await getVectorIndex(engineId);

  const expandedHits = [...seedHits];

  // 4️⃣ добор архитектурных чанков
  for (const file of expandedFiles) {
    if (seedFiles.includes(file)) continue;

    const vector = await embedQueued(`imports exports ${file}`);
    const extraRaw = await index.queryItems(vector, 6);
    const extraCandidates = extraRaw.map((r) => ({
      id: r.item.id,
      vector: r.item.vector,
      score: r.score,
      text: r.item.content,
      source: r.item.metadata.source,
      section: r.item.metadata.section,
      estimatedTokens: r.item.metadata.estimatedTokens,
    }));
    const diversified = mmrSelect(extraCandidates, vector, 2, 0.6);

    for (const h of diversified) {
      h.graphScore = computeGraphScore(h, seedFiles);
      h.finalScore = h.score * h.graphScore;
      expandedHits.push(h);
    }
  }
  expandedHits.sort(
    (a, b) => (b.finalScore ?? b.score) - (a.finalScore ?? a.score)
  );
  // 5️⃣ group by source
  const bySource = new Map();
  for (const h of expandedHits) {
    if (!bySource.has(h.source)) bySource.set(h.source, []);
    bySource.get(h.source).push(h);
  }

  // 6️⃣ context assembly
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
      if (used + h.estimatedTokens > budget) {
        return ctx.join("\n\n");
      }
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
// const cfg = JSON.parse(await fs.readFile(ENGINES.project.sourcesFile, "utf8"));
// const roots = Object.values(cfg.local_recurses || {}).map((p) =>
//   path.resolve(ROOT, p.root)
// );
// watchProjectIndex(roots);

/* 🔧 FIX: фильтрация по расширениям */
const VALID_EXT = /\.(js|ts|jsx|tsx)$/i;

function watchProjectIndex(rootPaths, debounceMs = 5000) {
  if (engineState.get("project") !== "ready") {
    throw new Error("watcher started before engine ready");
  }
  if (watcher) watcher.close();
  watcher = chokidar.watch(rootPaths, {
    ignored: /node_modules|\.git|\.docs-index/,
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
        const absRoot = path.resolve(ROOT, p.root);
        const absFile = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(ROOT, filePath);
        if (!absFile.startsWith(absRoot)) continue;
        const rel = path.relative(ROOT, absFile).replace(/\\/g, "/");

        if (event === "unlink") {
          await removeProjectFile(rel);
        } else {
          await indexProjectFile(rel, ROOT);
        }
      }
    }, debounceMs);
  };
  watcher
    .on("add", (p) => scheduleFileIndex(p, "add"))
    .on("change", (p) => scheduleFileIndex(p, "change"))
    .on("unlink", (p) => scheduleFileIndex(p, "unlink"));
}
