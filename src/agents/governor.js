// Governor — ported from Avrone (governor.py). Health-gated parallelism.
// Sensors: per-CPU load, memory %, data-dir disk %, max thermal zone temp.
// Each maps to a ramp-down factor in [0,1]; the WORST factor decides how many
// parallel workers run. Advisory only: sensor errors are ignored (factor 1),
// and the target never drops below 1.

import { readFileSync } from "node:fs";
import os from "node:os";

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Linear ramp: 1 at or below `lo`, 0 at or above `hi`.
function ramp(v, lo, hi) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 1;   // broken sensor → healthy
  if (v <= lo) return 1;
  if (v >= hi) return 0;
  return (hi - v) / (hi - lo);
}

export const governor = {
  enabled: process.env.GROK_GOVERNOR !== "false",

  sensors() {
    let load = 0.05;
    try {
      const [one] = os.loadavg();
      load = one / Math.max(1, os.cpus().length);
    } catch { load = 0.05; }

    let mem = 0;
    try { mem = 1 - os.freemem() / Math.max(1, os.totalmem()); } catch {}

    let disk = 0;
    try {
      const st = require_statfs();
      const used = 1 - st.bavail / Math.max(1, st.blocks);
      disk = used;
    } catch { disk = null; }

    let thermal = null;
    try {
      let maxC = -Infinity;
      for (let i = 0; i < 10; i++) {
        try {
          const raw = readFileSync(`/sys/class/thermal/thermal_zone${i}/temp`, "utf-8");
          const c = Number(String(raw).trim()) / 1000;
          if (Number.isFinite(c) && c > maxC) maxC = c;
        } catch { /* zone absent — normal on most hosts */ }
      }
      thermal = Number.isFinite(maxC) ? maxC : null;
    } catch { thermal = null; }

    const thermalMax = num("GROK_THERMAL_MAX_C", 80);
    return {
      load,                                    // fraction of one CPU of capacity
      mem,                                     // fraction used
      disk,                                    // fraction used (null if unreadable)
      thermal                                  // °C (null if unreadable)
    };
  },

  factors() {
    const s = this.sensors();
    const thermalMax = num("GROK_THERMAL_MAX_C", 80);
    return {
      load: ramp(s.load, 0.70, 1.00),
      mem: ramp(s.mem, 0.80, 0.97),
      disk: ramp(s.disk, 0.90, 0.99),
      thermal: ramp(s.thermal, thermalMax, thermalMax + 15)
    };
  },

  worst() {
    const f = this.factors();
    return Math.min(f.load, f.mem, f.disk, f.thermal);
  },

  state() {
    const w = this.worst();
    if (!this.enabled) return "disabled";
    if (w >= 0.75) return "healthy";
    if (w >= 0.34) return "throttled";
    return "critical";
  },

  target() {
    const floor = Math.max(1, num("GROK_MIN_PARALLEL", 1));
    const max = Math.max(floor, num("GROK_MAX_PARALLEL", 4));
    if (!this.enabled) return max;
    const w = this.worst();
    let t = floor + Math.round((max - floor) * w);
    t = Math.max(1, Math.min(max, t));
    const want = Number(process.env.GROK_WANT_PARALLEL);
    if (Number.isFinite(want) && want > 0) t = Math.min(t, Math.floor(want));
    return t;
  },

  snapshot() {
    return {
      state: this.state(),
      target: this.target(),
      max: Math.max(1, num("GROK_MAX_PARALLEL", 4)),
      sensors: this.factors(),
      raw: this.sensors(),
      enabled: this.enabled
    };
  }
};

// Lazily resolved so a missing statfs (macOS, some containers) never crashes boot.
import { statfsSync } from "node:fs";
function require_statfs() { return statfsSync(process.env.DATA_DIR || "/app/data"); }
