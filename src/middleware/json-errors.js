// Last-resort error handler. Without it Express answers a thrown route error (or a
// malformed JSON body) with an HTML page carrying the stack trace and absolute file
// paths. API callers get JSON instead, and internals stay in the server log.
export function jsonErrors({ log = console.error } = {}) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) log(`[api] ${req.method} ${req.originalUrl}: ${err?.stack || err}`);
    if (res.headersSent) return res.end();
    const error = status === 400 && err?.type === "entity.parse.failed" ? "malformed JSON body"
      : status === 413 ? "request body too large"
      : status < 500 ? String(err?.expose ? err.message : "bad request")
      : "internal error";
    res.status(status).json({ error });
  };
}
