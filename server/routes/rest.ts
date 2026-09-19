import { Router } from "express";
import { requireAuth } from "../auth/index.js";
import {
  listProjects, createProject, createReminder, createFollowUp, completeFollowUp,
  getDailySummary, getWeeklySummary, getStats, recentActivity,
  listMemories, rememberFact, deleteMemory,
  getToday, getOverdue, getUrgent, getWaiting, getUpcoming, listTasks, getTaskById, completeTask,
} from "../actions/tools.js";
import { getDb } from "../db/conn.js";
import { getDefaultTimezone } from "../db/seed.js";
import {
  createGoal, listGoals, updateGoal, breakdownGoal, breakdownTask, addSubtasks, listSubtasks,
  completeSubtask, recordFeedback, getSuggestions, dismissSuggestion, snoozeSuggestion, listPrefs,
} from "../actions/friday.js";
import { nowISO, todayStart, DAY } from "../lib/dates.js";
import { config, isAiConfigured } from "../config.js";
import { hasVapidKeys } from "../notifications/push.js";

export const restRouter = Router();
restRouter.use(requireAuth);

const asUser = (req: any): string => req.user.id;

// ─── Projects ──────────────────────────────────────────────────────────────────

restRouter.get("/projects", (req, res) => {
  res.json({ projects: listProjects(asUser(req)) });
});

restRouter.post("/projects", (req, res) => {
  try {
    const p = createProject(asUser(req), String(req.body?.name ?? ""));
    res.status(201).json({ project: p });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to create project." });
  }
});

// ─── Reminders ─────────────────────────────────────────────────────────────────

restRouter.get("/reminders", (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT r.*, t.title AS task_title FROM reminders r LEFT JOIN tasks t ON t.id = r.task_id
     WHERE r.user_id = ? AND r.status = 'scheduled' ORDER BY r.remind_at`
  ).all(asUser(req));
  res.json({ reminders: rows });
});

restRouter.post("/reminders", (req, res) => {
  try {
    const b = req.body ?? {};
    const r = createReminder(asUser(req), {
      taskId: b.taskId,
      title: b.title,
      remindAt: b.remindAt,
      offsetBeforeDeadline: b.offsetBeforeDeadline,
      recurrence: b.recurrence,
    });
    res.status(201).json({ reminder: r });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to create reminder." });
  }
});

restRouter.delete("/reminders/:id", (req, res) => {
  getDb().prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").run(req.params.id, asUser(req));
  res.json({ ok: true });
});

// ─── Follow-ups ────────────────────────────────────────────────────────────────

restRouter.get("/followups", (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT f.*, t.title AS task_title FROM follow_ups f LEFT JOIN tasks t ON t.id = f.task_id
     WHERE f.user_id = ? AND f.status = 'pending' ORDER BY COALESCE(f.follow_up_at, '9999-12-31')`
  ).all(asUser(req));
  res.json({ followUps: rows });
});

restRouter.post("/followups", (req, res) => {
  try {
    const b = req.body ?? {};
    const f = createFollowUp(asUser(req), {
      taskId: b.taskId,
      entity: b.entity,
      reason: b.reason,
      at: b.at,
      repeatConfig: b.repeatConfig,
    });
    res.status(201).json({ followUp: f });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to create follow-up." });
  }
});

restRouter.post("/followups/:id/complete", (req, res) => {
  completeFollowUp(asUser(req), req.params.id);
  res.json({ ok: true });
});

// ─── Briefing & stats ──────────────────────────────────────────────────────────

// ─── Goals ──────────────────────────────────────────────────────────────

restRouter.get("/goals", (req, res) => {
  const status = String(req.query.status || "active");
  res.json({ goals: listGoals(asUser(req), status) });
});

restRouter.post("/goals", (req, res) => {
  try {
    const b = req.body ?? {};
    const g = createGoal(asUser(req), { title: b.title, description: b.description, horizon: b.horizon });
    res.status(201).json({ goal: g });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to create goal." });
  }
});

