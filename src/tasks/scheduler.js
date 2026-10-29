import cron from "node-cron";
import { LLM } from "../llm/provider.js";
import Database from "better-sqlite3";
import { dataFile } from "../paths.js";

const db = new Database(dataFile("tasks.db"));
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, name TEXT, cron TEXT, agent TEXT, prompt TEXT,
  last_run TEXT, last_result TEXT
)`);
const llm = new LLM();
const jobs = new Map();
let onRun = async () => {};

export function setTaskRunner(fn) { onRun = fn; }

export function addTask({ name, cron: expr, agent, prompt }) {
  const { last_insert_rowid: id } = db.prepare(
    "INSERT INTO tasks (name, cron, agent, prompt) VALUES (?,?,?,?)"
  ).run(name, expr, agent, prompt);
  const job = cron.schedule(expr, () => runTask(id));
  jobs.set(id, job);
  return id;
}

export async function runTask(id) {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
  const answer = await onRun(t.agent, t.prompt);
  db.prepare("UPDATE tasks SET last_run=datetime('now'), last_result=? WHERE id=?")
    .run(String(answer).slice(0, 5000), id);
}

export function listTasks() {
  return db.prepare("SELECT id, name, cron, agent, last_run, substr(last_result,1,200) preview FROM tasks").all();
}
