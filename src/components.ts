/** Shared components: shell, task items, capture sheet, modals. */

import { el, openModal, confirmModal, toast } from "./ui.js";
import { icons } from "./icons.js";
import { api, createTaskSafe, flushQueue, queueSize, sendAssistantMessage } from "./api.js";
import { startVoiceCapture, browserSpeechAvailable, type VoiceHandle } from "./ui.js";

export interface AppCtx {
  user: { id: string; name: string; email: string };
  refresh(): void;
  go(route: string): void;
}

// ─── Icons/nav helpers ───────────────────────────────────────────────────────

export const NAV = [
  { id: "dashboard", label: "Dashboard", icon: icons.dashboard },
  { id: "today", label: "Today", icon: icons.today },
  { id: "tasks", label: "Tasks", icon: icons.tasks },
  { id: "projects", label: "Projects", icon: icons.projects },
  { id: "goals", label: "Goals", icon: icons.goals },
  { id: "assistant", label: "Assistant", icon: icons.assistant },
  { id: "settings", label: "Settings", icon: icons.settings },
];

export function shell(active: string, content: HTMLElement, ctx: AppCtx): HTMLElement {
  const navItem = (n: (typeof NAV)[number], bottom = false) =>
    el(
      "button",
      {
        class: `nav-item ${active === n.id ? "active" : ""}`,
        onclick: () => ctx.go(n.id),
        "aria-current": active === n.id ? "page" : undefined,
      },
      el("span", { html: n.icon, "aria-hidden": "true" }),
      el("span", { text: n.label })
    );

  const overdueBadge = el("span", { class: "nav-badge hidden", text: "0" });
  void overdueBadge;

  const sidebar = el(
    "aside",
    { class: "sidebar", "aria-label": "Main navigation" },
    el("div", { class: "brand" }, el("span", { class: "logo-dot" }), "Friday"),
    ...NAV.map((n) => navItem(n)),
    el("div", { class: "spacer" }),
    el(
      "div",
      { class: "small muted", style: { padding: "8px 12px", fontSize: "12px" } },
      el("span", { class: "sync-dot on", id: "sync-dot" }),
      "synced"
    )
  );

  const bottom = el(
    "nav",
    { class: "bottom-nav", "aria-label": "Mobile navigation" },
    ...NAV.filter((n) => n.id !== "settings").map((n) => navItem(n, true))
  );

  const themeBtn = el("button", {
    class: "icon-btn",
    html: document.documentElement.dataset.theme === "light" ? icons.moon : icons.sun,
    "aria-label": "Toggle theme",
    onclick: () => {
      const cur = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      const next = cur === "light" ? "dark" : "light";
      if (next === "light") document.documentElement.dataset.theme = "light";
      else delete document.documentElement.dataset.theme;
      localStorage.setItem("friday-theme", next === "light" ? "light" : "dark");
      themeBtn.innerHTML = next === "light" ? icons.moon : icons.sun;
    },
  });

  const topbar = el(
    "div",
    { class: "topbar" },
    el("div", {}, el("h1", { text: titleFor(active) }), el("div", { class: "who", text: greeting(ctx.user.name) })),
    el("div", { class: "row", style: { flex: "0" } }, themeBtn)
  );

  return el(
    "div",
    { class: "shell" },
    sidebar,
    el("main", { class: "main" }, topbar, content),
    bottom
  );
}

function titleFor(id: string): string {
  return NAV.find((n) => n.id === id)?.label ?? "Friday";
}

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return `${part}, ${name.split(" ")[0]}`;
}

// ─── Task item ───────────────────────────────────────────────────────────────

