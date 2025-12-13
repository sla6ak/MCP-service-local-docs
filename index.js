#!/usr/bin/env node
/**
 * mcp-docs-server v2.1
 * Автозагрузка и точный поиск по документации из docs_sources.json
 * - Индекс хранится в ./docs-index (удалишь папку — сервер пересоберёт индекс при старте)
 * - Предзагрузка всех профилей из docs_sources.json
 * - BM25-подобный поиск + бонусы заголовкам/началу текста
 * - Контекст-менеджер build_context(profile, query, budgetTokens)
 * - Инструменты: list_tools, get_sources, search_chunks, build_context, refresh_index
 */

import { stdin as input, stdout as output } from "node:process";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/* ====== Пути ====== */
const SOURCES_FILE = path.resolve("./docs_sources.json");
const INDEX_DIR = path.resolve("./docs-index");
const CHUNKS_FILE = path.join(INDEX_DIR, "chunks.json");
const ERRORS_FILE = path.join(INDEX_DIR, "errors.json");
const SOURCES_CACHE_FILE = path.join(INDEX_DIR, "sources.json");

/* ====== Настройки ====== */
const CONFIG = {
  requestDelayMs: 300,
  maxChunksPerResult: 20,
  tokenEstimate: {
    charsPerToken: 4,
    defaultBudgetTokens: 2500,
    maxBudgetTokens: 6000,
  },
  chunkDefaults: { size: 3500, overlap: 200 },
  search: { topK: 12 },
};

/* ====== Инициализация ====== */
await fs.mkdir(INDEX_DIR, { recursive: true });
await initJsonFile(CHUNKS_FILE, { chunks: [] });
await initJsonFile(ERRORS_FILE, { errors: [] });
await initJsonFile(SOURCES_CACHE_FILE, { sources: {} });

