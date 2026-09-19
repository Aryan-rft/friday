import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  port: number;
  databasePath: string;
  sessionSecret: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  whisperModel: string;
  voiceProvider: "auto" | "browser" | "server";
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  timezone: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(): void {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const parsedPort = Number(process.env.PORT);
export const config: Config = {
  port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8787,
  databasePath: process.env.DATABASE_PATH || path.join(rootDir, "data", "friday.db"),
  sessionSecret: process.env.SESSION_SECRET || "dev-insecure-secret-change-me",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  whisperModel: process.env.WHISPER_MODEL || "whisper-1",
  voiceProvider: (process.env.VOICE_PROVIDER as Config["voiceProvider"]) || "auto",
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
  vapidSubject: process.env.VAPID_SUBJECT || "mailto:admin@localhost",
  timezone: process.env.APP_TIMEZONE || "Asia/Kolkata",
  logLevel: (process.env.LOG_LEVEL as Config["logLevel"]) || "info",
};

export const isAiConfigured = (): boolean => Boolean(config.openaiApiKey);
export const rootDirPath = rootDir;