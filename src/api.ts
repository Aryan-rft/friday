/** API client — credentials-based session auth, JSON, offline capture queue. */

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const JSONH = { "content-type": "application/json" };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? JSONH : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "You're offline. Check your connection.");
  }
  if (res.status === 204) return {} as T;
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    if (res.status === 401 && !location.hash.includes("/login")) {
      location.hash = "#/login";
    }
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.code);
  }
  return data as T;
}

// ─── Offline capture queue (idempotent via clientId) ─────────────────────────

const QUEUE_KEY = "friday-queue";
export function queueSize(): number {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]").length;
  } catch {
    return 0;
  }
}

function enqueue(item: { method: string; path: string; body: Record<string, unknown> }): void {
  const q: { method: string; path: string; body: Record<string, unknown> }[] = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  // idempotency: replace queued item with same clientId
  const filtered = q.filter(
    (x) => !(x.path === item.path && x.body?.clientId && x.body.clientId === item.body?.clientId)
  );
  filtered.push(item);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(filtered));
}

export async function flushQueue(): Promise<number> {
  const q: { method: string; path: string; body: any }[] = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  if (q.length === 0) return 0;
  const remaining: typeof q = [];
  let synced = 0;
  for (const item of q) {
    try {
      await request(item.method, item.path, item.body);
      synced++;
    } catch (e) {
      if (e instanceof ApiError && e.status > 0 && e.status !== 401) {
        // permanently failed — drop but tell the truth later
      } else {
        remaining.push(item);
      }
    }
  }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  return synced;
}

/** Create a task; queues offline with a clientId so retries never duplicate. */
export async function createTaskSafe(task: Record<string, unknown>): Promise<{ task: any; queued: boolean }> {
  const clientId = task.clientId || crypto.randomUUID();
  const body = { ...task, clientId };
  if (!navigator.onLine) {
    enqueue({ method: "POST", path: "/api/tasks", body });
    return { task: null, queued: true };
  }
  try {
    return { task: await request("POST", "/api/tasks", body), queued: false };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
      enqueue({ method: "POST", path: "/api/tasks", body });
      return { task: null, queued: true };
    }
    throw e;
  }
}

