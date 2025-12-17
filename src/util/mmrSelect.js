// ++++++++++++фильтрация чанков+++++++++++++++
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function mmrSelect(candidates, queryVec, k = 10, lambda = 0.7) {
  const selected = [];
  const pool = [...candidates];

  while (selected.length < k && pool.length) {
    let best = null;
    let bestScore = -Infinity;

    for (const c of pool) {
      const simQ = cosine(queryVec, c.vector) * (c.graphScore ?? 1.0);
      const simS = selected.length
        ? Math.max(...selected.map((s) => cosine(c.vector, s.vector)))
        : 0;

      const score = lambda * simQ - (1 - lambda) * simS;

      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    selected.push(best);
    pool.splice(pool.indexOf(best), 1);
  }

  return selected;
}