restRouter.put("/goals/:id", (req, res) => {
  try {
    const g = updateGoal(asUser(req), req.params.id, req.body ?? {});
    res.json({ goal: g });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to update goal." });
  }
});

restRouter.post("/goals/:id/breakdown", (req, res) => {
  try {
    const tasks = breakdownGoal(asUser(req), req.params.id);
    res.json({ tasks: tasks.map((t) => ({ id: t.id, title: t.title })) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to break down goal." });
  }
});

// ─── Subtasks ────────────────────────────────────────────────────────────────

restRouter.get("/tasks/:id/subtasks", (req, res) => {
  res.json({ subtasks: listSubtasks(asUser(req), req.params.id) });
});

restRouter.post("/tasks/:id/subtasks", (req, res) => {
  try {
    const subs = addSubtasks(asUser(req), req.params.id, (req.body?.titles as unknown[]) ?? []);
    res.status(201).json({ subtasks: subs });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to add subtasks." });
  }
});

restRouter.post("/tasks/:id/breakdown", (req, res) => {
  try {
    const subs = breakdownTask(asUser(req), req.params.id);
    res.json({ subtasks: subs });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to break down task." });
  }
});

restRouter.post("/subtasks/:id/complete", (req, res) => {
  try {
    const s = completeSubtask(asUser(req), req.params.id);
    res.json({ subtask: s });
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : "Subtask not found." });
  }
});

// ─── Feedback & suggestions ──────────────────────────────────────────────────

restRouter.post("/feedback", (req, res) => {
  try {
    const b = req.body ?? {};
    const r = recordFeedback(asUser(req), {
      category: b.category,
      comment: b.comment,
      targetType: b.targetType,
      targetId: b.targetId,
    });
    res.status(201).json(r);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to record feedback." });
  }
});

restRouter.get("/suggestions", (req, res) => {
  const tz = getDefaultTimezone(asUser(req));
  res.json({ suggestions: getSuggestions(asUser(req), Date.now(), tz) });
});

restRouter.post("/suggestions/:key/dismiss", (req, res) => {
  dismissSuggestion(asUser(req), req.params.key);
  res.json({ ok: true });
});

restRouter.post("/suggestions/:key/snooze", (req, res) => {
  const until = Date.now() + 24 * 60 * 60 * 1000;
  snoozeSuggestion(asUser(req), req.params.key, until);
  res.json({ ok: true, snoozedUntil: new Date(until).toISOString() });
});

restRouter.get("/prefs", (req, res) => {
  res.json({ prefs: listPrefs(asUser(req)) });
});

restRouter.get("/brief/daily", (req, res) => {
  res.json(getDailySummary(asUser(req)));
});

restRouter.get("/brief/evening", (req, res) => {
  const db = getDb();
  const tz = getDefaultTimezone(asUser(req));
  const start = todayStart(Date.now(), tz);
  const summary = getDailySummary(asUser(req));
  const completedToday = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND status = 'completed' AND completed_at >= ?").get(asUser(req), new Date(start).toISOString()) as { c: number }).c;
  const createdToday = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND created_at >= ?").get(asUser(req), new Date(start).toISOString()) as { c: number }).c;
  const tomorrow = getUpcoming(asUser(req), 2, Date.now());
  res.json({ ...summary, completedToday, createdToday, tomorrow });
});

restRouter.get("/stats", (req, res) => {
  res.json(getStats(asUser(req)));
});

restRouter.get("/stats/weekly", (req, res) => {
  res.json(getWeeklySummary(asUser(req)));
});

// ─── Activity ──────────────────────────────────────────────────────────────────

restRouter.get("/activity", (req, res) => {
  res.json({ activity: recentActivity(asUser(req)) });
});

// ─── Memories ──────────────────────────────────────────────────────────────────

restRouter.get("/memories", (req, res) => {
  res.json({ memories: listMemories(asUser(req)) });
});

restRouter.post("/memories", (req, res) => {
  try {
    const m = rememberFact(asUser(req), String(req.body?.content ?? ""), "manual");
    res.status(201).json({ memory: m });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to save memory." });
  }
});

