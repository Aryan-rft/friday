import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getDb } from "../db/conn.js";
import { seedProjectsForUser, seedSettingsForUser } from "../db/seed.js";
import { config } from "../config.js";

const SESSION_DAYS = 30;
const COOKIE = "friday_session";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

function tokenHash(token: string): string {
  return crypto.createHmac("sha256", config.sessionSecret).update(token).digest("hex");
}

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const db = getDb();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), userId, tokenHash(token), now.toISOString(), expires.toISOString());
  // prune old sessions for this user
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").run(userId, now.toISOString());
  return token;
}

export function destroySession(token: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

function userFromToken(token: string | undefined): AuthUser | null {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare(
    `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(tokenHash(token), new Date().toISOString()) as AuthUser | undefined;
  return row ?? null;
}

/** Express middleware: requires a valid session cookie. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE];
  const user = userFromToken(token);
  if (!user) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }
  (req as Request & { user?: AuthUser }).user = user;
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE];
  const user = userFromToken(token);
  if (user) (req as Request & { user?: AuthUser }).user = user;
  next();
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // local/personal deployment over http; set to true behind TLS
    maxAge: SESSION_DAYS * 86_400_000,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE, { path: "/" });
}

export function registerUser(name: string, email: string, password: string): { id: string; name: string; email: string } {
  const db = getDb();
  const normalized = email.trim().toLowerCase();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(normalized);
  if (existing) throw new Error("An account with that email already exists.");
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, name.trim() || "Aryan", normalized, hashPassword(password), new Date().toISOString());
  seedProjectsForUser(id);
  seedSettingsForUser(id);
  return { id, name: name.trim() || "Aryan", email: normalized };
}

export function loginUser(email: string, password: string): { id: string; name: string; email: string } {
  const db = getDb();
  const row = db.prepare("SELECT id, name, email, password_hash FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as { id: string; name: string; email: string; password_hash: string } | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new Error("Invalid email or password.");
  }
  return { id: row.id, name: row.name, email: row.email };
}

export const SESSION_COOKIE = COOKIE;