import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

function fakeClassList() {
  const values = new Set();
  return {
    toggle(name, force) {
      if (force) values.add(name);
      else values.delete(name);
    },
    contains(name) {
      return values.has(name);
    },
  };
}

async function loadVoiceApi({ supported = true, inputValue = "" } = {}) {
  const source = await readFile(new URL("../public/voice.js", import.meta.url), "utf8");
  const listeners = new Map();
  const attributes = new Map();
  const events = [];
  const states = [];
  let fetchCount = 0;

  const input = {
    value: inputValue,
    dispatchEvent(event) {
      events.push(event.type);
    },
  };
  const button = {
    hidden: true,
    disabled: false,
    classList: fakeClassList(),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
  };
  const status = { textContent: "" };

  class FakeRecognition {
    static instance = null;

    constructor() {
      FakeRecognition.instance = this;
      this.continuous = false;
      this.interimResults = false;
      this.startCount = 0;
      this.stopCount = 0;
      this.abortCount = 0;
      this.onStop = null;
      this.onAbort = null;
    }

    start() {
      this.startCount += 1;
    }

    stop() {
      this.stopCount += 1;
      if (this.onStop) this.onStop();
      else this.onend?.();
    }

    abort() {
      this.abortCount += 1;
      if (this.onAbort) this.onAbort();
      else this.onend?.();
    }

    emitResult(parts, resultIndex = 0) {
      const results = parts.map(({ text, final = false }) => {
        const result = [{ transcript: text }];
        result.isFinal = final;
        return result;
      });
      this.onresult?.({ resultIndex, results });
    }

    emitError(error) {
      this.onerror?.({ error });
    }
  }

  class FakeEvent {
    constructor(type) {
      this.type = type;
    }
  }

  const window = {
    document: { documentElement: { lang: "en" } },
    navigator: { language: "en-US" },
    Event: FakeEvent,
    fetch() {
      fetchCount += 1;
      throw new Error("voice input must not call the network");
    },
  };
  if (supported) window.SpeechRecognition = FakeRecognition;
  vm.runInNewContext(source, {
    window,
    document: window.document,
    navigator: window.navigator,
    Event: FakeEvent,
    Map,
    Object,
    String,
    Promise,
    setTimeout,
    clearTimeout,
  });

  const initialized = window.BBVoice.init({
    input,
    button,
    status,
    onState(change) {
      states.push(change);
    },
  });

  return {
    api: window.BBVoice,
    initialized,
    input,
    button,
    status,
    states,
    events,
    attributes,
    listeners,
    recognition: () => FakeRecognition.instance,
    fetchCount: () => fetchCount,
  };
}

test("unsupported browsers keep normal chat available and hide the microphone", async () => {
  const voice = await loadVoiceApi({ supported: false, inputValue: "keep this" });

  assert.equal(voice.initialized, false);
  assert.equal(voice.button.hidden, true);
  assert.equal(voice.button.disabled, true);
  assert.equal(voice.input.value, "keep this");
  assert.equal(voice.api.isListening(), false);
});

test("dictation preserves typed text and replaces interim words without duplication", async () => {
  const voice = await loadVoiceApi({ inputValue: "Already typed" });
  assert.equal(voice.initialized, true);
  assert.equal(voice.button.hidden, false);

  voice.api.start();
  const recognition = voice.recognition();
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, true);
  assert.equal(voice.attributes.get("aria-pressed"), "true");

  recognition.emitResult([{ text: "log two eggs", final: false }]);
  assert.equal(voice.input.value, "Already typed log two eggs");
  recognition.emitResult([{ text: "log two eggs", final: true }]);
  assert.equal(voice.input.value, "Already typed log two eggs");
  recognition.emitResult(
    [
      { text: "log two eggs", final: true },
      { text: "and bacon", final: false },
    ],
    1
  );
  assert.equal(voice.input.value, "Already typed log two eggs and bacon");
  recognition.emitResult(
    [
      { text: "log two eggs", final: true },
      { text: "and bacon", final: true },
    ],
    1
  );
  assert.equal(voice.input.value, "Already typed log two eggs and bacon");
  assert.equal(voice.fetchCount(), 0);
  assert.ok(voice.events.includes("input"));
});

test("send can stop and settle the final transcript without auto-sending it", async () => {
  const voice = await loadVoiceApi();
  voice.api.start();
  const recognition = voice.recognition();
  recognition.emitResult([{ text: "yes", final: false }]);
  recognition.onStop = () => {
    recognition.emitResult([{ text: "yes", final: true }]);
    recognition.onend?.();
  };

  const draft = await voice.api.stopAndSettle();
  assert.equal(draft, "yes");
  assert.equal(voice.input.value, "yes");
  assert.equal(recognition.stopCount, 1);
  assert.equal(voice.attributes.get("aria-pressed"), "false");
  assert.equal(voice.fetchCount(), 0);
});

test("permission errors and aborts retain the draft and recover cleanly", async () => {
  const denied = await loadVoiceApi({ inputValue: "Breakfast" });
  denied.api.start();
  denied.recognition().emitResult([{ text: "three eggs", final: false }]);
  denied.recognition().emitError("not-allowed");
  denied.recognition().onend?.();
  assert.equal(denied.input.value, "Breakfast three eggs");
  assert.match(denied.status.textContent, /permission/i);
  assert.equal(denied.api.isListening(), false);
  assert.equal(denied.states.at(-1).state, "error");

  const aborted = await loadVoiceApi({ inputValue: "Lunch" });
  aborted.api.start();
  aborted.recognition().emitResult([{ text: "steak", final: true }]);
  const draft = await aborted.api.abort();
  assert.equal(draft, "Lunch steak");
  assert.equal(aborted.recognition().abortCount, 1);
  assert.equal(aborted.api.isListening(), false);
});

test("voice UI is review-first, lifecycle-safe, and honestly disclosed", async () => {
  const [html, app, voice, vision, privacy] = await Promise.all([
    readFile(new URL("../public/app.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/voice.js", import.meta.url), "utf8"),
    readFile(new URL("../public/vision.js", import.meta.url), "utf8"),
    readFile(new URL("../public/privacy.html", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="voiceBtn"[^>]+aria-pressed="false"[^>]+hidden/);
  assert.match(html, /id="voiceStatus"[^>]+role="status"/);
  assert.ok(html.indexOf("voice.js") < html.indexOf("app.js"));
  assert.match(app, /await window\.BBVoice\?\.stopAndSettle\?\.\(\)/);
  assert.ok(
    app.indexOf("stopAndSettle") <
      app.indexOf("const text = foodInput.value.trim()", app.indexOf("async function onSend"))
  );
  assert.match(app, /BBVoice\?\.abort\?\.\("day_change"\)/);
  assert.match(app, /BBVoice\?\.abort\?\.\("conversation_change"\)/);
  assert.match(app, /addEventListener\("pagehide"/);
  assert.match(app, /a\[href="\/api\/auth\/logout"\]/);
  assert.match(vision, /adapter\.stopVoice\?\.\(\)/);
  assert.doesNotMatch(voice, /fetch\s*\(/);
  assert.doesNotMatch(voice, /onSend|submit\s*\(/);
  assert.match(privacy, /browser(?: or device)? vendor/i);
  assert.match(privacy, /only the transcript you choose to send/i);
});
