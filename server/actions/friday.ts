/**
 * Friday's extended tools: goals, subtask breakdown, the feedback loop, and the
 * learned-preference store. Every mutation is validated. The assistant never
 * touches these tables directly — only through this module.
 */

import { getDb } from "../db/conn.js";
import { nowISO, DAY, zonedParts, ymd, todayEnd } from "../lib/dates.js";
import {
  toolError,
  getTaskById,
  listTasks,
  createTask,
  getEffectiveStatus,
  type TaskRow,
} from "./tools.js";
import { priorityRank, type Priority } from "../lib/priority.js";

// ─── small validation helpers (mirrors tools.ts) ──────────────────────────────

function str(v: unknown, field: string, maxLen = 500): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw toolError("invalid_input", `${field} must be a string`);
  const s = v.trim();
  if (s.length > maxLen) throw toolError("invalid_input", `${field} is too long (max ${maxLen})`);
  return s;
}

function requiredStr(v: unknown, field: string, maxLen = 500): string {
  const s = str(v, field, maxLen);
  if (!s) throw toolError("invalid_input", `${field} is required`);
  return s;
}

const HORIZONS = ["week", "month", "quarter", "year", "life"] as const;
type Horizon = (typeof HORIZONS)[number];

function validateHorizon(v: unknown): Horizon {
  if (typeof v === "string" && (HORIZONS as readonly string[]).includes(v)) return v as Horizon;
  throw toolError("invalid_input", `Horizon must be one of ${HORIZONS.join(", ")}`);
}

// ─── Learned preferences ──────────────────────────────────────────────────────

export type PrefValue = string | number | boolean;

export function getPref(userId: string, key: string): PrefValue | null {
  const row = getDb()
    .prepare("SELECT value FROM learned_prefs WHERE user_id = ? AND key = ?")
    .get(userId, key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as PrefValue;
  } catch {
    return row.value;
  }
}

export function setPref(userId: string, key: string, value: PrefValue, evidenceDelta = 1): void {
  if (!/^[a-z0-9_.:-]{1,80}$/.test(key)) throw toolError("invalid_input", "Invalid preference key");
  const db = getDb();
  const existing = db
    .prepare("SELECT evidence FROM learned_prefs WHERE user_id = ? AND key = ?")
    .get(userId, key) as { evidence: number } | undefined;
  if (existing) {
    db.prepare("UPDATE learned_prefs SET value = ?, evidence = evidence + ?, updated_at = ? WHERE user_id = ? AND key = ?")
      .run(JSON.stringify(value), evidenceDelta, nowISO(), userId, key);
  } else {
    db.prepare("INSERT INTO learned_prefs (user_id, key, value, evidence, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, key, JSON.stringify(value), Math.max(evidenceDelta, 1), nowISO());
  }
}

export function listPrefs(userId: string, minEvidence = 1): { key: string; value: PrefValue; evidence: number }[] {
  const rows = getDb()
    .prepare("SELECT key, value, evidence FROM learned_prefs WHERE user_id = ? AND evidence >= ? ORDER BY evidence DESC")
    .all(userId, minEvidence) as { key: string; value: string; evidence: number }[];
  return rows.map((r) => {
    let v: PrefValue = r.value;
    try {
      v = JSON.parse(r.value) as PrefValue;
    } catch {
      /* keep raw */
    }
    return { key: r.key, value: v, evidence: r.evidence };
  });
}

/** Bump a numeric pref (e.g. reminder_feedback counts) or create it. */
export function bumpPref(userId: string, key: string, delta: number, evidenceDelta = 1): number {
  const cur = getPref(userId, key);
  const next = (typeof cur === "number" ? cur : 0) + delta;
  setPref(userId, key, next, evidenceDelta);
  return next;
}

// ─── Goals ────────────────────────────────────────────────────────────────────

export interface GoalRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  horizon: string;
  status: string;
  created_at: string;
  updated_at: string;
  open_tasks?: number;
  total_tasks?: number;
}

