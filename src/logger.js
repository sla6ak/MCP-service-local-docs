import fs from "node:fs";
import path from "node:path";

const BASE_DIR = process.env.HOME || process.env.USERPROFILE || process.cwd();

const LOG_DIR = path.join(
  BASE_DIR,
  ".continue",
  "mcpServers",
  "local-docs-mcp"
);

const LOG_FILE = path.join(LOG_DIR, "mcp-service.log");

export function serviceLog(...args) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      LOG_FILE,
      new Date().toISOString() + " " + args.join(" ") + "\n"
    );
  } catch (e) {
    process.stderr.write("[LOGGER FAILED] " + (e?.stack || String(e)) + "\n");
  }
}
