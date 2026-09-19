import { Router } from "express";
import { requireAuth } from "../auth/index.js";
import { interpret } from "../ai/interpret.js";
import { getDb } from "../db/conn.js";
import { nowISO } from "../lib/dates.js";
import { rateLimit } from "../lib/ratelimit.js";

export const assistantRouter = Router();

assistantRouter.use(requireAuth);
assistantRouter.post(
  "/message",
  rateLimit({ windowMs: 60_000, max: 40, keyPrefix: "assistant" }),
  async (req, res) => {
    const userId = (req as any).user.id;
    const text = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!text) {
      res.status(400).json({ error: "Message is required." });
      return;
    }
    if (text.length > 4000) {
      res.status(400).json({ error: "Message too long." });
      return;
    }

    const db = getDb();
    const user = db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string } | undefined;

    // Find or create conversation
    let conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId : "";
    if (conversationId) {
      const conv = db.prepare("SELECT id FROM conversations WHERE id = ? AND user_id = ?").get(conversationId, userId);
      if (!conv) conversationId = "";
    }
    if (!conversationId) {
      const latest = db.prepare("SELECT id FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1").get(userId) as { id: string } | undefined;
      conversationId = latest?.id || "";
    }
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      const ts = nowISO();
      db.prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(conversationId, userId, text.slice(0, 60), ts, ts);
    }

    const historyRows = db.prepare(
      "SELECT role, content FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 20"
    ).all(conversationId, userId) as { role: "user" | "assistant"; content: string }[];

    db.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)")
      .run(crypto.randomUUID(), conversationId, userId, text, nowISO());
    db.prepare("UPDATE conversations SET updated_at = ?, title = CASE WHEN title = 'Chat' THEN ? ELSE title END WHERE id = ?")
      .run(nowISO(), text.slice(0, 60), conversationId);

    try {
      const result = await interpret(userId, text, {
        userId,
        userName: user?.name,
        history: historyRows.slice(-8),
      });

      db.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?)")
        .run(crypto.randomUUID(), conversationId, userId, result.reply, JSON.stringify(result.toolCalls.slice(0, 5)), nowISO());

      res.json({
        reply: result.reply,
        intent: result.intent,
        mode: result.mode,
        toolCalls: result.toolCalls,
        conversationId,
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "Something went wrong." });
    }
  }
);

assistantRouter.get("/conversations", requireAuth, (req, res) => {
  const userId = (req as any).user.id;
  const rows = getDb().prepare(
    "SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20"
  ).all(userId);
  res.json({ conversations: rows });
});

assistantRouter.get("/conversations/:id/messages", requireAuth, (req, res) => {
  const userId = (req as any).user.id;
  const rows = getDb().prepare(
    "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 100"
  ).all(String(req.params.id), userId);
  res.json({ messages: rows });
});