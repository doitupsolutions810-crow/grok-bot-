// X triggers — @bot mentions become tasks. A poller (webhook variant: POST /api/x/trigger)
// picks up mentions and hands them to the chief of staff, who dispatches the right
// teammate. Every mention is processed exactly once.

const seen = new Set();

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
        if (seen.has(key)) continue;
        seen.add(key);
        onTask(t.text.replace(`@${me}`, "").trim());   // chief-of-staff picks it up as a task
      }
    } catch (e) {
      console.warn(`[x-trigger] poll failed: ${e.message}`);
    }
  };
  const every = Math.max(15, Number(process.env.X_POLL_SECONDS) || 60) * 1000;
  setInterval(poll, every);   // every minute by default
}
