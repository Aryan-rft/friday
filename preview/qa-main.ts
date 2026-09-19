/**
 * QA harness entry — NOT part of the app.
 * Loads the fetch shim first, then boots the REAL app modules. Used only for
 * visual/interaction QA in the preview; the production entry is src/main.ts.
 */

import "./shim.js";
import "../src/styles.css";

// Deterministic preview environment:
// - No service worker is served here, so stub `register` to a handled rejection.
// - The webview exposes an inert SpeechRecognition stub that hangs forever; the
//   harness removes it so the mic path deterministically falls back to typing.
Object.defineProperty(navigator, "serviceWorker", {
  configurable: true,
  value: { register: () => Promise.reject(new Error("preview: no service worker")) },
});
Object.defineProperty(navigator, "mediaDevices", { configurable: true, get: () => undefined });
try {
  // `delete operator on navigator properties can fail; Reflect handles it.
  Reflect.deleteProperty(window, "SpeechRecognition");
  Reflect.deleteProperty(window, "webkitSpeechRecognition");
} catch {
  /* keep whatever the host provides */
}

// Theme before first paint (mirrors index.html behavior).
try {
  if (localStorage.getItem("friday-theme") === "light") document.documentElement.dataset.theme = "light";
} catch {
  /* ignore */
}

// Hooks for the QA driver.
(window as any).__qa = {
  setRoute: (r: string) => {
    location.hash = `#/${r}`;
  },
};

// Boot the real app.
import "../src/main.js";