/* ====== Утилиты ====== */
function cleanText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
}
function chunkText(
  text,
  size = CONFIG.chunkDefaults.size,
  overlap = CONFIG.chunkDefaults.overlap
) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + size, text.length);
    chunks.push(text.slice(i, end));
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}
function extractVisibleText(html) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  document
    .querySelectorAll("script, style, noscript")
    .forEach((el) => el.remove());
  return cleanText(document.body ? document.body.textContent || "" : "");
}
async function downloadDoc(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании: ${url}`);
  const ct = res.headers.get("content-type") || "";
  const body = await res.text();
  return ct.includes("html") ? extractVisibleText(body) : cleanText(body);
}
function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
function estimateTokens(text) {
  return Math.ceil(text.length / CONFIG.tokenEstimate.charsPerToken);
}
async function initJsonFile(file, initial) {
  if (!fssync.existsSync(file)) {
    await fs.writeFile(file, JSON.stringify(initial, null, 2), "utf8");
  }
}
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function writeJson(file, obj) {
  await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
}
async function logError(entry) {
  const data = await readJson(ERRORS_FILE);
  data.errors.push({ ...entry, at: new Date().toISOString() });
  await writeJson(ERRORS_FILE, data);
}

/* ====== Индексация ====== */
function detectSection(text) {
  const head = text.slice(0, 2000);
  const md = head.match(/^#{1,6}\s+(.+)$/m);
  if (md) return md[1].trim();
  const firstLine = head.split("\n")[0]?.trim();
  if (firstLine && firstLine.length > 8 && firstLine.length < 120)
    return firstLine;
  return null;
}
async function upsertChunks(source, chunks) {
  const store = await readJson(CHUNKS_FILE);
  const existingHashes = new Set(store.chunks.map((c) => c.hash));
  const added = [];
  let seq = 0;
  for (const text of chunks) {
    const cleaned = cleanText(text);
    const hash = hashText(cleaned);
    if (existingHashes.has(hash)) continue;
    added.push({
      source,
      seq: seq++,
      text: cleaned,
      hash,
      estimatedTokens: estimateTokens(cleaned),
      section: detectSection(cleaned),
    });
  }
  store.chunks.push(...added);
  await writeJson(CHUNKS_FILE, store);
  return added.length;
}
async function cacheSourceMeta(uri, payload) {
  const cache = await readJson(SOURCES_CACHE_FILE);
  cache.sources[uri] = {
    ...(cache.sources[uri] || {}),
    ...payload,
    fetched_at: new Date().toISOString(),
  };
  await writeJson(SOURCES_CACHE_FILE, cache);
}
async function isSourceIndexed(uri) {
  const store = await readJson(CHUNKS_FILE);
  return store.chunks.some((c) => c.source === uri);
}
function loadSourcesFile() {
  let SOURCES = { profiles: {} };
  try {
    const raw = fssync.readFileSync(SOURCES_FILE, "utf8");
    SOURCES = JSON.parse(raw);
  } catch (e) {
    console.error("Не удалось загрузить docs_sources.json:", e);
  }
  return SOURCES;
}
async function preloadDocs(progress = false) {
  const sourcesConfig = loadSourcesFile();
  for (const [name, profile] of Object.entries(sourcesConfig.profiles || {})) {
    const size = profile.chunk?.size ?? CONFIG.chunkDefaults.size;
    const overlap = profile.chunk?.overlap ?? CONFIG.chunkDefaults.overlap;
    for (const url of profile.seedUrls || []) {
      try {
        const already = await isSourceIndexed(url);
        if (already) {
          if (progress) console.log(`✓ Уже в индексе: ${name} → ${url}`);
          continue;
        }
        await delay(CONFIG.requestDelayMs);
        const text = await downloadDoc(url);
        const chunks = chunkText(text, size, overlap);
        const added = await upsertChunks(url, chunks);
        await cacheSourceMeta(url, { textHash: hashText(text), profile: name });
        if (progress)
          console.log(`✓ Загружено: ${name} → ${url} (${added} чанков)`);
      } catch (e) {
        await logError({
          source_uri: url,
          step: "preload",
          message: String(e),
        });
        if (progress) console.error(`Ошибка ${name}: ${url}`, e);
      }
    }
  }
}
function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/* ====== Поиск (BM25-подобный) ====== */
function tokenize(text) {
  return (text.toLowerCase().match(/[a-zа-яё0-9_]+/gi) || []).filter(Boolean);
}
function buildScores(chunks, query) {
  const qTokens = tokenize(query);
  const qSet = new Set(qTokens);
  const N = chunks.length || 1;

  const df = new Map();
  for (const c of chunks) {
    const tokens = new Set(tokenize(c.text));
    for (const t of tokens) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  const k1 = 1.5,
    b = 0.75;
  const avgLen = chunks.reduce((s, c) => s + c.text.length, 0) / N;

  const scored = [];
  for (const c of chunks) {
    const tokens = tokenize(c.text);
    const len = c.text.length;
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t) || 0;
      const idfVal = idf(t);
      const denom = f + k1 * (1 - b + b * (len / (avgLen || 1)));
      const part = (f * (k1 + 1)) / (denom || 1);
      score += idfVal * part;
    }

    // Бонусы: если заголовок/секция содержит ключевые слова — небольшой множитель
    if (c.section) {
      const sectionTokens = tokenize(c.section);
      for (const t of qTokens) {
        if (sectionTokens.includes(t)) {
          score *= 1.25;
          break;
        }
      }
    }

    // Бонус за ранние позиции (seq)
    if (typeof c.seq === "number" && c.seq < 3) {
      score *= 1.12;
    }

    // Бонус, если начало текста содержит запрос
    const head = c.text.slice(0, 300).toLowerCase();
    for (const t of qTokens) {
      if (head.includes(t)) {
        score *= 1.15;
        break;
      }
    }

    scored.push({ chunk: c, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* ====== Поиск чанков ====== */
async function search_chunks({
  query,
  topK = CONFIG.search.topK,
  profile = null,
} = {}) {
  const store = await readJson(CHUNKS_FILE);
  let chunks = store.chunks || [];

  // Если профиль указан — фильтруем по cache.sources (который хранит profile для uri)
  if (profile) {
    const cache = await readJson(SOURCES_CACHE_FILE);
    const allowedUris = Object.entries(cache.sources || {})
      .filter(([, v]) => v.profile === profile)
      .map(([uri]) => uri);
    chunks = chunks.filter((c) => allowedUris.includes(c.source));
  }

  if (!query || !query.trim()) return [];

  const scored = buildScores(chunks, query);
  const results = scored.slice(0, topK).map((s) => {
    const c = s.chunk;
    // snippet: кусочек вокруг первого вхождения
    const idx = c.text.toLowerCase().indexOf(query.toLowerCase());
    let snippet = c.text.slice(0, 300);
    if (idx >= 0) {
      const start = Math.max(0, idx - 60);
      snippet =
        (start ? "… " : "") +
        c.text.slice(start, Math.min(c.text.length, idx + 240)) +
        (idx + 240 < c.text.length ? " …" : "");
    } else {
      snippet = c.text.slice(0, 300) + (c.text.length > 300 ? " …" : "");
    }

    return {
      source: c.source,
      seq: c.seq,
      section: c.section,
      hash: c.hash,
      estimatedTokens: c.estimatedTokens,
      score: s.score,
      snippet,
    };
  });

  return results;
}

/* ====== Список инструментов (API) ====== */
function list_tools() {
  return [
    "list_tools",
    "get_sources",
    "search_chunks",
    "build_context",
    "refresh_index",
    "preload_docs",
  ];
}

/* ====== Получить список источников и метаданные ====== */
async function get_sources() {
  const cfg = loadSourcesFile();
  const cache = await readJson(SOURCES_CACHE_FILE);
  return { profiles: cfg.profiles || {}, cached: cache.sources || {} };
}

/* ====== Построение контекста ======
   build_context(profile, query, budgetTokens)
   - выбирает релевантные чанки (по profile если указан)
   - добавляет до бюджета (по estimateTokens)
   - возвращает объект { contextText, chunks: [...] }
*/
async function build_context(
  profile,
  query,
  budgetTokens = CONFIG.tokenEstimate.defaultBudgetTokens
) {
  // safety: clamp budget
  budgetTokens = Math.max(
    0,
    Math.min(
      CONFIG.tokenEstimate.maxBudgetTokens,
      parseInt(budgetTokens, 10) || CONFIG.tokenEstimate.defaultBudgetTokens
    )
  );

  // получаем релевантные чанки (topK большое, потом набираем по токенам)
  const candidates = await search_chunks({
    query,
    topK: CONFIG.search.topK * 4,
    profile,
  });

  const selected = [];
  let usedTokens = 0;
  const seenHashes = new Set();

  for (const c of candidates) {
    if (seenHashes.has(c.hash)) continue;
    if (usedTokens + (c.estimatedTokens || 0) > budgetTokens) continue;
    selected.push(c);
    seenHashes.add(c.hash);
    usedTokens += c.estimatedTokens || estimateTokens(c.snippet || "");
  }

  // Сортируем по score (desc) и формируем контекст
  selected.sort((a, b) => b.score - a.score);

  const header = `-- Context for query: ${query}\n-- Profile: ${
    profile || "global"
  }\n-- Tokens budget: ${budgetTokens}, used: ${usedTokens}\n\n`;
  const pieces = selected.map((c, i) => {
    return `-- SOURCE ${i + 1}: ${c.source} (seq ${c.seq}${
      c.section ? `, section: ${c.section}` : ""
    })\n${c.snippet}\n`;
  });

  const contextText = header + pieces.join("\n");

  return { contextText, chunks: selected, usedTokens };
}

/* ====== Обновление индекса ====== */
async function refresh_index({ wipe = false, progress = false } = {}) {
  if (wipe) {
    // удалим старый индекс
    if (fssync.existsSync(INDEX_DIR)) {
      if (progress) console.log("Удаляю папку индекса...");
      await fs.rm(INDEX_DIR, { recursive: true, force: true });
    }
    await fs.mkdir(INDEX_DIR, { recursive: true });
    await initJsonFile(CHUNKS_FILE, { chunks: [] });
    await initJsonFile(ERRORS_FILE, { errors: [] });
    await initJsonFile(SOURCES_CACHE_FILE, { sources: {} });
  }

  // перезагружаем sources.json (в кэше информация о профиле будет обновлена в preload)
  // и делаем предзагрузку
  if (progress) console.log("Запускаю предзагрузку документов...");
  await preloadDocs(progress);
  if (progress) console.log("Готово.");
}

/* ====== CLI / HTTP-подобный минимальный интерфейс ====== */
async function runCli() {
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
        '  node server.js search_chunks \'{"query":"auth middleware","topK":8}\''
      );
      console.log(
        '  node server.js build_context \'{"profile":"myProfile","query":"jwt","budgetTokens":1200}\''
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
    await logError({ step: "cli", message: String(e), cmd: cmd || "none" });
    process.exit(1);
  }
}

/* ====== Если файл запущен напрямую — запускаем CLI ====== */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] === __filename) {
  runCli();
}

/* ====== Экспортируем функции для использования как модуля ====== */
export {
  list_tools,
  get_sources,
  search_chunks,
  build_context,
  refresh_index,
  preloadDocs,
};
