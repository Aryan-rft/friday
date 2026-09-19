/**
 * In-app notification inbox. Shared by the reminder engine and the briefing
 * scheduler so both write the same row shape.
 */

import { getDb } from "../db/conn.js";
import { nowISO } from "../lib/dates.js";

export interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  url: string;
  read: number;
  created_at: string;
}

export function createNotification(userId: string, title: string, body: string, url = "/"): NotificationRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const ts = nowISO();
  db.prepare(
    "INSERT INTO notifications (id, user_id, title, body, url, read, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
  ).run(id, userId, title, body, url, ts, ts);
  return { id, user_id: userId, title, body, url, read: 0, created_at: ts };
}
