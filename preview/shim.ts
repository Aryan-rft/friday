/**
 * Preview/QA shim — NOT part of the app. Installs a fetch interceptor before any
 * app code runs, so the real views/components render against fixture data.
 */

const now = Date.now();
const H = 3_600_000;
const D = 86_400_000;

const u = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  description: "",
  status: "planned",
  effective_status: "planned",
  priority: "MEDIUM",
  task_type: "task",
  project_name: "",
  project_slug: "",
  people: [] as string[],
  deadline_at: null as string | null,
  ...extra,
});

const ALL_TASKS: any[] = [
  u("t1", "List every income stream and rate it: active, growing, dormant", {
    status: "today",
    effective_status: "today",
    priority: "HIGH",
    project_name: "Money",
    project_slug: "personal",
    deadline_at: new Date(now + 2 * H).toISOString(),
  }),
  u("t2", "Write the one-page plan: offer, customer, price, channel", {
    status: "today",
    effective_status: "today",
    priority: "CRITICAL",
    project_name: "Business",
    project_slug: "general",
    deadline_at: new Date(now + 5 * H).toISOString(),
  }),
  u("t3", "Fix a consistent sleep window for 14 days", {
    status: "today",
    effective_status: "today",
    priority: "MEDIUM",
    project_name: "Personal",
    project_slug: "personal",
    deadline_at: new Date(now + 12 * H).toISOString(),
  }),
  u("t4", "Send follow-up deck to CEO", {
    status: "waiting",
    effective_status: "waiting",
    priority: "HIGH",
    project_name: "AI Employees",
    project_slug: "ai-employees",
    deadline_at: new Date(now + 1.2 * D).toISOString(),
  }),
  u("t5", "Slides for Thursday's expert lecture", {
    status: "planned",
    effective_status: "planned",
    priority: "HIGH",
    project_name: "Expert Lectures",
    project_slug: "expert-lectures",
    deadline_at: new Date(now + 4 * D).toISOString(),
  }),
  u("t6", "Sketch AI-employee pitch outline", {
    status: "planned",
    effective_status: "planned",
    priority: "MEDIUM",
    project_name: "AI Employees",
    project_slug: "ai-employees",
    deadline_at: new Date(now + 6 * D).toISOString(),
  }),
  u("t7", "Reconcile KUK invoices", {
    status: "planned",
    effective_status: "overdue",
    priority: "HIGH",
    project_name: "KUK",
    project_slug: "kuk",
    deadline_at: new Date(now - 1.5 * D).toISOString(),
  }),
];

const overdueTask = () => ALL_TASKS.find((t) => t.id === "t7")!;
const todayTasks = () => ALL_TASKS.filter((t) => t.effective_status === "today");

const DASHBOARD = () => ({
  stats: { today: todayTasks().length, urgent: 3, overdue: 1, waiting: 1 },
  today: { tasks: todayTasks() },
  overdue: [overdueTask()],
  upcoming: [ALL_TASKS[4], ALL_TASKS[5]],
  waiting: {
    followUps: [
      { entity: "Rita ma'am", reason: "internship requirements", follow_up_at: new Date(now + 2 * D).toISOString() },
      { entity: "Outreach team", reason: "scraped companies list", follow_up_at: new Date(now + 3 * D).toISOString() },
    ],
  },
  activity: [
    { action: "create_goal", detail: '{"title":"Build Money"}', created_at: new Date(now - 26 * H).toISOString() },
    { action: "create_task", detail: '{"title":"Slides for the expert lecture"}', created_at: new Date(now - 20 * H).toISOString() },
    { action: "complete_task", detail: '{"title":"Inbox zero pass"}', created_at: new Date(now - 5 * H).toISOString() },
  ],
});

function completeTask(id: string): unknown {
  const t = ALL_TASKS.find((x) => x.id === id);
  if (!t) return { error: "not found" };
  t.effective_status = "completed";
  t.status = "completed";
  return { task: t };
}

const SUGGESTIONS = () => ({
  suggestions: [
    { key: "s1", kind: "overdue_cleanup", title: "Reconcile KUK invoices has been sitting overdue", detail: "Overdue by 2 days — move it or drop it." },
    { key: "s2", kind: "follow_up_due", title: "Rita ma'am follow-up is due", detail: "You promised to check in about internship requirements." },
    { key: "s3", kind: "goal_stale", title: "Goal Build Life has no tasks yet", detail: "Break it into starter actions." },
  ],
});

