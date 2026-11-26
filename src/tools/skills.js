// Teach-a-task: record a browser workflow once → it becomes a replayable skill tool.
// Plus SKILL.md playbooks (frontmatter name/description) shipped in /app/skills,
// exposed to agents as skill.list / skill.load.

import Database from "better-sqlite3";
import { dataPath } from "../paths.js";
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";

const db = new Database(dataPath("skills.db"));
db.exec(`CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE, description TEXT, steps TEXT, created TEXT
)`);

const SKILLS_DIR = process.env.SKILLS_DIR || "/app/skills";

// steps: [{action:"goto"|"click"|"type"|"wait", selector?, text?, url?, ms?}]
export function validateSkill(name, description, steps) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name)) return "name must be 1-48 chars of a-z 0-9 _ -";
  if (description != null && typeof description !== "string") return "description must be a string";
  if (!Array.isArray(steps) || !steps.length || steps.length > 50) return "steps must be an array of 1-50 steps";
  for (const [i, st] of steps.entries()) {
    if (!st || typeof st !== "object") return `step ${i}: must be an object`;
    if (st.action === "goto") { if (!/^https?:\/\//i.test(String(st.url || ""))) return `step ${i}: goto needs an http(s) url`; }
    else if (st.action === "click") { if (typeof st.selector !== "string" || !st.selector) return `step ${i}: click needs a selector`; }
    else if (st.action === "type") { if (typeof st.selector !== "string" || !st.selector || typeof st.text !== "string") return `step ${i}: type needs selector and text`; }
    else if (st.action === "wait") { if (st.ms != null && !(Number(st.ms) >= 0 && Number(st.ms) <= 60_000)) return `step ${i}: wait ms must be 0..60000`; }
    else return `step ${i}: unknown action ${JSON.stringify(st.action)}`;
  }
  return null;
}
export async function saveSkill(name, description, steps) {
  const bad = validateSkill(name, description, steps);
  if (bad) throw new Error(bad);
  db.prepare("INSERT OR REPLACE INTO skills (name, description, steps, created) VALUES (?,?,?,datetime('now'))")
    .run(name, String(description || ""), JSON.stringify(steps));
}
export function listSkills() {
  // one corrupt row used to throw and take every skill (and boot) down with it
  return db.prepare("SELECT name, description, steps FROM skills").all().flatMap(s => {
    try { const steps = JSON.parse(s.steps); return Array.isArray(steps) ? [{ ...s, steps }] : []; }
    catch { console.warn(`[skills] skipping corrupt skill ${s.name}`); return []; }
  });
}

// Shipped SKILL.md playbooks (frontmatter: name, description)
export function loadPlaybooks() {
  try {
    return readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        try { return { d, src: readFileSync(`${SKILLS_DIR}/${d.name}/SKILL.md`, "utf-8") }; } catch { return null; }
      })
      .filter(Boolean)
      .map(({ d, src }) => {
        // CRLF files and quoted values ("name: \"x\"") used to all collapse to name "playbook"
        src = src.replace(/^\uFEFF/, "");
        const fm = (src.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || "";
        const meta = Object.fromEntries(
          fm.split(/\r?\n/).filter(l => l.includes(":"))
            .map(l => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim().replace(/^(["'])(.*)\1$/, "$2")])
        );
        return { name: meta.name || d.name, description: meta.description || "", content: src };
      });
  } catch { return []; }
}

async function withSharedBrowser(fn) {
  const browser = await chromium.connectOverCDP(process.env.BROWSER_WS || "ws://browser:3000");
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    return await fn(page);
  } finally { await browser.close(); }
}

// Every saved skill becomes a first-class tool: skill.<name>
export function skillTools() {
  return listSkills().map(skillTool);
}
export function skillTool(s) {
  return ({
    name: `skill.${s.name}`,
    description: s.description,
    parameters: { type: "object", properties: {} },
    async run(args) {
      return await withSharedBrowser(async page => {
        for (const step of s.steps) {
          if (step.action === "goto") await page.goto(step.url);
          else if (step.action === "click") await page.click(step.selector);
          else if (step.action === "type") await page.fill(step.selector, step.text);
          else if (step.action === "wait") await page.waitForTimeout(step.ms || 500);
        }
        return { ok: true, url: page.url(), content: (await page.content()).slice(0, 4000) };
      });
    }
  });
}

// Meta tools: discover and load playbooks
export function playbookTools() {
  const list = {
    name: "skill.list",
    description: "List available skills (recorded browser skills and written playbooks).",
    parameters: { type: "object", properties: {} },
    async run() {
      const playbooks = loadPlaybooks();
      return {
        skills: [...listSkills().map(s => s.name), ...playbooks.map(p => p.name)],
        playbooks: playbooks.map(p => ({ name: p.name, description: p.description }))
      };
    }
  };
  const load = {
    name: "skill.load",
    description: "Load a written playbook by name and get its full instructions.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run({ name } = {}) {
      if (typeof name !== "string" || !name.trim()) return { error: "name required" };
      const want = name.trim().toLowerCase();
      const p = loadPlaybooks().find(p => p.name.toLowerCase() === want);
      if (!p) return { error: `no playbook named ${name}` };
      return p;
    }
  };
  return [list, load];
}
