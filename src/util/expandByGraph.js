export function expandByGraph(seedFiles, depth = 1) {
  const result = new Set(seedFiles);
  let frontier = new Set(seedFiles);

  for (let d = 0; d < depth; d++) {
    const next = new Set();
    for (const file of frontier) {
      const node = projectGraph.get(file);
      // forward: imports
      for (const imp of node?.imports || []) {
        if (!result.has(imp)) {
          result.add(imp);
          next.add(imp);
        }
      }
      // reverse: imported by
      const importers = reverseProjectGraph.get(file);
      if (importers) {
        for (const other of importers) {
          if (!result.has(other)) {
            result.add(other);
            next.add(other);
          }
        }
      }
    }
    frontier = next;
  }
  return [...result];
}
