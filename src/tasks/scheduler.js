import cron from "node-cron";
import Database from "better-sqlite3";
import { dataPath } from "../paths.js";

const db = new Database(dataPath("tasks.db"));
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, name TEXT, cron TEXT, agent TEXT, prompt TEXT,
  last_run TEXT, last_result TEXT
)`);
const jobs = new Map();
let onRun = async () => "no task runner registered";

export function setTaskRunner(fn) {
  onRun = fn;
  restore();   // tasks survive restarts: re-arm every saved schedule once a runner exists
}

function arm(id, expr) {
  jobs.get(id)?.stop?.();
  jobs.set(id, cron.schedule(expr, () => runTask(id).catch(e => console.warn(`[tasks] #${id} failed: ${e.message}`))));
}

function restore() {
  for (const t of db.prepare("SELECT id, cron FROM tasks").all()) {
    if (!jobs.has(t.id) && cron.validate(t.cron)) arm(t.id, t.cron);
  }
}

export function addTask({ name, cron: expr, agent, prompt } = {}) {
  if (typeof expr !== "string" || !cron.validate(expr)) throw new Error("cron must be a valid cron expression");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt required");
  // better-sqlite3 returns the new key as lastInsertRowid
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO tasks (name, cron, agent, prompt) VALUES (?,?,?,?)"
  ).run(String(name || "task").slice(0, 200), expr, String(agent || "grok-main"), prompt.slice(0, 20000));
  const id = Number(lastInsertRowid);
  arm(id, expr);
  return id;
}

const running = new Set();
export async function runTask(id) {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
  if (!t) return null;
  // a slow run must not stack: skip the tick while the previous run is still going
  if (running.has(t.id)) return t.id;
  running.add(t.id);
  try { return await runTaskNow(t); } finally { running.delete(t.id); }
}
async function runTaskNow(t) {
  let answer;
  try { answer = await onRun(t.agent, t.prompt); }
  catch (e) { answer = `error: ${e.message}`; }
  db.prepare("UPDATE tasks SET last_run=datetime('now'), last_result=? WHERE id=?")
    .run(String(typeof answer === "string" ? answer : JSON.stringify(answer)).slice(0, 5000), t.id);
  return t.id;
}

export function deleteTask(id) {
  id = Number(id);
  jobs.get(id)?.stop?.();
  jobs.delete(id);
  return db.prepare("DELETE FROM tasks WHERE id=?").run(id).changes > 0;
}

export function listTasks() {
  return db.prepare("SELECT id, name, cron, agent, last_run, substr(last_result,1,200) preview FROM tasks").all();
}
