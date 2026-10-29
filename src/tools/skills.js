// Teach-a-task: record a browser workflow once → it becomes a replayable skill tool.
// Plus SKILL.md playbooks (frontmatter name/description) shipped in /app/skills,
// exposed to agents as skill.list / skill.load.

import Database from "better-sqlite3";
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import { dataFile } from "../paths.js";

const db = new Database(dataFile("skills.db"));
db.exec(`CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE, description TEXT, steps TEXT, created TEXT
)`);

const SKILLS_DIR = process.env.SKILLS_DIR || "/app/skills";

// steps: [{action:"goto"|"click"|"type"|"wait", selector?, text?, url?, ms?}]
export async function saveSkill(name, description, steps) {
  db.prepare("INSERT OR REPLACE INTO skills (name, description, steps, created) VALUES (?,?,?,datetime('now'))")
    .run(name, description, JSON.stringify(steps));
}
export function listSkills() {
  return db.prepare("SELECT name, description, steps FROM skills").all().map(s => ({ ...s, steps: JSON.parse(s.steps) }));
}

// Shipped SKILL.md playbooks (frontmatter: name, description)
export function loadPlaybooks() {
  try {
    return readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        try { return readFileSync(`${SKILLS_DIR}/${d.name}/SKILL.md`, "utf-8"); } catch { return null; }
      })
      .filter(Boolean)
      .map(src => {
        const fm = (src.match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
        const meta = Object.fromEntries(
          fm.split("\n").filter(l => l.includes(":"))
            .map(l => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()])
        );
        return { name: meta.name || "playbook", description: meta.description || "", content: src };
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
  return listSkills().map(s => ({
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
  }));
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
    async run({ name }) {
      const p = loadPlaybooks().find(p => p.name === name);
      if (!p) return { error: `no playbook named ${name}` };
      return p;
    }
  };
  return [list, load];
}
