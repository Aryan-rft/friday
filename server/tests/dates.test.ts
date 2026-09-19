import { describe, it, expect } from "vitest";
import {
  parseDatePhrase, parseReminderPhrase, applyOffset, zonedParts, todayStart, ymd, MINUTE, HOUR, DAY,
} from "../lib/dates.js";

const TZ = "Asia/Kolkata";

// Fixed "now": 2026-09-07 10:00 IST = 04:30 UTC
const NOW = new Date("2026-09-07T04:30:00.000Z").getTime();
const ymdAt = (ms: number) => ymd(ms, TZ);

describe("parseDatePhrase — English", () => {
  it("parses today", () => {
    const r = parseDatePhrase("today", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-07");
  });

  it("parses tomorrow with end-of-day default", () => {
    const r = parseDatePhrase("tomorrow", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-08");
    const p = zonedParts(r.at!, TZ);
    expect(p.hour).toBe(23);
    expect(p.minute).toBe(59);
  });

  it("parses 'at 10' as 10:00 today", () => {
    const r = parseDatePhrase("at 10", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-07");
    const p = zonedParts(r.at!, TZ);
    expect(p.hour).toBe(10);
  });

  it("parses 'at 10pm'", () => {
    const r = parseDatePhrase("at 10pm", NOW, TZ);
    const p = zonedParts(r.at!, TZ);
    expect(p.hour).toBe(22);
  });

  it("parses '12:30'", () => {
    const r = parseDatePhrase("12:30", NOW, TZ);
    const p = zonedParts(r.at!, TZ);
    expect(p.hour).toBe(12);
    expect(p.minute).toBe(30);
  });

  it("parses '12:30pm'", () => {
    const r = parseDatePhrase("12:30pm", NOW, TZ);
    const p = zonedParts(r.at!, TZ);
    expect(p.hour).toBe(12);
    expect(p.minute).toBe(30);
  });

  it("parses 'tomorrow at 10'", () => {
    const r = parseDatePhrase("tomorrow at 10", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-08");
    const p = zonedParts(r.at!, TZ);
    expect(p.hour).toBe(10);
  });

  it("parses 'Friday' (next Friday, 2026-09-11)", () => {
    const r = parseDatePhrase("Friday", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-11");
  });

  it("parses 'next Monday' (2026-09-14)", () => {
    const r = parseDatePhrase("next Monday", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-14");
  });

  it("parses 'in three days'", () => {
    const r = parseDatePhrase("in three days", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-10");
  });

  it("parses 'in 3 days'", () => {
    const r = parseDatePhrase("in 3 days", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-10");
  });

  it("parses 'two hours from now' via 'in two hours'", () => {
    const r = parseDatePhrase("in two hours", NOW, TZ);
    expect(r.at!).toBeCloseTo(NOW + 2 * HOUR, -2);
  });

  it("parses 'this evening'", () => {
    const r = parseDatePhrase("this evening", NOW, TZ);
    const p = zonedParts(r.at!, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-07");
    expect(p.hour).toBe(18);
  });

  it("parses 'Thursday evening' (2026-09-10 18:00)", () => {
    const r = parseDatePhrase("Thursday evening", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-10");
    const p = zonedParts(r.at!, TZ);
    expect(p.hour).toBe(18);
  });

  it("parses 'March 5' absolute dates", () => {
    const r = parseDatePhrase("March 5", NOW, TZ);
    // 2027 (past in 2026 → next year)
    expect(ymdAt(r.at!)).toBe("2027-03-05");
  });

  it("rolls 'at 9' to tomorrow when already past", () => {
    const r = parseDatePhrase("at 9", NOW, TZ); // now is 10:00
    expect(ymdAt(r.at!)).toBe("2026-09-08");
    const p = zonedParts(r.at!, TZ);
    expect(p.hour).toBe(9);
  });
});

describe("parseDatePhrase — Hinglish", () => {
  it("kal → tomorrow", () => {
    const r = parseDatePhrase("kal", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-08");
  });

  it("parson → day after tomorrow", () => {
    const r = parseDatePhrase("parson", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-09");
  });

  it("'Friday ko' weekday", () => {
    const r = parseDatePhrase("Friday ko", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-11");
  });

  it("'three din mein' → +3 days", () => {
    const r = parseDatePhrase("three din mein", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-10");
  });

  it("'3 din baad' → +3 days", () => {
    const r = parseDatePhrase("3 din baad", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-10");
  });

  it("'somvaar' → Monday", () => {
    const r = parseDatePhrase("somvaar", NOW, TZ);
    expect(ymdAt(r.at!)).toBe("2026-09-14");
  });

  it("'twelve thirty' word time", () => {
    const r = parseDatePhrase("twelve thirty", NOW, TZ);
    const p = zonedParts(r.at!, TZ);
    expect(p.hour).toBe(12);
    expect(p.minute).toBe(30);
  });
});

describe("parseReminderPhrase", () => {
  it("every Monday → weekly:monday", () => {
    const r = parseReminderPhrase("every Monday", NOW, TZ);
    expect(r.recurrence).toBe("weekly:monday");
  });

  it("every day → daily", () => {
    const r = parseReminderPhrase("every day", NOW, TZ);
    expect(r.recurrence).toBe("daily");
  });

  it("two hours before → offset 120", () => {
    const r = parseReminderPhrase("two hours before the lecture", NOW, TZ);
    expect(r.offsetBeforeDeadline).toBe(120);
  });

  it("plain time", () => {
    const r = parseReminderPhrase("tomorrow at 9", NOW, TZ);
    expect(r.at).toBeDefined();
    expect(ymdAt(r.at!)).toBe("2026-09-08");
    const p = zonedParts(r.at!, TZ);
    expect(p.hour).toBe(9);
  });
});

describe("applyOffset", () => {
  it("subtracts minutes", () => {
    const deadline = NOW + 3 * DAY;
    expect(applyOffset(deadline, 120)).toBe(deadline - 120 * MINUTE);
  });
});

describe("todayStart / ymd helpers", () => {
  it("todayStart is midnight IST", () => {
    const start = todayStart(NOW, TZ);
    const p = zonedParts(start, TZ);
    expect(p.hour).toBe(0);
    expect(p.minute).toBe(0);
  });
});