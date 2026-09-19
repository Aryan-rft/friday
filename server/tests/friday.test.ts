import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { migrate } from "../db/migrations.js";
import { getDb } from "../db/conn.js";
import { createApp } from "../app.js";
import { createTask, listTasks, getTaskById, createReminder, completeTask } from "../actions/tools.js";
import {
  createGoal, breakdownGoal, listGoals, recordFeedback, getSuggestions,
  getPref, listSubtasks, breakdownTask, bumpPref,
} from "../actions/friday.js";
import { registerUser, createSession } from "../auth/index.js";
import { detectIntent, analyze } from "../ai/nlu.js";
import { interpret } from "../ai/interpret.js";

const NOW = Date.now();

describe("friday: goals", () => {
  let userId = "";
  let goalId = "";

  beforeAll(() => {
    migrate();
    userId = registerUser("Aryan", `goal-${NOW}@test.local`, "password123").id;
    const g = createGoal(userId, { title: "Build Money", horizon: "year" });
    goalId = g.id;
  });

  it("creates and lists goals with task counts", () => {
    const goals = listGoals(userId, "active");
    expect(goals).toHaveLength(1);
    expect(goals[0]!.title).toBe("Build Money");
    expect(goals[0]!.total_tasks).toBe(0);
  });

  it("breaks a goal into linked starter tasks (idempotent)", () => {
    const first = breakdownGoal(userId, goalId);
    expect(first.length).toBeGreaterThanOrEqual(3);
    const second = breakdownGoal(userId, goalId);
    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
    const goals = listGoals(userId, "active");
    expect(goals[0]!.total_tasks).toBe(first.length);
    expect(goals[0]!.open_tasks).toBe(first.length);
  });

  it("completing a linked task updates goal progress", () => {
    const linked = breakdownGoal(userId, goalId);
    const task = getTaskById(userId, linked[0]!.id);
    completeTask(userId, task.id);
    const g = listGoals(userId, "active")[0]!;
    expect(g.open_tasks).toBe((g.total_tasks ?? 1) - 1);
  });
});

describe("friday: feedback loop", () => {
  let userId = "";
  let taskId = "";
  let reminderId = "";

  beforeAll(() => {
    migrate();
    userId = registerUser("Aryan", `fb-${NOW}@test.local`, "password123").id;
    const t = createTask(userId, { title: "Call the outreach team", deadlineAt: new Date(NOW + 3 * 86_400_000).toISOString() });
    taskId = t.id;
    const r = createReminder(userId, { taskId, title: "Call reminder", remindAt: new Date(NOW + 86_400_000).toISOString() });
    reminderId = r.id;
  });

  it("reminder_too_early moves the specific reminder and records bias", () => {
    const before = getDb().prepare("SELECT remind_at FROM reminders WHERE id = ?").get(reminderId) as { remind_at: string };
    const res = recordFeedback(userId, { category: "reminder_too_early", targetType: "reminder", targetId: reminderId });
    const after = getDb().prepare("SELECT remind_at FROM reminders WHERE id = ?").get(reminderId) as { remind_at: string };
    expect(new Date(after.remind_at).getTime()).toBe(new Date(before.remind_at).getTime() + 30 * 60_000);
    expect(getPref(userId, "reminder_offset_bias_minutes")).toBe(30);
    expect(res.applied.join(" ")).toContain("Moved");
  });

  it("accumulated bias shifts future absolute reminders", () => {
    const target = NOW + 5 * 86_400_000;
    const r = createReminder(userId, { title: "Future thing", remindAt: new Date(target).toISOString() });
    const diff = new Date(r.remind_at).getTime() - target;
    expect(diff).toBe(30 * 60_000);
  });

  it("preferred_time learns the work hour", () => {
    recordFeedback(userId, { category: "preferred_time", comment: "I prefer doing this at night" });
    expect(getPref(userId, "preferred_work_hour")).toBe(21);
  });

  it("not_important lowers task priority", () => {
    recordFeedback(userId, { category: "not_important", targetType: "task", targetId: taskId });
    expect(getTaskById(userId, taskId).priority).toBe("LOW");
  });

  it("make_smaller breaks the task into subtasks", () => {
    const t = createTask(userId, { title: "Prepare the AI employees pitch deck" });
    recordFeedback(userId, { category: "make_smaller", targetType: "task", targetId: t.id });
    const subs = listSubtasks(userId, t.id);
    expect(subs.length).toBeGreaterThanOrEqual(3);
  });

  it("dont_suggest mutes a suggestion key", () => {
    const t = createTask(userId, { title: "Sitting around task", status: "inbox" });
    // age it into neglect territory
    getDb().prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(new Date(NOW - 6 * 86_400_000).toISOString(), t.id);
    const suggestions = getSuggestions(userId, Date.now(), "Asia/Kolkata");
    const target = suggestions.find((s) => s.key === `neglected:${t.id}`);
    if (target) {
      recordFeedback(userId, { category: "dont_suggest", targetType: "suggestion", targetId: target.key });
      const after = getSuggestions(userId, Date.now(), "Asia/Kolkata");
      expect(after.find((s) => s.key === target.key)).toBeUndefined();
    }
  });
});