export function fmtDue(task: any): string {
  if (!task.deadline_at) return "";
  const d = new Date(task.deadline_at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  const time = d.getHours() === 23 && d.getMinutes() === 59 ? "" : `, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (days === 0) return `Today${time}`;
  if (days === 1) return `Tomorrow${time}`;
  if (days === -1) return `Yesterday${time}`;
  if (days < -1) return `${-days} days overdue`;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) + time;
}

export function taskItem(task: any, ctx: AppCtx): HTMLElement {
  const effective = task.effective_status || task.status;
  const done = effective === "completed";
  const overdue = effective === "overdue";

  const check = el("button", {
    class: `task-check ${done ? "checked" : ""}`,
    "aria-label": done ? "Mark incomplete" : "Mark complete",
    html: done ? "✓" : "",
    onclick: async () => {
      try {
        if (done) await api.updateTask(task.id, { status: "today" });
        else await api.completeTask(task.id);
        ctx.refresh();
      } catch (e: any) {
        toast(e.message, "err");
      }
    },
  });

  const chips: HTMLElement[] = [];
  if (task.priority && task.priority !== "MEDIUM")
    chips.push(el("span", { class: `chip p-${task.priority}`, text: task.priority.toLowerCase() }));
  const due = fmtDue(task);
  if (due) chips.push(el("span", { class: `chip ${overdue ? "overdue" : ""}`, text: due }));
  if (task.project_name) chips.push(el("span", { class: "chip", text: task.project_name }));
  if (task.task_type && task.task_type !== "task") chips.push(el("span", { class: "chip", text: task.task_type }));
  if (Array.isArray(task.people) ? task.people.length : false) {
    try {
      const ppl = typeof task.people === "string" ? JSON.parse(task.people) : task.people;
      if (ppl?.length) chips.push(el("span", { class: "chip", text: `👤 ${ppl.slice(0, 2).join(", ")}` }));
    } catch { /* ignore */ }
  }

  const body = el(
    "div",
    { class: "task-body" },
    el("div", { class: `task-title ${done ? "done" : ""}`, text: task.title }),
    chips.length ? el("div", { class: "task-meta" }, ...chips) : el("div", { class: "task-meta" })
  );

  const subWrap = el("div", { class: "subtasks hidden" });
  let subsLoaded = false;
  async function loadSubs() {
    if (subsLoaded) return;
    subsLoaded = true;
    try {
      const { subtasks } = await api.subtasks(task.id);
      renderSubs(subtasks);
    } catch { /* offline etc. */ }
  }
  function renderSubs(subs: any[]) {
    subWrap.replaceChildren();
    if (!subs.length) {
      subWrap.append(
        el("button", {
          class: "btn small ghost",
          text: "✂️ Break into steps",
          onclick: async () => {
            try {
              const r = await api.breakdown(task.id);
              renderSubs(r.subtasks);
            } catch (e: any) {
              toast(e.message, "err");
            }
          },
        })
      );
    } else {
      for (const s of subs) {
        subWrap.append(
          el(
            "div",
            { class: `subtask ${s.status === "done" ? "done" : ""}` },
            el("button", {
              class: `task-check ${s.status === "done" ? "checked" : ""}`,
              html: s.status === "done" ? "✓" : "",
              "aria-label": "Complete step",
              onclick: async () => {
                try {
                  await api.completeSubtask(s.id);
                  s.status = "done";
                  renderSubs(subs);
                } catch (e: any) {
                  toast(e.message, "err");
                }
              },
            }),
            el("span", { class: "st-title", text: s.title })
          )
        );
      }
    }
  }

  const expandBtn = el("button", {
    class: "icon-btn",
    html: "▾",
    "aria-label": "Details",
    onclick: async () => {
      const hidden = subWrap.classList.toggle("hidden");
      if (!hidden) await loadSubs();
    },
  });

  const item = el(
    "div",
    { class: "task-item" },
    check,
    body,
    el(
      "div",
      { class: "task-actions" },
      el("button", {
        class: "icon-btn",
        html: "🗓️",
        title: "Reschedule",
        "aria-label": "Reschedule",
        onclick: () => rescheduleModal(task, ctx),
      }),
      el("button", {
        class: "icon-btn",
        html: "🗑",
        title: "Delete",
        "aria-label": "Delete",
        onclick: async () => {
          if (await confirmModal("Delete task", `Delete "${task.title}"? This can't be undone.`)) {
            try {
              await api.deleteTask(task.id);
              toast("Task deleted", "ok");
              ctx.refresh();
            } catch (e: any) {
              toast(e.message, "err");
            }
          }
        },
      }),
      expandBtn
    ),
    subWrap
  );
  return item;
}

function rescheduleModal(task: any, ctx: AppCtx): void {
  const defaultVal = task.deadline_at ? new Date(task.deadline_at).toISOString().slice(0, 16) : "";
  const input = el("input", { type: "datetime-local", value: defaultVal });
  const content = el(
    "div",
    {},
    el("p", { class: "muted small", text: task.title }),
    el("label", { text: "New deadline" }),
    input,
    el("div", { class: "error-text", id: "resched-err" }),
    el("button", {
      class: "btn primary block",
      style: { marginTop: "14px" },
      text: "Move it",
      onclick: async () => {
        if (!input.value) {
          content.querySelector("#resched-err")!.textContent = "Pick a date/time.";
          return;
        }
        try {
          await api.rescheduleTask(task.id, new Date(input.value).toISOString());
          toast("Rescheduled ✅", "ok");
          close();
          ctx.refresh();
        } catch (e: any) {
          content.querySelector("#resched-err")!.textContent = e.message;
        }
      },
    })
  );
  const close = openModal("Reschedule", content);
}

