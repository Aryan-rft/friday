/** All app views. Each returns an HTMLElement; data fetched fresh per render. */

import { el, toast, openModal, confirmModal } from "./ui.js";
import { icons } from "./icons.js";
import { api, createTaskSafe, sendAssistantMessage, ApiError } from "./api.js";
import { taskItem, newTaskModal, fmtDue, type AppCtx } from "./components.js";

// ─── Login / signup ──────────────────────────────────────────────────────────

export function loginView(mode: "login" | "signup", onDone: () => void): HTMLElement {
  const name = el("input", { type: "text", placeholder: "Your name", autocomplete: "name" });
  const email = el("input", { type: "email", placeholder: "you@example.com", autocomplete: "email" });
  const pass = el("input", { type: "password", placeholder: "••••••••", autocomplete: mode === "login" ? "current-password" : "new-password" });
  const err = el("div", { class: "error-text" });
  const btn = el("button", { class: "btn primary block", style: { marginTop: "16px" }, text: mode === "login" ? "Sign in" : "Create account" });

  async function submit() {
    err.textContent = "";
    btn.disabled = true;
    try {
      if (mode === "login") await api.login(email.value.trim(), pass.value);
      else await api.signup(name.value.trim() || "Aryan", email.value.trim(), pass.value);
      onDone();
    } catch (e: any) {
      err.textContent = e.message || "Something went wrong.";
    } finally {
      btn.disabled = false;
    }
  }
  btn.addEventListener("click", submit);
  for (const input of [email, pass, name]) input.addEventListener("keydown", (e) => e.key === "Enter" && submit());

  return el(
    "div",
    { class: "auth-wrap" },
    el(
      "div",
      { class: "auth-card" },
      el("h1", {}, el("span", { class: "logo-dot", style: { display: "inline-block", width: "12px", height: "12px", borderRadius: "50%", background: "linear-gradient(135deg,var(--accent),#9f7bff)", boxShadow: "0 0 12px var(--accent)", marginRight: "8px", verticalAlign: "middle" } }), "Friday"),
      el("p", { class: "tagline", text: mode === "login" ? "Your personal assistant. Speak, and it remembers." : "A few seconds and Friday is yours." }),
      ...(mode === "signup" ? [el("label", { text: "Name" }), name] : []),
      el("label", { text: "Email" }), email,
      el("label", { text: "Password" }), pass,
      err, btn,
      el(
        "div",
        { class: "auth-switch" },
        mode === "login" ? "New here? " : "Already have an account? ",
        el("a", { href: mode === "login" ? "#/signup" : "#/login", text: mode === "login" ? "Create an account" : "Sign in" })
      )
    )
  );
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function skeletonList(n = 3): HTMLElement[] {
  return Array.from({ length: n }, () => el("div", { class: "skeleton" }));
}

function emptyState(emoji: string, message: string, hint?: string): HTMLElement {
  return el("div", { class: "empty" }, el("div", { class: "big", text: emoji }), el("div", { text: message }), hint ? el("div", { class: "faint", text: hint }) : el("span"));
}

function statCard(num: number | string, label: string, onclick?: () => void, color?: string): HTMLElement {
  return el(
    "div",
    { class: "stat", onclick, role: "button", tabindex: "0" },
    el("div", { class: "num", text: String(num), style: color ? { color } : undefined }),
    el("div", { class: "lbl", text: label })
  );
}

function section(title: string, body: HTMLElement, extra?: HTMLElement): HTMLElement {
  const card = el("div", { class: "card" }, el("h2", {}, el("span", { html: title })), body);
  if (extra) card.append(extra);
  return card;
}

// ─── Suggestions (Friday's proactive brain) ──────────────────────────────────

const SUGG_EMOJI: Record<string, string> = {
  overdue_cleanup: "🔥", upcoming_deadline: "⏰", follow_up_due: "📞", goal_stale: "🎯", evening_planning: "🌙", neglected_task: "🗓️",
};

function suggestionItem(s: any, ctx: AppCtx): HTMLElement {
  const act = async () => {
    const t = s.title.replace(/["“”]/g, "");
    const canned: Record<string, string> = {
      overdue_cleanup: `Move "${t}" to tomorrow`,
      upcoming_deadline: `Remind me 2 hours before the deadline for "${t}"`,
      follow_up_due: `What am I waiting for?`,
      goal_stale: `Break down my goal ${t.replace(/^Goal /, "")}`,
      evening_planning: `Evening review`,
      neglected_task: `Plan "${t.replace(/^"|" has been sitting.*$/g, "")}" for this week`,
    };
    try {
      const r = await sendAssistantMessage(canned[s.kind] || s.title);
      toast(r.reply, "ok", 5200);
      ctx.refresh();
    } catch (e: any) {
      toast(e.message, "err");
    }
  };
  return el(
    "div",
    { class: "sugg" },
    el("span", { class: "s-emoji", text: SUGG_EMOJI[s.kind] || "💡" }),
    el(
      "div",
      { style: { flex: "1", minWidth: "0" } },
      el("div", { class: "s-title", text: s.title }),
      s.detail ? el("div", { class: "s-detail", text: s.detail }) : el("span")
    ),
    el(
      "div",
      { class: "s-actions" },
      el("button", { class: "btn small primary", text: "Do it", onclick: act }),
      el("button", {
        class: "btn small ghost",
        text: "Snooze",
        title: "Remind me tomorrow",
        onclick: async () => {
          try {
            await api.snoozeSuggestion(s.key);
            toast("Snoozed until tomorrow.", "ok");
            ctx.refresh();
          } catch (e: any) {
            toast(e.message, "err");
          }
        },
      }),
      el("button", {
        class: "btn small ghost",
        text: "✕",
        title: "Don't suggest this",
        onclick: async () => {
          try {
            await api.dismissSuggestion(s.key);
            // Learning signal: explicit dismiss counts as "don't suggest"
            await api.feedback({ category: "dont_suggest", targetType: "suggestion", targetId: s.key });
            toast("Won't suggest this again.", "ok");
            ctx.refresh();
          } catch (e: any) {
            toast(e.message, "err");
          }
        },
      })
    )
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export async function dashboardView(ctx: AppCtx): Promise<HTMLElement> {
  const wrap = el("div", {}, ...skeletonList(4));
  try {
    const [d, sugg] = await Promise.all([api.dashboard(), api.suggestions()]);
    wrap.replaceChildren();

    // Stats
    const st = d.stats;
    wrap.append(
      el(
        "div",
        { class: "grid stats-grid" },
        statCard(st.today, "Today", () => ctx.go("today")),
        statCard(st.urgent, "Urgent", () => ctx.go("tasks"), st.urgent ? "var(--high)" : undefined),
        statCard(st.overdue, "Overdue", () => ctx.go("tasks"), st.overdue ? "var(--crit)" : undefined),
        statCard(st.waiting, "Waiting", () => ctx.go("tasks"))
      )
    );

    // Suggestions
    if (sugg.suggestions?.length) {
      wrap.append(
        section(
          "⚡ Friday thinks",
          el("div", { class: "sugg-list" }, ...sugg.suggestions.map((s: any) => suggestionItem(s, ctx)))
        )
      );
    }

    // Today's timeline
    const todayBody = el("div");
    if (!d.today.tasks.length) todayBody.append(emptyState("🌤️", "Nothing due today.", "Say “Friday, I need to…” to capture something."));
    else {
      const sorted = [...d.today.tasks].sort((a, b) => (a.deadline_at ?? "").localeCompare(b.deadline_at ?? ""));
      for (const t of sorted) todayBody.append(taskItem(t, ctx));
    }
    wrap.append(section("📆 Today", todayBody, el("button", { class: "btn small", text: "+ Add", onclick: () => newTaskModal(ctx) })));

    // Overdue
    if (d.overdue.length) {
      const body = el("div");
      for (const t of d.overdue.slice(0, 4)) body.append(taskItem(t, ctx));
      wrap.append(section("🔥 Overdue", body));
    }

    // Focus
    if (d.upcoming.length) {
      const body = el("div");
      for (const t of d.upcoming.slice(0, 5)) {
        body.append(
          el(
            "div",
            { class: "task-item" },
            el("span", { text: "🗓️" }),
            el(
              "div",
              { class: "task-body" },
              el("div", { class: "task-title", text: t.title }),
              el("div", { class: "task-meta" }, el("span", { class: "chip", text: fmtDue(t) }), t.project_name ? el("span", { class: "chip", text: t.project_name }) : el("span"))
            )
          )
        );
      }
      wrap.append(section("⏭️ Coming up", body));
    }

    // Waiting
    if (d.waiting.followUps?.length) {
      const body = el("div");
      for (const f of d.waiting.followUps.slice(0, 5)) {
        body.append(
          el(
            "div",
            { class: "task-item" },
            el("span", { text: "📞" }),
            el(
              "div",
              { class: "task-body" },
              el("div", { class: "task-title", text: f.entity || "Someone" }),
              el("div", { class: "task-meta" }, f.reason ? el("span", { class: "chip", text: f.reason }) : el("span"), f.follow_up_at ? el("span", { class: "chip", text: fmtDue({ deadline_at: f.follow_up_at }) }) : el("span"))
            )
          )
        );
      }
      wrap.append(section("📞 Waiting for", body));
    }

    // Recent activity
    if (d.activity.length) {
      const body = el("div", { class: "small muted" });
      const labels: Record<string, string> = {
        create_task: "created", complete_task: "completed ✅", update_task: "updated", delete_task: "deleted",
        create_reminder: "set a reminder for", create_follow_up: "started a follow-up with", create_goal: "set a goal:",
        remember: "remembered", breakdown: "broke down",
      };
      for (const a of d.activity.slice(0, 6)) {
        let detail = "";
        try {
          const j = JSON.parse(a.detail || "{}");
          detail = j.title || j.entity || j.content || "";
        } catch { /* ignore */ }
        body.append(el("div", { text: `${labels[a.action] || a.action} ${detail} · ${new Date(a.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` }));
      }
      wrap.append(section("🕘 Recent", body));
    }
  } catch (e: any) {
    wrap.replaceChildren(emptyState("📡", e.message || "Couldn't load your dashboard.", "Check your connection and try again."));
  }
  return wrap;
}

// ─── Today ───────────────────────────────────────────────────────────────────

export async function todayView(ctx: AppCtx): Promise<HTMLElement> {
  const wrap = el("div", {}, ...skeletonList(3));
  try {
    const d = await api.dailyBrief();
    wrap.replaceChildren();
    const c = d.today.counts;
    wrap.append(
      el(
        "div",
        { class: "grid stats-grid" },
        statCard(c.total, "Due today"),
        statCard(c.CRITICAL ?? 0, "Critical", undefined, (c.CRITICAL ?? 0) ? "var(--crit)" : undefined),
        statCard(c.HIGH ?? 0, "High", undefined, (c.HIGH ?? 0) ? "var(--high)" : undefined),
        statCard(d.overdue.length, "Overdue", undefined, d.overdue.length ? "var(--crit)" : undefined)
      )
    );
    const body = el("div");
    const all = [...d.today.tasks, ...d.overdue];
    if (!all.length) body.append(emptyState("🎉", "Nothing due today. Enjoy the clean slate."));
    else for (const t of all.sort((a, b) => (a.deadline_at ?? "").localeCompare(b.deadline_at ?? ""))) body.append(taskItem(t, ctx));
    wrap.append(body);

    if (d.focus?.length) {
      const f = el("div");
      f.append(el("p", { class: "muted small", text: "If you only do one thing, make it this:" }));
      const top = d.focus[0];
      f.append(
        el(
          "div",
          { class: "card", style: { borderColor: "var(--accent)" } },
          el("strong", { text: top.title }),
          el("div", { class: "task-meta", style: { marginTop: "6px" } }, top.deadline_at ? el("span", { class: "chip", text: fmtDue(top) }) : el("span"), el("span", { class: `chip p-${top.priority}`, text: `${top.priority.toLowerCase()} priority` }))
        )
      );
      wrap.append(section("🎯 Focus", f));
    }
  } catch (e: any) {
    wrap.replaceChildren(emptyState("📡", e.message || "Couldn't load today."));
  }
  return wrap;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

let tasksFilter = { status: "active", search: "", project: "" };

export async function tasksView(ctx: AppCtx): Promise<HTMLElement> {
  const wrap = el("div");

  const search = el("input", { type: "search", placeholder: "Search tasks…", value: tasksFilter.search, "aria-label": "Search tasks" });
  search.addEventListener("input", () => {
    tasksFilter.search = search.value;
    void load();
  });

  const chips = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", flex: "0" } });
  const FILTERS: [string, string][] = [
    ["active", "Open"], ["overdue", "Overdue"], ["today", "Today"], ["waiting", "Waiting"], ["completed", "Done"],
  ];
  for (const [id, label] of FILTERS) {
    chips.append(
      el("button", {
        class: `btn small ${tasksFilter.status === id ? "primary" : ""}`,
        text: label,
        onclick: () => {
          tasksFilter.status = id;
          void render();
        },
      })
    );
  }
  chips.append(el("button", { class: "btn small", text: "+ New", onclick: () => newTaskModal(ctx) }));

  const toolbar = el("div", { class: "row", style: { flexWrap: "wrap", marginBottom: "12px" } }, search, chips);
  const listWrap = el("div");
  wrap.append(toolbar, listWrap);

  async function load() {
    listWrap.replaceChildren(...skeletonList(3));
    try {
      const params: Record<string, string> = { status: tasksFilter.status };
      if (tasksFilter.search) params.search = tasksFilter.search;
      if (tasksFilter.project) params.projectSlug = tasksFilter.project;
      if (tasksFilter.status === "completed") params.includeCompleted = "true";
      const { tasks } = await api.tasks(params);
      listWrap.replaceChildren();
      if (!tasks.length) listWrap.append(emptyState("🗂️", tasksFilter.search ? "Nothing matches that search." : "No tasks here.", "Press N or tap + to capture one."));
      else for (const t of tasks) listWrap.append(taskItem(t, ctx));
    } catch (e: any) {
      listWrap.replaceChildren(emptyState("📡", e.message || "Couldn't load tasks."));
    }
  }
  async function render() {
    // rebuild chip active states
    for (const btn of Array.from(chips.querySelectorAll("button"))) {
      const f = FILTERS.find((x) => x[1] === btn.textContent);
      if (f) btn.className = `btn small ${f[0] === tasksFilter.status ? "primary" : ""}`;
    }
    await load();
  }
  await load();
  return wrap;
}

// ─── Projects ────────────────────────────────────────────────────────────────

export async function projectsView(ctx: AppCtx): Promise<HTMLElement> {
  const wrap = el("div", {}, ...skeletonList(2));
  try {
    const { projects } = await api.projects();
    wrap.replaceChildren();

    const grid = el("div", { class: "grid", style: { gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" } });
    for (const p of projects) {
      const pct = p.task_count ? Math.round(((p.task_count - p.open_count) / p.task_count) * 100) : 0;
      grid.append(
        el(
          "div",
          {
            class: "stat",
            onclick: () => {
              tasksFilter = { status: "active", search: "", project: p.slug };
              ctx.go("tasks");
            },
          },
          el("div", { class: "row", style: { justifyContent: "space-between" } }, el("strong", { text: p.name }), el("span", { class: "chip", text: String(p.open_count) })),
          el("div", { class: "progress" }, el("div", { style: { width: `${pct}%` } })),
          el("div", { class: "faint", text: `${p.open_count} open · ${p.task_count} total` })
        )
      );
    }
    wrap.append(grid);

    const nameInput = el("input", { type: "text", placeholder: "New project name", "aria-label": "New project name" });
    const err = el("div", { class: "error-text" });
    wrap.append(
      section(
        "➕ New project",
        el(
          "div",
          { class: "row" },
          nameInput,
          el("button", {
            class: "btn primary",
            text: "Create",
            onclick: async () => {
              if (!nameInput.value.trim()) return;
              try {
                await api.createProject(nameInput.value.trim());
                toast("Project created ✅", "ok");
                ctx.refresh();
              } catch (e: any) {
                err.textContent = e.message;
              }
            },
          }),
          err
        )
      )
    );
  } catch (e: any) {
    wrap.replaceChildren(emptyState("📡", e.message || "Couldn't load projects."));
  }
  return wrap;
}

// ─── Goals ───────────────────────────────────────────────────────────────────

export async function goalsView(ctx: AppCtx): Promise<HTMLElement> {
  const wrap = el("div", {}, ...skeletonList(2));
  try {
    const { goals } = await api.goals();
    wrap.replaceChildren();

    const body = el("div");
    if (!goals.length) {
      body.append(emptyState("🎯", "No goals yet.", "Tell Friday: “My goal is to build the business this year.”"));
    } else {
      for (const g of goals) {
        const total = g.total_tasks ?? 0;
        const open = g.open_tasks ?? 0;
        const pct = total ? Math.round(((total - open) / total) * 100) : 0;
        body.append(
          el(
            "div",
            { class: "card" },
            el(
              "div",
              { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start" } },
              el(
                "div",
                { style: { flex: "1", minWidth: "0" } },
                el("h2", { text: g.title }),
                el("div", { class: "task-meta" }, el("span", { class: "chip", text: g.horizon }), el("span", { class: "chip", text: total ? `${total - open}/${total} done` : "no tasks yet" }))
              ),
              el(
                "div",
                { class: "row", style: { flex: "0", flexWrap: "wrap" } },
                el("button", {
                  class: "btn small",
                  text: "Break down",
                  title: "Create starter tasks for this goal",
                  onclick: async () => {
                    try {
                      const r = await api.breakdownGoal(g.id);
                      toast(`${r.tasks.length} tasks created and linked 🎯`, "ok");
                      ctx.refresh();
                    } catch (e: any) {
                      toast(e.message, "err");
                    }
                  },
                }),
                el("button", {
                  class: "btn small ghost",
                  text: "✓ Achieved",
                  onclick: async () => {
                    if (await confirmModal("Achieve goal", `Mark "${g.title}" as achieved?`)) {
                      await api.updateGoal(g.id, { status: "achieved" });
                      toast("Goal achieved! 🎉", "ok");
                      ctx.refresh();
                    }
                  },
                }),
                el("button", {
                  class: "btn small ghost",
                  text: "✕",
                  title: "Drop goal",
                  onclick: async () => {
                    if (await confirmModal("Drop goal", `Drop "${g.title}"? You can't undo this from the UI.`)) {
                      await api.updateGoal(g.id, { status: "dropped" });
                      ctx.refresh();
                    }
                  },
                })
              )
            ),
            total ? el("div", { class: "progress" }, el("div", { style: { width: `${pct}%` } })) : el("span")
          )
        );
      }
    }
    wrap.append(body);

    // New goal form
    const title = el("input", { type: "text", placeholder: "e.g. Build Expertise", "aria-label": "Goal title" });
    const horizon = el(
      "select",
      { "aria-label": "Horizon" },
      ...["week", "month", "quarter", "year", "life"].map((h) => el("option", { value: h, text: h }))
    );
    horizon.value = "quarter";
    wrap.append(
      section(
        "➕ New goal",
        el(
          "div",
          { class: "row" },
          title,
          el("div", { style: { maxWidth: "120px" } }, horizon),
          el("button", {
            class: "btn primary",
            text: "Set goal",
            onclick: async () => {
              if (!title.value.trim()) return;
              try {
                await api.createGoal({ title: title.value.trim(), horizon: horizon.value });
                toast("Goal set 🎯", "ok");
                ctx.refresh();
              } catch (e: any) {
                toast(e.message, "err");
              }
            },
          })
        )
      )
    );
  } catch (e: any) {
    wrap.replaceChildren(emptyState("📡", e.message || "Couldn't load goals."));
  }
  return wrap;
}

// ─── Assistant ───────────────────────────────────────────────────────────────

let assistantConvId = "";

export async function assistantView(ctx: AppCtx): Promise<HTMLElement> {
  const log = el("div", { class: "chat-log", "aria-live": "polite" });
  const input = el("input", { type: "text", placeholder: "Ask or tell Friday anything…", "aria-label": "Message Friday" });
  const send = el("button", { class: "btn primary", html: icons.send, "aria-label": "Send" });

  function addMsg(role: "user" | "assistant", text: string, typing = false) {
    const m = el("div", { class: `msg ${role} ${typing ? "typing" : ""}`, text });
    log.append(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }

  async function sendText(text: string) {
    if (!text.trim()) return;
    input.value = "";
    addMsg("user", text);
    const typing = addMsg("assistant", "…", true);
    try {
      const r = await sendAssistantMessage(text, assistantConvId || undefined);
      assistantConvId = r.conversationId;
      localStorage.setItem("friday-conv", assistantConvId);
      typing.textContent = r.reply;
      log.scrollTop = log.scrollHeight;
      ctx.refresh();
    } catch (e: any) {
      typing.textContent = e.status === 0 ? "You're offline — captures still queue up, but I can't think right now." : e.message || "I couldn't process that. Try again?";
      typing.classList.add("typing");
    }
  }

  send.addEventListener("click", () => void sendText(input.value));
  input.addEventListener("keydown", (e) => e.key === "Enter" && void sendText(input.value));

  const quick = el(
    "div",
    { class: "row", style: { flexWrap: "wrap", gap: "6px", flex: "0", marginBottom: "8px" } },
    ...["Brief me", "What's urgent?", "What am I waiting for?", "Evening review", "What are my goals?"].map((q) =>
      el("button", { class: "btn small", text: q, onclick: () => void sendText(q) })
    )
  );

  // Load history
  const saved = localStorage.getItem("friday-conv");
  if (saved) {
    try {
      const { messages } = await api.messages(saved);
      assistantConvId = saved;
      for (const m of messages.slice(-30)) addMsg(m.role === "user" ? "user" : "assistant", m.content);
    } catch {
      localStorage.removeItem("friday-conv");
    }
  }
  if (!log.children.length) {
    addMsg("assistant", "Hey! I'm Friday. Tell me what's on your mind — tasks, deadlines, follow-ups, goals — in English or Hinglish. Or ask me what's up. 🎤");
  }

  return el(
    "div",
    { class: "chat-box" },
    el("div", {}, quick),
    log,
    el("div", { class: "chat-input-row" }, input, send)
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────

export async function settingsView(ctx: AppCtx): Promise<HTMLElement> {
  const wrap = el("div", {}, ...skeletonList(2));
  try {
    const { settings, user } = await api.settings();
    wrap.replaceChildren();

    // Profile
    const name = el("input", { type: "text", value: user?.name ?? "", "aria-label": "Your name" });
    wrap.append(
      section(
        "👤 You",
        el(
          "div",
          {},
          el("label", { text: "Name" }),
          name,
          el("div", { class: "faint", text: user?.email ?? "" }),
          el("button", {
            class: "btn",
            style: { marginTop: "12px" },
            text: "Save",
            onclick: async () => {
              try {
                await api.saveSettings({ name: name.value.trim() });
                toast("Saved ✅", "ok");
                ctx.refresh();
              } catch (e: any) {
                toast(e.message, "err");
              }
            },
          })
        )
      )
    );

    // Reminders & briefings
    const briefTime = el("input", { type: "time", value: settings?.brief_time ?? "08:00" });
    const eveningTime = el("input", { type: "time", value: settings?.evening_review_time ?? "19:00" });
    const autoRemind = el("input", { type: "checkbox", checked: !!settings?.auto_remind, style: { width: "auto" } });
    wrap.append(
      section(
        "⏰ Rhythm",
        el(
          "div",
          {},
          el("div", { class: "row" }, el("div", {}, el("label", { text: "Morning brief at" }), briefTime), el("div", {}, el("label", { text: "Evening review at" }), eveningTime)),
          el("label", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "14px" } }, autoRemind, el("span", { text: "Auto-create reminders for deadlines" })),
          el("button", {
            class: "btn",
            style: { marginTop: "12px" },
            text: "Save rhythm",
            onclick: async () => {
              try {
                await api.saveSettings({
                  brief_time: briefTime.value,
                  evening_review_time: eveningTime.value,
                  auto_remind: autoRemind.checked,
                });
                toast("Rhythm saved ✅", "ok");
              } catch (e: any) {
                toast(e.message, "err");
              }
            },
          })
        )
      )
    );

    // Notifications
    const notifStatus = el("p", { class: "muted small" });
    async function refreshNotifStatus() {
      if (!("Notification" in window)) {
        notifStatus.textContent = "This browser doesn't support notifications.";
        return;
      }
      notifStatus.textContent =
        Notification.permission === "granted" ? "✅ Notifications enabled on this device." : Notification.permission === "denied" ? "⛔ Blocked — allow notifications in browser settings." : "Notifications not enabled yet.";
    }
    await refreshNotifStatus();
    const enableBtn = el("button", {
      class: "btn",
      text: "Enable notifications",
      onclick: async () => {
        try {
          const perm = await Notification.requestPermission();
          if (perm === "granted") {
            const { publicKey } = await api.vapidKey();
            if (publicKey && "serviceWorker" in navigator) {
              const reg = await navigator.serviceWorker.ready;
              const existing = await reg.pushManager.getSubscription();
              const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey }));
              await api.pushSubscribe(sub);
            }
            new Notification("Friday", { body: "You're all set — reminders will reach you here." });
          }
          await refreshNotifStatus();
        } catch (e: any) {
          toast(e.message || "Couldn't enable notifications.", "err");
        }
      },
    });
    wrap.append(section("🔔 Notifications", el("div", {}, notifStatus, el("div", { style: { marginTop: "10px" } }, enableBtn, el("span", { class: "faint", text: " Per-device — enable on laptop and phone separately." })))));

    // Voice
    const voiceSel = el(
      "select",
      {},
      el("option", { value: "auto", text: "Auto (browser speech, fallback to server)" }),
      el("option", { value: "server", text: "Server transcription (OpenAI Whisper)" })
    );
    voiceSel.value = localStorage.getItem("friday-voice-provider") || "auto";
    voiceSel.addEventListener("change", () => localStorage.setItem("friday-voice-provider", voiceSel.value));
    wrap.append(section("🎤 Voice", el("div", {}, el("label", { text: "Speech engine" }), voiceSel, el("p", { class: "faint", text: "Server transcription needs OPENAI_API_KEY configured on the server." }))));

    // Learned preferences
    try {
      const { prefs } = await api.prefs();
      if (prefs.length) {
        const body = el("div", { class: "small" });
        for (const p of prefs.slice(0, 10)) {
          body.append(el("div", { text: `• ${p.key.replace(/_/g, " ")}: ${String(p.value)} (learned from ${p.evidence} signal${p.evidence === 1 ? "" : "s"})` }));
        }
        wrap.append(section("🧠 What Friday learned about you", body));
      }
    } catch { /* optional */ }

    // Memories
    const memBody = el("div");
    try {
      const { memories } = await api.memories();
      if (!memories.length) memBody.append(el("p", { class: "muted small", text: "Say “Remember that …” to Friday and it'll stick here." }));
      for (const m of memories.slice(0, 12)) {
        memBody.append(
          el(
            "div",
            { class: "row", style: { marginBottom: "6px" } },
            el("span", { class: "small", style: { flex: "1" }, text: m.content }),
            el("button", {
              class: "icon-btn",
              html: "🗑",
              "aria-label": "Forget",
              onclick: async () => {
                await api.forget(m.id);
                ctx.refresh();
              },
            })
          )
        );
      }
    } catch { /* offline */ }
    const memInput = el("input", { type: "text", placeholder: "Remember that …", "aria-label": "New memory" });
    memInput.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && memInput.value.trim()) {
        await api.remember(memInput.value.trim());
        memInput.value = "";
        ctx.refresh();
      }
    });
    wrap.append(section("🧷 Memory", el("div", {}, memBody, memInput)));

    // Session
    wrap.append(
      section(
        "⚙️ Session",
        el("button", {
          class: "btn danger",
          text: "Sign out",
          onclick: async () => {
            await api.logout();
            localStorage.removeItem("friday-conv");
            location.hash = "#/login";
            ctx.refresh();
          },
        })
      )
    );
  } catch (e: any) {
    wrap.replaceChildren(emptyState("📡", e.message || "Couldn't load settings."));
  }
  return wrap;
}