describe("friday: suggestions", () => {
  let userId = "";

  beforeAll(() => {
    migrate();
    userId = registerUser("Aryan", `sug-${NOW}@test.local`, "password123").id;
  });

  it("flags deadlines within 48h that lack reminders", () => {
    createTask(userId, { title: "Due soon no reminder", deadlineAt: new Date(NOW + 20 * 3_600_000).toISOString() });
    const suggestions = getSuggestions(userId, Date.now(), "Asia/Kolkata");
    expect(suggestions.some((s) => s.kind === "upcoming_deadline" && s.title.includes("Due soon no reminder"))).toBe(true);
  });

  it("respect pushiness: mute score reduces suggestion count", () => {
    const before = getSuggestions(userId, Date.now(), "Asia/Kolkata").length;
    for (let i = 0; i < 5; i++) bumpPref(userId, "suggestion_mute_score", 1, 2);
    const after = getSuggestions(userId, Date.now(), "Asia/Kolkata").length;
    expect(after).toBeLessThanOrEqual(Math.max(1, before - 1));
  });
});

describe("friday: NLU", () => {
  it("detects goal creation", () => {
    expect(detectIntent("My goal is to build the business this year").intent).toBe("create_goal");
    expect(detectIntent("Add a goal: get KUK running fully").intent).toBe("create_goal");
  });

  it("extracts goal title and horizon", () => {
    const r = analyze("My goal is to build expertise this year");
    expect(r.goal!.title.toLowerCase()).toContain("build expertise");
    expect(r.goal!.horizon).toBe("year");
  });

  it("detects goals query", () => {
    expect(detectIntent("What are my goals?").intent).toBe("query_goals");
  });

  it("detects feedback: too early", () => {
    expect(detectIntent("That reminder was too early").intent).toBe("give_feedback");
    expect(detectIntent("too early yaar").intent).toBe("give_feedback");
  });

  it("detects feedback: don't suggest", () => {
    expect(detectIntent("Don't suggest this again").intent).toBe("give_feedback");
  });

  it("detects feedback: prefer night", () => {
    const r = analyze("I prefer doing this at night");
    expect(r.intent).toBe("give_feedback");
    expect(r.feedback!.category).toBe("preferred_time");
  });

  it("detects feedback: make smaller", () => {
    const r = analyze("Make this task smaller");
    expect(r.intent).toBe("give_feedback");
    expect(r.feedback!.category).toBe("make_smaller");
  });

  it("still treats ordinary task statements as tasks", () => {
    expect(detectIntent("I need to follow up with Rita ma'am about internship requirements").intent).toBe("follow_up");
  });
});

describe("friday: end-to-end rules interpret", () => {
  let userId = "";
  let token = "";
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    migrate();
    userId = registerUser("Aryan", `e2e-${NOW}@test.local`, "password123").id;
    token = createSession(userId);
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("assistant creates a goal via rules mode", async () => {
    const res = await fetch(`${baseUrl}/api/assistant/message`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `friday_session=${token}` },
      body: JSON.stringify({ message: "My goal is to build purpose this year" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string; intent: string };
    expect(body.intent).toBe("create_goal");
    expect(body.reply).toContain("Goal set");
    const goals = listGoals(userId, "active");
    expect(goals.some((g) => g.title.toLowerCase().includes("build purpose"))).toBe(true);
  });

  it("assistant records feedback via rules mode", async () => {
    const res = await fetch(`${baseUrl}/api/assistant/message`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `friday_session=${token}` },
      body: JSON.stringify({ message: "That reminder was too early" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intent: string; reply: string };
    expect(body.intent).toBe("give_feedback");
    expect(getPref(userId, "reminder_offset_bias_minutes")).toBe(30);
  });

  it("full loop: task → suggestion → dismiss → gone", async () => {
    const t = createTask(userId, { title: "Rotting inbox item", status: "inbox" });
    getDb().prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(new Date(NOW - 8 * 86_400_000).toISOString(), t.id);
    const sug = getSuggestions(userId, Date.now(), "Asia/Kolkata").find((s) => s.key === `neglected:${t.id}`);
    expect(sug).toBeTruthy();
    const dis = await fetch(`${baseUrl}/api/suggestions/${encodeURIComponent(sug!.key)}/dismiss`, {
      method: "POST",
      headers: { cookie: `friday_session=${token}` },
    });
    expect(dis.status).toBe(200);
    expect(getSuggestions(userId, Date.now(), "Asia/Kolkata").find((s) => s.key === sug!.key)).toBeUndefined();
  });

  it("tasks created through interpret keep working", async () => {
    const res = await fetch(`${baseUrl}/api/assistant/message`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `friday_session=${token}` },
      body: JSON.stringify({ message: "I need to review the RFT contract by Friday" }),
    });
    expect(res.status).toBe(200);
    const tasks = listTasks(userId, { search: "RFT" });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });
});
