/**
 * Interpretation pipeline.
 *
 * 1. LLM mode (when OPENAI_API_KEY is set): model picks structured tool calls,
 *    we execute them against the DB, then the model writes the final reply.
 * 2. Rules mode (always available): deterministic NLU → same tools → template
 *    replies. Every failure in LLM mode falls back to rules mode, so the
 *    assistant always answers.
 */

import { analyze, type Analysis, type TaskDraft } from "./nlu.js";
import { chat, extractJson, isAiConfigured } from "./llm.js";
import {
  createTask, updateTask, completeTask, cancelTask, deleteTask, rescheduleTask,
  setTaskStatus, createReminder, createFollowUp, completeFollowUp,
  listTasks, searchTasks, getToday, getUrgent, getOverdue, getWaiting, getUpcoming,
  getFinished, getUnfinished, getFocus, listProjects, getDailySummary, getWeeklySummary,
  rememberFact, findTaskByTitle, friendlyDateTime, friendlyDate,
  toolError, type TaskRow,
} from "../actions/tools.js";
import { getDefaultTimezone } from "../db/seed.js";
import { getDb } from "../db/conn.js";
import { zonedParts, todayStart, DAY } from "../lib/dates.js";
import {
  createGoal, listGoals, updateGoal, breakdownTask, addSubtasks, completeSubtask, listSubtasks,
  recordFeedback, getSuggestions, prefsSummary,
} from "../actions/friday.js";
import { logger } from "../lib/logger.js";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface InterpretResult {
  reply: string;
  intent: string;
  toolCalls: { name: string; data: unknown }[];
  mode: "llm" | "rules";
}

