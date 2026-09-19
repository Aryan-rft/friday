/**
 * Daily scheduled briefing — server-side, timezone-correct, push-backed.
 *
 * The reminder engine's 20s loop calls tickBriefings(). For each user it
 * checks the local wall clock (in the user's timezone) against their
 * settings.brief_time; inside a 3-hour catch-up window it composes the day
 * from the real database and delivers it:
 *   - in-app notification row (visible even without push configured)
 *   - web push to every subscribed device
 * It fires at most once per calendar day per user, and honors brief_time
 * changes instantly (no stored schedule to get stale).
 */

import { getDb } from "../db/conn.js";
import { zonedParts, todayStart, formatZoned } from "../lib/dates.js";
import { getDefaultTimezone } from "../db/seed.js";
import { getDailySummary } from "../actions/tools.js";
import { sendPush, hasVapidKeys } from "../notifications/push.js";
import { createNotification } from "../notifications/inbox.js";
import { logger } from "../lib/logger.js";

const CATCHUP_MINUTES = 180;

interface BriefRow {
  id: string;
  name: string;
  timezone: string | null;
  brief_time: string | null;
}

function parseBriefTime(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

/** Compose the morning brief from the user's real data. */
export function composeMorningBrief(userId: string, now = Date.now()): { title: string; body: string; pushBody: string } {
  const tz = getDefaultTimezone(userId);
  const d = getDailySummary(userId, now);
  const user = getDb().prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string } | undefined;
  const first = (user?.name || "").split(" ")[0];

  const counts = d.today.counts;
  const totalToday = counts.total ?? 0;
  const lines: string[] = [];
  if (totalToday > 0) {
    const bits = [`${totalToday} due today`];
    if (counts.CRITICAL) bits.push(`${counts.CRITICAL} critical`);
    if (counts.HIGH) bits.push(`${counts.HIGH} high`);
    lines.push(bits.join(" · "));
    const todays = [...d.today.tasks]
      .sort((a, b) => (a.deadline_at ?? "").localeCompare(b.deadline_at ?? ""))
      .slice(0, 3);
    for (const t of todays) {
      const when = t.deadline_at ? formatZoned(new Date(t.deadline_at).getTime(), tz, { hour: "numeric", minute: "2-digit" }) : "anytime";
      lines.push(`  ${when} — ${t.title}`);
    }
  } else {
    lines.push("Nothing due today — clean slate.");
  }
  if (d.overdue.length) {
    lines.push(`${d.overdue.length} overdue — reschedule ${d.overdue.length === 1 ? "it" : "them"} or clear ${d.overdue.length === 1 ? "it" : "them"} first.`);
  }
  if (d.waiting.length) {
    lines.push(`${d.waiting.length} waiting on others.`);
  }
  const focus = d.focus[0];
  if (focus) {
    lines.push(`Start with: "${focus.title}"`);
  } else if (counts.total === 0) {
    lines.push('Open Friday and ask: "what should I focus on first?"');
  }

  const title = first ? `Good morning, ${first} ☀️` : "Good morning ☀️";
  const pushBits = [totalToday ? `${totalToday} due today` : "Nothing due today"];
  if (d.overdue.length) pushBits.push(`${d.overdue.length} overdue`);
  if (focus) pushBits.push(`Start with: "${focus.title}"`);

  return {
    title,
    body: lines.join("\n"),
    pushBody: truncate(pushBits.join(" · "), 160),
  };
}

async function hasBriefedToday(userId: string, dayStartMs: number): Promise<boolean> {
  const row = getDb()
    .prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Good morning%' AND created_at >= ? LIMIT 1")
    .get(userId, new Date(dayStartMs).toISOString());
  return Boolean(row);
}

/** Deliver the brief: in-app notification + web push to all devices. */
export async function sendMorningBriefing(userId: string, now = Date.now()): Promise<void> {
  const brief = composeMorningBrief(userId, now);
  createNotification(userId, brief.title, brief.body, "/");

  const db = getDb();
  const subs = db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").all(userId) as
    { id: string; endpoint: string; p256dh: string; auth: string }[];
  if (subs.length && hasVapidKeys()) {
    for (const sub of subs) {
      const ok = await sendPush(sub, { title: brief.title, body: brief.pushBody, url: "/" });
      if (!ok) db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
    }
  }
  logger.info("morning briefing sent", { userId });
}

/**
 * One scheduler tick: brief every user whose local time is inside their
 * brief window and who hasn't been briefed today.
 */
export async function tickBriefings(now = Date.now()): Promise<number> {
  const db = getDb();
  const rows = db
    .prepare("SELECT u.id, u.name, s.timezone, s.brief_time FROM users u JOIN settings s ON s.user_id = u.id")
    .all() as unknown as BriefRow[];

  let sent = 0;
  for (const r of rows) {
    try {
      const tz = r.timezone || "Asia/Kolkata";
      const briefMin = parseBriefTime(r.brief_time);
      if (briefMin === null) continue;
      const p = zonedParts(now, tz);
      const localMin = p.hour * 60 + p.minute;
      if (localMin < briefMin || localMin >= briefMin + CATCHUP_MINUTES) continue;
      const dayStart = todayStart(now, tz);
      if (await hasBriefedToday(r.id, dayStart)) continue;
      await sendMorningBriefing(r.id, now);
      sent++;
    } catch (e) {
      logger.error("briefing tick error", { userId: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return sent;
}