export function createGoal(
  userId: string,
  input: { title: unknown; description?: unknown; horizon?: unknown }
): GoalRow {
  const title = requiredStr(input.title, "title", 200);
  const description = str(input.description, "description", 2000);
  const horizon = input.horizon === undefined || input.horizon === null || input.horizon === ""
    ? "quarter"
    : validateHorizon(input.horizon);
  const id = crypto.randomUUID();
  const ts = nowISO();
  getDb()
    .prepare("INSERT INTO goals (id, user_id, title, description, horizon, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)")
    .run(id, userId, title, description, horizon, ts, ts);
  return getGoal(userId, id);
}

export function getGoal(userId: string, id: string): GoalRow {
  const row = getDb().prepare("SELECT * FROM goals WHERE id = ? AND user_id = ?").get(id, userId) as GoalRow | undefined;
  if (!row) throw toolError("not_found", "Goal not found.");
  const counts = getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN t.status IN ('inbox','planned','today','in_progress','waiting','overdue') THEN 1 ELSE 0 END) AS open
       FROM goal_tasks gt JOIN tasks t ON t.id = gt.task_id WHERE gt.goal_id = ?`
    )
    .get(id) as { total: number; open: number | null };
  return { ...row, total_tasks: counts.total, open_tasks: counts.open ?? 0 };
}

export function listGoals(userId: string, status = "active"): GoalRow[] {
  const rows = getDb()
    .prepare(
      `SELECT g.*, COUNT(t.id) AS total_tasks,
              SUM(CASE WHEN t.status IN ('inbox','planned','today','in_progress','waiting','overdue') THEN 1 ELSE 0 END) AS open_tasks
       FROM goals g
       LEFT JOIN goal_tasks gt ON gt.goal_id = g.id
       LEFT JOIN tasks t ON t.id = gt.task_id
       WHERE g.user_id = ? AND g.status = ?
       GROUP BY g.id ORDER BY g.created_at ASC`
    )
    .all(userId, status) as unknown as GoalRow[];
  return rows;
}

export function updateGoal(
  userId: string,
  id: string,
  input: { title?: unknown; description?: unknown; horizon?: unknown; status?: unknown }
): GoalRow {
  const existing = getGoal(userId, id);
  const title = input.title !== undefined ? requiredStr(input.title, "title", 200) : existing.title;
  const description = input.description !== undefined ? str(input.description, "description", 2000) : existing.description;
  const horizon = input.horizon !== undefined && input.horizon !== "" ? validateHorizon(input.horizon) : existing.horizon;
  const status = input.status !== undefined ? str(input.status, "status", 20) : existing.status;
  if (!["active", "paused", "achieved", "dropped"].includes(status)) {
    throw toolError("invalid_input", "Invalid goal status.");
  }
  getDb()
    .prepare("UPDATE goals SET title = ?, description = ?, horizon = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(title, description, horizon, status, nowISO(), id, userId);
  return getGoal(userId, id);
}

export function linkTaskToGoal(userId: string, goalId: string, taskId: string): void {
  // both must belong to the user
  getGoal(userId, goalId);
  getTaskById(userId, taskId);
  getDb()
    .prepare("INSERT OR IGNORE INTO goal_tasks (goal_id, task_id, created_at) VALUES (?, ?, ?)")
    .run(goalId, taskId, nowISO());
}

export function unlinkTaskFromGoal(userId: string, goalId: string, taskId: string): void {
  getDb().prepare("DELETE FROM goal_tasks WHERE goal_id = ? AND task_id = ?").run(goalId, taskId);
}

/**
 * Break a goal into concrete starter tasks, linked to the goal.
 * Deterministic, generic milestones — honest about being a starting point.
 */
export function breakdownGoal(userId: string, goalId: string): TaskRow[] {
  const goal = getGoal(userId, goalId);
  const existing = getDb()
    .prepare("SELECT COUNT(*) AS c FROM goal_tasks WHERE goal_id = ?").get(goalId) as { c: number };
  if (existing.c > 0) {
    const linked = getDb()
      .prepare(
        `SELECT t.* FROM goal_tasks gt JOIN tasks t ON t.id = gt.task_id
         WHERE gt.goal_id = ? ORDER BY t.created_at`
      )
      .all(goalId) as unknown as TaskRow[];
    return linked;
  }
  const steps = [
    `Define what done looks like: ${goal.title}`,
    `First concrete step: ${goal.title}`,
    `Review progress: ${goal.title}`,
  ];
  const created: TaskRow[] = [];
  for (const s of steps) {
    const t = createTask(userId, { title: s.slice(0, 200), priority: "MEDIUM", taskType: "goal-step" });
    linkTaskToGoal(userId, goalId, t.id);
    created.push(t);
  }
  return created;
}

// ─── Subtasks (breaking big things into smaller actions) ──────────────────────

export interface SubtaskRow {
  id: string;
  task_id: string;
  title: string;
  status: "pending" | "done";
  position: number;
}

export function addSubtasks(userId: string, taskId: string, titles: unknown[]): SubtaskRow[] {
  getTaskById(userId, taskId);
  const clean = (Array.isArray(titles) ? titles : [])
    .map((t) => str(t, "subtask", 300))
    .filter(Boolean)
    .slice(0, 20);
  if (clean.length === 0) throw toolError("invalid_input", "At least one subtask title is required.");
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) AS c FROM subtasks WHERE task_id = ?").get(taskId) as { c: number };
  const ts = nowISO();
  const out: SubtaskRow[] = [];
  clean.forEach((title, i) => {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO subtasks (id, user_id, task_id, title, status, position, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, userId, taskId, title, existing.c + i, ts);
    out.push({ id, task_id: taskId, title, status: "pending", position: existing.c + i });
  });
  return out;
}

export function listSubtasks(userId: string, taskId: string): SubtaskRow[] {
  return getDb()
    .prepare("SELECT id, task_id, title, status, position FROM subtasks WHERE user_id = ? AND task_id = ? ORDER BY position")
    .all(userId, taskId) as unknown as SubtaskRow[];
}

export function completeSubtask(userId: string, subtaskId: string): SubtaskRow {
  const row = getDb().prepare("SELECT * FROM subtasks WHERE id = ? AND user_id = ?").get(subtaskId, userId) as
    | (SubtaskRow & { user_id: string })
    | undefined;
  if (!row) throw toolError("not_found", "Subtask not found.");
  getDb().prepare("UPDATE subtasks SET status = 'done', completed_at = ? WHERE id = ?").run(nowISO(), subtaskId);
  return { id: row.id, task_id: row.task_id, title: row.title, status: "done", position: row.position };
}

/**
 * Break a task into concrete subtasks. Deterministic templates per task type,
 * falling back to generic preparation/action/verification steps. Returns the
 * created subtasks so the caller can report exactly what was made.
 */
export function breakdownTask(userId: string, taskId: string): SubtaskRow[] {
  const task = getTaskById(userId, taskId);
  const existing = listSubtasks(userId, taskId);
  if (existing.length > 0) return existing;

  const t = `${task.title} ${task.description}`.toLowerCase();
  let steps: string[];
  if (/slide|deck|presentation|ppt/.test(t)) {
    steps = ["Outline the key points", "Draft the slides", "Add examples/data", "Rehearse once"];
  } else if (/pitch|demo|ai employee/.test(t)) {
    steps = ["Define the audience and the ask", "Prepare the pitch material", "Schedule the conversation", "Send follow-up"];
  } else if (/roadmap|plan|strategy/.test(t)) {
    steps = ["List the milestones", "Assign owners/timeline", "Review with stakeholders", "Publish the final version"];
  } else if (/lecture|teach|session|training/.test(t)) {
    steps = ["Finalize the topic and flow", "Prepare materials/links", "Set up logistics (venue/links)", "Confirm with attendees"];
  } else if (/report|document|write|doc/.test(t)) {
    steps = ["Collect the source material", "Write the first draft", "Review and edit", "Share with the right person"];
  } else if (/outreach|email|call|follow/.test(t)) {
    steps = ["Draft the message", "Send it", "Log the response", "Set the next follow-up"];
  } else if (/intern|student|hiring/.test(t)) {
    steps = ["Define the requirement/role", "Reach out to candidates or team", "Shortlist and schedule chats", "Confirm the selection"];
  } else {
    steps = ["Clarify exactly what done looks like", "Do the first concrete step", "Finish and verify"];
  }
  return addSubtasks(userId, taskId, steps);
}

// ─── Feedback loop ────────────────────────────────────────────────────────────

export type FeedbackCategory =
  | "reminder_too_early"
  | "reminder_too_late"
  | "dont_suggest"
  | "preferred_time"
  | "not_important"
  | "make_smaller"
  | "good"
  | "other";

export interface FeedbackInput {
  category: FeedbackCategory;
  targetType?: string;
  targetId?: string;
  comment?: string;
}

const CATEGORY_SET: FeedbackCategory[] = [
  "reminder_too_early", "reminder_too_late", "dont_suggest", "preferred_time",
  "not_important", "make_smaller", "good", "other",
];

export function validateCategory(v: unknown): FeedbackCategory {
  if (typeof v === "string" && (CATEGORY_SET as string[]).includes(v)) return v as FeedbackCategory;
  throw toolError("invalid_input", `Feedback category must be one of ${CATEGORY_SET.join(", ")}`);
}

export function recordFeedback(userId: string, input: FeedbackInput): { id: string; applied: string[] } {
  const category = validateCategory(input.category);
  const targetType = str(input.targetType || "general", "targetType", 40);
  const targetId = str(input.targetId || "", "targetId", 100) || null;
  const comment = str(input.comment || "", "comment", 1000);
  const id = crypto.randomUUID();
  getDb()
    .prepare("INSERT INTO feedback (id, user_id, target_type, target_id, category, comment, applied, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
    .run(id, userId, targetType, targetId, category, comment, nowISO());

  const applied = applyFeedback(userId, category, targetType, targetId, comment);
  getDb().prepare("UPDATE feedback SET applied = 1 WHERE id = ?").run(id);
  return { id, applied };
}

/**
 * Translate a piece of feedback into concrete preference updates.
 * Returns human-readable descriptions of what changed.
 */
export function applyFeedback(
  userId: string,
  category: FeedbackCategory,
  targetType: string,
  targetId: string | null,
  comment: string
): string[] {
  const applied: string[] = [];
  const db = getDb();

  const applyReminderOffset = (deltaMinutes: number, label: string) => {
    if (targetType === "reminder" && targetId) {
      const row = db.prepare("SELECT remind_at, task_id FROM reminders WHERE id = ? AND user_id = ?").get(targetId, userId) as
        | { remind_at: string; task_id: string | null }
        | undefined;
      if (row) {
        const newAt = new Date(new Date(row.remind_at).getTime() + deltaMinutes * 60_000).toISOString();
        db.prepare("UPDATE reminders SET remind_at = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(newAt, nowISO(), targetId, userId);
        applied.push(`Moved that reminder ${label}.`);
        bumpPref(userId, "reminder_offset_bias_minutes", deltaMinutes);
        return;
      }
    }
    bumpPref(userId, "reminder_offset_bias_minutes", deltaMinutes);
    applied.push(`Future reminders will fire ${label}.`);
  };

  switch (category) {
    case "reminder_too_early":
      applyReminderOffset(+30, "30 minutes later");
      break;
    case "reminder_too_late":
      applyReminderOffset(-30, "30 minutes earlier");
      break;
    case "preferred_time": {
      const hour = parsePreferredHour(comment);
      if (hour !== null) {
        setPref(userId, "preferred_work_hour", hour, 2);
        applied.push(`Got it — you prefer working around ${hour}:00. I'll schedule accordingly.`);
      } else {
        applied.push("Tell me a time (e.g. 'I prefer doing this at night' or 'mornings') and I'll remember it.");
      }
      break;
    }
    case "dont_suggest": {
      if (targetType === "suggestion" && targetId) {
        dismissSuggestion(userId, targetId);
        applied.push("That suggestion won't come back.");
      } else if (targetType === "task" && targetId) {
        setPref(userId, `mute_suggestions:${targetId}`, true);
        applied.push("I'll stop suggesting around that task.");
      } else {
        bumpPref(userId, "suggestion_mute_score", 1, 2);
        applied.push("I'll hold back on suggestions for a while.");
      }
      break;
    }
    case "not_important": {
      if (targetType === "task" && targetId) {
        db.prepare("UPDATE tasks SET priority = 'LOW', updated_at = ? WHERE id = ? AND user_id = ?").run(nowISO(), targetId, userId);
        applied.push("Marked it low priority.");
      } else {
        bumpPref(userId, "aggressiveness_bias", -1, 2);
        applied.push("I'll be less pushy with priorities.");
      }
      break;
    }
    case "make_smaller": {
      if (targetType === "task" && targetId) {
        const subs = breakdownTask(userId, targetId);
        applied.push(`Broke it into ${subs.length} smaller steps.`);
      } else {
        applied.push("Tell me which task to break down and I'll split it into steps.");
      }
      break;
    }
    case "good":
      bumpPref(userId, "suggestion_good_score", 1, 2);
      applied.push("Noted — I'll keep doing more of that.");
      break;
    case "other":
      if (comment) {
        getDb()
          .prepare("INSERT INTO memories (id, user_id, kind, content, source, created_at, last_seen_at) VALUES (?, ?, 'preference', ?, 'feedback', ?, ?)")
          .run(crypto.randomUUID(), userId, comment, nowISO(), nowISO());
        applied.push("Remembered that.");
      }
      break;
  }
  return applied;
}

