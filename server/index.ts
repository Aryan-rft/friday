import os from "node:os";
import { execSync } from "node:child_process";
import { createApp } from "./app.js";
import { migrate } from "./db/migrations.js";
import { startReminderEngine } from "./reminders/engine.js";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";

migrate();
startReminderEngine();

/** LAN IPv4s of this machine, for the "open on your phone" banner. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const app = createApp();
app.listen(config.port, () => {
  logger.info(`Friday API listening on http://localhost:${config.port}`);
  const ips = lanAddresses();
  for (const ip of ips) {
    logger.info(`  📱 from your phone (same Wi-Fi):  http://${ip}:${config.port}`);
  }
  try {
    const local = execSync("scutil --get LocalHostName", { encoding: "utf8" }).trim();
    if (local) logger.info(`  📱 or try:                          http://${local}.local:${config.port}`);
  } catch {
    /* non-macOS or scutil unavailable — IP above is enough */
  }
  logger.info(`Database: ${config.databasePath}`);
});
