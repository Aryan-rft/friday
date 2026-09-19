import { getDb } from "./conn.js";

export const DEFAULT_PROJECTS: { name: string; slug: string; color: string; icon: string }[] = [
  { name: "KUK", slug: "kuk", color: "#6366f1", icon: "graduation" },
  { name: "KUK Training & Implementation", slug: "kuk-training-implementation", color: "#8b5cf6", icon: "roadmap" },
  { name: "Expert Lectures", slug: "expert-lectures", color: "#0ea5e9", icon: "lecture" },
  { name: "Corporate Outreach", slug: "corporate-outreach", color: "#f59e0b", icon: "handshake" },
  { name: "Internships & Students", slug: "internships-students", color: "#10b981", icon: "students" },
  { name: "AI Employees", slug: "ai-employees", color: "#ef4444", icon: "robot" },
  { name: "RFT", slug: "rft", color: "#14b8a6", icon: "briefcase" },
  { name: "Personal", slug: "personal", color: "#ec4899", icon: "user" },
  { name: "Ideas", slug: "ideas", color: "#f97316", icon: "idea" },
  { name: "General", slug: "general", color: "#64748b", icon: "inbox" },
];

export function seedProjectsForUser(userId: string): void {
  const db = getDb();
  const existing = db.prepare("SELECT slug FROM projects WHERE user_id = ?").all(userId) as { slug: string }[];
  const have = new Set(existing.map((r) => r.slug));
  const now = new Date().toISOString();
  for (const p of DEFAULT_PROJECTS) {
    if (have.has(p.slug)) continue;
    db.prepare(
      `INSERT INTO projects (id, user_id, name, slug, color, icon, is_system, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(crypto.randomUUID(), userId, p.name, p.slug, p.color, p.icon, now);
  }
}

export function seedSettingsForUser(userId: string): void {
  const db = getDb();
  // updated_at is NOT NULL with no default — the insert must supply it,
  // otherwise the row silently never exists (INSERT OR IGNORE swallows it).
  db.prepare(
    `INSERT INTO settings (user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING`
  ).run(userId, new Date().toISOString());
}

export function getDefaultTimezone(userId: string): string {
  const db = getDb();
  const row = db.prepare("SELECT timezone FROM settings WHERE user_id = ?").get(userId) as
    | { timezone: string }
    | undefined;
  return row?.timezone || "Asia/Kolkata";
}