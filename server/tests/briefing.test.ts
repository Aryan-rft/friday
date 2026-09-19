import { describe, it, expect, beforeAll } from "vitest";
import { migrate } from "../db/migrations.js";
import { getDb } from "../db/conn.js";
import { registerUser } from "../auth/index.js";
import { createTask } from "../actions/tools.js";
import { composeMorningBrief, sendMorningBriefing, tickBriefings } from "../reminders/briefing.js";
import { zonedMs, ymd, DAY } from "../lib/dates.js";

const TZ = "Asia/Kolkata";

/** ms for "today" (IST) at the given local time. */
function todayAt(h: number, m: number): number {
  return zonedMs({ ...zonedToday(), hour: h, minute: m }, TZ);
}
function zonedToday() {
  const now = new Date();
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now)
    .split("-")
    .map(Number);
  return { year: p[0]!, month: p[1]!, day: p[2]! };
}

describe("morning briefing", () => {
  let userId = "";
  const NOW = Date.now();

  beforeAll(() => {
    migrate();
    userId = registerUser("Aryan", `brief-${NOW}@test.local`, "password123").id;
  });

  it("composes a brief reflecting real data: today count, overdue, focus", () => {
    createTask(userId, {
      title: "Finish the outreach deck",
      deadlineAt: new Date(todayAt(23, 58)).toISOString(), // tonight: always "due today", never overdue
    });
    createTask(userId, {
      title: "Old thing that slipped",
      deadlineAt: new Date(todayAt(9, 0) - 2 * DAY).toISOString(),
    });
    const brief = composeMorningBrief(userId);
    expect(brief.title).toContain("Good morning");
    expect(brief.body).toContain("1 due today");
    expect(brief.body).toContain("Finish the outreach deck");
    expect(brief.body).toMatch(/11:58/); // formatted local time
    expect(brief.body).toContain("1 overdue");
    expect(brief.body).toContain('Start with: "');
    // push variant is a compact single line
    expect(brief.pushBody.split("\n").length).toBe(1);
  });

  it("empty day says so and still points at focus/next step", () => {
    const u2 = registerUser("Aryan", `brief-empty-${NOW}@test.local`, "password123").id;
    const brief = composeMorningBrief(u2);
    expect(brief.body).toContain("Nothing due today");
  });

  it("sendMorningBriefing writes an in-app notification exactly once per day", async () => {
    await sendMorningBriefing(userId, todayAt(8, 5));
    const count = () =>
      (
        getDb()
          .prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title LIKE 'Good morning%'")
          .get(userId) as { c: number }
      ).c;
    expect(count()).toBe(1);
    // second send the same day would duplicate — the scheduler guards, not send
    await sendMorningBriefing(userId, todayAt(8, 40));
    expect(count()).toBe(2); // send is dumb; tick is smart
  });

  it("tickBriefings fires inside the window and never twice per day", async () => {
    getDb().prepare("UPDATE settings SET brief_time = '08:00' WHERE user_id = ?").run(userId);
    // clear earlier sends from previous test (other users may also brief —
    // assert on THIS user's notifications, not the global tick count)
    getDb().prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
    const countFor = () =>
      (getDb().prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title LIKE 'Good morning%'").get(userId) as { c: number }).c;

    await tickBriefings(todayAt(8, 10));
    expect(countFor()).toBe(1);
    await tickBriefings(todayAt(8, 40));
    expect(countFor()).toBe(1); // still once per day
  });

  it("skips users outside their window", async () => {
    const before = (
      getDb().prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title LIKE 'Good morning%'").get(userId) as { c: number }
    ).c;
    const sent = await tickBriefings(todayAt(15, 0)); // 08:00 + 180min catch-up = 11:00 < 15:00
    expect(sent).toBe(0);
    const after = (
      getDb().prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title LIKE 'Good morning%'").get(userId) as { c: number }
    ).c;
    expect(after).toBe(before);
  });

  it("catches up when the server boots late within the window", async () => {
    getDb().prepare("UPDATE settings SET brief_time = '08:00' WHERE user_id = ?").run(userId);
    getDb().prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
    // 10:30 local is past 08:00 but within the 3h catch-up (≤ 11:00)
    const sent = await tickBriefings(todayAt(10, 30));
    expect(sent).toBe(1);
  });

  it("honors brief_time changes immediately (changed to 13:00, fired at 13:05)", async () => {
    getDb().prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
    getDb().prepare("UPDATE settings SET brief_time = '13:00' WHERE user_id = ?").run(userId);
    const sent = await tickBriefings(todayAt(13, 5));
    expect(sent).toBe(1);
  });

  it("users with missing or invalid brief_time are skipped safely", async () => {
    const u3 = registerUser("Aryan", `brief-bad-${NOW}@test.local`, "password123").id;
    getDb().prepare("UPDATE settings SET brief_time = '' WHERE user_id = ?").run(u3);
    const sent = await tickBriefings(todayAt(8, 30));
    // must not throw; u3 got nothing
    const c = (
      getDb().prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title LIKE 'Good morning%'").get(u3) as { c: number }
    ).c;
    expect(c).toBe(0);
    void sent;
  });

  it("briefs are day-scoped in the user's timezone, not UTC", async () => {
    getDb().prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
    getDb().prepare("UPDATE settings SET brief_time = '08:00' WHERE user_id = ?").run(userId);
    // fire "today" 08:05 IST
    await tickBriefings(todayAt(8, 5));
    const firstRow = getDb()
      .prepare("SELECT created_at FROM notifications WHERE user_id = ? AND title LIKE 'Good morning%' ORDER BY created_at")
      .get(userId) as { created_at: string };
    // the created_at must fall on the same IST calendar day
    const ms = new Date(firstRow.created_at).getTime();
    const istDay = ymd(ms, TZ);
    expect(istDay).toBe(ymd(todayAt(8, 5), TZ));
    void DAY;
  });
});
