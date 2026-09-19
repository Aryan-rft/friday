/**
 * The AI Action System. The assistant (LLM or rule engine) never touches the
 * database directly — every mutation/query goes through these validated tools.
 */

import { getDb } from "../db/conn.js";
import { seedProjectsForUser, seedSettingsForUser, getDefaultTimezone } from "../db/seed.js";
import { toISO, todayStart, todayEnd, DAY, ymd, zonedParts, formatZoned } from "../lib/dates.js";
import { priorityRank, type Priority } from "../lib/priority.js";
import { nowISO } from "../lib/dates.js";

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  project_id: string | null;
  project_name: string | null;
  project_slug: string | null;
  project_color: string | null;
  priority: Priority;
  status: string;
  task_type: string;
  due_date: string | null;
  due_time: string | null;
  deadline_at: string | null;
  recurrence: string | null;
  people: string;
  source: string;
  notes: string;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

const ACTIVE_STATUSES = ["inbox", "planned", "today", "in_progress", "waiting", "overdue"];

function ensureUser(userId: string): void {
  seedProjectsForUser(userId);
  seedSettingsForUser(userId);
}

function logActivity(userId: string, action: string, entityType: string, entityId: string | null, detail: Record<string, unknown> = {}): void {
  getDb()
    .prepare(
      `INSERT INTO activity_log (id, user_id, action, entity_type, entity_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(crypto.randomUUID(), userId, action, entityType, entityId, JSON.stringify(detail), nowISO());
}

function taskSelect(): string {
  return `
    SELECT t.*, p.name AS project_name, p.slug AS project_slug, p.color AS project_color
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
  `;
}

export function getEffectiveStatus(task: { status: string; deadline_at: string | null; completed_at: string | null; cancelled_at: string | null }, now = Date.now()): string {
  if (task.status === "completed" || task.status === "cancelled") return task.status;
  if (task.deadline_at && new Date(task.deadline_at).getTime() < now) return "overdue";
  return task.status;
}

function decorateTasks(rows: TaskRow[], tz: string, now = Date.now()): TaskRow[] {
  for (const r of rows) {
    (r as TaskRow & { effective_status: string }).effective_status = getEffectiveStatus(r, now);
  }
  return rows;
}

export interface ToolError extends Error {
  code: string;
}

export function toolError(code: string, message: string): ToolError {
  const e = new Error(message) as ToolError;
  e.code = code;
  return e;
}

// ─── Validation helpers ────────────────────────────────────────────────────────

function isISODate(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

const PRIORITIES: Priority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

function validatePriority(v: unknown): Priority {
  if (typeof v !== "string" || !PRIORITIES.includes(v as Priority)) {
    throw toolError("invalid_priority", `Priority must be one of ${PRIORITIES.join(", ")}`);
  }
  return v as Priority;
}

const STATUSES = ["inbox", "planned", "today", "in_progress", "waiting", "completed", "cancelled"];

function validateStatus(v: unknown): string {
  if (typeof v !== "string" || !STATUSES.includes(v)) {
    throw toolError("invalid_status", `Status must be one of ${STATUSES.join(", ")}`);
  }
  return v;
}

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

function optStr(v: unknown, field: string, maxLen = 500): string | null {
  const s = str(v, field, maxLen);
  return s === "" ? null : s;
}

// ─── Task matching (used by complete/reschedule/delete/set_priority) ──────────

export function findTaskByTitle(userId: string, query: string, now = Date.now()): TaskRow {
  if (!query.trim()) throw toolError("not_found", "I couldn't tell which task you mean — please name it.");
  const q = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const tokens = q.split(" ").filter((t) => t.length > 1);
  if (tokens.length === 0) throw toolError("not_found", "I couldn't tell which task you mean — please name it.");

  const db = getDb();
  const rows = db
    .prepare(`${taskSelect()} WHERE t.user_id = ? AND t.status IN (${ACTIVE_STATUSES.map(() => "?").join(",")}) ORDER BY t.created_at DESC`)
    .all(userId, ...ACTIVE_STATUSES) as unknown as TaskRow[];

  let best: { task: TaskRow; score: number } | null = null;
  for (const task of rows) {
    const title = task.title.toLowerCase();
    if (title === q) {
      best = { task, score: 10 };
      break;
    }
    if (title.includes(q) || q.includes(title)) {
      best = { task, score: 8 };
      break;
    }
    let hits = 0;
    for (const tok of tokens) if (title.includes(tok)) hits++;
    const score = hits / tokens.length;
    if (score >= 0.5 && (!best || score > best.score)) best = { task, score };
  }
  if (!best) throw toolError("not_found", `I couldn't find an open task matching "${query}".`);
  return best.task;
}

export function getTaskById(userId: string, id: string): TaskRow {
  const row = getDb()
    .prepare(`${taskSelect()} WHERE t.id = ? AND t.user_id = ?`)
    .get(id, userId) as TaskRow | undefined;
  if (!row) throw toolError("not_found", "Task not found.");
  return row;
}

// ─── Project helpers ───────────────────────────────────────────────────────────

export function getProjectBySlug(userId: string, slug: string): { id: string; name: string; slug: string; color: string } | null {
  const row = getDb()
    .prepare("SELECT id, name, slug, color FROM projects WHERE user_id = ? AND slug = ?")
    .get(userId, slug) as { id: string; name: string; slug: string; color: string } | undefined;
  return row ?? null;
}

export function resolveProject(userId: string, slug: string | null | undefined): { id: string; name: string; slug: string; color: string } | null {
  if (!slug) return null;
  return getProjectBySlug(userId, slug);
}

// ─── Tools ─────────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  description?: string;
  projectSlug?: string;
  priority?: Priority;
  deadlineAt?: string;
  dueDate?: string;
  dueTime?: string;
  status?: string;
  taskType?: string;
  recurrence?: string;
  people?: string[];
  notes?: string;
  source?: string;
  clientId?: string;
  reminderAt?: string;
  followUp?: { entity: string; reason: string; at?: string };
}