// ─── New task modal ──────────────────────────────────────────────────────────

export async function newTaskModal(ctx: AppCtx): Promise<void> {
  const title = el("input", { type: "text", placeholder: "e.g. Finish KUK roadmap", "aria-label": "Task title" });
  const when = el("input", { type: "text", placeholder: "e.g. tomorrow 5pm, Friday, in 2 days", "aria-label": "When (natural language)" });
  const project = el("select", { "aria-label": "Project" }, el("option", { value: "", text: "Auto-detect project" }));
  const prio = el(
    "select",
    { "aria-label": "Priority" },
    el("option", { value: "", text: "Auto priority" }),
    el("option", { value: "CRITICAL", text: "Critical" }),
    el("option", { value: "HIGH", text: "High" }),
    el("option", { value: "MEDIUM", text: "Medium" }),
    el("option", { value: "LOW", text: "Low" })
  );
  const notes = el("textarea", { rows: "2", placeholder: "Notes (optional)", "aria-label": "Notes" });
  try {
    const { projects } = await api.projects();
    for (const p of projects) project.append(el("option", { value: p.slug, text: p.name }));
  } catch { /* offline */ }

  const err = el("div", { class: "error-text" });
  const submit = async () => {
    if (!title.value.trim()) {
      err.textContent = "Give it a title.";
      return;
    }
    // Natural-language "when" goes through the assistant so dates parse the
    // same way as voice; a picked project/priority overrides auto-detection.
    const text = [title.value.trim(), when.value.trim() ? `(due ${when.value.trim()})` : "", prio.value ? `(${prio.value.toLowerCase()} priority)` : ""]
      .filter(Boolean)
      .join(" ");
    try {
      await sendAssistantMessage(text);
      toast("Task captured ✅", "ok");
      close();
      ctx.refresh();
    } catch (e: any) {
      // Only fall back to raw capture when Friday itself is unreachable or
      // overloaded — a real rejection should be shown honestly.
      if (e.status === 0 || e.status >= 500 || e.status === 429) {
        try {
          await createTaskSafe({ title: title.value.trim(), notes: notes.value, projectSlug: project.value || undefined, priority: prio.value || undefined });
          toast(e.status === 0 ? "Saved offline — will sync when you reconnect." : "Captured directly (assistant busy).", "ok");
          close();
          ctx.refresh();
          return;
        } catch {
          /* fall through to the honest error */
        }
      }
      err.textContent = e.message || "Couldn't capture that. Try again.";
    }
  };
  title.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  when.addEventListener("keydown", (e) => e.key === "Enter" && submit());

  const content = el(
    "div",
    {},
    el("label", { text: "What needs doing?" }),
    title,
    el("label", { text: "When? (plain language works)" }),
    when,
    el("div", { class: "row" }, el("div", {}, el("label", { text: "Project" }), project), el("div", {}, el("label", { text: "Priority" }), prio)),
    el("label", { text: "Notes" }),
    notes,
    err,
    el("button", { class: "btn primary block", style: { marginTop: "14px" }, text: "Capture", onclick: submit })
  );
  const close = openModal("New task", content);
  setTimeout(() => title.focus(), 60);
}

// ─── Capture sheet (voice result) ────────────────────────────────────────────

export function captureSheet(text: string, reply: string): void {
  const content = el(
    "div",
    {},
    el("div", { class: "chip", text: "you said" }),
    el("p", { style: { margin: "8px 0 14px", fontStyle: "italic" }, text: `“${text}”` }),
    el("div", { class: "card", style: { background: "var(--bg-raised)", whiteSpace: "pre-wrap" }, text: reply }),
    el("button", { class: "btn primary block", style: { marginTop: "14px" }, text: "Got it", onclick: () => close() })
  );
  const close = openModal("Friday heard you", content);
}

// ─── Floating mic ────────────────────────────────────────────────────────────

