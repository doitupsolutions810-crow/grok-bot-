// Single source of truth for on-disk locations. Defaults match the container
// layout (/app/data, /output), so Docker deployments behave exactly as before;
// native mode just sets DATA_DIR / OUTPUT_DIR.
import path from "node:path";
import fs from "node:fs";

export const dataDir = () => process.env.DATA_DIR || "/app/data";
export const outputDir = () => process.env.OUTPUT_DIR || "/output";
export const dataFile = name => {
  const d = dataDir();
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name);
};