export function createTask(userId: string, input: CreateTaskInput, now = Date.now()): TaskRow {
  ensureUser(userId);
  const title = requiredStr(input.title, "title");
  const project = resolveProject(userId, input.projectSlug || null);
  const priority = validatePriority(input.priority || "MEDIUM");
  const status = input.status ? validateStatus(input.status) : "inbox";
  const taskType = str(input.taskType || "task", "taskType", 50) || "task";
  const recurrence = optStr(input.recurrence, "recurrence", 100);
  const description = optStr(input.description, "description", 2000);
  const notes = optStr(input.notes, "notes", 2000);
  const source = str(input.source || "assistant", "source", 50) || "assistant";
  const clientId = optStr(input.clientId, "clientId", 100);

  if (input.deadlineAt !== undefined && input.deadlineAt !== null && !isISODate(input.deadlineAt)) {
    throw toolError("invalid_date", "Deadline must be a valid date.");
  }
  const deadlineAt = input.deadlineAt ? new Date(input.deadlineAt).toISOString() : null;
  let dueDate = input.dueDate ?? null;
  let dueTime = input.dueTime ?? null;
  if (deadlineAt && !dueDate) {
    const tz = getDefaultTimezone(userId);
    dueDate = ymd(new Date(deadlineAt).getTime(), tz);
  }
  if (deadlineAt && !dueTime) {
    const tz = getDefaultTimezone(userId);
    const p = zonedParts(new Date(deadlineAt).getTime(), tz);
    const hasTime = p.hour !== 23 || p.minute !== 59;
    if (hasTime) dueTime = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  }

  const people = Array.isArray(input.people) ? input.people.map((p) => String(p)).filter(Boolean).slice(0, 10) : [];

  const db = getDb();
  const id = crypto.randomUUID();
  const ts = toISO(now);

  // Idempotency: if clientId provided, update the existing task instead of
  // duplicating (offline retry safety).
  if (clientId) {
    const existing = db.prepare("SELECT id FROM tasks WHERE user_id = ? AND client_id = ?").get(userId, clientId) as { id: string } | undefined;
    if (existing) {
      updateTask(userId, existing.id, {
        title, description: description ?? undefined, projectSlug: project?.slug, priority,
        deadlineAt: deadlineAt ?? undefined, status, taskType, recurrence, people,
        notes: notes ?? undefined, source,
      });
      return getTaskById(userId, existing.id);
    }
  }

  db.prepare(
    `INSERT INTO tasks (id, user_id, client_id, title, description, project_id, priority, status, task_type,
       due_date, due_time, deadline_at, recurrence, people, source, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, userId, clientId, title, description || "", project?.id ?? null, priority, status, taskType,
    dueDate, dueTime, deadlineAt, recurrence, JSON.stringify(people), source, notes || "", ts, ts
  );

  if (input.reminderAt) {
    if (!isISODate(input.reminderAt)) throw toolError("invalid_date", "Reminder time must be a valid date.");
    createReminder(userId, { taskId: id, title: `${title} — reminder`, remindAt: input.reminderAt });
  }

  if (input.followUp) {
    createFollowUp(userId, {
      taskId: id,
      entity: str(input.followUp.entity, "entity", 200),
      reason: str(input.followUp.reason, "reason", 500),
      at: input.followUp.at ?? input.deadlineAt ?? undefined,
    });
  }

  logActivity(userId, "create_task", "task", id, { title, priority, status });
  return getTaskById(userId, id);
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  projectSlug?: string | null;
  priority?: Priority;
  status?: string;
  taskType?: string;
  deadlineAt?: string | null;
  recurrence?: string | null;
  people?: string[];
  notes?: string;
  source?: string;
}

export function updateTask(userId: string, id: string, input: UpdateTaskInput): TaskRow {
  const existing = getTaskById(userId, id);
  const db = getDb();

  const title = input.title !== undefined ? requiredStr(input.title, "title") : existing.title;
  const description = input.description !== undefined ? str(input.description, "description", 2000) : existing.description;
  const priority = input.priority !== undefined ? validatePriority(input.priority) : (existing.priority as Priority);
  const status = input.status !== undefined ? validateStatus(input.status) : existing.status;
  const taskType = input.taskType !== undefined ? str(input.taskType, "taskType", 50) : existing.task_type;
  const recurrence = input.recurrence !== undefined ? optStr(input.recurrence, "recurrence", 100) : existing.recurrence;
  const notes = input.notes !== undefined ? optStr(input.notes, "notes", 2000) : existing.notes;

  let projectId = existing.project_id;
  if (input.projectSlug !== undefined) {
    if (input.projectSlug === null) projectId = null;
    else {
      const p = resolveProject(userId, input.projectSlug);
      if (!p) throw toolError("project_not_found", `Project "${input.projectSlug}" not found.`);
      projectId = p.id;
    }
  }

  let deadlineAt = existing.deadline_at;
  let dueDate = existing.due_date;
  let dueTime = existing.due_time;
  if (input.deadlineAt !== undefined) {
    if (input.deadlineAt === null) {
      deadlineAt = null;
      dueDate = null;
      dueTime = null;
    } else {
      if (!isISODate(input.deadlineAt)) throw toolError("invalid_date", "Deadline must be a valid date.");
      deadlineAt = new Date(input.deadlineAt).toISOString();
      const tz = getDefaultTimezone(userId);
      dueDate = ymd(new Date(deadlineAt).getTime(), tz);
      const p = zonedParts(new Date(deadlineAt).getTime(), tz);
      dueTime = p.hour === 23 && p.minute === 59 ? null : `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    }
  }

  const people = input.people !== undefined ? JSON.stringify(input.people.map((p) => String(p)).filter(Boolean).slice(0, 10)) : existing.people;
  const source = input.source !== undefined ? str(input.source, "source", 50) : existing.source;

  db.prepare(
    `UPDATE tasks SET title = ?, description = ?, project_id = ?, priority = ?, status = ?, task_type = ?,
       due_date = ?, due_time = ?, deadline_at = ?, recurrence = ?, people = ?, notes = ?, source = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    title, description, projectId, priority, status, taskType,
    dueDate, dueTime, deadlineAt, recurrence, people, notes, source, nowISO(), id, userId
  );

  logActivity(userId, "update_task", "task", id, { title });
  return getTaskById(userId, id);
}

export function completeTask(userId: string, id: string, now = Date.now()): TaskRow {
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(toISO(now), toISO(now), id, userId);
  const task = getTaskById(userId, id);
  logActivity(userId, "complete_task", "task", id, { title: task.title });
  return task;
}

export function cancelTask(userId: string, id: string): TaskRow {
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(nowISO(), nowISO(), id, userId);
  const task = getTaskById(userId, id);
  logActivity(userId, "cancel_task", "task", id, { title: task.title });
  return task;
}

export function deleteTask(userId: string, id: string): void {
  getDb().prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?").run(id, userId);
  logActivity(userId, "delete_task", "task", id, {});
}

export function rescheduleTask(userId: string, id: string, newDeadlineAt: string): TaskRow {
  if (!isISODate(newDeadlineAt)) throw toolError("invalid_date", "New deadline must be a valid date.");
  return updateTask(userId, id, { deadlineAt: new Date(newDeadlineAt).toISOString() });
}

export function setTaskStatus(userId: string, id: string, status: string): TaskRow {
  validateStatus(status);
  return updateTask(userId, id, { status });
}

export interface CreateReminderInput {
  taskId?: string;
  title: string;
  remindAt?: string;
  offsetBeforeDeadline?: number;
  recurrence?: string;
}

export function createReminder(userId: string, input: CreateReminderInput, now = Date.now()): { id: string; remind_at: string; title: string } {
  ensureUser(userId);
  const title = requiredStr(input.title, "title");
  const recurrence = optStr(input.recurrence, "recurrence", 50);
  let remindAt: number | null = null;

  if (input.offsetBeforeDeadline !== undefined && input.taskId) {
    const task = getTaskById(userId, input.taskId);
    if (!task.deadline_at) throw toolError("no_deadline", "That task has no deadline to count back from.");
    remindAt = new Date(task.deadline_at).getTime() - input.offsetBeforeDeadline * 60_000;
  } else if (input.remindAt) {
    if (!isISODate(input.remindAt)) throw toolError("invalid_date", "Reminder time must be a valid date.");
    remindAt = new Date(input.remindAt).getTime();
  } else {
    throw toolError("invalid_input", "Provide remindAt or offsetBeforeDeadline with taskId.");
  }

  // Learned behaviour: shift absolute reminder times by the user's feedback
  // bias ("too early" / "too late" feedback accumulates here).
  if (remindAt !== null && !input.offsetBeforeDeadline && !recurrence) {
    const biasRow = getDb()
      .prepare("SELECT value FROM learned_prefs WHERE user_id = ? AND key = 'reminder_offset_bias_minutes'")
      .get(userId) as { value: string } | undefined;
    if (biasRow) {
      const bias = Number(JSON.parse(biasRow.value));
      if (Number.isFinite(bias) && bias !== 0) remindAt += bias * 60_000;
    }
  }

  if (remindAt < now - 60_000 && !recurrence) {
    throw toolError("past_reminder", "That reminder time is already in the past.");
  }

  const id = crypto.randomUUID();
  const ts = toISO(now);
  getDb()
    .prepare(
      `INSERT INTO reminders (id, user_id, task_id, title, remind_at, offset_minutes, recurrence, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`
    )
    .run(id, userId, input.taskId ?? null, title, toISO(remindAt), input.offsetBeforeDeadline ?? null, recurrence, ts, ts);

  logActivity(userId, "create_reminder", "reminder", id, { title, remind_at: toISO(remindAt) });
  return { id, remind_at: toISO(remindAt), title };
}

export interface CreateFollowUpInput {
  taskId?: string;
  entity: string;
  reason: string;
  at?: string;
  repeatConfig?: string;
}

export function createFollowUp(userId: string, input: CreateFollowUpInput): { id: string; entity: string; follow_up_at: string | null } {
  ensureUser(userId);
  const entity = str(input.entity, "entity", 200);
  const reason = str(input.reason, "reason", 500);
  let at: string | null = null;
  if (input.at) {
    if (!isISODate(input.at)) throw toolError("invalid_date", "Follow-up time must be a valid date.");
    at = new Date(input.at).toISOString();
  }
  const id = crypto.randomUUID();
  const ts = nowISO();
  getDb()
    .prepare(
      `INSERT INTO follow_ups (id, user_id, task_id, entity, reason, follow_up_at, repeat_config, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(id, userId, input.taskId ?? null, entity, reason, at, input.repeatConfig ?? null, ts, ts);
  logActivity(userId, "create_follow_up", "follow_up", id, { entity, follow_up_at: at });
  return { id, entity, follow_up_at: at };
}

export function completeFollowUp(userId: string, id: string): void {
  getDb().prepare(`UPDATE follow_ups SET status = 'done', updated_at = ? WHERE id = ? AND user_id = ?`).run(nowISO(), id, userId);
  logActivity(userId, "complete_follow_up", "follow_up", id, {});
}

// ─── Query tools ───────────────────────────────────────────────────────────────

export interface ListTasksInput {
  status?: string;
  projectSlug?: string;
  priority?: Priority;
  dueFrom?: string;
  dueTo?: string;
  search?: string;
  limit?: number;
  includeCompleted?: boolean;
}

export function listTasks(userId: string, input: ListTasksInput = {}, now = Date.now()): TaskRow[] {
  ensureUser(userId);
  const tz = getDefaultTimezone(userId);
  const where: string[] = ["t.user_id = ?"];
  const params: (string | number)[] = [userId];

  if (input.status) {
    const st = input.status;
    if (st === "overdue" || st === "active") {
      // virtual statuses
      where.push(`t.status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`);
      params.push(...ACTIVE_STATUSES);
      if (st === "overdue") {
        where.push("t.deadline_at IS NOT NULL AND t.deadline_at < ?");
        params.push(toISO(now));
      }
    } else if (st === "completed" || st === "cancelled") {
      where.push("t.status = ?");
      params.push(st);
    } else {
      where.push("t.status = ?");
      params.push(validateStatus(st));
    }
  } else if (!input.includeCompleted) {
    where.push(`t.status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`);
    params.push(...ACTIVE_STATUSES);
  }

  if (input.projectSlug) {
    where.push("p.slug = ?");
    params.push(input.projectSlug);
  }
  if (input.priority) {
    where.push("t.priority = ?");
    params.push(validatePriority(input.priority));
  }
  if (input.dueFrom) {
    where.push("t.deadline_at >= ?");
    params.push(input.dueFrom);
  }
  if (input.dueTo) {
    where.push("t.deadline_at < ?");
    params.push(input.dueTo);
  }
  if (input.search) {
    where.push("t.title LIKE ?");
    params.push(`%${input.search}%`);
  }

  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const rows = getDb()
    .prepare(`${taskSelect()} WHERE ${where.join(" AND ")} ORDER BY
      CASE t.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
      COALESCE(t.deadline_at, '9999-12-31'), t.created_at DESC LIMIT ?`)
    .all(...params, limit) as unknown as TaskRow[];
  return decorateTasks(rows, tz, now);
}

export function searchTasks(userId: string, q: string, limit = 10): TaskRow[] {
  const tz = getDefaultTimezone(userId);
  const rows = getDb()
    .prepare(`${taskSelect()} WHERE t.user_id = ? AND t.status IN (${ACTIVE_STATUSES.map(() => "?").join(",")}) AND (t.title LIKE ? OR t.notes LIKE ?) ORDER BY t.updated_at DESC LIMIT ?`)
    .all(userId, ...ACTIVE_STATUSES, `%${q}%`, `%${q}%`, limit) as unknown as TaskRow[];
  return decorateTasks(rows, tz);
}

export function getToday(userId: string, now = Date.now()): { tasks: TaskRow[]; counts: Record<string, number> } {
  const tz = getDefaultTimezone(userId);
  const start = todayStart(now, tz);
  const end = todayEnd(now, tz);
  const all = listTasks(userId, {}, now);
  const tasks = all.filter((t) => {
    if (t.deadline_at) {
      const ms = new Date(t.deadline_at).getTime();
      if (ms >= start && ms < end) return true;
    }
    return false;
  });
  const counts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, total: tasks.length };
  for (const t of tasks) counts[t.priority] = (counts[t.priority] || 0) + 1;
  return { tasks, counts };
}

export function getOverdue(userId: string, now = Date.now()): TaskRow[] {
  const all = listTasks(userId, { status: "active" }, now);
  return all.filter((t) => getEffectiveStatus(t, now) === "overdue");
}

export function getUrgent(userId: string, now = Date.now()): TaskRow[] {
  const all = listTasks(userId, { status: "active" }, now);
  return all.filter((t) => (t.priority === "CRITICAL" || t.priority === "HIGH") && getEffectiveStatus(t, now) !== "overdue");
}

export function getWaiting(userId: string, now = Date.now()): { followUps: { id: string; entity: string; reason: string; follow_up_at: string | null; task_title: string | null }[] } {
  ensureUser(userId);
  const rows = getDb()
    .prepare(
      `SELECT f.id, f.entity, f.reason, f.follow_up_at, t.title AS task_title
       FROM follow_ups f LEFT JOIN tasks t ON t.id = f.task_id
       WHERE f.user_id = ? AND f.status = 'pending'
       ORDER BY COALESCE(f.follow_up_at, '9999-12-31')`
    )
    .all(userId) as { id: string; entity: string; reason: string; follow_up_at: string | null; task_title: string | null }[];
  return { followUps: rows };
}

export function getUpcoming(userId: string, days = 7, now = Date.now()): TaskRow[] {
  const tz = getDefaultTimezone(userId);
  const start = todayStart(now, tz);
  const end = start + days * DAY;
  const all = listTasks(userId, {}, now);
  return all
    .filter((t) => t.deadline_at && new Date(t.deadline_at).getTime() >= start && new Date(t.deadline_at).getTime() < end)
    .sort((a, b) => new Date(a.deadline_at!).getTime() - new Date(b.deadline_at!).getTime());
}

export function getFinished(userId: string, period: "week" | "month" = "week", now = Date.now()): { tasks: TaskRow[]; periodStart: number } {
  const tz = getDefaultTimezone(userId);
  const start = todayStart(now, tz) - (period === "week" ? 6 : 29) * DAY;
  const rows = getDb()
    .prepare(`${taskSelect()} WHERE t.user_id = ? AND t.status = 'completed' AND t.completed_at >= ? ORDER BY t.completed_at DESC LIMIT 100`)
    .all(userId, toISO(start)) as unknown as TaskRow[];
  return { tasks: decorateTasks(rows, tz, now), periodStart: start };
}

export function getUnfinished(userId: string, now = Date.now()): TaskRow[] {
  const all = listTasks(userId, { status: "active" }, now);
  return all.filter((t) => getEffectiveStatus(t, now) !== "overdue");
}

export function getFocus(userId: string, now = Date.now()): TaskRow[] {
  const all = listTasks(userId, { status: "active" }, now);
  return all
    .filter((t) => getEffectiveStatus(t, now) !== "overdue")
    .sort((a, b) => {
      const pr = priorityRank(b.priority) - priorityRank(a.priority);
      if (pr !== 0) return pr;
      const ad = (a.deadline_at ? new Date(a.deadline_at).getTime() : Number.MAX_SAFE_INTEGER);
      const bd = (b.deadline_at ? new Date(b.deadline_at).getTime() : Number.MAX_SAFE_INTEGER);
      return ad - bd;
    })
    .slice(0, 5);
}

export function listProjects(userId: string): { id: string; name: string; slug: string; color: string; icon: string; task_count: number; open_count: number }[] {
  ensureUser(userId);
  return getDb()
    .prepare(
      `SELECT p.id, p.name, p.slug, p.color, p.icon,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})) AS open_count
       FROM projects p WHERE p.user_id = ? AND p.archived = 0 ORDER BY p.created_at`
    )
    .all(userId, ...ACTIVE_STATUSES) as { id: string; name: string; slug: string; color: string; icon: string; task_count: number; open_count: number }[];
}

export function createProject(userId: string, name: string): { id: string; name: string; slug: string; color: string } {
  ensureUser(userId);
  const n = requiredStr(name, "name", 100);
  const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!slug) throw toolError("invalid_input", "Project name is invalid.");
  const existing = getProjectBySlug(userId, slug);
  if (existing) return existing;
  const id = crypto.randomUUID();
  getDb()
    .prepare("INSERT INTO projects (id, user_id, name, slug, color, icon, is_system, created_at) VALUES (?, ?, ?, ?, '#64748b', 'folder', 0, ?)")
    .run(id, userId, n, slug, nowISO());
  logActivity(userId, "create_project", "project", id, { name: n });
  return { id, name: n, slug, color: "#64748b" };
}

