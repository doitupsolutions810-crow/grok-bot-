import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

export function createTerminalTool({ execFileImpl = execFile, uuid = randomUUID } = {}) {
  return {
    name: "terminal",
    description: "Run a shell command in the user's personal sandbox container and return stdout/stderr. Your working directory is your own persistent home.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "Shell command to execute" } },
      required: ["command"]
    },
    async run({ command }, ctx) {
      if (typeof command !== "string" || !command.trim() || command.length > 20000) {
        return { ok: false, cwd: "", stdout: "", stderr: "command must contain 1..20000 characters" };
      }
      if (ctx?.signal?.aborted) return { ok: false, cwd: "", stdout: "", stderr: "command cancelled before start" };
      const container = (process.env.ALLOWED_TERMINAL_CONTAINERS || "grok-sandbox").split(",")[0].trim();
      const slug = String(ctx?.agent || "main").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || "main";
      const home = `/workspace/agents/${slug}`;
      const id = uuid();
      const pidFile = `/tmp/grok-swarm-${id}.pid`;
      const cancelFile = `/tmp/grok-swarm-${id}.cancel`;
      const qHome = quote(home);
      const qPid = quote(pidFile);
      const qCancel = quote(cancelFile);
      const inner = `cd ${qHome} && ${command}`;
      const wrapped = `mkdir -p ${qHome} && if [ -e ${qCancel} ]; then rm -f ${qCancel}; exit 143; fi; (setsid sh -lc ${quote(inner)} & child=$!; printf '%s' "$child" > ${qPid}; if [ -e ${qCancel} ]; then /bin/kill -TERM -- "-$child" 2>/dev/null || true; fi; wait "$child"; status=$?; rm -f ${qPid} ${qCancel}; exit "$status")`;
      const killRemote = () => {
        const killScript = `: > ${qCancel}; if [ -r ${qPid} ]; then p=$(cat ${qPid}); case "$p" in ""|*[!0-9]*) ;; *) /bin/kill -TERM -- "-$p" 2>/dev/null || true; sleep 1; /bin/kill -KILL -- "-$p" 2>/dev/null || true;; esac; fi`;
        execFileImpl("docker", ["exec", container, "sh", "-lc", killScript], {
          timeout: 5000, maxBuffer: 64 * 1024
        }, () => {});
      };
      return await new Promise(resolve => {
        let cancelStarted = false;
        const cancel = () => {
          if (cancelStarted) return;
          cancelStarted = true;
          killRemote();
        };
        ctx?.signal?.addEventListener("abort", cancel, { once: true });
        execFileImpl("docker", ["exec", container, "sh", "-lc", wrapped], {
          timeout: 30_000, maxBuffer: 1024 * 1024, signal: ctx?.signal
        }, (err, stdout = "", stderr = "") => {
          if (err) cancel();
          ctx?.signal?.removeEventListener("abort", cancel);
          resolve({
            ok: !err,
            cwd: home,
            stdout: String(stdout).slice(0, 8000),
            stderr: String(stderr || err?.message || "").slice(0, 4000)
          });
        });
      });
    }
  };
}

export const terminalTool = createTerminalTool();