export function attachMic(ctx: AppCtx): void {
  const fab = el("button", {
    class: "fab-mic",
    html: icons.mic,
    "aria-label": "Voice capture",
    title: "Speak to Friday (V)",
  });
  let statusEl: HTMLElement | null = null;
  let handle: VoiceHandle | null = null;

  function showStatus(text: string) {
    if (!statusEl) {
      statusEl = el("div", { class: "mic-status", role: "status" });
      document.body.append(statusEl);
    }
    statusEl.textContent = text;
  }
  function hideStatus() {
    statusEl?.remove();
    statusEl = null;
  }

  async function handleFinal(text: string) {
    showStatus("Thinking…");
    try {
      const r = await sendAssistantMessage(text);
      hideStatus();
      captureSheet(text, r.reply);
      ctx.refresh();
    } catch (e: any) {
      hideStatus();
      if (e.status === 0) {
        // offline → queue raw text as a task via NLU later; save typed text now
        try {
          await createTaskSafe({ title: text.slice(0, 200), notes: "Captured offline by voice" });
          toast("Offline — saved as an inbox task to sort later.", "ok");
        } catch {
          toast("Offline and couldn't save. Try again once connected.", "err");
        }
      } else {
        toast(e.message || "Interpretation failed — try again.", "err");
      }
    }
  }

  fab.addEventListener("click", () => {
    if (handle) {
      handle.stop();
      handle = null;
      fab.classList.remove("recording");
      hideStatus();
      return;
    }
    if (!browserSpeechAvailable() && (localStorage.getItem("friday-voice-provider") || "auto") !== "server") {
      // No Web Speech → try server path directly; if that fails, type.
      void startVoiceCapture({
        onState: (s) => {
          if (s === "listening") {
            fab.classList.add("recording");
            showStatus("Listening… tap to stop");
          } else if (s === "processing") showStatus("Transcribing…");
        },
        onFinal: handleFinal,
        onError: (m) => {
          fab.classList.remove("recording");
          handle = null;
          hideStatus();
          typeFallback(m);
        },
      }).then((h) => {
        if (h) handle = h;
      });
      return;
    }
    void startVoiceCapture({
      onState: (s) => {
        if (s === "listening") {
          fab.classList.add("recording");
          showStatus("Listening…");
        } else if (s === "processing") {
          fab.classList.remove("recording");
          showStatus("Thinking…");
        }
      },
      onPartial: (t) => showStatus(t || "Listening…"),
      onFinal: (t) => {
        fab.classList.remove("recording");
        handle = null;
        void handleFinal(t);
      },
      onError: (m) => {
        fab.classList.remove("recording");
        handle = null;
        hideStatus();
        // Even with Web Speech available, failure (no mic, denied permission,
        // network drop) must never dead-end the user — offer typing.
        typeFallback(m);
      },
    }).then((h) => {
      handle = h;
      if (!h) {
        fab.classList.remove("recording");
        hideStatus();
      }
    });
  });

  function typeFallback(message: string) {
    toast(message, "err");
    const input = el("input", { type: "text", placeholder: "Type it instead — same as speaking…", "aria-label": "Type to Friday" });
    const content = el(
      "div",
      {},
      input,
      el("button", {
        class: "btn primary block",
        style: { marginTop: "12px" },
        text: "Send",
        onclick: async () => {
          if (!input.value.trim()) return;
          close();
          await handleFinal(input.value.trim());
        },
      })
    );
    input.addEventListener("keydown", (e) => e.key === "Enter" && (content.querySelector("button.btn.primary") as HTMLButtonElement)?.click());
    const close = openModal("Type to Friday", content);
    setTimeout(() => input.focus(), 60);
  }

  (fab as any).__openTyped = () => typeFallback("Voice unavailable — type instead.");
  (fab as any).__trigger = () => fab.click();
  document.body.append(fab);
}

// ─── Offline banner & sync ───────────────────────────────────────────────────

export function setupConnectivity(ctx: AppCtx): void {
  let banner = document.querySelector(".offline-banner") as HTMLElement | null;
  function update() {
    const online = navigator.onLine;
    if (!online && !banner) {
      banner = el("div", { class: "offline-banner", text: "Offline — captures are saved locally and sync automatically." });
      document.body.prepend(banner);
    } else if (online && banner) {
      banner.remove();
      banner = null;
    }
    const dot = document.getElementById("sync-dot");
    if (dot) dot.className = `sync-dot ${online ? "on" : "off"}`;
  }
  window.addEventListener("online", async () => {
    update();
    const n = await flushQueue();
    if (n > 0) {
      toast(`Synced ${n} offline capture${n === 1 ? "" : "s"} ✅`, "ok");
      ctx.refresh();
    }
  });
  window.addEventListener("offline", update);
  update();
  // periodic flush + badge
  setInterval(async () => {
    if (navigator.onLine) {
      const n = await flushQueue();
      if (n > 0) ctx.refresh();
    }
  }, 30_000);
  const qs = queueSize();
  if (qs > 0) toast(`${qs} capture${qs === 1 ? "" : "s"} waiting to sync`, "info");
}

// ─── PWA ─────────────────────────────────────────────────────────────────────

export function setupPWA(): void {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => { /* offline support unavailable */ });
    });
  }
}