export interface DailySummary {
  today: { tasks: TaskRow[]; counts: Record<string, number> };
  overdue: TaskRow[];
  waiting: { id: string; entity: string; reason: string; follow_up_at: string | null; task_title: string | null }[];
  urgent: TaskRow[];
  upcoming: TaskRow[];
  focus: TaskRow[];
}

export function getDailySummary(userId: string, now = Date.now()): DailySummary {
  return {
    today: getToday(userId, now),
    overdue: getOverdue(userId, now),
    waiting: getWaiting(userId, now).followUps,
    urgent: getUrgent(userId, now),
    upcoming: getUpcoming(userId, now, 3),
    focus: getFocus(userId, now),
  };
}

export interface WeeklySummary {
  completed: TaskRow[];
  completedCount: number;
  createdCount: number;
  pending: number;
  overdue: number;
  topProjects: { name: string; count: number }[];
}

export function getWeeklySummary(userId: string, now = Date.now()): WeeklySummary {
  const tz = getDefaultTimezone(userId);
  const weekStart = todayStart(now, tz) - 6 * DAY;
  const db = getDb();
  const completed = getFinished(userId, "week", now).tasks;
  const createdCount = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND created_at >= ?").get(userId, toISO(weekStart)) as { c: number }).c;
  const pending = (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`).all(userId, ...ACTIVE_STATUSES) as { c: number }[]).reduce((s, r) => s + r.c, 0);
  const overdue = getOverdue(userId, now).length;
  const topProjects = (db.prepare(
    `SELECT p.name AS name, COUNT(*) AS count FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.user_id = ? AND t.created_at >= ? GROUP BY p.name ORDER BY count DESC LIMIT 5`
  ).all(userId, toISO(weekStart)) as { name: string; count: number }[]);
  return { completed, completedCount: completed.length, createdCount, pending, overdue, topProjects };
}

export function rememberFact(userId: string, content: string, source = "assistant"): { id: string } {
  const c = requiredStr(content, "content", 1000);
  const id = crypto.randomUUID();
  const ts = nowISO();
  getDb()
    .prepare("INSERT INTO memories (id, user_id, kind, content, source, created_at, last_seen_at) VALUES (?, ?, 'fact', ?, ?, ?, ?)")
    .run(id, userId, c, source, ts, ts);
  logActivity(userId, "remember", "memory", id, {});
  return { id };
}

export function listMemories(userId: string, limit = 50): { id: string; content: string; created_at: string }[] {
  return getDb()
    .prepare("SELECT id, content, created_at FROM memories WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT ?")
    .all(userId, limit) as { id: string; content: string; created_at: string }[];
}

export function deleteMemory(userId: string, id: string): void {
  getDb().prepare("DELETE FROM memories WHERE id = ? AND user_id = ?").run(id, userId);
}

export function recentActivity(userId: string, limit = 30): { id: string; action: string; entity_type: string; detail: string; created_at: string }[] {
  return getDb()
    .prepare("SELECT id, action, entity_type, detail, created_at FROM activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as { id: string; action: string; entity_type: string; detail: string; created_at: string }[];
}

export function getStats(userId: string, now = Date.now()) {
  const db = getDb();
  const active = listTasks(userId, { status: "active" }, now);
  const completedToday = db.prepare(
    "SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND status = 'completed' AND completed_at >= ?"
  ).get(userId, toISO(todayStart(now, getDefaultTimezone(userId)))) as { c: number };
  return {
    open: active.length,
    overdue: getOverdue(userId, now).length,
    today: getToday(userId, now).tasks.length,
    urgent: getUrgent(userId, now).length,
    waiting: getWaiting(userId, now).followUps.length,
    completedToday: completedToday.c,
    memories: listMemories(userId).length,
    projects: listProjects(userId).length,
  };
}

// ─── Human-readable formatting (shared with rules-mode replies) ───────────────

export function friendlyDate(iso: string | null, tz: string, now = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime();
  const start = todayStart(now, tz);
  if (ms >= start && ms < start + DAY) return "today";
  if (ms >= start + DAY && ms < start + 2 * DAY) return "tomorrow";
  if (ms >= start - DAY && ms < start) return "yesterday";
  return formatZoned(ms, tz, { weekday: "short", day: "numeric", month: "short" });
}

export function friendlyDateTime(iso: string | null, tz: string, now = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime();
  const p = zonedParts(ms, tz);
  const hasTime = !(p.hour === 23 && p.minute === 59);
  const date = friendlyDate(iso, tz, now);
  if (!hasTime) return date;
  const time = formatZoned(ms, tz, { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}