function parsePreferredHour(comment: string): number | null {
  const c = comment.toLowerCase();
  const explicit = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/.exec(c);
  if (explicit) {
    let h = Number(explicit[1]) % 12;
    if (explicit[3] === "pm") h += 12;
    return h;
  }
  const h24 = /\bat\s+(\d{1,2})\b/.exec(c);
  if (h24) return Number(h24[1]) % 24;
  if (/night|late evening/.test(c)) return 21;
  if (/evening/.test(c)) return 19;
  if (/afternoon/.test(c)) return 15;
  if (/morning/.test(c)) return 9;
  if (/noon|lunch/.test(c)) return 13;
  return null;
}

// ─── Suggestion state ─────────────────────────────────────────────────────────

export function dismissSuggestion(userId: string, suggestionKey: string): void {
  getDb()
    .prepare(
      `INSERT INTO suggestion_state (id, user_id, suggestion_key, dismissed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, suggestion_key) DO UPDATE SET dismissed_at = excluded.dismissed_at`
    )
    .run(crypto.randomUUID(), userId, suggestionKey, nowISO());
}

export function snoozeSuggestion(userId: string, suggestionKey: string, untilMs: number): void {
  getDb()
    .prepare(
      `INSERT INTO suggestion_state (id, user_id, suggestion_key, snoozed_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, suggestion_key) DO UPDATE SET snoozed_until = excluded.snoozed_until`
    )
    .run(crypto.randomUUID(), userId, suggestionKey, new Date(untilMs).toISOString());
}