// ─── Typed endpoints ─────────────────────────────────────────────────────────

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),

  // auth
  me: () => request<{ user: { id: string; name: string; email: string } | null }>("GET", "/api/auth/me"),
  login: async (email: string, password: string) => {
    const r = await fetch("/api/auth/login", { method: "POST", headers: JSONH, body: JSON.stringify({ email, password }), credentials: "same-origin" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, data.error || "Login failed");
    return data as { user: { id: string; name: string; email: string } };
  },
  signup: async (name: string, email: string, password: string) => {
    const r = await fetch("/api/auth/register", { method: "POST", headers: JSONH, body: JSON.stringify({ name, email, password }), credentials: "same-origin" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, data.error || "Registration failed");
    return data as { user: { id: string; name: string; email: string } };
  },
  logout: () => request<{ ok: boolean }>("POST", "/api/auth/logout"),

  // dashboard & briefs
  dashboard: () => request<any>("GET", "/api/dashboard"),
  dailyBrief: () => request<any>("GET", "/api/brief/daily"),
  eveningBrief: () => request<any>("GET", "/api/brief/evening"),

  // tasks
  tasks: (params: Record<string, string> = {}) =>
    request<{ tasks: any[] }>("GET", `/api/tasks?${new URLSearchParams(params)}`),
  task: (id: string) => request<{ task: any }>("GET", `/api/tasks/${id}`),
  createTask: (body: Record<string, unknown>) => request<{ task: any }>("POST", "/api/tasks", body),
  updateTask: (id: string, body: Record<string, unknown>) => request<{ task: any }>("PATCH", `/api/tasks/${id}`, body),
  completeTask: (id: string) => request<{ task: any }>("POST", `/api/tasks/${id}/complete`),
  deleteTask: (id: string) => request<{ ok: boolean }>("DELETE", `/api/tasks/${id}`),
  rescheduleTask: (id: string, deadlineAt: string) => request<{ task: any }>("POST", `/api/tasks/${id}/reschedule`, { deadlineAt }),
  subtasks: (id: string) => request<{ subtasks: any[] }>("GET", `/api/tasks/${id}/subtasks`),
  breakdown: (id: string) => request<{ subtasks: any[] }>("POST", `/api/tasks/${id}/breakdown`),
  completeSubtask: (id: string) => request<{ subtask: any }>("POST", `/api/subtasks/${id}/complete`),

  // projects & goals
  projects: () => request<{ projects: any[] }>("GET", "/api/projects"),
  createProject: (name: string) => request<{ project: any }>("POST", "/api/projects", { name }),
  goals: (status = "active") => request<{ goals: any[] }>("GET", `/api/goals?status=${status}`),
  createGoal: (body: { title: string; horizon?: string }) => request<{ goal: any }>("POST", "/api/goals", body),
  updateGoal: (id: string, body: Record<string, unknown>) => request<{ goal: any }>("PUT", `/api/goals/${id}`, body),
  breakdownGoal: (id: string) => request<{ tasks: any[] }>("POST", `/api/goals/${id}/breakdown`),

  // reminders / follow-ups / notifications
  reminders: () => request<{ reminders: any[] }>("GET", "/api/reminders"),
  deleteReminder: (id: string) => request<{ ok: boolean }>("DELETE", `/api/reminders/${id}`),
  followups: () => request<{ followUps: any[] }>("GET", "/api/followups"),
  completeFollowup: (id: string) => request<{ ok: boolean }>("POST", `/api/followups/${id}/complete`),
  notifications: () => request<{ notifications: any[] }>("GET", "/api/notifications"),
  markNotificationsRead: () => request<{ ok: boolean }>("POST", "/api/notifications/read"),

  // friday loop
  suggestions: () => request<{ suggestions: any[] }>("GET", "/api/suggestions"),
  dismissSuggestion: (key: string) => request<{ ok: boolean }>("POST", `/api/suggestions/${encodeURIComponent(key)}/dismiss`),
  snoozeSuggestion: (key: string) => request<{ ok: boolean }>("POST", `/api/suggestions/${encodeURIComponent(key)}/snooze`),
  feedback: (body: { category: string; comment?: string; targetType?: string; targetId?: string }) =>
    request<{ applied: string[] }>("POST", "/api/feedback", body),
  prefs: () => request<{ prefs: { key: string; value: unknown; evidence: number }[] }>("GET", "/api/prefs"),

  // assistant
  conversations: () => request<{ conversations: any[] }>("GET", "/api/assistant/conversations"),
  messages: (id: string) => request<{ messages: any[] }>("GET", `/api/assistant/conversations/${id}/messages`),

  // misc
  settings: () => request<{ settings: any; user: any }>("GET", "/api/settings"),
  saveSettings: (body: Record<string, unknown>) => request<{ settings: any }>("PUT", "/api/settings", body),
  activity: () => request<{ activity: any[] }>("GET", "/api/activity"),
  memories: () => request<{ memories: any[] }>("GET", "/api/memories"),
  remember: (content: string) => request<{ memory: any }>("POST", "/api/memories", { content }),
  forget: (id: string) => request<{ ok: boolean }>("DELETE", `/api/memories/${id}`),
  vapidKey: () => request<{ publicKey: string | null }>("GET", "/api/push/vapid-key"),
  pushSubscribe: (sub: PushSubscription) => request<{ ok: boolean }>("POST", "/api/push/subscribe", sub.toJSON()),
  pushUnsubscribe: (endpoint: string) => request<{ ok: boolean }>("POST", "/api/push/unsubscribe", { endpoint }),
};

/** Assistant message (kept separate to keep types honest). */
export async function sendAssistantMessage(message: string, conversationId?: string) {
  return request<{ reply: string; intent: string; mode: string; toolCalls: any[]; conversationId: string }>(
    "POST",
    "/api/assistant/message",
    { message, conversationId }
  );
}

/** Voice transcription (raw audio body). */
export async function transcribe(blob: Blob): Promise<string> {
  const res = await fetch("/api/voice/transcribe", {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm" },
    body: blob,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || "Voice recognition failed. Tap to retry.");
  return data.text as string;
}
