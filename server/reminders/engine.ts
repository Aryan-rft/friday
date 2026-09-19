import { getDb } from "../db/conn.js";
import { nowISO, DAY, zonedMs, zonedParts } from "../lib/dates.js";
import { logger } from "../lib/logger.js";
import { sendPush, hasVapidKeys } from "../notifications/push.js";
import { getDefaultTimezone } from "../db/seed.js";
import { tickBriefings } from "./briefing.js";

interface DueReminder {
  id: string;
  user_id: string;
  title: string;
  remind_at: string;
  recurrence: string | null;
  task_title: string | null;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  url: string;
  read: number;
  created_at: string;
}

/** Compute the next occurrence of a recurring reminder after `after`. */
export function nextOccurrence(recurrence: string, afterMs: number, timezone: string): number | null {
  const p = zonedParts(afterMs, timezone);
  if (recurrence === "daily") return afterMs + DAY;
  if (recurrence === "weekly") return afterMs + 7 * DAY;
  if (recurrence === "monthly") {
    const nextYear = p.month === 12 ? p.year + 1 : p.year;
    const nextMonth = p.month === 12 ? 1 : p.month + 1;
    const nextDay = Math.min(p.day, 28);
    return zonedMs({ year: nextYear, month: nextMonth, day: nextDay, hour: p.hour, minute: p.minute }, timezone);
  }
  const weeklyDay = /^weekly:(.+)$/.exec(recurrence);
  if (weeklyDay) {
    const names: Record<string, number> = {
      monday: 1, mon: 1, somvaar: 1, somwar: 1,
      tuesday: 2, tue: 2, mangalvaar: 2, mangalvar: 2,
      wednesday: 3, wed: 3, budhvaar: 3, budhvar: 3,
      thursday: 4, thu: 4, thur: 4, guruvaar: 4, guruvar: 4,
      friday: 5, fri: 5, shukravaar: 5, shukravar: 5,
      saturday: 6, sat: 6, shanivaar: 6, shanivar: 6,
      sunday: 0, sun: 0, ravivaar: 0, ravivar: 0,
    };
    const target = names[weeklyDay[1]!];
    if (target === undefined) return afterMs + 7 * DAY;
    const daysAhead = (target - p.weekday + 7) % 7;
    const next = afterMs + (daysAhead === 0 ? 7 : daysAhead) * DAY;
    const np = zonedParts(next, timezone);
    // keep original time of day
    return next - (np.hour * 3_600_000 + np.minute * 60_000) + (p.hour * 3_600_000 + p.minute * 60_000);
  }
  return null;
}

function createNotification(userId: string, title: string, body: string, url = "/"): NotificationRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const ts = nowISO();
  db.prepare(
    "INSERT INTO notifications (id, user_id, title, body, url, read, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
  ).run(id, userId, title, body, url, ts, ts);
  return { id, user_id: userId, title, body, url, read: 0, created_at: ts };
}

/** One engine tick: fire due reminders + scheduled briefings. */
export async function tickReminderEngine(now = Date.now()): Promise<number> {
  // Daily briefings ride the same loop as reminders.
  try {
    await tickBriefings(now);
  } catch (e) {
    logger.error("briefing tick failed", { error: e instanceof Error ? e.message : String(e) });
  }

  const db = getDb();
  const due = db.prepare(
    `SELECT r.id, r.user_id, r.title, r.remind_at, r.recurrence, t.title AS task_title
     FROM reminders r LEFT JOIN tasks t ON t.id = r.task_id
     WHERE r.status = 'scheduled' AND r.remind_at <= ?`
  ).all(new Date(now).toISOString()) as unknown as DueReminder[];

  let fired = 0;
  for (const r of due) {
    try {
      const tz = getDefaultTimezone(r.user_id);
      const body = r.task_title ? `Reminder: ${r.task_title}` : "Friday reminder";
      const notif = createNotification(r.user_id, r.title, body, "/");
      logger.info("reminder fired", { reminderId: r.id, userId: r.user_id });

      // Push to all subscriptions
      const subs = db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").all(r.user_id) as
        { id: string; endpoint: string; p256dh: string; auth: string }[];
      if (subs.length && hasVapidKeys()) {
        for (const sub of subs) {
          const ok = await sendPush(sub, { title: r.title, body: body || "Friday reminder", url: "/" });
          if (!ok) {
            // expired subscription → remove
            db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
          }
        }
      }

      if (r.recurrence) {
        const next = nextOccurrence(r.recurrence, new Date(r.remind_at).getTime(), tz);
        if (next !== null) {
          db.prepare(
            "UPDATE reminders SET status = 'fired', fired_at = ?, updated_at = ? WHERE id = ?"
          ).run(nowISO(), nowISO(), r.id);
          db.prepare(
            `INSERT INTO reminders (id, user_id, task_id, title, remind_at, offset_minutes, recurrence, status, created_at, updated_at)
             VALUES (?, ?, (SELECT task_id FROM reminders WHERE id = ?), ?, ?, NULL, ?, 'scheduled', ?, ?)`
          ).run(crypto.randomUUID(), r.user_id, r.id, r.title, new Date(next).toISOString(), r.recurrence, nowISO(), nowISO());
        } else {
          db.prepare(
            "UPDATE reminders SET status = 'fired', fired_at = ?, updated_at = ? WHERE id = ?"
          ).run(nowISO(), nowISO(), r.id);
        }
      } else {
        db.prepare(
          "UPDATE reminders SET status = 'fired', fired_at = ?, updated_at = ? WHERE id = ?"
        ).run(nowISO(), nowISO(), r.id);
      }
      void notif;
      fired++;
    } catch (e) {
      logger.error("reminder tick error", { reminderId: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return fired;
}

let timer: NodeJS.Timeout | null = null;

export function startReminderEngine(intervalMs = 20_000): void {
  if (timer) return;
  void tickReminderEngine().catch((e) => logger.error("reminder engine tick failed", { error: String(e) }));
  timer = setInterval(() => {
    void tickReminderEngine().catch((e) => logger.error("reminder engine tick failed", { error: String(e) }));
  }, intervalMs);
  timer.unref();
  logger.info("reminder engine started", { intervalMs });
}

export function stopReminderEngine(): void {
  if (timer) clearInterval(timer);
  timer = null;
}