export function markSuggestionShown(userId: string, suggestionKey: string): void {
  getDb()
    .prepare(
      `INSERT INTO suggestion_state (id, user_id, suggestion_key, shown_count, last_shown_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(user_id, suggestion_key) DO UPDATE SET shown_count = shown_count + 1, last_shown_at = excluded.last_shown_at`
    )
    .run(crypto.randomUUID(), userId, suggestionKey, nowISO());
}

function isSuggestionBlocked(userId: string, key: string, now: number): boolean {
  const row = getDb()
    .prepare("SELECT dismissed_at, snoozed_until FROM suggestion_state WHERE user_id = ? AND suggestion_key = ?")
    .get(userId, key) as { dismissed_at: string | null; snoozed_until: string | null } | undefined;
  if (!row) return false;
  if (row.dismissed_at) return true;
  if (row.snoozed_until && new Date(row.snoozed_until).getTime() > now) return true;
  return false;
}

// ─── Proactive suggestion engine ──────────────────────────────────────────────

export interface Suggestion {
  key: string;
  kind: "neglected_task" | "upcoming_deadline" | "follow_up_due" | "goal_stale" | "evening_planning" | "overdue_cleanup";
  title: string;
  detail: string;
  action?: { type: string; taskId?: string; goalId?: string };
  severity: "info" | "nudge" | "urgent";
}

