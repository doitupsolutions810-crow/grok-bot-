// Ollama lists every model WITH its tag ("nomic-embed-text:latest"), but configs name them
// with or without one ("nomic-embed-text"). Comparing raw names made an untagged model look
// absent forever: the boot waited 15 min, threw, and the container restart-looped.
export function normModel(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return "";
  const last = n.slice(n.lastIndexOf("/") + 1);
  return last.includes(":") ? n : `${n}:latest`;
}
export function hasModel(list, model) {
  const want = normModel(model);
  return !!want && Array.isArray(list?.models) &&
    list.models.some(m => normModel(m?.name) === want || normModel(m?.model) === want);
}
