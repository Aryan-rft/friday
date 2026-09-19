import { config } from "../config.js";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[config.logLevel]) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}${meta ? " " + safeJson(meta) : ""}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function safeJson(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return "[unserializable]";
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
};