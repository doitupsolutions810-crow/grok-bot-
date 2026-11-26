// One place to resolve on-disk state. DATA_DIR (default /app/data) lets the
// same code run in the container, in local unit tests, and on bare hosts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function dataDir() {
  const dir = process.env.DATA_DIR || "/app/data";
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const dataPath = file => join(dataDir(), file);
