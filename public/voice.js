/**
 * Review-first browser speech dictation.
 * Speech only updates the existing message draft; app.js remains the sole send path.
 */
(function () {
  "use strict";

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let input = null;
  let button = null;
  let status = null;
  let onState = () => {};
  let recognition = null;
  let listening = false;
  let baseText = "";
  let segments = new Map();
  let settleResolve = null;
  let settleTimer = null;

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function currentDraft() {
    const speech = Array.from(segments.entries())
      .sort(([a], [b]) => a - b)
      .map(([, value]) => clean(value))
      .filter(Boolean)
      .join(" ");
    return [baseText, speech].filter(Boolean).join(" ").trim();
  }

  function writeDraft() {
    if (!input) return "";
    input.value = currentDraft();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  }

  function announce(state, message) {
    if (status) status.textContent = message;
    onState({ state, message, listening, draft: input?.value || "" });
  }

  function paintButton() {
    if (!button) return;
    button.setAttribute("aria-pressed", listening ? "true" : "false");
    button.setAttribute(
      "aria-label",
      listening ? "Stop voice dictation" : "Start voice dictation"
    );
    button.classList.toggle("is-listening", listening);
  }

  function finish(state = "ready", message = "Dictation stopped. Review before sending.") {
    listening = false;
    paintButton();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    writeDraft();
    announce(state, message);
    const resolve = settleResolve;
    settleResolve = null;
    resolve?.(input?.value || "");
    return input?.value || "";
  }

  function createRecognition() {
    const next = new Recognition();
    next.continuous = true;
    next.interimResults = true;
    next.lang = navigator.language || document.documentElement.lang || "en-US";
    next.onresult = (event) => {
      const startIndex = Number.isInteger(event.resultIndex) ? event.resultIndex : 0;
      for (let index = startIndex; index < event.results.length; index += 1) {
        segments.set(index, clean(event.results[index]?.[0]?.transcript));
      }
      writeDraft();
    };
    next.onerror = (event) => {
      const denied = ["not-allowed", "service-not-allowed"].includes(event?.error);
      finish(
        "error",
        denied
          ? "Microphone permission was not granted. Your draft is still here."
          : "Voice dictation stopped. Your draft is still here."
      );
    };
    next.onend = () => {
      if (listening || settleResolve) finish();
    };
    return next;
  }

  function start() {
    if (!Recognition || !input || !button || listening) return false;
    baseText = clean(input.value);
    segments = new Map();
    recognition = createRecognition();
    listening = true;
    paintButton();
    announce("listening", "Listening… Speak naturally, then review before sending.");
    try {
      recognition.start();
      return true;
    } catch {
      finish("error", "Voice dictation could not start. Your draft is still here.");
      return false;
    }
  }

  function settle(method) {
    if (!listening || !recognition) return Promise.resolve(input?.value || "");
    return new Promise((resolve) => {
      settleResolve = resolve;
      settleTimer = setTimeout(() => finish(), 800);
      try {
        recognition[method]();
      } catch {
        finish();
      }
    });
  }

  function stopAndSettle() {
    return settle("stop");
  }

  function abort() {
    return settle("abort");
  }

  function isListening() {
    return listening;
  }

  function init(options = {}) {
    input = options.input || null;
    button = options.button || null;
    status = options.status || null;
    onState = typeof options.onState === "function" ? options.onState : () => {};
    if (!button || !input) return false;
    if (!Recognition) {
      button.hidden = true;
      button.disabled = true;
      return false;
    }
    button.hidden = false;
    button.disabled = false;
    paintButton();
    button.addEventListener("click", () => {
      if (listening) stopAndSettle();
      else start();
    });
    return true;
  }

  window.BBVoice = Object.freeze({ init, start, stopAndSettle, abort, isListening });
})();
