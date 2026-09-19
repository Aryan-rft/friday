import { Router } from "express";
import { registerUser, loginUser, requireAuth, setSessionCookie, clearSessionCookie, destroySession, createSession, SESSION_COOKIE } from "../auth/index.js";
import { rateLimit } from "../lib/ratelimit.js";
import { getDb } from "../db/conn.js";

export const authRouter = Router();

authRouter.post(
  "/register",
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: "auth:register" }),
  (req, res) => {
    const { name, email, password } = req.body ?? {};
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "A valid email is required." });
      return;
    }
    if (typeof password !== "string" || password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters." });
      return;
    }
    try {
      const user = registerUser(typeof name === "string" ? name : "", email, password);
      const token = createSessionFor(user.id);
      setSessionCookie(res, token);
      res.status(201).json({ user, token });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "Registration failed." });
    }
  }
);

authRouter.post(
  "/login",
  rateLimit({ windowMs: 60_000, max: 15, keyPrefix: "auth:login" }),
  (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Email and password are required." });
      return;
    }
    try {
      const user = loginUser(email, password);
      const token = createSessionFor(user.id);
      setSessionCookie(res, token);
      res.json({ user, token });
    } catch (e) {
      res.status(401).json({ error: e instanceof Error ? e.message : "Login failed." });
    }
  }
);

authRouter.post("/logout", (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  const db = getDb();
  const settings = db.prepare("SELECT * FROM settings WHERE user_id = ?").get((req as any).user.id) ?? {};
  res.json({ user: (req as any).user, settings });
});

function createSessionFor(userId: string): string {
  return createSession(userId);
}