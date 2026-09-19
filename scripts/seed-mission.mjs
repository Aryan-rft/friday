/**
 * Seeds the 24→25 mission into Friday: 7 goals × 4 concrete starter tasks,
 * created through the same validated action tools the assistant uses.
 * Idempotent — rerunning never duplicates.
 *
 *   node --experimental-sqlite --no-warnings --import tsx scripts/seed-mission.mjs
 *
 * Optional env: FRIDAY_EMAIL, FRIDAY_PASSWORD (used only when creating the account).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env"), "utf8").split("\n") : []) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq > 0 && process.env[t.slice(0, eq).trim()] === undefined) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const { migrate } = await import("../server/db/migrations.js");
const { getDb } = await import("../server/db/conn.js");
const { registerUser } = await import("../server/auth/index.js");
const { createGoal, listGoals, linkTaskToGoal } = await import("../server/actions/friday.js");
const { createTask } = await import("../server/actions/tools.js");
const { zonedMs, zonedParts } = await import("../server/lib/dates.js");

const TZ = "Asia/Kolkata";
const DAY = 86_400_000;

/** ISO timestamp for `days` days from now at 17:00 in the user's timezone. */
function dueInDays(days) {
  const p = zonedParts(Date.now() + days * DAY, TZ);
  return new Date(zonedMs({ year: p.year, month: p.month, day: p.day, hour: 17 }, TZ)).toISOString();
}

const MISSION = [
  {
    title: "Build Money",
    horizon: "year",
    tasks: [
      ["List every current income stream and rate it: active, growing, dormant", 2],
      ["Set a concrete revenue target for the next 90 days", 2],
      ["Pick one income stream to double this quarter and define its next 3 actions", 9],
      ["Set up a weekly money review — income, expenses, runway — every Sunday", 9],
    ],
  },
  {
    title: "Build Business",
    horizon: "year",
    tasks: [
      ["Write the one-page business plan: offer, customer, price, channel", 2],
      ["Map the current pipeline: leads, conversations, proposals, closes", 2],
      ["Book 5 customer conversations this week to sharpen the offer", 9],
      ["Decide the single metric that defines business progress this quarter", 9],
    ],
  },
  {
    title: "Build Expertise",
    horizon: "year",
    tasks: [
      ["Define the 3 skills that compound your value over the next 12 months", 2],
      ["Block 5 hours/week of deep learning time in the calendar", 2],
      ["Ship one public artefact this month — lecture, post, repo or talk", 9],
      ["Find one mentor or community to be accountable to", 9],
    ],
  },
  {
    title: "Build Purpose",
    horizon: "year",
    tasks: [
      ["Write the personal mission statement — what you're building and why", 2],
      ["List the commitments that matter most; cut or delegate the rest", 9],
      ["Plan one thing this month that serves someone who can't repay you", 9],
      ["Set a quarterly ritual: am I working on what I claim matters?", 16],
    ],
  },
  {
    title: "Build Health",
    horizon: "quarter",
    tasks: [
      ["Fix a consistent sleep window and protect it for 14 days", 2],
      ["Book the workouts: 4 slots a week, same days, same time", 2],
      ["Get a full health check-up and log the baselines", 9],
      ["Cut one thing that's quietly draining energy — late nights, sugar, scrolling", 9],
    ],
  },
  {
    title: "Build Relationships",
    horizon: "quarter",
    tasks: [
      ["List the 10 people who matter most; schedule real contact with 3 this week", 2],
      ["Plan one proper family day this month — no work", 9],
      ["Reconnect with one person you've been meaning to call", 9],
      ["Start one recurring ritual — weekly dinner, monthly trip, daily walk", 16],
    ],
  },
  {
    title: "Build Life",
    horizon: "life",
    tasks: [
      ["Write the 10-year vision — one page, vivid, dated", 2],
      ["List 20 things to do in this lifetime; pick the first 3", 2],
      ["Define what a good year means beyond work — health, love, adventure", 9],
      ["Book the next adventure — something you'd regret not doing", 16],
    ],
  },
];

migrate();
const db = getDb();

// ── Resolve the user ─────────────────────────────────────────────────────────
const email = process.env.FRIDAY_EMAIL || "aryan@friday.local";
let user = db.prepare("SELECT id, name, email FROM users WHERE email = ?").get(email);
let createdPassword = null;
if (!user) {
  createdPassword = process.env.FRIDAY_PASSWORD || crypto.randomBytes(6).toString("base64url");
  user = registerUser("Aryan", email, createdPassword);
  console.log(`account created: ${email} / ${createdPassword}`);
} else {
  console.log(`using existing account: ${user.email}`);
}

// ── Seed (idempotent) ────────────────────────────────────────────────────────
const existingGoals = listGoals(user.id, "active");
let createdGoals = 0;
let createdTasks = 0;

for (const g of MISSION) {
  let goal = existingGoals.find((x) => x.title.toLowerCase() === g.title.toLowerCase());
  if (!goal) {
    goal = createGoal(user.id, { title: g.title, horizon: g.horizon, description: "Part of the 24→25 mission" });
    createdGoals++;
  }
  const linked = db.prepare("SELECT COUNT(*) AS c FROM goal_tasks WHERE goal_id = ?").get(goal.id).c;
  if (linked === 0) {
    g.tasks.forEach(([title, dueDays], i) => {
      const t = createTask(user.id, {
        title,
        priority: "MEDIUM",
        taskType: "goal-step",
        source: "mission",
        status: i === 0 ? "today" : "planned",
        deadlineAt: dueInDays(dueDays),
      });
      linkTaskToGoal(user.id, goal.id, t.id);
      createdTasks++;
    });
  }
}

// ── Print the plan ───────────────────────────────────────────────────────────
console.log(`\nseeded ${createdGoals} new goals, ${createdTasks} starter tasks\n`);
const goals = listGoals(user.id, "active");
for (const goal of goals) {
  console.log(`🎯 ${goal.title}  (${goal.horizon})`);
  const tasks = db
    .prepare(
      `SELECT t.title, t.status, t.due_date, t.due_time FROM goal_tasks gt
       JOIN tasks t ON t.id = gt.task_id WHERE gt.goal_id = ? ORDER BY t.created_at`
    )
    .all(goal.id);
  for (const t of tasks) {
    const due = t.due_date ? ` · due ${t.due_date}${t.due_time ? " " + t.due_time : ""}` : "";
    console.log(`   ${t.status === "today" ? "▸" : " "} ${t.title}${due}`);
  }
  console.log("");
}
console.log("Open Friday and ask: \"what should I focus on first?\"");
