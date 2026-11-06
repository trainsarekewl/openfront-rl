// Makes `@openfront/*` importable from bridge/ by junctioning the submodule's
// workspace links (openfront/node_modules/@openfront) into bridge/node_modules.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../../openfront/node_modules/@openfront");
const dir = path.resolve(here, "../node_modules");
const link = path.join(dir, "@openfront");
if (!fs.existsSync(target)) {
  console.error(`missing ${target}; run npm run inst in openfront/ first`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true });
fs.symlinkSync(target, link, "junction");
console.log(`linked ${link} -> ${target}`);
