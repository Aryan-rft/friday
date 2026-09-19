/**
 * Deterministic priority engine.
 *
 * Inputs: deadline (absolute ms), task type, follow-up flag, the raw
 * natural-language phrase (for urgency keywords), current time.
 * Output: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
 *
 * Rules are applied in order; the first match wins, so behaviour is
 * consistent and testable.
 */

import { HOUR, todayStart } from "./dates.js";

export type Priority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

const CRITICAL_PHRASES = [
  "asap", "a.s.a.p", "immediately", "right now", "urgent", "critical",
  "this instant", "emergency", "jaise hi", "turant", "foran", "fauran",
  "do not forget", "don't forget", "must not miss", "can't miss",
];

const HIGH_PHRASES = [
  "high priority", "important", "very important", "priority", "must",
  "need this", "need to", "have to", "has to", "tonight", "today",
  "before", "by ", "deadline", "due", "crucial", "essential", "top",
  "zabardast", "jaroori", "zaroori", "important hai", "jaroori hai",
  "pehle", "before tomorrow", "first thing",
];

const LOW_PHRASES = [
  "whenever", "sometime", "some time", "if you get time", "when you get a chance",
  "when you can", "no rush", "not urgent", "low priority", "later", "someday",
  "eventually", "kabhi", "fursat", "time mile", "jab time mile", "koi jaldi nahi",
  "koi jaldi nahi hai", "relaxed", "when free", "if possible", "agar ho sake",
];

export interface PriorityInput {
  text: string;
  deadlineAt?: string | null; // ISO
  taskType?: string;
  isFollowUp?: boolean;
  now?: number;
  timezone?: string;
}

export function computePriority(input: PriorityInput): Priority {
  const text = (input.text || "").toLowerCase();
  const now = input.now ?? Date.now();
  const timezone = input.timezone ?? "Asia/Kolkata";
  const deadline = input.deadlineAt ? new Date(input.deadlineAt).getTime() : null;
  const taskType = (input.taskType || "task").toLowerCase();
  const isFollowUp = Boolean(input.isFollowUp);

  // 1. Overdue → CRITICAL (a passed deadline always escalates)
  if (deadline && deadline < now) return "CRITICAL";

  // 2. Explicit priority labels win over everything
  if (/\b(low priority|not urgent|no rush|whenever|sometime|some time|if you get time|when you get a chance|when you can|koi jaldi nahi|jab time mile|time mile|agar ho sake)\b/.test(text)) return "LOW";
  if (/\b(urgent|critical|asap|a\.s\.a\.p|immediately|right now|emergency)\b/.test(text)) return "CRITICAL";
  if (/\b(high priority|top priority)\b/.test(text)) return "HIGH";

  // 3. Explicit urgency language ("before", "tonight", "must"…)
  if (HIGH_PHRASES.some((p) => text.includes(p))) return "HIGH";

  // 4. Follow-ups: closer deadline → higher priority
  if (isFollowUp && deadline) {
    const start = todayStart(now, timezone);
    if (deadline < start + 48 * HOUR) return "HIGH";
    if (deadline < start + 7 * 24 * HOUR) return "MEDIUM";
    return "LOW";
  }

  // 5. Deadline proximity
  if (deadline) {
    const start = todayStart(now, timezone);
    const end = start + 24 * HOUR;
    if (deadline < end) return "HIGH"; // due today
    if (deadline < end + 24 * HOUR) return "MEDIUM"; // due tomorrow
  }

  // 6. Remaining low-priority language
  if (LOW_PHRASES.some((p) => text.includes(p))) return "LOW";

  // 7. Type-based defaults
  if (taskType === "lecture" || taskType === "meeting" || taskType === "pitch") return "HIGH";
  if (taskType === "follow-up") return "MEDIUM";
  if (taskType === "idea") return "LOW";

  return "MEDIUM";
}

/** Human label + colour for the UI. */
export const PRIORITY_META: Record<Priority, { label: string; color: string; emoji: string }> = {
  CRITICAL: { label: "Critical", color: "#dc2626", emoji: "🔴" },
  HIGH: { label: "High", color: "#ea580c", emoji: "🟠" },
  MEDIUM: { label: "Medium", color: "#ca8a04", emoji: "🟡" },
  LOW: { label: "Low", color: "#16a34a", emoji: "🟢" },
};

export function priorityRank(p: Priority): number {
  return { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }[p] ?? 0;
}