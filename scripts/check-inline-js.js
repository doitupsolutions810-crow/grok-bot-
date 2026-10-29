import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attributes, body]) => !/\bsrc\s*=/.test(attributes) && body.trim());

if (scripts.length === 0) throw new Error("No inline JavaScript blocks found in public/index.html.");
scripts.forEach(([, , body], index) => {
  new Script(body, { filename: `public/index.html:inline-${index + 1}.js` });
});
console.log(`Validated ${scripts.length} inline JavaScript block(s) in public/index.html.`);