export interface InterpretContext {
  userId: string;
  userName?: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

const TOOL_SCHEMAS: { name: string; description: string; parameters: Record<string, unknown> }[] = [
  {
    name: "create_task",
    description: "Create a task/todo. Always used for 'I need to...', 'add...', deadlines, lectures, pitches, etc.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title" },
        description: { type: "string" },
        projectSlug: { type: "string", description: "One of: kuk, kuk-training-implementation, expert-lectures, corporate-outreach, internships-students, ai-employees, rft, personal, ideas, general" },
        priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
        deadlineAt: { type: "string", description: "ISO-8601 deadline in Asia/Kolkata" },
        taskType: { type: "string" },
        recurrence: { type: "string" },
        people: { type: "array", items: { type: "string" } },
        reminderAt: { type: "string", description: "ISO-8601 reminder time" },
        followUp: {
          type: "object",
          properties: { entity: { type: "string" }, reason: { type: "string" }, at: { type: "string" } },
        },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark an existing task completed. For 'mark X done/complete'.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "reschedule_task",
    description: "Move a task to a new deadline.",
    parameters: { type: "object", properties: { id: { type: "string" }, newDeadlineAt: { type: "string" } }, required: ["id", "newDeadlineAt"] },
  },
  {
    name: "delete_task",
    description: "Permanently delete a task.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "create_reminder",
    description: "Schedule a reminder at a time or relative to a task deadline.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        title: { type: "string" },
        remindAt: { type: "string" },
        offsetBeforeDeadline: { type: "number", description: "Minutes before task deadline" },
        recurrence: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "create_follow_up",
    description: "Track a follow-up with a person/entity.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" }, entity: { type: "string" }, reason: { type: "string" }, at: { type: "string" } },
      required: ["entity"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks with filters. For 'what do I have', 'urgent', 'overdue', project queries.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "overdue", "completed", "inbox", "planned", "today", "in_progress", "waiting"] },
        projectSlug: { type: "string" },
        priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
        search: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "get_daily_summary",
    description: "Full picture of today: tasks, deadlines, waiting, overdue. For briefings.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_weekly_summary",
    description: "Week summary: completed, created, pending, top projects.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_waiting",
    description: "Pending follow-ups.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_upcoming",
    description: "Upcoming deadlines in the next N days.",
    parameters: { type: "object", properties: { days: { type: "number" } } },
  },
  {
    name: "get_focus",
    description: "What to focus on first, by priority and deadline.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_projects",
    description: "List all projects.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "remember",
    description: "Store a persistent fact or note.",
    parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "create_goal",
    description: "Create a long-term goal (week/month/quarter/year/life horizon). For 'my goal is...', 'add a goal...'.",
    parameters: { type: "object", properties: { title: { type: "string" }, horizon: { type: "string", enum: ["week", "month", "quarter", "year", "life"] }, description: { type: "string" } }, required: ["title"] },
  },
  {
    name: "list_goals",
    description: "List the user's active goals with progress.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "update_goal",
    description: "Update or pause/achieve/drop a goal.",
    parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["active", "paused", "achieved", "dropped"] } }, required: ["id"] },
  },
  {
    name: "breakdown_task",
    description: "Break a task into smaller concrete subtasks. For 'break it down', 'make it smaller', 'split into steps'.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "add_subtasks",
    description: "Add specific subtask steps to a task.",
    parameters: { type: "object", properties: { id: { type: "string" }, titles: { type: "array", items: { type: "string" } } }, required: ["id", "titles"] },
  },
  {
    name: "record_feedback",
    description: "Record user feedback about Friday's behaviour: reminder_too_early, reminder_too_late, dont_suggest, preferred_time, not_important, make_smaller, good, other.",
    parameters: { type: "object", properties: { category: { type: "string" }, comment: { type: "string" }, taskId: { type: "string" } }, required: ["category"] },
  },
  {
    name: "get_suggestions",
    description: "Get Friday's proactive suggestions (neglected work, deadlines without reminders, follow-ups due, stale goals).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "respond",
    description: "Respond to greetings, thanks, or chit-chat without touching data.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

function systemPrompt(ctx: InterpretContext): string {
  const tz = getDefaultTimezone(ctx.userId);
  const now = new Date();
  const p = zonedParts(now.getTime(), tz);
  const projects = listProjects(ctx.userId).map((p2) => p2.slug).join(", ");
  return `You are Friday, the personal voice-first assistant of ${ctx.userName || "the user"}.

Today's date in ${tz}: ${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} (weekday ${p.weekday}).
${prefsSummary(ctx.userId) ? `Learned preferences about the user: ${prefsSummary(ctx.userId)}. Honour these when scheduling.` : ""}

You MUST use the provided tools for anything about the user's tasks, goals, projects, reminders, follow-ups or data — never invent data. Interpret the user's natural speech (English or Hinglish like "kal KUK mein lecture slides check karni hain"). For a statement about something to do, call create_task and set title, projectSlug, priority, deadlineAt, taskType, people, reminderAt and followUp where appropriate. For statements of ambition ("my goal is X", "build the business this year"), call create_goal. For feedback about your behaviour ("too early", "don't suggest this", "I prefer nights"), call record_feedback. For queries, call a list/get tool. For "mark X complete"/"move X to Y"/"break it down", call list_tasks/search first to find the task id, then complete_task/reschedule_task/breakdown_task.

Available project slugs: ${projects || "general"}.

Respond ONLY with JSON, either:
{"tool_calls":[{"name":"...","arguments":{...}}]}
or, for pure chit-chat, {"reply":"..."}. Never answer a data question without a tool call.`;
}

// ─── Tool execution ────────────────────────────────────────────────────────────

function executeTool(userId: string, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "create_task": {
      const t = createTask(userId, {
        title: String(args.title ?? ""),
        description: args.description as string | undefined,
        projectSlug: args.projectSlug as string | undefined,
        priority: args.priority as TaskDraft["priority"],
        deadlineAt: args.deadlineAt as string | undefined,
        taskType: args.taskType as string | undefined,
        recurrence: args.recurrence as string | undefined,
        people: args.people as string[] | undefined,
        reminderAt: args.reminderAt as string | undefined,
        followUp: args.followUp as { entity: string; reason: string; at?: string } | undefined,
      });
      return { id: t.id, title: t.title, project: t.project_name, priority: t.priority, deadline_at: t.deadline_at };
    }
    case "update_task": {
      const id = String(args.id ?? "");
      const t = updateTask(userId, id, {
        title: args.title as string | undefined,
        description: args.description as string | undefined,
        projectSlug: args.projectSlug as string | null | undefined,
        priority: args.priority as TaskDraft["priority"],
        status: args.status as string | undefined,
        deadlineAt: args.deadlineAt as string | null | undefined,
        recurrence: args.recurrence as string | null | undefined,
        people: args.people as string[] | undefined,
      });
      return { id: t.id, title: t.title };
    }
    case "complete_task": {
      const t = completeTask(userId, String(args.id ?? ""));
      return { id: t.id, title: t.title };
    }
    case "cancel_task": {
      const t = cancelTask(userId, String(args.id ?? ""));
      return { id: t.id, title: t.title };
    }
    case "delete_task": {
      deleteTask(userId, String(args.id ?? ""));
      return { id: String(args.id ?? "") };
    }
    case "reschedule_task": {
      const t = rescheduleTask(userId, String(args.id ?? ""), String(args.newDeadlineAt ?? ""));
      return { id: t.id, title: t.title, deadline_at: t.deadline_at };
    }
    case "set_task_status": {
      const t = setTaskStatus(userId, String(args.id ?? ""), String(args.status ?? ""));
      return { id: t.id, title: t.title, status: t.status };
    }
    case "create_reminder": {
      const r = createReminder(userId, {
        taskId: args.taskId as string | undefined,
        title: String(args.title ?? ""),
        remindAt: args.remindAt as string | undefined,
        offsetBeforeDeadline: args.offsetBeforeDeadline as number | undefined,
        recurrence: args.recurrence as string | undefined,
      });
      return r;
    }
    case "create_follow_up": {
      const f = createFollowUp(userId, {
        taskId: args.taskId as string | undefined,
        entity: String(args.entity ?? ""),
        reason: String(args.reason ?? ""),
        at: args.at as string | undefined,
      });
      return f;
    }
    case "complete_follow_up": {
      completeFollowUp(userId, String(args.id ?? ""));
      return { id: String(args.id ?? "") };
    }
    case "list_tasks": {
      const rows = listTasks(userId, {
        status: args.status as string | undefined,
        projectSlug: args.projectSlug as string | undefined,
        priority: args.priority as TaskDraft["priority"],
        search: args.search as string | undefined,
        limit: args.limit as number | undefined,
      });
      return rows.map(publicTask);
    }
    case "search_tasks": {
      return searchTasks(userId, String(args.query ?? "")).map(publicTask);
    }
    case "get_today":
      return getToday(userId);
    case "get_urgent":
      return getUrgent(userId);
    case "get_overdue":
      return getOverdue(userId);
    case "get_waiting":
      return getWaiting(userId);
    case "get_upcoming":
      return getUpcoming(userId, Number(args.days ?? 7));
    case "get_finished": {
      const f = getFinished(userId, (args.period as "week" | "month") || "week");
      return { tasks: f.tasks.map(publicTask) };
    }
    case "get_unfinished":
      return getUnfinished(userId).map(publicTask);
    case "get_focus":
      return getFocus(userId).map(publicTask);
    case "get_daily_summary": {
      const s = getDailySummary(userId);
      return {
        today: { tasks: s.today.tasks.map(publicTask), counts: s.today.counts },
        overdue: s.overdue.map(publicTask),
        waiting: s.waiting,
        urgent: s.urgent.map(publicTask),
        upcoming: s.upcoming.map(publicTask),
      };
    }
    case "get_weekly_summary": {
      const s = getWeeklySummary(userId);
      return { ...s, completed: s.completed.map(publicTask) };
    }
    case "list_projects":
      return listProjects(userId);
    case "remember": {
      const r = rememberFact(userId, String(args.content ?? ""));
      return r;
    }
    case "create_goal": {
      const g = createGoal(userId, { title: args.title, horizon: args.horizon, description: args.description });
      return { id: g.id, title: g.title, horizon: g.horizon };
    }
    case "list_goals":
      return listGoals(userId, "active").map((g) => ({ id: g.id, title: g.title, horizon: g.horizon, total_tasks: g.total_tasks, open_tasks: g.open_tasks }));
    case "update_goal": {
      const g = updateGoal(userId, String(args.id ?? ""), { title: args.title, status: args.status });
      return { id: g.id, title: g.title, status: g.status };
    }
    case "breakdown_task": {
      const subs = breakdownTask(userId, String(args.id ?? ""));
      return { taskId: args.id, subtasks: subs.map((s) => s.title) };
    }
    case "add_subtasks": {
      const subs = addSubtasks(userId, String(args.id ?? ""), (args.titles as unknown[]) ?? []);
      return { taskId: args.id, subtasks: subs.map((s) => s.title) };
    }
    case "list_subtasks":
      return listSubtasks(userId, String(args.id ?? ""));
    case "complete_subtask": {
      const s = completeSubtask(userId, String(args.id ?? ""));
      return { id: s.id, status: s.status };
    }
    case "record_feedback": {
      const res = recordFeedback(userId, {
        category: String(args.category ?? "other") as never,
        comment: args.comment as string | undefined,
        targetType: args.taskId ? "task" : undefined,
        targetId: args.taskId as string | undefined,
      });
      return { applied: res.applied };
    }
    case "get_suggestions":
      return getSuggestions(userId);
    case "respond":
      return { text: String(args.text ?? "") };
    default:
      throw toolError("unknown_tool", `Unknown tool: ${name}`);
  }
}

