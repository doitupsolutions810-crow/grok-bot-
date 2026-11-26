import { execFile } from "node:child_process";

// Runs commands inside the grok-sandbox container via `docker exec`.
// Personal terminal: feels like the host, safely isolated in a container.
// Each agent gets its own persistent home (/workspace/agents/<id>) so
// parallel workers never trample each other's files.
export const terminalTool = {
  name: "terminal",
  description: "Run a shell command in the user's personal sandbox container and return stdout/stderr. Your working directory is your own persistent home.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" }
    },
    required: ["command"]
  },
  async run({ command } = {}, ctx) {
    // "undefined" used to be executed as a shell command
    if (typeof command !== "string" || !command.trim()) return { ok: false, error: "command required" };
    if (command.length > 20_000) return { ok: false, error: "command too long (max 20000 chars)" };
    const container = (process.env.ALLOWED_TERMINAL_CONTAINERS || "grok-sandbox").split(",")[0].trim();
    const slug = String(ctx?.agent || "main").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || "main";
    const home = `/workspace/agents/${slug}`;
    const wrapped = `mkdir -p ${home} && cd ${home} && ${command}`;
    return await new Promise(resolve => {
      execFile("docker", ["exec", container, "sh", "-lc", wrapped], {
        timeout: Math.min(Math.max(1000, Number(process.env.TERMINAL_TIMEOUT_MS) || 30_000), 600_000),
        maxBuffer: 1024 * 1024, killSignal: "SIGKILL"
      }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          cwd: home,
          timedOut: !!err?.killed,
          stdout: String(stdout || "").slice(0, 8000),
          stderr: (stderr || err?.message || "").slice(0, 4000)
        });
      });
    });
  }
};
