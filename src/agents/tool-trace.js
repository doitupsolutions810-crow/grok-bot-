export function safeToolTraceText(value, cap = 1200) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    // Redact sensitive values in dotenv, YAML-like, JSON, and URL-query output.
    // Match sensitive key names even with prefixes/suffixes such as AWS_SECRET_ACCESS_KEY.
    .replace(
      /(["']?[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret|authorization|cookie|private[_ -]?key|credential|client[_-]?secret|session[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^"'\s,;&}]+)/gi,
      '$1"[REDACTED]"'
    )
    .slice(0, cap);
}

export function summarizeToolResult(result) {
  if (result && typeof result === "object") {
    const ok = typeof result.ok === "boolean" ? result.ok : !result.error;
    const output = [result.stdout, result.stderr, result.output]
      .filter(value => typeof value === "string" && value.length)
      .join("\n");
    return {
      ok,
      output_excerpt: safeToolTraceText(output, 1200),
      output_chars: output.length,
      error_excerpt: result.error ? safeToolTraceText(result.error, 500) : null
    };
  }
  if (typeof result === "string") {
    const failed = /^\s*ERROR:/i.test(result);
    return {
      ok: !failed,
      output_excerpt: failed ? safeToolTraceText(result, 500) : "",
      output_chars: result.length,
      error_excerpt: failed ? safeToolTraceText(result, 500) : null
    };
  }
  return { ok: true, output_excerpt: "", output_chars: 0, error_excerpt: null };
}