function publicTask(t: TaskRow) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    project: t.project_name,
    priority: t.priority,
    status: (t as TaskRow & { effective_status?: string }).effective_status ?? t.status,
    task_type: t.task_type,
    deadline_at: t.deadline_at,
    due_date: t.due_date,
    due_time: t.due_time,
    people: JSON.parse(t.people || "[]"),
    completed_at: t.completed_at,
    created_at: t.created_at,
  };
}

// ─── LLM mode ──────────────────────────────────────────────────────────────────

async function llmInterpret(userId: string, text: string, ctx: InterpretContext): Promise<InterpretResult | null> {
  const history = ctx.history ?? [];
  const msgs = [
    { role: "system" as const, content: systemPrompt(ctx) },
    ...history.slice(-8).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: `Tools: ${JSON.stringify(TOOL_SCHEMAS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })))}\n\nUser: ${text}` },
  ];

  const raw1 = await chat(msgs, { jsonMode: true, maxTokens: 600 });
  const parsed1 = extractJson<{ tool_calls?: ToolCall[]; reply?: string }>(raw1);

  if (parsed1.reply && !parsed1.tool_calls?.length) {
    return { reply: parsed1.reply, intent: "llm", toolCalls: [], mode: "llm" };
  }

  const calls = (parsed1.tool_calls ?? []).slice(0, 6);
  const results: { name: string; ok: boolean; data?: unknown; error?: string }[] = [];
  for (const call of calls) {
    try {
      const data = executeTool(userId, call.name, call.arguments || {});
      results.push({ name: call.name, ok: true, data });
    } catch (e) {
      results.push({ name: call.name, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Final reply from the model
  const raw2 = await chat([
    { role: "system", content: systemPrompt(ctx) },
    ...msgs.slice(-2),
    {
      role: "user",
      content: `Tool execution results:\n${JSON.stringify(results, null, 1)}\n\nWrite a short, friendly confirmation or answer in the user's language (English or Hinglish). Do not mention tools or JSON.`,
    },
  ], { maxTokens: 400 });

  return {
    reply: raw2.trim(),
    intent: calls[0]?.name || "reply",
    toolCalls: results.map((r) => ({ name: r.name, data: r })),
    mode: "llm",
  };
}

// ─── Rules mode ────────────────────────────────────────────────────────────────

function taskLine(t: TaskRow, tz: string, now: number): string {
  const when = t.deadline_at ? friendlyDateTime(t.deadline_at, tz, now) : "";
  const proj = t.project_name ? ` [${t.project_name}]` : "";
  return `• ${t.title}${proj}${when ? ` — ${when}` : ""} (${t.priority})`;
}

function rulesInterpret(userId: string, text: string): InterpretResult {
  const tz = getDefaultTimezone(userId);
  const now = Date.now();
  const analysis: Analysis = analyze(text, { now, timezone: tz, knownProjectSlugs: listProjects(userId).map((p) => p.slug) });
  const toolCalls: { name: string; data: unknown }[] = [];
  let reply = "";

  const run = (name: string, args: Record<string, unknown>) => {
    const data = executeTool(userId, name, args);
    toolCalls.push({ name, data: { ok: true, data } });
    return data;
  };

  switch (analysis.intent) {
    case "smalltalk": {
      reply = "I'm here! Speak naturally — tell me what you need to do, ask what's on your plate, or say 'brief me'. I understand English and Hinglish. 🎤";
      break;
    }
    case "help": {
      reply = "You can say things like:\n• “I need to finish the KUK roadmap by Wednesday”\n• “Remind me tomorrow at 10 to call the outreach team”\n• “Follow up with them Friday”\n• “What do I have today?” / “What is urgent?” / “What am I waiting for?”\n• “Mark the roadmap task complete” / “Move the lecture prep to Friday”";
      break;
    }
    case "remember": {
      run("remember", { content: analysis.rememberText || text });
      reply = `Got it — I'll remember: "${analysis.rememberText}".`;
      break;
    }
    case "create_task": {
      const t = analysis.task!;
      const created = run("create_task", taskDraftToArgs(t)) as { id: string; title: string; project: string | null; priority: string; deadline_at: string | null };
      const parts = [`Added: "${created.title}"`];
      if (created.project) parts.push(`to ${created.project}`);
      parts.push(`${created.priority.toLowerCase()} priority`);
      if (created.deadline_at) parts.push(`due ${friendlyDateTime(created.deadline_at, tz, now)}`);
      reply = parts.join(" — ") + ".";
      if (t.reminder?.at) reply += ` Reminder set for ${friendlyDateTime(t.reminder.at, tz, now)}.`;
      if (t.followUp?.entity) reply += ` Follow-up with ${t.followUp.entity} tracked.`;
      break;
    }
    case "remind": {
      const t = analysis.task!;
      if (t.title && t.title !== "Reminder" && t.reminder) {
        const created = run("create_task", taskDraftToArgs({ ...t, reminder: undefined })) as { id: string };
        if (t.reminder.at) {
          run("create_reminder", { taskId: created.id, title: t.reminder.title || t.title, remindAt: t.reminder.at });
        } else if (t.reminder.offsetBeforeDeadline !== undefined && t.deadlineAt) {
          run("create_reminder", { taskId: created.id, title: t.reminder.title || t.title, offsetBeforeDeadline: t.reminder.offsetBeforeDeadline });
        } else if (t.reminder.recurrence) {
          run("create_reminder", { taskId: created.id, title: t.reminder.title || t.title, recurrence: t.reminder.recurrence, remindAt: t.reminder.at ?? undefined });
        }
        if (t.reminder.at) reply = `Reminder scheduled for ${friendlyDateTime(t.reminder.at, tz, now)}.`;
        else if (t.reminder.recurrence) reply = `Repeating reminder set${t.reminder.at ? ` — next ${friendlyDateTime(t.reminder.at, tz, now)}` : ""}.`;
        else if (t.reminder.offsetBeforeDeadline !== undefined && t.deadlineAt) reply = `Reminder set ${t.reminder.offsetBeforeDeadline} minutes before the deadline.`;
        else reply = `Reminder scheduled.`;
      } else {
        if (t.reminder?.at) {
          run("create_reminder", { title: t.title || "Reminder", remindAt: t.reminder.at });
          reply = `Reminder scheduled for ${friendlyDateTime(t.reminder.at, tz, now)}.`;
        } else if (t.reminder?.recurrence) {
          run("create_reminder", { title: t.title || "Reminder", recurrence: t.reminder.recurrence, remindAt: t.reminder.at ?? undefined });
          reply = `Repeating reminder set${t.reminder.at ? ` — next ${friendlyDateTime(t.reminder.at, tz, now)}` : ""}.`;
        } else {
          reply = "I didn't catch when you want the reminder. Try “remind me tomorrow at 10”. 😅";
        }
      }
      break;
    }
    case "follow_up": {
      const t = analysis.task!;
      // create the task without the embedded follow-up — we create it once,
      // explicitly, below (entity fallback included).
      const args = taskDraftToArgs(t);
      delete args.followUp;
      const created = run("create_task", args) as { id: string; title: string };
      if (t.followUp) {
        run("create_follow_up", { taskId: created.id, entity: t.followUp.entity || t.title, reason: t.followUp.reason, at: t.followUp.at });
      }
      if (t.reminder?.at) run("create_reminder", { taskId: created.id, title: t.reminder.title || t.title, remindAt: t.reminder.at });
      const when = t.followUp?.at ? `on ${friendlyDate(t.followUp.at, tz, now)}` : t.deadlineAt ? `on ${friendlyDate(t.deadlineAt, tz, now)}` : "";
      reply = `Follow-up with ${t.followUp?.entity || "them"}${when ? " " + when : ""} tracked. I'll keep it on your radar.`;
      break;
    }
    case "complete": {
      const task = findTaskByTitle(userId, analysis.targetTitle || "");
      run("complete_task", { id: task.id });
      reply = `Done! Marked "${task.title}" as completed. ✅`;
      break;
    }
    case "reschedule": {
      const task = findTaskByTitle(userId, analysis.targetTitle || "");
      run("reschedule_task", { id: task.id, newDeadlineAt: analysis.newDeadlineAt || new Date(Date.now() + 3 * DAY).toISOString() });
      reply = `Moved "${task.title}" to ${friendlyDateTime(analysis.newDeadlineAt || "", tz, now) || "the new date"}.`;
      break;
    }
    case "delete": {
      const task = findTaskByTitle(userId, analysis.targetTitle || "");
      run("delete_task", { id: task.id });
      reply = `Deleted "${task.title}".`;
      break;
    }
    case "set_priority": {
      const task = findTaskByTitle(userId, analysis.targetTitle || "");
      const priority = /\burgent\b|\bcritical\b/.test(text.toLowerCase()) ? "CRITICAL" : /\blow\b/.test(text.toLowerCase()) ? "LOW" : "HIGH";
      run("update_task", { id: task.id, priority });
      reply = `"${task.title}" is now ${priority.toLowerCase()} priority.`;
      break;
    }
    case "query_today": {
      const { tasks, counts } = getToday(userId, now);
      if (tasks.length === 0) {
        reply = "You have nothing due today. 🎉";
      } else {
        const lines = [`You have ${counts.total} tasks today.`];
        if (counts.CRITICAL) lines.push(`🔴 ${counts.CRITICAL} critical`);
        if (counts.HIGH) lines.push(`🟠 ${counts.HIGH} high priority`);
        if (counts.MEDIUM) lines.push(`🟡 ${counts.MEDIUM} medium`);
        const sorted = [...tasks].sort((a, b) => (a.deadline_at ?? "").localeCompare(b.deadline_at ?? ""));
        for (const t of sorted.slice(0, 8)) lines.push(taskLine(t, tz, now));
        if (tasks.length > 8) lines.push(`…and ${tasks.length - 8} more`);
        reply = lines.join("\n");
      }
      break;
    }
    case "query_urgent": {
      const urgent = getUrgent(userId, now);
      if (urgent.length === 0) reply = "Nothing urgent right now. 👍";
      else reply = `You have ${urgent.length} urgent ${urgent.length === 1 ? "task" : "tasks"}:\n` + urgent.slice(0, 8).map((t) => taskLine(t, tz, now)).join("\n");
      break;
    }
    case "query_overdue": {
      const overdue = getOverdue(userId, now);
      if (overdue.length === 0) reply = "Nothing overdue. Nice work. ✅";
      else reply = `${overdue.length} overdue ${overdue.length === 1 ? "task" : "tasks"}:\n` + overdue.slice(0, 8).map((t) => taskLine(t, tz, now)).join("\n");
      break;
    }
    case "query_waiting": {
      const { followUps } = getWaiting(userId, now);
      if (followUps.length === 0) reply = "You're not waiting on anyone right now.";
      else {
        const lines = [`You're waiting on ${followUps.length} ${followUps.length === 1 ? "follow-up" : "follow-ups"}:`];
        for (const f of followUps.slice(0, 8)) {
          const when = f.follow_up_at ? ` — ${friendlyDate(f.follow_up_at, tz, now)}` : "";
          const reason = f.reason ? ` (${f.reason})` : "";
          lines.push(`• ${f.entity}${reason}${when}`);
        }
        reply = lines.join("\n");
      }
      break;
    }
    case "query_project": {
      const slug = analysis.query?.projectSlug;
      if (!slug) {
        reply = "Which project? For example: “What are my KUK tasks?”";
        break;
      }
      const project = listProjects(userId).find((p) => p.slug === slug);
      const tasks = listTasks(userId, { projectSlug: slug, status: "active" }, now);
      if (tasks.length === 0) reply = `No open tasks in ${project?.name || slug}.`;
      else reply = `${project?.name || slug} — ${tasks.length} open task${tasks.length === 1 ? "" : "s"}:\n` + tasks.slice(0, 10).map((t) => taskLine(t, tz, now)).join("\n");
      break;
    }
    case "query_upcoming": {
      const upcoming = getUpcoming(userId, 7, now);
      if (upcoming.length === 0) reply = "No deadlines in the next 7 days.";
      else reply = "Upcoming deadlines:\n" + upcoming.slice(0, 10).map((t) => taskLine(t, tz, now)).join("\n");
      break;
    }
    case "query_finished": {
      const { tasks } = getFinished(userId, analysis.query?.period === "month" ? "month" : "week", now);
      if (tasks.length === 0) reply = "Nothing completed in that period yet.";
      else reply = `You completed ${tasks.length} task${tasks.length === 1 ? "" : "s"}:\n` + tasks.slice(0, 10).map((t) => `• ${t.title} (${friendlyDate(t.completed_at, tz, now)})`).join("\n");
      break;
    }
    case "query_unfinished": {
      const tasks = getUnfinished(userId, now);
      if (tasks.length === 0) reply = "Everything is done. Enjoy the win. 🎉";
      else reply = `${tasks.length} unfinished task${tasks.length === 1 ? "" : "s"}:\n` + tasks.slice(0, 10).map((t) => taskLine(t, tz, now)).join("\n");
      break;
    }
    case "query_focus": {
      const focus = getFocus(userId, now);
      if (focus.length === 0) reply = "Nothing on the list — a good time to add something or rest. 🙂";
      else {
        const top = focus[0]!;
        const why = top.deadline_at ? `due ${friendlyDate(top.deadline_at, tz, now)}` : `${top.priority.toLowerCase()} priority`;
        reply = `Focus on: “${top.title}” — ${why}.`;
        if (focus.length > 1) reply += `\nThen: ${focus.slice(1, 4).map((t) => `“${t.title}”`).join(", ")}.`;
      }
      break;
    }
    case "briefing": {
      const s = getDailySummary(userId, now);
      const lines = ["Good " + (zonedParts(now, tz).hour < 12 ? "morning" : zonedParts(now, tz).hour < 17 ? "afternoon" : "evening") + "! Here's your day:", "────────────"];
      lines.push(`Today: ${s.today.counts.total} task${s.today.counts.total === 1 ? "" : "s"} — ` +
        [s.today.counts.CRITICAL ? `🔴 ${s.today.counts.CRITICAL} critical` : "",
         s.today.counts.HIGH ? `🟠 ${s.today.counts.HIGH} high` : "",
         s.today.counts.MEDIUM ? `🟡 ${s.today.counts.MEDIUM} medium` : ""].filter(Boolean).join(", ") || "all clear");
      if (s.today.tasks.length) {
        lines.push("Deadlines:");
        for (const t of [...s.today.tasks].sort((a, b) => (a.deadline_at ?? "").localeCompare(b.deadline_at ?? "")).slice(0, 6)) {
          const time = t.deadline_at ? friendlyDateTime(t.deadline_at, tz, now) : "";
          lines.push(`  ${time} — ${t.title}`);
        }
      }
      if (s.waiting.length) lines.push(`Waiting for: ${s.waiting.length} response${s.waiting.length === 1 ? "" : "s"}`);
      if (s.overdue.length) lines.push(`Overdue: ${s.overdue.length} task${s.overdue.length === 1 ? "" : "s"}`);
      reply = lines.join("\n");
      break;
    }
    case "evening_review": {
      const s = getDailySummary(userId, now);
      const tz2 = tz;
      const start = todayStart(now, tz2);
      const db = getDb();
      const completedToday = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND status = 'completed' AND completed_at >= ?").get(userId, new Date(start).toISOString()) as { c: number };
      const createdToday = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND created_at >= ?").get(userId, new Date(start).toISOString()) as { c: number };
      const lines = ["Evening review:", "────────────"];
      lines.push(`Completed today: ${completedToday.c}`);
      lines.push(`New tasks created: ${createdToday.c}`);
      if (s.overdue.length) lines.push(`Overdue: ${s.overdue.length}`);
      if (s.today.tasks.length) {
        lines.push("Still due today:");
        for (const t of s.today.tasks.slice(0, 5)) lines.push(`  • ${t.title} (${t.priority})`);
      }
      const tomorrow = getUpcoming(userId, 1, now + DAY);
      if (tomorrow.length) {
        lines.push("Tomorrow:");
        for (const t of tomorrow.slice(0, 5)) lines.push(`  • ${t.title}`);
      }
      if (s.overdue.length > 0) lines.push("Tip: your overdue items should be first on tomorrow's list.");
      reply = lines.join("\n");
      break;
    }
    case "create_goal": {
      const g = analysis.goal!;
      const goal = createGoal(userId, { title: g.title, horizon: g.horizon, description: g.description });
      reply = `Goal set: "${goal.title}" (${goal.horizon}). Say "break it down" or "what should I do first for it?" and I'll turn it into concrete actions.`;
      break;
    }
    case "query_goals": {
      const goals = listGoals(userId, "active");
      if (goals.length === 0) {
        reply = "You haven't set any goals yet. Tell me: “My goal is …” and I'll track it.";
      } else {
        const lines = ["Your active goals:"];
        for (const g of goals) {
          const total = g.total_tasks ?? 0;
          const open = g.open_tasks ?? 0;
          lines.push(`• ${g.title} (${g.horizon}) — ${total === 0 ? "no tasks yet" : `${total - open}/${total} tasks done`}`);
        }
        reply = lines.join("\n");
      }
      break;
    }
    case "give_feedback": {
      const fb = analysis.feedback!;
      let targetType: string | undefined;
      let targetId: string | undefined;
      // Try to attach the feedback to a specific task when the user names one
      if (fb.category === "make_smaller" || fb.category === "not_important" || fb.category === "dont_suggest") {
        const stripped = fb.comment
          .replace(/\b(make|it|them|this|that|smaller|break|down|into|steps?|not|important|anymore|now|to me|don'?t|do not|stop|suggesting|suggest|reminding me about|nagging|recommending|task|the|a|an)\b/gi, " ")
          .replace(/\s+/g, " ").trim();
        if (stripped.split(" ").filter((w) => w.length > 1).length >= 1) {
          try {
            const task = findTaskByTitle(userId, stripped);
            targetType = "task";
            targetId = task.id;
          } catch {
            /* no specific task — global feedback */
          }
        }
      }
      const res = recordFeedback(userId, { category: fb.category as never, comment: fb.comment, targetType, targetId });
      reply = res.applied.length ? res.applied.join(" ") : "Feedback noted.";
      break;
    }
    case "weekly_summary": {
      const s = getWeeklySummary(userId, now);
      const lines = ["Weekly summary:", "────────────"];
      lines.push(`Completed: ${s.completedCount}`);
      lines.push(`Created: ${s.createdCount}`);
      lines.push(`Still open: ${s.pending}`);
      lines.push(`Overdue: ${s.overdue}`);
      if (s.topProjects.length) lines.push("Most active: " + s.topProjects.slice(0, 3).map((p) => `${p.name} (${p.count})`).join(", "));
      reply = lines.join("\n");
      break;
    }
    default:
      reply = "I couldn't understand that. Please try again.";
  }

  return { reply, intent: analysis.intent, toolCalls, mode: "rules" };
}

function taskDraftToArgs(t: TaskDraft): Record<string, unknown> {
  const args: Record<string, unknown> = {
    title: t.title,
    projectSlug: t.projectSlug,
    priority: t.priority,
    deadlineAt: t.deadlineAt,
    taskType: t.taskType,
    recurrence: t.recurrence,
    people: t.people,
    reminderAt: t.reminder?.at,
  };
  if (t.isFollowUp || t.followUp) {
    args.followUp = { entity: t.followUp?.entity || "", reason: t.followUp?.reason || "", at: t.followUp?.at };
  }
  for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
  return args;
}

// ─── Entry point ───────────────────────────────────────────────────────────────

export async function interpret(userId: string, text: string, ctx: InterpretContext = {} as InterpretContext): Promise<InterpretResult> {
  const start = Date.now();
  let llmResult: InterpretResult | null = null;
  if (isAiConfigured()) {
    try {
      llmResult = await llmInterpret(userId, text, ctx);
    } catch (e) {
      logger.warn("LLM interpretation failed, falling back to rules engine", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const result = llmResult ?? rulesInterpret(userId, text);
  logger.debug("interpret", { intent: result.intent, mode: result.mode, latencyMs: Date.now() - start });
  return result;
}

export const interpretTools = { executeTool, TOOL_SCHEMAS };