/**
 * Generate at most a handful of high-signal suggestions based on real data:
 * neglected work, deadlines about to hit, follow-ups due, stale goals.
 * Respects dismissed/snoozed state and learned mute signals.
 */
export function getSuggestions(userId: string, now = Date.now(), tz = "Asia/Kolkata"): Suggestion[] {
  const out: Suggestion[] = [];
  const muteScore = (getPref(userId, "suggestion_mute_score") as number) ?? 0;
  const goodScore = (getPref(userId, "suggestion_good_score") as number) ?? 0;
  // learned pushiness: default 1.0, feedback nudges it down/up
  const pushiness = Math.max(0.25, Math.min(1.5, 1 + 0.12 * (goodScore - muteScore)));
  const maxSuggestions = Math.max(1, Math.round(4 * pushiness));

  const p = zonedParts(now, tz);
  const hourNow = p.hour;
  const endOfToday = todayEnd(now, tz);

  // 1. Overdue cleanup — oldest overdue items
  const overdue = listTasks(userId, { status: "active" }, now)
    .filter((t) => getEffectiveStatus(t, now) === "overdue")
    .sort((a, b) => new Date(a.deadline_at ?? a.created_at).getTime() - new Date(b.deadline_at ?? b.created_at).getTime());
  for (const t of overdue.slice(0, 2)) {
    const key = `overdue:${t.id}`;
    if (isSuggestionBlocked(userId, key, now)) continue;
    if (getPref(userId, `mute_suggestions:${t.id}`)) continue;
    out.push({
      key,
      kind: "overdue_cleanup",
      title: `"${t.title}" is overdue`,
      detail: "Reschedule it, do it now, or drop it — but don't let it rot.",
      action: { type: "reschedule_or_complete", taskId: t.id },
      severity: "urgent",
    });
  }

  // 2. Deadlines within 48h without a reminder
  const upcoming = listTasks(userId, { status: "active" }, now)
    .filter((t) => t.deadline_at && new Date(t.deadline_at).getTime() > now && new Date(t.deadline_at).getTime() < now + 2 * DAY);
  for (const t of upcoming) {
    const hasReminder = getDb()
      .prepare("SELECT 1 FROM reminders WHERE task_id = ? AND status = 'scheduled' LIMIT 1")
      .get(t.id);
    if (!hasReminder) {
      const key = `no_reminder:${t.id}`;
      if (!isSuggestionBlocked(userId, key, now)) {
        out.push({
          key,
          kind: "upcoming_deadline",
          title: `No reminder set for "${t.title}"`,
          detail: "It's due soon — want me to remind you beforehand?",
          action: { type: "create_reminder", taskId: t.id },
          severity: "nudge",
        });
      }
    }
  }

  // 3. Follow-ups due
  const followUps = getDb()
    .prepare(
      `SELECT f.id, f.entity, f.reason, f.follow_up_at, t.id AS task_id, t.title AS task_title
       FROM follow_ups f LEFT JOIN tasks t ON t.id = f.task_id
       WHERE f.user_id = ? AND f.status = 'pending' AND f.follow_up_at IS NOT NULL AND f.follow_up_at <= ?`
    )
    .all(userId, new Date(now).toISOString()) as { id: string; entity: string; reason: string; follow_up_at: string; task_id: string | null; task_title: string | null }[];
  for (const f of followUps.slice(0, 2)) {
    const key = `followup:${f.id}`;
    if (isSuggestionBlocked(userId, key, now)) continue;
    out.push({
      key,
      kind: "follow_up_due",
      title: `Time to follow up with ${f.entity || "them"}`,
      detail: f.task_title ? `About: ${f.task_title}` : f.reason || "",
      action: f.task_id ? { type: "open_task", taskId: f.task_id } : undefined,
      severity: "nudge",
    });
  }

  // 4. Neglected tasks — created >4 days ago, still inbox, never touched
  const neglected = listTasks(userId, { status: "active" }, now)
    .filter((t) => t.status === "inbox" && now - new Date(t.created_at).getTime() > 4 * DAY)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  for (const t of neglected.slice(0, 2)) {
    const key = `neglected:${t.id}`;
    if (isSuggestionBlocked(userId, key, now)) continue;
    if (getPref(userId, `mute_suggestions:${t.id}`)) continue;
    out.push({
      key,
      kind: "neglected_task",
      title: `"${t.title}" has been sitting in your inbox for ${Math.floor((now - new Date(t.created_at).getTime()) / DAY)} days`,
      detail: "Schedule it or let it go.",
      action: { type: "plan_task", taskId: t.id },
      severity: "info",
    });
  }

  // 5. Stale goals — active goals with no open tasks
  const goals = listGoals(userId, "active");
  for (const g of goals) {
    if ((g.total_tasks ?? 0) === 0) {
      const key = `goal_stale:${g.id}`;
      if (!isSuggestionBlocked(userId, key, now)) {
        out.push({
          key,
          kind: "goal_stale",
          title: `Goal "${g.title}" has no active tasks`,
          detail: "Break it into concrete actions so it actually moves.",
          action: { type: "breakdown_goal", goalId: g.id },
        // goal suggestions carry goalId for the client's breakdown action
          severity: "nudge",
        });
      }
    }
  }

  // 6. Evening planning — one nudge per evening
  if (hourNow >= 18 && hourNow <= 23) {
    const today = ymd(now, tz);
    const key = `evening_planning:${today}`;
    if (!isSuggestionBlocked(userId, key, now)) {
      const openCount = listTasks(userId, { status: "active" }, now).length;
      out.push({
        key,
        kind: "evening_planning",
        title: "Evening review time",
        detail: `${openCount} open items. Want to plan tomorrow for 5 minutes?`,
        action: { type: "evening_review" },
        severity: "info",
      });
    }
  }

  const severityOrder: Record<Suggestion["severity"], number> = { urgent: 0, nudge: 1, info: 2 };
  out.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  const picked = out.slice(0, maxSuggestions);
  for (const s of picked) markSuggestionShown(userId, s.key);
  return picked;
}

