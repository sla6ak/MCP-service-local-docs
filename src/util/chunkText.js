export function chunkText(text, size, overlap) {
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
