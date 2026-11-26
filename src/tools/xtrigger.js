// X triggers — @bot mentions become tasks. A poller (webhook variant: POST /api/x/trigger)
// picks up mentions and hands them to the chief of staff, who dispatches the right
// teammate. Every mention is processed exactly once.

const seen = new Set();

export function stripMention(text, me) {
  const esc = String(me).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text).replace(new RegExp(`@${esc}\\b`, "gi"), "").replace(/\s+/g, " ").trim();
}

export function startXTrigger(onTask) {
  const poll = async () => {
    const token = process.env.X_API_BEARER;
    if (!token) return;
    const me = process.env.X_ACCOUNT || "grok_bot";
    try {
      const r = await fetch(`https://api.x.com/2/tweets/search/recent?query=@${me}&max_results=10`, {
        headers: { authorization: `Bearer ${token}` }
      }).then(r => r.json());
      for (const t of (r.data || [])) {
        const key = `x:${t.id}`;
        if (seen.has(key) || typeof t?.text !== "string") continue;
        seen.add(key);
        if (seen.size > 5000) seen.delete(seen.values().next().value);   // bounded memory, oldest first
        const text = stripMention(t.text, me);
        if (text) onTask(text);   // chief-of-staff picks it up as a task
      }
    } catch (e) {
      console.warn(`[x-trigger] poll failed: ${e.message}`);
    }
  };
  const every = Math.max(15, Number(process.env.X_POLL_SECONDS) || 60) * 1000;
  setInterval(poll, every);   // every minute by default
}
