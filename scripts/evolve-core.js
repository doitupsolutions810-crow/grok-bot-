/** Pure, deterministic event parsing/accounting shared by the evolution report and tests. */

export function parseEventLine(line) {
  const raw = String(line ?? "").trim();
  if (!raw) return null;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  // JSONL event logs should contain objects. Ignore null, arrays and scalar values
  // instead of crashing the report on otherwise valid JSON.
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  return event;
}

export function recordEvent(stats, event) {
  if (!stats || !event || typeof event !== "object" || Array.isArray(event)) return false;
  stats.events = (stats.events || 0) + 1;
  const kind = String(event.kind || event.type || "event");
  stats.byKind ||= {};
  stats.toolCalls ||= {};
  stats.errors ||= 0;
  stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
  const tool = event.tool || event.name;
  if (kind.includes("tool") && tool) {
    const key = String(tool);
    stats.toolCalls[key] = (stats.toolCalls[key] || 0) + 1;
  }
  if (kind.includes("error") || event.error) stats.errors += 1;
  return true;
}
