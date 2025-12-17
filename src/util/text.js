import crypto from "node:crypto";
import { JSDOM } from "jsdom";
export function extractVisibleText(html) {
  const dom = new JSDOM(html);
  dom.window.document
    .querySelectorAll("script, style, noscript")
    .forEach((e) => e.remove());
  return cleanText(dom.window.document.body?.textContent || "");
}
export const TOKEN_ESTIMATE = {
  charsPerToken: 4,
  defaultBudget: 2500,
  maxBudget: 6000,
};
export function cleanText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
}

export function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function estimateTokens(text) {
  return Math.ceil(text.length / TOKEN_ESTIMATE.charsPerToken);
}

export function detectSection(text) {
  const head = text.slice(0, 2000);
  const md = head.match(/^#{1,6}\s+(.+)$/m);
  if (md) return md[1].trim();
  const first = head.split("\n")[0]?.trim();
  if (first && first.length > 8 && first.length < 120) return first;
  return null;
}
