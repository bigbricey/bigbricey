/**
 * Compact adaptive-home state for the chat header.
 * State derivation stays pure; DOM updates are a small browser adapter below.
 */
(function () {
  "use strict";

  const VALID_STATES = new Set([
    "ready",
    "tracking",
    "listening",
    "thinking",
    "verified",
    "reviewing",
    "error",
  ]);

  const COPY = Object.freeze({
    ready: Object.freeze({
      label: "Ready",
      detail: "Tell me what you ate, did, or want to change.",
    }),
    thinking: Object.freeze({
      label: "Working",
      detail: "Reading your request.",
    }),
    listening: Object.freeze({
      label: "Listening",
      detail: "Speak naturally. Review before sending.",
    }),
    verified: Object.freeze({
      label: "Saved",
      detail: "Verified in your log.",
    }),
    reviewing: Object.freeze({
      label: "Review",
      detail: "Your approval is needed before anything changes.",
    }),
    error: Object.freeze({
      label: "Needs attention",
      detail: "That request needs another look.",
    }),
  });

  let visibleItemCount = 0;

  function safeItemCount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  /** Pure, bounded translation from real app state to visible companion copy. */
  function homeView({ state, itemCount } = {}) {
    const count = safeItemCount(itemCount);
    const idleState = count > 0 ? "tracking" : "ready";
    let nextState = VALID_STATES.has(state) ? state : idleState;
    if (nextState === "tracking" && count === 0) nextState = "ready";

    if (nextState === "tracking") {
      return Object.freeze({
        state: nextState,
        label: "Tracking",
        detail: `${count} logged item${count === 1 ? "" : "s"} in view.`,
        itemCount: count,
      });
    }

    const copy = COPY[nextState] || COPY.ready;
    return Object.freeze({
      state: nextState,
      label: copy.label,
      detail: copy.detail,
      itemCount: count,
    });
  }

  function mountView(view) {
    const body = document.body;
    const companion = document.getElementById("companionCore");
    const label = document.getElementById("companionStateLabel");
    const detail = document.getElementById("companionStateDetail");
    if (body) body.dataset.homeState = view.state;
    if (companion) {
      companion.dataset.state = view.state;
      companion.setAttribute("aria-label", `${view.label}. ${view.detail}`);
    }
    if (label) label.textContent = view.label;
    if (detail) detail.textContent = view.detail;
    return view;
  }

  function set(state, { itemCount = visibleItemCount } = {}) {
    visibleItemCount = safeItemCount(itemCount);
    return mountView(homeView({ state, itemCount: visibleItemCount }));
  }

  function render({ itemCount = visibleItemCount } = {}) {
    visibleItemCount = safeItemCount(itemCount);
    return mountView(homeView({ itemCount: visibleItemCount }));
  }

  function init(options = {}) {
    return render(options);
  }

  window.BBHome = Object.freeze({
    init,
    render,
    set,
    homeView,
    states: Object.freeze(Array.from(VALID_STATES)),
  });
})();
