/* ===================== EMBEDDINGS ===================== */

import fetch from "node-fetch";
export async function embed(text, retries = 3) {
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
