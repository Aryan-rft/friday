/** Friday app entry: router, auth, shortcuts, voice, offline, briefings. */

import { el, openModal, toast } from "./ui.js";
import { api } from "./api.js";
import { shell, attachMic, setupConnectivity, setupPWA, newTaskModal, type AppCtx } from "./components.js";
import {
  loginView, dashboardView, todayView, tasksView, projectsView, goalsView, assistantView, settingsView,
} from "./views.js";

let currentUser: { id: string; name: string; email: string } | null = null;
let renderSeq = 0;

function currentRoute(): string {
  const h = location.hash.replace(/^#\//, "");
  return h || "dashboard";
}

async function render(): Promise<void> {
  const seq = ++renderSeq;
  const appRoot = document.getElementById("app")!;
  const route = currentRoute();

  // Auth gate
  if (!currentUser) {
    if (route === "signup") appRoot.replaceChildren(loginView("signup", boot));
    else appRoot.replaceChildren(loginView("login", boot));
    return;
  }
  if (route === "login" || route === "signup") {
    location.hash = "#/";
    return;
  }

  const ctx: AppCtx = {
    user: currentUser,
    refresh: () => void render(),
    go: (r) => {
      location.hash = `#/${r}`;
    },
  };

  const builders: Record<string, (c: AppCtx) => Promise<HTMLElement>> = {
    dashboard: dashboardView,
    today: todayView,
    tasks: tasksView,
    projects: projectsView,
    goals: goalsView,
    assistant: assistantView,
    settings: settingsView,
  };
  const build = builders[route] ?? dashboardView;
  const content = await build(ctx);
  if (seq !== renderSeq) return; // a newer render superseded this one
  appRoot.replaceChildren(shell(route, content, ctx));
}

function boot(): void {
  void init();
}

// ─── Keyboard shortcuts (desktop power) ──────────────────────────────────────

function isTyping(): boolean {
  const a = document.activeElement;
  return Boolean(a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || (a as HTMLElement).isContentEditable));
}

document.addEventListener("keydown", (e) => {
  if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!currentUser) return;
  const mic = document.querySelector(".fab-mic") as any;
  switch (e.key.toLowerCase()) {
    case "v":
      mic?.__trigger?.();
      break;
    case "n":
      void newTaskModal(ctxSingleton!);
      break;
    case "t":
      location.hash = "#/today";
      break;
    case "u":
      tasksFilterUrgent();
      break;
    case "d":
      location.hash = "#/";
      break;
    case "a":
      location.hash = "#/assistant";
      break;
    case "?":
      showShortcuts();
      break;
  }
});

let ctxSingleton: AppCtx | null = null;

function tasksFilterUrgent(): void {
  // routed through the tasks view with the overdue filter as closest proxy
  location.hash = "#/tasks";
  setTimeout(() => {
    const btns = Array.from(document.querySelectorAll(".bottom-nav .nav-item, .sidebar .nav-item"));
    void btns;
    const overdueChip = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Overdue");
    overdueChip?.click();
  }, 350);
}

function showShortcuts(): void {
  const list = el(
    "div",
    { class: "small" },
    el("p", {}, el("kbd", { text: "V" }), " voice capture"),
    el("p", {}, el("kbd", { text: "N" }), " new task"),
    el("p", {}, el("kbd", { text: "T" }), " today"),
    el("p", {}, el("kbd", { text: "U" }), " urgent"),
    el("p", {}, el("kbd", { text: "D" }), " dashboard"),
    el("p", {}, el("kbd", { text: "A" }), " assistant"),
    el("p", {}, el("kbd", { text: "?" }), " this help")
  );
  openModal("Keyboard shortcuts", list);
}

// ─── In-app notification poller (briefs + reminders reach every open tab) ───────────────────────────

const seenNotifKey = "friday-seen-notifs";
let seenNotifs = new Set<string>(JSON.parse(localStorage.getItem(seenNotifKey) || "[]") as string[]);

async function pollInbox(): Promise<void> {
  if (!currentUser || document.hidden) return;
  try {
    const { notifications } = await api.notifications();
    let fresh = false;
    for (const n of notifications.slice(0, 5)) {
      if (seenNotifs.has(n.id)) continue;
      seenNotifs.add(n.id);
      fresh = true;
      const firstLine = (n.body || "").split("\n")[0] || "";
      toast(`${n.title}\n${firstLine}`, "info", 9000);
    }
    if (fresh) {
      localStorage.setItem(seenNotifKey, JSON.stringify([...seenNotifs].slice(-200)));
      await api.markNotificationsRead();
    }
  } catch {
    /* offline — the server has already persisted the brief */
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

window.addEventListener("hashchange", () => void render());

async function init(): Promise<void> {
  try {
    const me = await api.me();
    currentUser = me.user ?? null;
  } catch {
    currentUser = null;
  }
  if (currentUser) {
    const ctx: AppCtx = {
      user: currentUser,
      refresh: () => void render(),
      go: (r) => {
        location.hash = `#/${r}`;
      },
    };
    ctxSingleton = ctx;
    attachMic(ctx);
    setupConnectivity(ctx);
    setupPWA();
    setInterval(() => void pollInbox(), 60_000);
    void pollInbox();
  }
  void render();
}

void init();
