/** UI primitives: element builder, toasts, modals, voice capture. */

import { transcribe } from "./api.js";

// ─── Element builder ─────────────────────────────────────────────────────────

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "value") (node as HTMLInputElement).value = String(v);
    else if (k === "checked") (node as HTMLInputElement).checked = Boolean(v);
    else if (k === "disabled") (node as HTMLInputElement).disabled = Boolean(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ─── Toasts ──────────────────────────────────────────────────────────────────

export function toast(message: string, kind: "ok" | "err" | "info" = "info", ms = 3800): void {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const icon = kind === "ok" ? "✅" : kind === "err" ? "⚠️" : "💬";
  const t = el("div", { class: `toast ${kind}`, role: "status" }, el("span", { text: icon }), el("span", { text: message }));
  root.append(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity .25s";
    setTimeout(() => t.remove(), 260);
  }, ms);
}

// ─── Modal ───────────────────────────────────────────────────────────────────

export function openModal(title: string, content: HTMLElement): () => void {
  const root = document.getElementById("modal-root")!;
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e: Event) => e.target === backdrop && close() });
  const modal = el(
    "div",
    { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
    el(
      "div",
      { class: "row", style: { marginBottom: "10px" } },
      el("h2", { text: title, style: { flex: "1", margin: "0" } }),
      el("button", { class: "icon-btn", html: "✕", "aria-label": "Close", onclick: () => close() })
    ),
    content
  );
  backdrop.append(modal);
  root.append(backdrop);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  return close;
}

export function confirmModal(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const content = el(
      "div",
      {},
      el("p", { class: "muted", text: message }),
      el(
        "div",
        { class: "row", style: { marginTop: "16px" } },
        el("button", { class: "btn block", text: "Cancel", onclick: () => { close(); resolve(false); } }),
        el("button", { class: "btn primary block", text: "Confirm", onclick: () => { close(); resolve(true); } })
      )
    );
    const close = openModal(title, content);
  });
}

// ─── Voice capture ───────────────────────────────────────────────────────────
/**
 * Voice pipeline:
 * 1. Web Speech API (Chrome/Edge/Android) — live interim text, fastest path.
 * 2. MediaRecorder → /api/voice/transcribe (server Whisper) — Safari/Firefox
 *    or when configured VOICE_PROVIDER=server.
 */
export interface VoiceHandle {
  stop(): void;
}

export interface VoiceHandlers {
  onState(state: "listening" | "processing" | "idle"): void;
  onPartial?(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
}

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export async function startVoiceCapture(h: VoiceHandlers): Promise<VoiceHandle | null> {
  const SR = getSpeechRecognition();
  const providerPref = localStorage.getItem("friday-voice-provider") || "auto";

  if (SR && providerPref !== "server") {
    let stopped = false;
    let finalText = "";
    let gotResult = false;
    const rec = new SR();
    rec.lang = navigator.language?.startsWith("en") ? navigator.language : "en-IN";
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e: any) => {
      gotResult = true;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      h.onPartial?.((finalText + " " + interim).trim());
    };
    rec.onerror = (e: any) => {
      const code = e?.error || "unknown";
      if (code === "not-allowed" || code === "service-not-allowed") {
        h.onError("Microphone permission denied. Allow mic access in your browser settings.");
      } else if (code === "no-speech") {
        h.onError("Didn't catch that — tap and speak again.");
      } else if (code === "network") {
        h.onError("Speech service unreachable. Check your connection.");
      } else if (code !== "aborted") {
        h.onError("Voice recognition failed. Tap to retry.");
      }
    };
    rec.onend = () => {
      if (stopped) return;
      if (finalText.trim()) {
        h.onState("processing");
        h.onFinal(finalText.trim());
      } else if (!gotResult) {
        h.onError("Didn't catch that — tap and speak again.");
      } else {
        h.onState("idle");
      }
    };

    try {
      rec.start();
      h.onState("listening");
    } catch {
      h.onError("Could not start the microphone. Tap to retry.");
      return null;
    }
    return {
      stop() {
        stopped = true;
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      },
    };
  }

  // Fallback: record audio → server transcription
  try {
    return await startServerCapture(h);
  } catch {
    h.onError("Voice recognition failed. Tap to retry.");
    return null;
  }
}

async function startServerCapture(h: VoiceHandlers): Promise<VoiceHandle | null> {
  if (!navigator.mediaDevices?.getUserMedia) {
    h.onError("Voice input isn't supported in this browser. Type instead — it works the same.");
    return null;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    h.onError("Microphone permission denied. Allow mic access in your browser settings.");
    return null;
  }
  h.onState("listening");
  const chunks: BlobPart[] = [];
  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    h.onState("processing");
    try {
      const blob = new Blob(chunks, { type: mime || "audio/webm" });
      if (blob.size < 1200) {
        h.onError("Didn't catch that — tap and speak again.");
        return;
      }
      const text = await transcribe(blob);
      if (!text.trim()) h.onError("Heard nothing usable — try again a bit closer to the mic.");
      else h.onFinal(text.trim());
    } catch (e: any) {
      h.onError(e?.message || "Voice recognition failed. Tap to retry.");
    }
  };
  recorder.start();
  return {
    stop() {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

export const browserSpeechAvailable = (): boolean => {
  const w = window as any;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
};
