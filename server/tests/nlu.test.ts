import { describe, it, expect } from "vitest";
import { analyze, detectIntent } from "../ai/nlu.js";
import { zonedParts, ymd } from "../lib/dates.js";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-09-07T04:30:00.000Z").getTime(); // Monday 10:00 IST
const ctx = { now: NOW, timezone: TZ, knownProjectSlugs: ["kuk", "kuk-training-implementation", "expert-lectures", "corporate-outreach", "internships-students", "ai-employees", "rft", "personal", "ideas", "general"] };

const a = (text: string) => analyze(text, ctx);
const date = (iso: string | undefined) => (iso ? ymd(new Date(iso).getTime(), TZ) : null);
const hm = (iso: string | undefined) => {
  if (!iso) return null;
  const p = zonedParts(new Date(iso).getTime(), TZ);
  return `${p.hour}:${p.minute}`;
};

describe("intent detection", () => {
  const cases: [string, string][] = [
    ["Remind me tomorrow at 10 to call the outreach team", "remind"],
    ["Finish the KUK roadmap by Thursday", "create_task"],
    ["I need to prepare slides for the next expert lecture", "create_task"],
    ["Follow up with them in three days", "follow_up"],
    ["What do I have today?", "query_today"],
    ["What is urgent?", "query_urgent"],
    ["Mark the roadmap task complete", "complete"],
    ["Move the lecture preparation to Wednesday", "reschedule"],
    ["What am I waiting for?", "query_waiting"],
    ["Show me everything related to KUK", "query_project"],
    ["What deadlines are coming up?", "query_upcoming"],
    ["What did I finish this week?", "query_finished"],
    ["Show me unfinished work", "query_unfinished"],
    ["What should I focus on first?", "query_focus"],
    ["Brief me", "briefing"],
    ["Give me the evening review", "evening_review"],
    ["Weekly summary please", "weekly_summary"],
    ["Remember that I prefer morning meetings", "remember"],
    ["Finish this tonight", "create_task"],
    ["Delete the outreach task", "delete"],
    ["Make the roadmap task high priority", "set_priority"],
    ["What tasks are overdue?", "query_overdue"],
  ];
  for (const [text, expected] of cases) {
    it(`${JSON.stringify(text)} → ${expected}`, () => {
      expect(detectIntent(text).intent).toBe(expected);
    });
  }
});

describe("task extraction", () => {
  it("corporate outreach follow-up example", () => {
    const r = a("Tomorrow I need to follow up with the corporate outreach team about the companies they scraped.");
    expect(r.intent).toBe("follow_up");
    expect(r.task!.title.toLowerCase()).toContain("follow up with the corporate outreach team");
    expect(r.task!.projectSlug).toBe("corporate-outreach");
    expect(date(r.task!.deadlineAt)).toBe("2026-09-08");
    expect(r.task!.isFollowUp).toBe(true);
    expect(r.task!.followUp!.entity.toLowerCase()).toBe("corporate outreach team");
    expect(r.task!.followUp!.reason).toContain("companies they scraped");
  });

  it("Hinglish lecture slides example", () => {
    const r = a("Kal KUK mein twelve thirty wali lecture ke liye slides check karni hain.");
    expect(r.intent).toBe("create_task");
    expect(date(r.task!.deadlineAt)).toBe("2026-09-08");
    expect(hm(r.task!.deadlineAt)).toBe("12:30");
    expect(r.task!.projectSlug).toBe("expert-lectures");
  });

  it("Hinglish outreach follow-up", () => {
    const r = a("Friday ko outreach team se follow up karna hai.");
    expect(r.intent).toBe("follow_up");
    expect(date(r.task!.deadlineAt)).toBe("2026-09-11");
    expect(r.task!.followUp?.entity.toLowerCase()).toContain("outreach team");
  });

  it("Hinglish CEO pitch example", () => {
    const r = a("CEO ko AI employees ka pitch complete karna hai before Thursday.");
    expect(r.intent).toBe("create_task");
    expect(r.task!.projectSlug).toBe("ai-employees");
    expect(date(r.task!.deadlineAt)).toBe("2026-09-10");
  });

  it("Rita ma'am internships example", () => {
    const r = a("Rita ma'am se final year students ke internship requirements discuss karne hain.");
    expect(r.intent).toBe("create_task");
    expect(r.task!.projectSlug).toBe("internships-students");
    expect(r.task!.people).toContain("Rita ma'am");
  });

  it("roadmap example with explicit add", () => {
    const r = a("Add a task to finish the training implementation roadmap by Thursday evening.");
    expect(r.intent).toBe("create_task");
    expect(r.task!.projectSlug).toBe("kuk-training-implementation");
    expect(date(r.task!.deadlineAt)).toBe("2026-09-10");
    expect(hm(r.task!.deadlineAt)).toBe("18:0");
  });

  it("reminder with task action creates both", () => {
    const r = a("Remind me tomorrow at 10 to call the outreach team.");
    expect(r.intent).toBe("remind");
    expect(r.task!.title.toLowerCase()).toContain("call the outreach team");
    expect(date(r.task!.reminder!.at)).toBe("2026-09-08");
    expect(hm(r.task!.reminder!.at)).toBe("10:0");
    expect(r.task!.projectSlug).toBe("corporate-outreach");
  });

  it("standalone reminder", () => {
    const r = a("Remind me tomorrow at 9.");
    expect(r.intent).toBe("remind");
    expect(r.task!.reminder!.at).toBeDefined();
  });

  it("recurring reminder", () => {
    const r = a("Remind me every Monday at 9am.");
    expect(r.intent).toBe("remind");
    expect(r.task!.reminder!.recurrence).toBe("weekly:monday");
  });

  it("offset reminder", () => {
    const r = a("Remind me two hours before the lecture.");
    expect(r.intent).toBe("remind");
    expect(r.task!.reminder!.offsetBeforeDeadline).toBe(120);
  });

  it("follow up in three days", () => {
    const r = a("Follow up with them in three days.");
    expect(r.intent).toBe("follow_up");
    expect(date(r.task!.deadlineAt)).toBe("2026-09-10");
  });

  it("finish this tonight → create with tonight deadline", () => {
    const r = a("Finish this tonight.");
    expect(r.intent).toBe("create_task");
    expect(date(r.task!.deadlineAt)).toBe("2026-09-07");
    expect(hm(r.task!.deadlineAt)).toBe("21:0");
  });

  it("mark task complete target extraction", () => {
    const r = a("Mark the roadmap task complete.");
    expect(r.intent).toBe("complete");
    expect(r.targetTitle!.toLowerCase()).toContain("roadmap task");
  });

  it("reschedule target + new date", () => {
    const r = a("Move the lecture preparation to Wednesday.");
    expect(r.intent).toBe("reschedule");
    expect(r.targetTitle!.toLowerCase()).toContain("lecture preparation");
    expect(date(r.newDeadlineAt!)).toBe("2026-09-09");
  });

  it("query project mapping", () => {
    const r = a("Show me everything related to KUK.");
    expect(r.query!.projectSlug).toBe("kuk");
  });

  it("auto-reminder for future deadlines (9am on deadline day)", () => {
    const r = a("Finish the KUK roadmap by Thursday.");
    expect(r.task!.reminder!.at).toBeDefined();
    expect(date(r.task!.reminder!.at)).toBe("2026-09-10");
  });

  it("does not hallucinate when nothing is given", () => {
    const r = a("I need to prepare slides for the next expert lecture.");
    expect(r.task!.title.length).toBeGreaterThan(5);
  });
});