const SETTINGS = () => ({
  settings: { brief_time: "08:00", evening_review_time: "19:00", auto_remind: 1, timezone: "Asia/Kolkata" },
  user: { id: "u1", name: "Aryan", email: "aryan@friday.local" },
});

const GOALS = () => ({
  goals: [
    { id: "g1", title: "Build Money", horizon: "year", status: "active", total_tasks: 4, open_tasks: 4 },
    { id: "g2", title: "Build Business", horizon: "year", status: "active", total_tasks: 4, open_tasks: 3 },
    { id: "g3", title: "Build Health", horizon: "quarter", status: "active", total_tasks: 3, open_tasks: 3 },
    { id: "g4", title: "Build Life", horizon: "life", status: "active", total_tasks: 0, open_tasks: 0 },
  ],
});

const PROJECTS = () => ({
  projects: [
    { slug: "personal", name: "Personal", task_count: 5, open_count: 3 },
    { slug: "general", name: "General", task_count: 4, open_count: 4 },
    { slug: "expert-lectures", name: "Expert Lectures", task_count: 2, open_count: 2 },
    { slug: "ai-employees", name: "AI Employees", task_count: 2, open_count: 2 },
    { slug: "kuk", name: "KUK", task_count: 3, open_count: 3 },
  ],
});

const ASSISTANT_REPLY = () => ({
  reply: 'Added: "Slides for the expert lecture" — Expert Lectures · due Thursday 17:00 · high priority · reminder set 🔔',
  intent: "create_task",
  mode: "rules",
  toolCalls: [],
  conversationId: "c1",
});

// ─── Response helper ─────────────────────────────────────────────────────────

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeParse(b: unknown): any {
  if (typeof b !== "string") return b;
  try {
    return JSON.parse(b);
  } catch {
    return b;
  }
}

// ─── Install ─────────────────────────────────────────────────────────────────

