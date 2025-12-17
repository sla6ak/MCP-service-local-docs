/* ===================== PROJECT AST LOADER ===================== */
import { cleanText } from "./text.js";
import { normalizeImport } from "./normalizeImport.js";
import * as babel from "@babel/parser";
import traverse from "@babel/traverse";

export function extractProjectSymbols(code, filePath, root) {
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

      if (n.type === "ImportDeclaration" && n.source?.value) {
        const normalized = normalizeImport(
          n.source.value,
          filePath,
          root // передай root
        );
        if (normalized) imports.add(normalized);
      }

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

  return { chunks, imports: [...imports], exports: [...exports] };
}
