export function normalizeSubtasks(reply, { fallback = 3, min = 1, max = 4, source = "" } = {}) {
  const text = String(reply || "");
  const ceiling = Math.max(1, Math.floor(Number(max) || 4));
  const target = Math.max(1, Math.min(ceiling, Math.floor(Number(min) || 1)));
  let items = [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) items = parsed.filter(s => typeof s === "string" && s.trim()).map(s => s.trim());
    } catch { /* planner produced invalid JSON — fall through */ }
  }
  const seen = new Set();
  items = items.filter(t => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const original = String(source || text.slice(0, 200) || "the request").slice(0, 200);
  if (!items.length) {
    items = Array.from({ length: Math.max(target, Math.min(ceiling, Math.floor(Number(fallback) || 3))) }, (_, i) =>
      `Independently investigate angle ${i + 1} of: "${original}". Gather concrete evidence and state what cannot be verified.`);
  }
  items = items.slice(0, ceiling);

  // The configured SQUAD_N is a contract, not just a fallback. If the planner
  // returns too few lanes, fill missing lanes with distinct verification work.
  const angles = [
    "runtime identity, operating system, Node/Python versions, process state, and filesystem capacity",
    "service endpoints, container reachability, bridge configuration, and health responses",
    "independent evidence checks, inconsistent claims, missing test results, and reproducibility",
    "security boundaries, secrets-safe environment checks, and least-privilege assumptions"
  ];
  while (items.length < target) {
    const angle = angles[items.length % angles.length];
    items.push(`Independent verification lane: inspect ${angle} for "${original}". Use read-only evidence and identify gaps rather than assuming success.`);
  }
  return items.slice(0, ceiling);
}
