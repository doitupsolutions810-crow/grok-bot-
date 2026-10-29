// Ollama reports an untagged model with an implicit ":latest" tag, so a
// configured name like "nomic-embed-text" never matches the reported
// "nomic-embed-text:latest" without normalizing it first.
export function withTag(model) {
  const name = String(model).trim();
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  return colon > slash ? name : `${name}:latest`;
}

export function modelPresent(tags, model) {
  return !!tags?.models?.some(m => m.name === withTag(model));
}
