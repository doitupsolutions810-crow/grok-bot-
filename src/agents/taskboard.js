// Task board — run-scoped kanban for orchestrated squads (Avrone task_board.py).
// Cards live in memory scoped to a runId (ctx.run.runId), so parallel squads
// never see each other's boards. Workers claim cards by owner and move them done.

const boards = new Map();   // runId -> [{ id, title, owner, status, created }]
const MAX_BOARDS = 500, MAX_CARDS = 200;   // bounded: old runs' boards are evicted first

export function taskBoardTool() {
  return {
    name: "task.board",
    description: "Shared task board for the current run. Actions: add, list, update, done. " +
      "Add a card per subtask before starting work; claim a card with update (owner); mark it done when finished.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "update", "done"] },
        title: { type: "string", description: "Card title (action: add)" },
        id: { type: "string", description: "Card id (actions: update, done)" },
        owner: { type: "string", description: "Claiming worker id (action: update)" },
        note: { type: "string", description: "Optional progress note (action: update)" }
      },
      required: ["action"]
    },
    async run({ action, title, id, owner, note } = {}, ctx) {
      const runId = ctx?.run?.runId;
      if (!runId) return { error: "no active run — task board is run-scoped" };
      if (!["add", "list", "update", "done"].includes(action)) return { error: `unknown action ${action}` };
      let board = boards.get(runId);
      if (!board) {
        board = [];
        boards.set(runId, board);
        if (boards.size > MAX_BOARDS) boards.delete(boards.keys().next().value);
      }

      if (action === "add") {
        const t = (typeof title === "string" ? title : "").replace(/\s+/g, " ").trim().slice(0, 300);
        if (!t) return { error: "title required" };
        if (board.length >= MAX_CARDS) return { error: `board full (${MAX_CARDS} cards)` };
        const dupe = board.find(c => c.title.toLowerCase() === t.toLowerCase());
        if (dupe) return { dedupe: true, card: dupe };
        const card = { id: `t${board.length + 1}`, title: t, owner: null, status: "todo", note: "", created: new Date().toISOString() };
        board.push(card);
        return { card, dedupe: false };
      }

      if (action === "list") return { cards: board };

      const card = board.find(c => c.id === id);
      if (!card) return { error: `no card ${id}` };

      if (action === "update") {
        if (owner) {
          card.owner = String(owner).slice(0, 64);
          if (card.status === "todo") card.status = "in_progress";
        }
        if (note !== undefined) card.note = String(note).slice(0, 2000);
        return { card };
      }

      if (action === "done") {
        card.status = "done";
        return { card };
      }

      return { error: `unknown action ${action}` };
    }
  };
}
