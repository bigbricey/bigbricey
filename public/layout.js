/**
 * Movable Today layout — YouTube-playlist style drag reorder (live snap).
 */
(function () {
  const CORE_PANEL_IDS = [
    "chat",
    "world",
    "kcal",
    "pro",
    "fat",
    "carb",
    "net",
    "minerals",
    "summary",
    "food",
  ];
  // Alias for external callers
  const PANEL_IDS = CORE_PANEL_IDS;
  let extraIds = []; // custom box panel ids (c_*)
  const SIZES = ["full", "half", "third"];
  const SIZE_LABEL = { full: "Full", half: "Half", third: "1/3" };
  const LEGACY_LS_KEY = "bigbricey-layout-v1";
  const LS_PREFIX = "bigbricey-layout-v2-";
  const QUARANTINE_KEY = "bigbricey-unassigned-layout-v1";

  const DEFAULT_LAYOUT = {
    order: CORE_PANEL_IDS.slice(),
    sizes: {
      chat: "full",
      world: "full",
      kcal: "full",
      pro: "full",
      fat: "full",
      carb: "full",
      net: "full",
      minerals: "half",
      summary: "half",
      food: "full",
    },
  };

  let layout = cloneLayout(DEFAULT_LAYOUT);
  let editMode = false;
  let saveTimer = null;

  function storageKey() {
    try {
      return window.BBAccountStorage?.key(LS_PREFIX, window.__ntUser?.email) || null;
    } catch {
      return null;
    }
  }

  function quarantineLegacyPreference() {
    try {
      window.BBAccountStorage?.quarantineLegacyKey(
        localStorage,
        LEGACY_LS_KEY,
        QUARANTINE_KEY
      );
    } catch {
      /* local storage may be unavailable */
    }
  }

  function allPanelIds() {
    const set = new Set(CORE_PANEL_IDS);
    for (const id of extraIds) set.add(id);
    // also pick up any custom panels already in DOM
    document.querySelectorAll(".layout-panel[data-panel]").forEach((el) => {
      if (el.dataset.panel) set.add(el.dataset.panel);
    });
    return Array.from(set);
  }

  function isAllowedId(id) {
    if (!id) return false;
    if (CORE_PANEL_IDS.includes(id)) return true;
    if (extraIds.includes(id)) return true;
    if (/^c_[a-z0-9_]{1,40}$/.test(id)) return true;
    return false;
  }

  function registerExtraIds(ids) {
    extraIds = (Array.isArray(ids) ? ids : [])
      .map((x) => String(x).toLowerCase())
      .filter((id) => isAllowedId(id) && !CORE_PANEL_IDS.includes(id));
  }

  function syncSizesFromBoxes(boxList) {
    if (!Array.isArray(boxList)) return;
    for (const box of boxList) {
      if (!box?.id) continue;
      if (box.size && SIZES.includes(box.size)) {
        layout.sizes[box.id] = box.size;
      }
    }
  }

  // Active pointer drag
  // { id, el, ph, pointerId, offsetX, offsetY, width, height }
  let drag = null;

  function cloneLayout(src) {
    return {
      order: Array.isArray(src?.order) ? src.order.slice() : CORE_PANEL_IDS.slice(),
      sizes: { ...(src?.sizes || {}) },
    };
  }

  function normalizeLayout(raw) {
    const known = allPanelIds();
    const base = cloneLayout(DEFAULT_LAYOUT);
    if (!raw || typeof raw !== "object") {
      // still include extras at end
      for (const id of known) {
        if (!base.order.includes(id)) base.order.push(id);
      }
      return base;
    }

    const seen = new Set();
    const order = [];
    const incoming = Array.isArray(raw.order) ? raw.order : [];
    for (const id of incoming) {
      const key = String(id || "")
        .toLowerCase()
        .trim();
      if (!isAllowedId(key) || seen.has(key)) continue;
      seen.add(key);
      order.push(key);
    }
    if (incoming.length && !seen.has("world")) {
      const chatIndex = order.indexOf("chat");
      if (chatIndex >= 0) {
        order.splice(chatIndex + 1, 0, "world");
        seen.add("world");
      }
    }
    for (const id of known) {
      if (!seen.has(id)) order.push(id);
    }

    const sizes = { ...base.sizes };
    const rs = raw.sizes && typeof raw.sizes === "object" ? raw.sizes : {};
    for (const id of order) {
      const s = String(rs[id] || sizes[id] || (id.startsWith("c_") ? "half" : "full")).toLowerCase();
      sizes[id] = SIZES.includes(s) ? s : "full";
    }
    return { order, sizes };
  }

  function board() {
    return document.getElementById("layoutBoard");
  }

  function panelEl(id) {
    return document.querySelector(`.layout-panel[data-panel="${id}"]`);
  }

  function panelsInDom() {
    const b = board();
    if (!b) return [];
    return Array.from(b.querySelectorAll(":scope > .layout-panel"));
  }

  function orderFromDom() {
    return panelsInDom()
      .map((el) => el.dataset.panel)
      .filter((id) => isAllowedId(id));
  }

  function applyLayout(next, { persist = false, cloud = false } = {}) {
    layout = normalizeLayout(next);
    const b = board();
    if (!b) return layout;

    for (const id of layout.order) {
      const el = panelEl(id);
      if (!el) continue;
      const size = layout.sizes[id] || "full";
      el.dataset.size = size;
      el.classList.toggle("size-full", size === "full");
      el.classList.toggle("size-half", size === "half");
      el.classList.toggle("size-third", size === "third");
      const btn = el.querySelector("[data-size-cycle]");
      if (btn) btn.textContent = SIZE_LABEL[size] || "Full";
      b.appendChild(el);
    }

    if (persist) saveLocal();
    if (cloud) scheduleCloudSave();
    return layout;
  }

  function currentLayout() {
    return cloneLayout(layout);
  }

  function saveLocal() {
    try {
      const key = storageKey();
      if (key) localStorage.setItem(key, JSON.stringify(layout));
    } catch {
      /* quota */
    }
  }

  function loadLocal() {
    try {
      const key = storageKey();
      if (!key) return null;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return normalizeLayout(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function scheduleCloudSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveCloud(layout).catch(() => {});
    }, 350);
  }

  async function saveCloud(lay) {
    try {
      await fetch("/api/auth/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: normalizeLayout(lay) }),
      });
    } catch {
      /* offline ok */
    }
  }

  function setEditMode(on) {
    editMode = Boolean(on);
    document.body.classList.toggle("layout-editing", editMode);
    const editBtn = document.getElementById("btnEditLayout");
    const doneBtn = document.getElementById("btnDoneLayout");
    const resetBtn = document.getElementById("btnResetLayout");
    if (editBtn) editBtn.hidden = editMode;
    if (doneBtn) doneBtn.hidden = !editMode;
    if (resetBtn) resetBtn.hidden = !editMode;
    const hint = document.getElementById("layoutHint");
    if (hint) {
      hint.textContent = editMode
        ? "Grab ⠿ and drag — snaps like a playlist · tap size"
        : "Grab ⠿ on any box to reorder · or tell BigBricey";
    }
  }

  function cycleSize(panelId) {
    const cur = layout.sizes[panelId] || "full";
    const i = SIZES.indexOf(cur);
    const next = SIZES[(i + 1) % SIZES.length];
    layout.sizes[panelId] = next;
    applyLayout(layout, { persist: true, cloud: true });
  }

  function resetLayout() {
    applyLayout(DEFAULT_LAYOUT, { persist: true, cloud: true });
  }

  function ensurePlaceholder() {
    let ph = document.getElementById("layoutDropPlaceholder");
    if (!ph) {
      ph = document.createElement("div");
      ph.id = "layoutDropPlaceholder";
      ph.className = "layout-drop-placeholder";
      ph.setAttribute("aria-hidden", "true");
      ph.innerHTML = '<span class="layout-drop-label">Drop here</span>';
    }
    return ph;
  }

  function clearFloatingStyles(el) {
    el.style.position = "";
    el.style.left = "";
    el.style.top = "";
    el.style.width = "";
    el.style.height = "";
    el.style.zIndex = "";
    el.style.pointerEvents = "";
    el.style.margin = "";
    el.style.transform = "";
  }

  /** Move the drop outline (placeholder) based on pointer Y — live snap slot */
  function snapPlaceholder(clientY) {
    if (!drag?.ph) return;
    const b = board();
    if (!b) return;

    const others = panelsInDom().filter((el) => el !== drag.el);
    let insertBefore = null;
    for (const el of others) {
      const rect = el.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (clientY < mid) {
        insertBefore = el;
        break;
      }
    }

    if (insertBefore) {
      if (drag.ph.nextElementSibling !== insertBefore) {
        b.insertBefore(drag.ph, insertBefore);
      }
    } else {
      // after last real panel
      const last = others[others.length - 1];
      if (last) {
        if (last.nextElementSibling !== drag.ph) {
          last.after(drag.ph);
        }
      } else if (drag.ph.parentNode !== b) {
        b.appendChild(drag.ph);
      }
    }
  }

  function autoScroll(clientY) {
    const edge = 72;
    const speed = 14;
    if (clientY < edge) {
      window.scrollBy(0, -speed);
    } else if (clientY > window.innerHeight - edge) {
      window.scrollBy(0, speed);
    }
  }

  function endDrag(save) {
    if (!drag) return;
    const el = drag.el;
    const ph = drag.ph;
    try {
      if (drag.pointerId != null && el.releasePointerCapture) {
        el.releasePointerCapture(drag.pointerId);
      }
    } catch {
      /* already released */
    }

    // Land panel where the outline is
    if (ph && ph.parentNode) {
      ph.parentNode.insertBefore(el, ph);
      ph.remove();
    }
    clearFloatingStyles(el);
    el.classList.remove("is-dragging");
    document.body.classList.remove("layout-dragging");

    layout.order = orderFromDom();
    // re-apply size classes cleanly
    applyLayout(layout, { persist: !!save, cloud: !!save });

    drag = null;
  }

  function onPointerDown(e) {
    // Grab handle OR the chrome strip (where the hand cursor shows)
    const grab = e.target.closest(".layout-drag, .layout-panel-chrome");
    if (!grab) return;
    // Don't start drag from size button
    if (e.target.closest(".layout-size-btn, button, a, input, textarea")) return;
    if (e.button != null && e.button !== 0) return;

    const panel = grab.closest(".layout-panel");
    if (!panel?.dataset.panel) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = panel.getBoundingClientRect();
    const size = panel.dataset.size || "full";
    const ph = ensurePlaceholder();
    ph.className = "layout-drop-placeholder size-" + size;
    ph.style.height = Math.round(rect.height) + "px";
    ph.style.minHeight = Math.round(rect.height) + "px";

    // Slot outline stays in list; panel floats with the pointer
    panel.parentNode.insertBefore(ph, panel);

    panel.classList.add("is-dragging");
    document.body.classList.add("layout-dragging");
    panel.style.position = "fixed";
    panel.style.left = rect.left + "px";
    panel.style.top = rect.top + "px";
    panel.style.width = rect.width + "px";
    panel.style.height = rect.height + "px";
    panel.style.zIndex = "1000";
    panel.style.pointerEvents = "none";
    panel.style.margin = "0";

    drag = {
      id: panel.dataset.panel,
      el: panel,
      ph,
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };

    try {
      panel.setPointerCapture(e.pointerId);
    } catch {
      /* older */
    }
  }

  function onPointerMove(e) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();

    // Float the box with the cursor
    drag.el.style.top = e.clientY - drag.offsetY + "px";
    drag.el.style.left = e.clientX - drag.offsetX + "px";

    autoScroll(e.clientY);
    snapPlaceholder(e.clientY);
  }

  function onPointerUp(e) {
    if (!drag || (e.pointerId != null && drag.pointerId !== e.pointerId)) return;
    endDrag(true);
  }

  function wireBoard() {
    const b = board();
    if (!b || b.dataset.layoutWired) return;
    b.dataset.layoutWired = "1";

    // Pointer events on board (handles bubble from .layout-drag)
    b.addEventListener("pointerdown", onPointerDown);
    b.addEventListener("pointermove", onPointerMove);
    b.addEventListener("pointerup", onPointerUp);
    b.addEventListener("pointercancel", onPointerUp);

    b.addEventListener("click", (e) => {
      const sizeBtn = e.target.closest("[data-size-cycle]");
      if (!sizeBtn) return;
      // Size only in edit mode (keeps normal use clean) OR always allow — always allow is fine
      const panel = sizeBtn.closest(".layout-panel");
      if (panel?.dataset.panel) {
        e.preventDefault();
        cycleSize(panel.dataset.panel);
      }
    });
  }

  function wireToolbar() {
    document.getElementById("btnEditLayout")?.addEventListener("click", () => {
      setEditMode(true);
    });
    document.getElementById("btnDoneLayout")?.addEventListener("click", () => {
      saveLocal();
      scheduleCloudSave();
      setEditMode(false);
    });
    document.getElementById("btnResetLayout")?.addEventListener("click", () => {
      if (!confirm("Reset layout to default?")) return;
      resetLayout();
    });
  }

  function applyFromAction(action) {
    if (!action || typeof action !== "object") return layout;
    if (action.reset || action.type === "reset_layout") {
      resetLayout();
      return layout;
    }

    let next = cloneLayout(layout);

    if (Array.isArray(action.order) && action.order.length) {
      next.order = action.order;
    }

    if (action.sizes && typeof action.sizes === "object") {
      next.sizes = { ...next.sizes, ...action.sizes };
    }

    const panel =
      action.panel ||
      action.id ||
      action.put ||
      (action.size && action.target) ||
      null;
    if (action.size && panel && isAllowedId(String(panel).toLowerCase())) {
      const s = String(action.size).toLowerCase();
      if (SIZES.includes(s)) next.sizes[String(panel).toLowerCase()] = s;
    }

    const put = action.put || action.move || action.panel_id;
    const before = action.before;
    const after = action.after;
    if (put && (before || after)) {
      const id = String(put).toLowerCase();
      const anchor = String(before || after).toLowerCase();
      if (isAllowedId(id) && isAllowedId(anchor)) {
        let order = next.order.filter((x) => x !== id);
        const ai = order.indexOf(anchor);
        if (ai >= 0) {
          order.splice(before ? ai : ai + 1, 0, id);
        } else {
          order.push(id);
        }
        for (const p of allPanelIds()) {
          if (!order.includes(p)) order.push(p);
        }
        next.order = order;
      }
    }

    if (action.chat_bottom || action.chat === "bottom") {
      next.order = next.order.filter((x) => x !== "chat").concat(["chat"]);
    }
    if (action.chat_top || action.chat === "top") {
      next.order = ["chat"].concat(next.order.filter((x) => x !== "chat"));
    }

    return applyLayout(next, { persist: true, cloud: true });
  }

  function initLayout() {
    quarantineLegacyPreference();
    wireBoard();
    wireToolbar();

    const cloud = window.__ntUser?.layout;
    const local = loadLocal();
    const seed = cloud || local || DEFAULT_LAYOUT;
    applyLayout(seed, { persist: false });
    setEditMode(false);

    if (cloud && !local) saveLocal();
  }

  window.BBLayout = {
    init: initLayout,
    apply: applyLayout,
    applyFromAction,
    current: currentLayout,
    reset: resetLayout,
    setEditMode,
    registerExtraIds,
    syncSizesFromBoxes,
    DEFAULT: DEFAULT_LAYOUT,
    PANEL_IDS: CORE_PANEL_IDS,
  };
})();
