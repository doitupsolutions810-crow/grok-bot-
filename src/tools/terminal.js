import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isNative, nativeWorkspace } from "../native/index.js";

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
  async run({ command }, ctx) {
    if (isNative()) {
      const slugN = String(ctx?.agent || "main").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || "main";
      const homeN = path.join(nativeWorkspace(), "agents", slugN);
      fs.mkdirSync(homeN, { recursive: true });
      return await new Promise(resolve => {
        execFile("sh", ["-lc", command], { cwd: homeN, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ ok: !err, cwd: homeN, stdout: stdout.slice(0, 8000), stderr: (stderr || err?.message || "").slice(0, 4000) });
        });
      });
    }
    const container = (process.env.ALLOWED_TERMINAL_CONTAINERS || "grok-sandbox").split(",")[0].trim();
    const slug = String(ctx?.agent || "main").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || "main";
    const home = `/workspace/agents/${slug}`;
    const wrapped = `mkdir -p ${home} && cd ${home} && ${command}`;
    return await new Promise(resolve => {
      execFile("docker", ["exec", container, "sh", "-lc", wrapped], {
        timeout: 30_000, maxBuffer: 1024 * 1024
      }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          cwd: home,
          stdout: stdout.slice(0, 8000),
          stderr: (stderr || err?.message || "").slice(0, 4000)
        });
      });
    });
  }
};
