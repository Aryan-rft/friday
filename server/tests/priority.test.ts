import { describe, it, expect } from "vitest";
import { computePriority } from "../lib/priority.js";

const NOW = new Date("2026-09-07T04:30:00.000Z").getTime(); // 10:00 IST Monday
const iso = (ms: number) => new Date(ms).toISOString();

describe("computePriority", () => {
  it("overdue → CRITICAL", () => {
    expect(computePriority({ text: "finish report", deadlineAt: iso(NOW - 3_600_000), now: NOW })).toBe("CRITICAL");
  });

  it("explicit urgent → CRITICAL", () => {
    expect(computePriority({ text: "urgent call with the client", now: NOW })).toBe("CRITICAL");
    expect(computePriority({ text: "do this ASAP", now: NOW })).toBe("CRITICAL");
    expect(computePriority({ text: "right now please", now: NOW })).toBe("CRITICAL");
  });

  it("'finish this tonight' → HIGH", () => {
    expect(computePriority({ text: "finish this tonight", deadlineAt: iso(NOW + 11 * 3_600_000), now: NOW })).toBe("HIGH");
  });

  it("deadline today → HIGH", () => {
    expect(computePriority({ text: "submit form", deadlineAt: iso(NOW + 5 * 3_600_000), now: NOW })).toBe("HIGH");
  });

  it("deadline tomorrow → MEDIUM", () => {
    expect(computePriority({ text: "prepare slides", deadlineAt: iso(NOW + 26 * 3_600_000), now: NOW })).toBe("MEDIUM");
  });

  it("'before tomorrow's lecture' → HIGH via keyword", () => {
    expect(computePriority({ text: "need this before tomorrow's lecture", deadlineAt: iso(NOW + 26 * 3_600_000), now: NOW })).toBe("HIGH");
  });

  it("'whenever you get time' → LOW", () => {
    expect(computePriority({ text: "whenever you get time, look into this", now: NOW })).toBe("LOW");
  });

  it("'no rush' → LOW", () => {
    expect(computePriority({ text: "look into this, no rush", now: NOW })).toBe("LOW");
  });

  it("Hinglish low priority", () => {
    expect(computePriority({ text: "jab time mile karna", now: NOW })).toBe("LOW");
  });

  it("lecture/meeting type → HIGH", () => {
    expect(computePriority({ text: "prepare slides for lecture", taskType: "lecture", now: NOW })).toBe("HIGH");
    expect(computePriority({ text: "meeting with principal", taskType: "meeting", now: NOW })).toBe("HIGH");
  });

  it("idea type → LOW", () => {
    expect(computePriority({ text: "maybe build a mobile app", taskType: "idea", now: NOW })).toBe("LOW");
  });

  it("follow-up with near deadline → HIGH, far → LOW", () => {
    expect(computePriority({ text: "follow up with them", isFollowUp: true, deadlineAt: iso(NOW + 30 * 3_600_000), now: NOW })).toBe("HIGH");
    expect(computePriority({ text: "follow up with them", isFollowUp: true, deadlineAt: iso(NOW + 10 * 86_400_000), now: NOW })).toBe("LOW");
  });

  it("default → MEDIUM", () => {
    expect(computePriority({ text: "check email", now: NOW })).toBe("MEDIUM");
  });

  it("deterministic: same input twice", () => {
    const a = computePriority({ text: "kuk roadmap by wednesday", deadlineAt: iso(NOW + 3 * 86_400_000), now: NOW });
    const b = computePriority({ text: "kuk roadmap by wednesday", deadlineAt: iso(NOW + 3 * 86_400_000), now: NOW });
    expect(a).toBe(b);
  });
});