// ─── Pattern learning ─────────────────────────────────────────────────────────

/**
 * Learn working patterns from history: completion hour distribution and the
 * preferred work window. Cheap, structured, no vectors.
 */
export function learnPatterns(userId: string, now = Date.now(), tz = "Asia/Kolkata"): void {
  const since = new Date(now - 30 * DAY).toISOString();
  const rows = getDb()
    .prepare("SELECT completed_at FROM tasks WHERE user_id = ? AND status = 'completed' AND completed_at >= ?")
    .all(userId, since) as { completed_at: string }[];
  if (rows.length < 3) return;
  const hours: number[] = rows.map((r) => zonedParts(new Date(r.completed_at).getTime(), tz).hour);
  const avg = Math.round(hours.reduce((a, b) => a + b, 0) / hours.length);
  setPref(userId, "avg_completion_hour", avg, 1);
}

/** One-line description of learned prefs, for prompts and UI. */
export function prefsSummary(userId: string): string {
  const prefs = listPrefs(userId, 2);
  if (prefs.length === 0) return "";
  return prefs
    .slice(0, 8)
    .map((p) => `${p.key.replace(/_/g, " ")}: ${String(p.value)} (seen ${p.evidence}×)`)
    .join("; ");
}

// ─── Focus with goals ─────────────────────────────────────────────────────────

export interface FocusItem {
  task: TaskRow;
  goalTitle?: string;
}

export function getFocusWithGoals(userId: string, now = Date.now()): FocusItem[] {
  const tasks = listTasks(userId, { status: "active" }, now);
  const goalLinks = getDb()
    .prepare(
      `SELECT gt.task_id, g.title FROM goal_tasks gt JOIN goals g ON g.id = gt.goal_id
       WHERE g.user_id = ? AND g.status = 'active'`
    )
    .all(userId) as { task_id: string; title: string }[];
  const goalByTask = new Map(goalLinks.map((l) => [l.task_id, l.title]));
  return tasks
    .filter((t) => getEffectiveStatus(t, now) !== "overdue")
    .sort((a, b) => {
      const pr = priorityRank(b.priority as Priority) - priorityRank(a.priority as Priority);
      if (pr !== 0) return pr;
      const ad = a.deadline_at ? new Date(a.deadline_at).getTime() : Number.MAX_SAFE_INTEGER;
      const bd = b.deadline_at ? new Date(b.deadline_at).getTime() : Number.MAX_SAFE_INTEGER;
      return ad - bd;
    })
    .slice(0, 5)
    .map((task) => ({ task, goalTitle: goalByTask.get(task.id) }));
}
