// Shared model-chain policy used by both inference and boot provisioning.
// A model advertised as a fallback must be pulled before the readiness gate.
const DEFAULT_FALLBACKS = ["llama3.2:3b", "llama3.2:1b"];

function splitModels(value) {
  return String(value || "").split(",").map(model => model.trim()).filter(Boolean);
}

function unique(models) {
  return [...new Set(models.filter(Boolean))];
}

export function resolveModelChain(env = process.env) {
  const configured = splitModels(env.MODEL_CHAIN);
  const primary = String(env.LLM_MODEL || "llama3.1:8b").trim();
  return unique(configured.length ? configured : [primary, ...DEFAULT_FALLBACKS]);
}

export function resolveRequiredModels(env = process.env) {
  const configuredRequired = splitModels(env.MODELS_REQUIRED);
  const baseRequired = configuredRequired.length
    ? configuredRequired
    : [String(env.LLM_MODEL || "llama3.1:8b").trim(), "nomic-embed-text"];
  const vision = String(env.ENABLE_VISION || "").toLowerCase() === "true" ? ["llava:7b"] : [];
  return unique([...baseRequired, String(env.LLM_MODEL || "").trim(), ...resolveModelChain(env), ...vision]);
}
