import { cleanText, extractVisibleText } from "./text.js";
/* ===================== WEB LOADER ===================== */

export async function loadWebSource(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const ct = res.headers.get("content-type") || "";
  const body = await res.text();
  return ct.includes("html") ? extractVisibleText(body) : cleanText(body);
}
