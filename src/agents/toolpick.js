// Tool shortlist. A small local model handed 40+ tool schemas loses the plot. In live run
// 45775974761, qwen2.5:3b with 37 tools answered "None of the provided functions support running
// shell commands" while the terminal tool was right there. So each turn offers the model the
// tools that fit the request, ranked; every granted tool can still be executed.
// TOOL_SHORTLIST=<n> sets the size (default 12); 0 turns it off.

const HINTS = {
  terminal: "shell command run execute bash sh uname kernel ls df du cat grep sed awk install pip npm apt git sandbox script disk process cpu memory uptime whoami env curl python node compile build test",
  browser: "browse browser click website webpage screenshot login sign navigate form javascript spa",
  "web.search": "search google bing look find latest news research discover sources web internet query",
  "web.scrape": "scrape extract page article url headings links read website text",
  "web.fetch": "fetch url http https api download json endpoint request",
  "github.search": "github repo repository repositories open source library project code issues stars study",
  "github.read": "github repo repository readme release releases file source code study",
  "node.exec": "node container machine own run command execute code script build compile test",
  "node.service": "service daemon systemd background start stop restart logs supervise",
  "node.info": "node container machine resources cpu memory network info",
  "node.mcp": "mcp server tool protocol",
  "harness.list": "harness own source code yourself improve upgrade capabilities",
  "harness.read": "harness own source code read yourself improve",
  "harness.propose": "harness propose upgrade improve fix yourself new tool skill patch code",
  "harness.proposals": "harness proposals status upgrade",
  "team.say": "team teammate tell share message colleague council",
  "team.inbox": "team inbox messages teammate replies queue",
  "team.knowledge": "team knowledge eureka discoveries findings learned",
  "team.ask": "ask teammate delegate colleague expert",
  "team.spawn": "spawn subagent helper parallel delegate",
  "task.board": "task todo board plan track assign",
  "skill.list": "skill skills playbook how",
  "skill.load": "skill playbook procedure",
  "rag.search": "document documents notes knowledge base files search memory",
  imagegen: "image picture draw generate art photo illustration",
  vision: "image photo screenshot look see describe picture",
  "x.search": "x twitter tweet tweets posts trending",
  "x.post": "x twitter tweet post publish",
  "voice.speak": "speak voice say aloud audio tts",
  "mind.think": "think reason reasoning step plan consider why hard problem reflect",
  "mind.journal": "journal lesson learned remember reflect evolve",
  "mind.goals": "goal goals objective aim evolve want",
  "memory.recall": "remember recall memory earlier previous"
};
const STOP = new Set("the and for with that this from your you are was what when where which into then than them they have has had not but can all any how why who our out use using via per one two its it's".split(" "));
const words = s => String(s || "").toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) || [];

export function scoreTool(tool, msgWords, msgText) {
  const hint = new Set(words(HINTS[tool.name] || HINTS[tool.name.split(".")[0]] || ""));
  const desc = new Set(words(`${tool.name} ${tool.description || ""}`).filter(w => w.length > 2 && !STOP.has(w)));
  let s = 0;
  for (const w of msgWords) { if (hint.has(w)) s += 3; if (desc.has(w)) s += 1; }
  if (msgText.includes(tool.name.toLowerCase())) s += 10;              // named outright
  return s;
}

export function shortlist(tools, message, k = Number(process.env.TOOL_SHORTLIST ?? 12)) {
  if (!Array.isArray(tools) || !k || k < 1 || tools.length <= k) return tools;
  const text = String(message || "").toLowerCase();
  const mw = [...new Set(words(text).filter(w => !STOP.has(w)))];
  const ranked = tools.map((t, i) => ({ t, i, s: scoreTool(t, mw, text) })).sort((a, b) => b.s - a.s || a.i - b.i);
  const picked = ranked.filter(r => r.s > 0).slice(0, k).map(r => r.t);
  for (const name of ["terminal", "web.search", "web.fetch", "team.say", "skill.load"]) {   // sensible floor
    if (picked.length >= Math.min(k, 5)) break;
    const t = tools.find(x => x.name === name);
    if (t && !picked.includes(t)) picked.push(t);
  }
  for (const r of ranked) { if (picked.length >= Math.min(k, 5)) break; if (!picked.includes(r.t)) picked.push(r.t); }
  return picked;
}
