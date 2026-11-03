export function toolSucceeded(name, result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (name === "terminal") return result.ok === true && result.exitCode === 0 && !result.error;
  if (name === "web.fetch") return Number.isInteger(result.status) && result.status >= 200 && result.status < 300 && typeof result.content === "string" && !result.error;
  if (name === "browser") return typeof result.url === "string" && typeof result.content === "string" && !result.error;
  return result.isError !== true && result.ok !== false && !result.error && (result.ok === true || Array.isArray(result.content));
}
