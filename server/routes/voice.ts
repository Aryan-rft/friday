import { Router } from "express";
import { requireAuth } from "../auth/index.js";
import { transcribeAudio, isAiConfigured } from "../ai/llm.js";
import { rateLimit } from "../lib/ratelimit.js";
import { logger } from "../lib/logger.js";

export const voiceRouter = Router();

voiceRouter.use(requireAuth);
voiceRouter.post(
  "/transcribe",
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "voice" }),
  async (req, res) => {
    if (!isAiConfigured()) {
      res.status(501).json({ error: "Server transcription is not configured. Use browser voice or set OPENAI_API_KEY." });
      return;
    }
    const buf = (req as any).body as Buffer | undefined;
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: "No audio received." });
      return;
    }
    if (buf.length > 25 * 1024 * 1024) {
      res.status(413).json({ error: "Audio too large (max 25 MB)." });
      return;
    }
    const rawType = req.headers["content-type"] || "audio/webm";
    const mime = rawType.split(";")[0] || "audio/webm";
    const start = Date.now();
    try {
      const result = await transcribeAudio(buf, mime);
      logger.info("voice transcription", { latencyMs: Date.now() - start, durationSec: result.durationSec });
      res.json({ text: result.text, language: result.language, latencyMs: Date.now() - start });
    } catch (e) {
      logger.error("voice transcription failed", { error: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: "Voice recognition failed. Tap to retry." });
    }
  }
);