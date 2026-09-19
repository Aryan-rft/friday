import { config, isAiConfigured } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  if (!isAiConfigured()) throw new Error("AI not configured");
  const body: Record<string, unknown> = {
    model: config.openaiModel,
    messages,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned empty content");
  return content;
}

/** Extract the first JSON object from a possibly noisy model response. */
export function extractJson<T = Record<string, unknown>>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through to scanning */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      /* fall through */
    }
  }
  throw new Error("Could not parse JSON from model response");
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSec?: number;
}

/** Transcribe audio via a Whisper-compatible endpoint (multipart form). */
export async function transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
  if (!isAiConfigured()) throw new Error("AI not configured");
  const form = new FormData();
  const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("wav") ? "wav" : "webm";
  form.append("file", new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
  form.append("model", config.whisperModel);
  form.append("language", "en");
  form.append("response_format", "json");
  form.append(
    "prompt",
    "Transcribe Indian English and Hinglish (Hindi-English mix). Preserve names like KUK, RFT, Rita, CEO, ma'am, sir. Preserve acronyms, dates, times, and numbers exactly. Examples: 'kal' (tomorrow), 'karna hai', 'ke liye', '12:30 wali lecture'."
  );

  const res = await fetch(`${config.openaiBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Transcription failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { text?: string; language?: string; duration?: number };
  if (!data.text || !data.text.trim()) throw new Error("Transcription returned empty text");
  return {
    text: data.text.trim(),
    language: data.language,
    durationSec: data.duration,
  };
}

export { isAiConfigured };