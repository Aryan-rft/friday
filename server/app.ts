import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { rootDirPath } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { assistantRouter } from "./routes/assistant.js";
import { voiceRouter } from "./routes/voice.js";
import { tasksRouter } from "./routes/tasks.js";
import { restRouter } from "./routes/rest.js";
import { logger } from "./lib/logger.js";

/** Minimal cookie parser (avoids a dependency for two lines of logic). */
function cookieParser(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.cookie;
  const cookies: Record<string, string> = {};
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) {
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
      }
    }
  }
  (req as Request & { cookies?: Record<string, string> }).cookies = cookies;
  next();
}

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(cookieParser);
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      if (res.statusCode >= 400) {
        logger.info("http", { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start, ip: (req.ip || "").replace(/^::ffff:/, "") });
      }
    });
    next();
  });

  // Health first — it must not be swallowed by the authed /api mount below.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use("/api/auth", express.json({ limit: "100kb" }), authRouter);
  // Raw audio body for transcription (no multipart needed)
  app.use("/api/voice", express.raw({ type: () => true, limit: "26mb" }), voiceRouter);
  app.use("/api/assistant", express.json({ limit: "1mb" }), assistantRouter);
  app.use("/api/tasks", express.json({ limit: "1mb" }), tasksRouter);
  app.use("/api", express.json({ limit: "1mb" }), restRouter);

  // 404 for unknown API routes
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  // Static frontend (production build)
  const distDir = path.join(rootDirPath, "dist");
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res
        .status(200)
        .send("Friday API is running. Start the web app with `npm run dev` or build it with `npm run build`.");
    });
  }

  // Central error handler — never leak stack traces
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("unhandled error", { message: err.message });
    res.status(err.status || 500).json({ error: "Something went wrong." });
  });

  return app;
}