restRouter.delete("/memories/:id", (req, res) => {
  deleteMemory(asUser(req), req.params.id);
  res.json({ ok: true });
});

// ─── Notifications ─────────────────────────────────────────────────────────────

restRouter.get("/notifications", (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT 50").all(asUser(req));
  res.json({ notifications: rows });
});

restRouter.post("/notifications/read", (req, res) => {
  getDb().prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0").run(asUser(req));
  res.json({ ok: true });
});

restRouter.get("/push/vapid-key", (req, res) => {
  res.json({ publicKey: hasVapidKeys() ? config.vapidPublicKey : null });
});

restRouter.post("/push/subscribe", (req, res) => {
  const b = req.body ?? {};
  if (typeof b.endpoint !== "string" || !b.endpoint.startsWith("https://")) {
    res.status(400).json({ error: "Invalid subscription." });
    return;
  }
  const db = getDb();
  const existing = db.prepare("SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").get(asUser(req), b.endpoint);
  if (!existing) {
    db.prepare("INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), asUser(req), b.endpoint, String(b.keys?.p256dh ?? ""), String(b.keys?.auth ?? ""), nowISO());
  }
  res.json({ ok: true });
});

restRouter.post("/push/unsubscribe", (req, res) => {
  getDb().prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(asUser(req), String(req.body?.endpoint ?? ""));
  res.json({ ok: true });
});

// ─── Settings ──────────────────────────────────────────────────────────────────

restRouter.get("/settings", (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM settings WHERE user_id = ?").get(asUser(req)) ?? {};
  const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(asUser(req));
  res.json({ settings: row, user });
});

restRouter.put("/settings", (req, res) => {
  const b = req.body ?? {};
  const db = getDb();
  const allowed = ["timezone", "language", "voice_provider", "brief_time", "evening_review_time", "notify_browser", "auto_remind"];
  const fields: string[] = [];
  const values: (string | number)[] = [];
  for (const key of allowed) {
    if (b[key] !== undefined) {
      fields.push(`${key} = ?`);
      const v = b[key];
      values.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
  }
  if (b.name !== undefined) {
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(String(b.name).slice(0, 100), asUser(req));
  }
  if (fields.length) {
    db.prepare(`UPDATE settings SET ${fields.join(", ")}, updated_at = ? WHERE user_id = ?`).run(...values, nowISO(), asUser(req));
  }
  const row = db.prepare("SELECT * FROM settings WHERE user_id = ?").get(asUser(req));
  res.json({ settings: row });
});

// ─── Dashboard aggregates ───────────────────────────────────────────────────────

restRouter.get("/dashboard", (req, res) => {
  const userId = asUser(req);
  res.json({
    stats: getStats(userId),
    today: getToday(userId),
    urgent: getUrgent(userId),
    overdue: getOverdue(userId),
    waiting: getWaiting(userId),
    upcoming: getUpcoming(userId, 7),
    projects: listProjects(userId),
    activity: recentActivity(userId, 10),
  });
});

restRouter.get("/calendar", (req, res) => {
  const userId = asUser(req);
  const tz = getDefaultTimezone(userId);
  const now = Date.now();
  const start = todayStart(now, tz) - 2 * DAY;
  const end = start + 35 * DAY;
  const tasks = listTasks(userId, { status: "active" }, now)
    .filter((t) => t.deadline_at && new Date(t.deadline_at).getTime() >= start && new Date(t.deadline_at).getTime() < end);
  res.json({ tasks, start: new Date(start).toISOString(), end: new Date(end).toISOString(), timezone: tz });
});

// ─── Config (client bootstrap) ─────────────────────────────────────────────────

restRouter.get("/config", (req, res) => {
  res.json({
    timezone: getDefaultTimezone(asUser(req)),
    aiConfigured: isAiConfigured(),
    voiceProvider: config.voiceProvider,
    pushSupported: hasVapidKeys(),
  });
});