export function installShim(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const urlish = raw.startsWith("http") ? new URL(raw).pathname + new URL(raw).search : raw;
    const path = urlish.split("?")[0]; // views pass filter params; fixtures ignore them
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? safeParse(init.body) : undefined;
    const byId = /^\/api\/(?:tasks|goals|subtasks|reminders|followups|memories|suggestions|projects)\/([^/]+)(\/[^/]+)?$/;

    // Auth (harness is pre-authenticated)
    if (path === "/api/auth/me") return json({ user: { id: "u1", name: "Aryan", email: "aryan@friday.local" } });
    if (path === "/api/auth/login" || path === "/api/auth/register") {
      return json({ user: { id: "u1", name: "Aryan", email: "aryan@friday.local" } });
    }
    if (path === "/api/auth/logout") return json({ ok: true });

    // Dashboard & briefs
    if (path === "/api/dashboard") return json(DASHBOARD());
    if (path === "/api/brief/daily") {
      return json({
        today: { counts: { total: todayTasks().length, CRITICAL: 1, HIGH: 2, MEDIUM: 1 }, tasks: todayTasks() },
        overdue: [overdueTask()],
        focus: [ALL_TASKS[1]],
      });
    }
    if (path === "/api/brief/evening") return json({ ok: true });

    // Friday loop
    if (path === "/api/suggestions") return json(SUGGESTIONS());
    if (/^\/api\/suggestions\/[^/]+\/(dismiss|snooze)$/.test(path)) return json({ ok: true });
    if (path === "/api/feedback") return json({ applied: ["dont_suggest"] });
    if (path === "/api/prefs") {
      return json({
        prefs: [
          { key: "preferred_work_hour", value: "night", evidence: 2 },
          { key: "reminder_bias_minutes", value: 30, evidence: 1 },
        ],
      });
    }

    // Tasks
    if (path === "/api/tasks" && method === "GET") {
      return json({ tasks: ALL_TASKS.filter((t) => t.effective_status !== "completed") });
    }
    if (path === "/api/tasks" && method === "POST") {
      const t = u(body?.clientId || `new-${ALL_TASKS.length + 1}`, body?.title || "Untitled task", {
        priority: body?.priority || "MEDIUM",
        project_name: body?.projectSlug || "",
        notes: body?.notes || "",
      });
      ALL_TASKS.push(t);
      return json({ task: t });
    }
    if (/^\/api\/tasks\/[^/]+\/complete$/.test(path)) return json(completeTask(path.split("/")[3]));
    if (/^\/api\/tasks\/[^/]+\/reschedule$/.test(path)) {
      const t = ALL_TASKS.find((x) => x.id === path.split("/")[3]);
      if (t) t.deadline_at = body?.deadlineAt ?? t.deadline_at;
      return json({ task: t ?? { ok: true } });
    }
    if (/^\/api\/tasks\/[^/]+\/subtasks$/.test(path)) return json({ subtasks: [] });
    if (/^\/api\/tasks\/[^/]+\/breakdown$/.test(path)) {
      return json({
        subtasks: [
          { id: "st1", title: "Draft the outline", status: "open" },
          { id: "st2", title: "Fill in the details", status: "open" },
          { id: "st3", title: "Review and polish", status: "open" },
        ],
      });
    }
    if (/^\/api\/subtasks\/[^/]+\/complete$/.test(path)) return json({ subtask: { ok: true } });
    if (byId.test(path) && path.startsWith("/api/tasks/")) {
      const id = path.split("/")[3];
      const t = ALL_TASKS.find((x) => x.id === id);
      if (method === "PATCH" && t) {
        Object.assign(t, body || {});
        return json({ task: t });
      }
      if (method === "DELETE") return json({ ok: true });
      return json({ task: t ?? { ok: true } });
    }

    // Projects & goals
    if (path === "/api/projects" && method === "GET") return json(PROJECTS());
    if (path === "/api/projects" && method === "POST") return json({ project: { slug: body?.name?.toLowerCase() || "new", name: body?.name || "New", task_count: 0, open_count: 0 } });
    if (path === "/api/goals") return json(GOALS());
    if (path === "/api/goals" && method === "POST") return json({ goal: { id: "g-new", title: body?.title || "New goal", horizon: body?.horizon || "quarter", status: "active", total_tasks: 0, open_tasks: 0 } });
    if (/^\/api\/goals\/[^/]+\/breakdown$/.test(path)) return json({ tasks: [] });
    if (/^\/api\/goals\/[^/]+$/.test(path)) return json({ goal: { ok: true, status: body?.status } });

    // Reminders / follow-ups / notifications
    if (path === "/api/reminders") {
      return json({
        reminders: [
          { id: "r1", title: "Reconcile KUK invoices", remind_at: new Date(now + 2 * H).toISOString(), kind: "deadline" },
          { id: "r2", title: "Slides for the expert lecture", remind_at: new Date(now + 3.5 * D).toISOString(), kind: "deadline" },
        ],
      });
    }
    if (path === "/api/followups") {
      return json({
        followUps: [
          { id: "f1", entity: "Rita ma'am", reason: "internship requirements", follow_up_at: new Date(now + 2 * D).toISOString(), status: "active" },
        ],
      });
    }
    if (/^\/api\/followups\/[^/]+\/complete$/.test(path)) return json({ ok: true });
    if (/^\/api\/reminders\/[^/]+$/.test(path)) return json({ ok: true });
    if (path === "/api/notifications") return json({ notifications: [] });
    if (path === "/api/notifications/read") return json({ ok: true });

    // Assistant
    if (path === "/api/assistant/conversations") return json({ conversations: [] });
    if (/^\/api\/assistant\/conversations\/[^/]+\/messages$/.test(path)) return json({ messages: [] });
    if (path === "/api/assistant/message") return json(ASSISTANT_REPLY());

    // Settings / activity / memories / push / voice
    if (path === "/api/settings" && method === "GET") return json(SETTINGS());
    if (path === "/api/settings" && method === "PUT") return json({ settings: { ...SETTINGS().settings, ...body } });
    if (path === "/api/activity") return json({ activity: DASHBOARD().activity });
    if (path === "/api/memories" && method === "GET") {
      return json({ memories: [{ id: "m1", content: "KUK = Kurukshetra University — cybersecurity training engagement." }] });
    }
    if (path === "/api/memories" && method === "POST") return json({ memory: { id: "m-new", content: body?.content || "" } });
    if (/^\/api\/memories\/[^/]+$/.test(path)) return json({ ok: true });
    if (path === "/api/push/vapid-key") return json({ publicKey: null });
    if (path === "/api/push/subscribe" || path === "/api/push/unsubscribe") return json({ ok: true });
    if (path === "/api/voice/transcribe") {
      return json({ text: "Kal KUK mein twelve thirty wali lecture ke liye final slides check karni hain." });
    }

    // Anything else: succeed generically so optional calls never break QA.
    return json({ ok: true });
  };
}

installShim();
export {};
