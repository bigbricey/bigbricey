import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadHomeApi() {
  const source = await readFile(new URL("../public/home.js", import.meta.url), "utf8");
  const body = { dataset: {} };
  const label = { textContent: "" };
  const detail = { textContent: "" };
  const companion = { dataset: {}, setAttribute() {} };
  const document = {
    body,
    getElementById(id) {
      return {
        companionCore: companion,
        companionStateLabel: label,
        companionStateDetail: detail,
      }[id] || null;
    },
  };
  const window = { document };
  vm.runInNewContext(source, { window, document, Object, String, Number, Math });
  return { api: window.BBHome, body, label, detail, companion };
}

test("home view states use bounded truthful copy", async () => {
  const { api } = await loadHomeApi();

  assert.deepEqual(
    { ...api.homeView({ state: "ready", itemCount: 0 }) },
    {
      state: "ready",
      label: "Ready",
      detail: "Tell me what you ate, did, or want to change.",
      itemCount: 0,
    }
  );
  assert.deepEqual(
    { ...api.homeView({ state: "tracking", itemCount: 2 }) },
    {
      state: "tracking",
      label: "Tracking",
      detail: "2 logged items in view.",
      itemCount: 2,
    }
  );
  assert.equal(api.homeView({ state: "thinking" }).detail, "Reading your request.");
  assert.equal(
    api.homeView({ state: "listening" }).detail,
    "Speak naturally. Review before sending."
  );
  assert.equal(api.homeView({ state: "verified" }).detail, "Verified in your log.");
  assert.equal(
    api.homeView({ state: "reviewing" }).detail,
    "Your approval is needed before anything changes."
  );
  assert.equal(
    api.homeView({ state: "error" }).detail,
    "That request needs another look."
  );
});

test("invalid state and item counts fail safely to visible idle state", async () => {
  const { api } = await loadHomeApi();

  assert.equal(api.homeView({ state: "made_up", itemCount: 4 }).state, "tracking");
  assert.equal(api.homeView({ state: "made_up", itemCount: 4 }).itemCount, 4);
  assert.equal(api.homeView({ itemCount: -20 }).state, "ready");
  assert.equal(api.homeView({ state: "tracking", itemCount: "not-a-number" }).itemCount, 0);
});

test("controller writes one state to the compact companion and body dataset", async () => {
  const { api, body, label, detail, companion } = await loadHomeApi();

  api.init({ itemCount: 0 });
  assert.equal(body.dataset.homeState, "ready");
  assert.equal(label.textContent, "Ready");

  api.render({ itemCount: 3 });
  assert.equal(body.dataset.homeState, "tracking");
  assert.equal(detail.textContent, "3 logged items in view.");

  api.set("thinking", { itemCount: 3 });
  assert.equal(body.dataset.homeState, "thinking");
  assert.equal(companion.dataset.state, "thinking");

  api.set("listening", { itemCount: 3 });
  assert.equal(body.dataset.homeState, "listening");
  assert.equal(label.textContent, "Listening");

  api.set("verified", { itemCount: 4 });
  assert.equal(body.dataset.homeState, "verified");
  assert.equal(label.textContent, "Saved");

  api.set("reviewing", { itemCount: 4 });
  assert.equal(body.dataset.homeState, "reviewing");
  assert.equal(label.textContent, "Review");

  api.set("error", { itemCount: 4 });
  assert.equal(body.dataset.homeState, "error");
  assert.equal(label.textContent, "Needs attention");
});

test("ambient scene animation loop stays off with reduced motion and follows live preference changes", async () => {
  const source = await readFile(new URL("../public/scenes.js", import.meta.url), "utf8");
  const media = {
    matches: true,
    listener: null,
    addEventListener(type, listener) {
      if (type === "change") this.listener = listener;
    },
  };
  let frameRequests = 0;
  let frameCancels = 0;
  let sceneCanvas = null;
  const context = { clearRect() {} };
  const body = {
    dataset: {},
    prepend(node) {
      sceneCanvas = node;
    },
  };
  const document = {
    body,
    getElementById(id) {
      return id === "sceneFx" ? sceneCanvas : null;
    },
    createElement() {
      return {
        dataset: {},
        style: {},
        width: 0,
        height: 0,
        setAttribute() {},
        getContext() {
          return context;
        },
      };
    },
    querySelectorAll() {
      return [];
    },
  };
  const window = {
    document,
    __ntUser: { scene: "snow" },
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 1,
    matchMedia(query) {
      assert.equal(query, "(prefers-reduced-motion: reduce)");
      return media;
    },
    addEventListener() {},
  };
  vm.runInNewContext(source, {
    window,
    document,
    localStorage: { getItem() { return null; }, setItem() {} },
    requestAnimationFrame() {
      frameRequests += 1;
      return frameRequests;
    },
    cancelAnimationFrame() {
      frameCancels += 1;
    },
    Math,
    Object,
    String,
    Number,
  });

  window.BBScenes.init();
  assert.equal(body.dataset.scene, "snow");
  assert.equal(frameRequests, 0, "reduced motion must not start the canvas loop");
  assert.equal(typeof media.listener, "function");

  media.matches = false;
  media.listener();
  assert.equal(frameRequests, 1, "animation may start after reduced motion is disabled");

  media.matches = true;
  media.listener();
  assert.equal(frameRequests, 1, "re-enabling reduced motion must not schedule another frame");
  assert.equal(frameCancels, 1);
  assert.equal(sceneCanvas.style.display, "none");
});
