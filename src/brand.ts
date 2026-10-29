// Brand voice: a Markdown file the agent reads on every turn. Lives in DATA_DIR so edits survive redeploys;
// seeded from the BRAND.md template in the repo root the first time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "BRAND.md");
const file = () => path.join(config.dataDir, "BRAND.md");

export function readBrand(): string {
  if (!fs.existsSync(file())) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file(), fs.existsSync(TEMPLATE) ? fs.readFileSync(TEMPLATE, "utf8") : "# Brand voice\n");
  }
  return fs.readFileSync(file(), "utf8");
}

export function writeBrand(text: string) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file(), text.trim() + "\n");
}
