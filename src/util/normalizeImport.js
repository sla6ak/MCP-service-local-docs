import fssync from "node:fs";
import path from "node:path";
export function normalizeImport(source, fromFile, root) {
  // 1. node_modules — игнорируем
  if (
    !source.startsWith(".") &&
    !source.startsWith("/") &&
    !source.startsWith("@")
  ) {
    return null;
  }
  let resolved;
  // 2. относительные импорты
  if (source.startsWith(".")) {
    resolved = path.resolve(path.dirname(fromFile), source);
  }
  // 3. алиасы (пример: @ → src)
  else if (source.startsWith("@/")) {
    resolved = path.resolve(root, "src", source.slice(2));
  } else {
    return null;
  }
  // 4. расширения
  const candidates = [
    resolved,
    resolved + ".ts",
    resolved + ".js",
    resolved + ".tsx",
    resolved + ".jsx",
    path.join(resolved, "index.ts"),
    path.join(resolved, "index.js"),
  ];
  for (const c of candidates) {
    if (fssync.existsSync(c)) {
      return path.relative(root, c).replace(/\\/g, "/"); // win fix
    }
  }

  return null;
}
