let selectedDay = todayKey();
let rows = [];
let storageAccount = null;
let sortKey = null;
let sortDesc = true;
let cloudReady = false;
let calendarDays = [];
let activeTab = "today";

const CHART_COLORS = {
  kcal: "#38bdf8",
  protein: "#34d399",
  fat: "#fbbf24",
  carbs: "#a78bfa",
  potassium: "#c084fc",
  magnesium: "#2dd4bf",
  sodium: "#f87171",
  steps: "#60a5fa",
};

const foodInput = document.getElementById("foodInput");
const addBtn = document.getElementById("addBtn");
const chatLog = document.getElementById("chatLog");
const sortStatus = document.getElementById("sortStatus");
const apiStatus = document.getElementById("apiStatus");
const tbody = document.getElementById("tbody");
const foodCards = document.getElementById("foodCards");
const foodEmpty = document.getElementById("foodEmpty");

/** Default daily goals (overridden by watches when present). Low-carb friendly. */
const DEFAULT_GOALS = {
  kcal: 2000,
  protein: 150,
  fat: 100,
  carbs: 50,
  net_carbs: 50,
  potassium: 3500,
  magnesium: 350,
};

let dayGoals = { ...DEFAULT_GOALS };
let pendingDeleteId = null;
let sending = false;
let conversationId = null;
let pendingToolConfirmation = null;
let daySelectionEpoch = 0;
let conversationEpoch = 0;
let conversationLoadEpoch = 0;
let memoryRequestEpoch = 0;
let memoryRecords = [];
let memoryLoadedAccount = null;
const dayRevisions = new Map();

init();

async function init() {
  const ok = await requireAuth();
  if (!ok) return;
  configureAccountStorage(window.__ntUser?.email);
  rows = loadLocal(selectedDay);
  initVisionCapture();
  wireMemoryCenter();

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => sortBy(th.dataset.key, th.dataset.type));
  });
  addBtn?.addEventListener("click", onSend);
  foodInput?.addEventListener("keydown", (e) => {
    // Enter = send; Shift+Enter = new line (normal chat box)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  // Auto-grow textarea up to max-height, then scrollbar
  window.__growFoodInput = () => {
    if (!foodInput) return;
    foodInput.style.height = "auto";
    if (!foodInput.value.trim()) {
      foodInput.style.height = "52px"; // collapsed empty size
      return;
    }
    const max = 220;
    foodInput.style.height = Math.min(foodInput.scrollHeight, max) + "px";
  };
  foodInput?.addEventListener("input", window.__growFoodInput);
  window.__growFoodInput();

  const clear = async () => {
    const day = selectedDay;
    if (!confirm(`Clear all food for ${day}? This cannot be undone.`)) return;
    const account = storageAccount;
    const selectionEpoch = daySelectionEpoch;
    const expectedRevision = getDayRevision(day, account);
    const previousRows = rows.map((row) => ({ ...row }));
    rows = [];
    saveLocalRows(day, rows, account);
    render();
    const result = await syncCloud(true, {
      allowClear: true,
      day,
      rows: [],
      expectedRevision,
    });
    if (!sameDayContext(account, day, selectionEpoch)) return;
    if (result?.ok) {
      appendChat("bot", `Cleared ${day}.`);
    } else if (!result?.conflict) {
      rows = previousRows;
      saveLocalRows(day, rows, account);
      render();
      appendChat("bot", `I couldn't safely clear ${day}, so nothing changed.`, true);
    }
    loadCharts();
  };
  document.getElementById("clearDay")?.addEventListener("click", clear);
  document.getElementById("clearDay2")?.addEventListener("click", clear);

  document.getElementById("wSave")?.addEventListener("click", saveWatchFromForm);
  document.getElementById("refreshFeedback")?.addEventListener("click", loadFeedbackInbox);
  document.getElementById("refreshUsage")?.addEventListener("click", loadUsageInbox);
  document.getElementById("btnExport30")?.addEventListener("click", () => exportStatsPack(30));
  document.getElementById("btnExport7")?.addEventListener("click", () => exportStatsPack(7));
  document.getElementById("refreshCharts")?.addEventListener("click", loadCharts);
  document.getElementById("chartToggles")?.addEventListener("change", loadCharts);

  document.getElementById("confirmCancel")?.addEventListener("click", closeConfirm);
  document.getElementById("confirmOk")?.addEventListener("click", confirmDelete);
  document.getElementById("btnManualAdd")?.addEventListener("click", () => {
    const m = document.getElementById("manualModal");
    if (m) m.hidden = false;
  });
  document.getElementById("manualCancel")?.addEventListener("click", () => {
    const m = document.getElementById("manualModal");
    if (m) m.hidden = true;
  });
  document.getElementById("manualOk")?.addEventListener("click", addManualFood);

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setTab(tab.dataset.tab));
  });

  document.getElementById("chartRangeSeg")?.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#chartRangeSeg button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      loadCharts();
    });
  });

  const menuBtn = document.getElementById("menuBtn");
  const menu = document.getElementById("menu");
  menuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!menu) return;
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", () => {
    if (menu) menu.hidden = true;
  });
  menu?.addEventListener("click", (e) => e.stopPropagation());

  const picker = document.getElementById("dayPicker");
  if (picker) {
    picker.value = selectedDay;
    picker.addEventListener("change", () => {
      if (picker.value) selectDay(picker.value);
    });
  }
  document.getElementById("dayPrev")?.addEventListener("click", () =>
    selectDay(shiftDay(selectedDay, -1))
  );
  document.getElementById("dayNext")?.addEventListener("click", () =>
    selectDay(shiftDay(selectedDay, 1))
  );
  document.getElementById("dayToday")?.addEventListener("click", () => selectDay(todayKey()));

  checkApi();
  updateDayLabel();
  const justOnboarded = personalizeWelcome();
  if (window.BBTheme) window.BBTheme.init();
  if (window.BBScenes) {
    window.BBScenes.init();
  }
  if (window.BBLayout) window.BBLayout.init();
  if (window.BBBoxes) window.BBBoxes.init();
  wireChatHistoryUi();
  await loadFromCloud(selectedDay);
  render();
  if (window.BBBoxes) window.BBBoxes.loadValuesForDay(selectedDay);
  if (!justOnboarded) await restoreConversation();
  loadWatches();
  loadAlerts();
  loadCharts();
  setTab("today");
}

function personalizeWelcome() {
  const u = window.__ntUser;
  if (!u) return false;
  const justOnboarded = new URLSearchParams(location.search).has("welcome");
  if (!justOnboarded) return false;
  const o = u.onboarding || {};
  const name = o.first_name || (u.name || "").split(/\s+/)[0] || "";
  const goalMap = {
    lose: "lose weight",
    maintain: "maintain",
    muscle: "build muscle",
    gain: "build muscle",
  };
  const goal = goalMap[o.primary_goal] || null;
  const g = u.goals || o.goals || {};
  history.replaceState({}, "", "/app.html");
  setConversationId(null);
  const bits = [];
  if (name) bits.push(`You’re set, ${name}.`);
  else bits.push("You’re set.");
  if (goal) bits.push(`Primary goal: ${goal}.`);
  if (g.kcal) {
    bits.push(
      `I sized your day around ~${g.kcal} kcal and ${g.protein || "—"}g protein.`
    );
  }
  bits.push(
    "Tell me what you ate or did — e.g. “3 eggs and bacon”, “40 push-ups”, “210 lb weigh-in”."
  );
  const bubble = appendChat("bot", bits.join(" "), false, { scroll: false });
  bubble?.classList.add("welcome");
  return true;
}

function setTab(tab) {
  activeTab = tab || "today";
  document.body.className = "tab-" + activeTab;
  ["today", "trends", "goals", "you"].forEach((t) => {
    const panel = document.getElementById(
      "panel" + t.charAt(0).toUpperCase() + t.slice(1)
    );
    if (panel) panel.hidden = t !== activeTab;
  });
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === activeTab);
  });
  if (activeTab === "trends") loadCharts();
  if (activeTab === "goals") loadWatches();
  if (activeTab === "you") loadMemories();
  if (activeTab === "you" && window.__ntUser?.admin) {
    loadFeedbackInbox();
    loadUsageInbox();
  }
}

function todayKey() {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function shiftDay(dayKey, delta) {
  const [y, m, d] = String(dayKey).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function dayRevisionKey(account, day) {
  const owner = String(account || "").trim().toLowerCase();
  const date = String(day || "").trim();
  return owner && date ? `${owner}\u0000${date}` : null;
}

function getDayRevision(day, account = storageAccount) {
  const key = dayRevisionKey(account, day);
  return key && dayRevisions.has(key) ? dayRevisions.get(key) : null;
}

function setDayRevision(day, revision, account = storageAccount) {
  const key = dayRevisionKey(account, day);
  const number = Number(revision);
  if (key && Number.isInteger(number) && number >= 0) {
    dayRevisions.set(key, number);
  }
}

function sameDayContext(account, day, selectionEpoch = daySelectionEpoch) {
  return (
    storageAccount === account &&
    selectedDay === day &&
    daySelectionEpoch === selectionEpoch
  );
}

function visionContext() {
  return {
    account: storageAccount,
    day: selectedDay,
    selectionEpoch: daySelectionEpoch,
    conversationId,
    conversationEpoch,
  };
}

function visionContextMatches(context) {
  return Boolean(
    context &&
      sameDayContext(context.account, context.day, context.selectionEpoch) &&
      conversationId === context.conversationId &&
      conversationEpoch === context.conversationEpoch
  );
}

async function commitVisionRows(proposedRows, context) {
  if (!visionContextMatches(context)) {
    return {
      ok: false,
      stale: true,
      message: "The selected day or conversation changed. Scan the photo again here.",
    };
  }
  const additions = (Array.isArray(proposedRows) ? proposedRows : [])
    .filter((row) => row && typeof row === "object")
    .slice(0, 8)
    .map((row) => ({ ...row, id: newId() }));
  if (!additions.length) {
    return { ok: false, message: "Choose at least one complete item to log." };
  }
  const previousRows = rows.map((row) => ({ ...row }));
  const expectedRevision = getDayRevision(context.day, context.account);
  const nextRows = ensureUniqueIds([...previousRows, ...additions]);
  rows = nextRows;
  saveLocalRows(context.day, nextRows, context.account);
  render();
  const result = await syncCloud(true, {
    day: context.day,
    rows: nextRows,
    expectedRevision,
  });
  const stillVisible = visionContextMatches(context);
  if (result?.ok) {
    if (stillVisible) {
      render();
      pulseVerifiedLogUpdate(additions);
      appendChat("bot", "Logged from your photo after your review.", false, {
        receipt: buildVerifiedLogReceipt(additions, context.day),
      });
    }
    return { ok: true, committedRows: additions, stale: !stillVisible };
  }
  if (!result?.conflict && stillVisible) {
    rows = previousRows;
    saveLocalRows(context.day, previousRows, context.account);
    render();
  }
  return {
    ok: false,
    conflict: Boolean(result?.conflict),
    message: result?.conflict
      ? "The day changed somewhere else, so I reloaded it. Review the photo again before logging."
      : "I couldn't safely save those foods, so nothing was added.",
  };
}

function initVisionCapture() {
  window.BBVision?.init({
    appendChat,
    getContext: visionContext,
    contextMatches: visionContextMatches,
    commitRows: commitVisionRows,
  });
}

function updateDayLabel() {
  const el = document.getElementById("dayLabel");
  if (el) {
    el.textContent =
      selectedDay === todayKey()
        ? "Today"
        : selectedDay;
  }
  const picker = document.getElementById("dayPicker");
  if (picker) picker.value = selectedDay;
}

async function selectDay(day) {
  if (!day || day === selectedDay) {
    updateDayLabel();
    return;
  }
  const selectionEpoch = ++daySelectionEpoch;
  const account = storageAccount;
  const priorDay = selectedDay;
  const priorRows = rows.map((row) => ({ ...row }));
  await syncCloud(true, {
    day: priorDay,
    rows: priorRows,
    expectedRevision: getDayRevision(priorDay, account),
  });
  if (storageAccount !== account || daySelectionEpoch !== selectionEpoch) return;
  selectedDay = day;
  pendingToolConfirmation = null;
  rows = loadLocal(selectedDay);
  updateDayLabel();
  await loadFromCloud(selectedDay, { selectionEpoch });
  if (!sameDayContext(account, day, selectionEpoch)) return;
  render();
  if (window.BBBoxes) window.BBBoxes.loadValuesForDay(selectedDay);
}

async function loadFromCloud(
  day,
  { selectionEpoch = daySelectionEpoch } = {}
) {
  const requestDay = day || selectedDay;
  const requestAccount = storageAccount;
  try {
    const r = await fetch("/api/log?date=" + encodeURIComponent(requestDay));
    if (r.status === 503) {
      if (storageAccount === requestAccount) cloudReady = false;
      return { ok: false, unavailable: true };
    }
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json();
    if (!Array.isArray(d.rows) || !Number.isInteger(Number(d.revision))) {
      return { ok: false, invalid: true };
    }
    const cloudRows = ensureUniqueIds(d.rows);
    const revision = Number(d.revision);
    setDayRevision(requestDay, revision, requestAccount);
    saveLocalRows(requestDay, cloudRows, requestAccount);
    if (storageAccount === requestAccount) cloudReady = true;
    if (sameDayContext(requestAccount, requestDay, selectionEpoch)) {
      rows = cloudRows;
    }
    return { ok: true, rows: cloudRows, revision };
  } catch {
    if (storageAccount === requestAccount) cloudReady = false;
    return { ok: false, unavailable: true };
  }
}

function ensureUniqueIds(list) {
  // Only collapse the *same row id* (refresh/sync glitch).
  // Same meal twice (e.g. two shakes) = two different ids — KEEP both.
  const seen = new Set();
  const out = [];
  for (const r of list || []) {
    let id = r.id || r.client_id || newId();
    id = String(id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...r, id });
  }
  return out;
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "r_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
}

function askDelete(id, label) {
  pendingDeleteId = id;
  const modal = document.getElementById("confirmModal");
  const title = document.getElementById("confirmTitle");
  const body = document.getElementById("confirmBody");
  if (title) title.textContent = "Remove this item?";
  if (body) {
    body.textContent = label
      ? `Remove “${label}” from ${selectedDay}? This only deletes this one item.`
      : "Remove this item from the day?";
  }
  if (modal) modal.hidden = false;
}

function closeConfirm() {
  pendingDeleteId = null;
  const modal = document.getElementById("confirmModal");
  if (modal) modal.hidden = true;
}

async function confirmDelete() {
  const id = pendingDeleteId;
  closeConfirm();
  if (!id) return;
  const day = selectedDay;
  const account = storageAccount;
  const selectionEpoch = daySelectionEpoch;
  const expectedRevision = getDayRevision(day, account);
  const previousRows = rows.map((row) => ({ ...row }));
  const removed = previousRows.find((row) => String(row.id) === String(id));
  const nextRows = previousRows.filter((row) => String(row.id) !== String(id));
  if (nextRows.length === previousRows.length) return;
  rows = nextRows;
  saveLocalRows(day, rows, account);
  render();
  const result = await syncCloud(true, {
    allowClear: nextRows.length === 0,
    day,
    rows: nextRows,
    expectedRevision,
  });
  if (!sameDayContext(account, day, selectionEpoch)) return;
  if (result?.ok) {
    appendChat("bot", `Removed: ${removed?.label || "food entry"}.`);
  } else if (!result?.conflict) {
    rows = previousRows;
    saveLocalRows(day, rows, account);
    render();
    appendChat("bot", "I couldn't safely remove that entry, so nothing changed.", true);
  }
}

async function addManualFood() {
  const name = document.getElementById("mName")?.value?.trim();
  if (!name) return;
  const readAmount = (id, { required = false } = {}) => {
    const raw = String(document.getElementById(id)?.value ?? "").trim();
    if (!raw) return required ? { error: "required" } : { value: undefined };
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
      return { error: "invalid" };
    }
    return { value };
  };
  const inputs = {
    kcal: readAmount("mKcal", { required: true }),
    protein: readAmount("mPro", { required: true }),
    fat: readAmount("mFat", { required: true }),
    carbs: readAmount("mCarb", { required: true }),
    potassium: readAmount("mK"),
  };
  if (Object.values(inputs).some((input) => input.error)) {
    appendChat(
      "bot",
      "For a manual food, enter non-negative calories, protein, fat, and carbs. Potassium is optional.",
      true
    );
    return;
  }
  const row = {
    id: newId(),
    label: name,
    kcal: inputs.kcal.value,
    protein: inputs.protein.value,
    fat: inputs.fat.value,
    carbs: inputs.carbs.value,
    ...(inputs.potassium.value !== undefined
      ? { potassium: inputs.potassium.value }
      : {}),
  };
  const day = selectedDay;
  const account = storageAccount;
  const selectionEpoch = daySelectionEpoch;
  const expectedRevision = getDayRevision(day, account);
  const previousRows = rows.map((item) => ({ ...item }));
  const nextRows = ensureUniqueIds([...previousRows, row]);
  const button = document.getElementById("manualOk");
  if (button) button.disabled = true;
  rows = nextRows;
  saveLocalRows(day, rows, account);
  render();
  const result = await syncCloud(true, {
    day,
    rows: nextRows,
    expectedRevision,
  });
  if (button) button.disabled = false;
  if (!sameDayContext(account, day, selectionEpoch)) return;
  if (result?.ok) {
    const m = document.getElementById("manualModal");
    if (m) m.hidden = true;
    ["mName", "mKcal", "mPro", "mFat", "mCarb", "mK"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    appendChat("bot", `Added manually: ${name}.`);
  } else if (!result?.conflict) {
    rows = previousRows;
    saveLocalRows(day, rows, account);
    render();
    appendChat("bot", "I couldn't safely save that manual food, so nothing changed.", true);
  }
}

/**
 * Drive a ring fill (0–1).
 * overMode: "auto" | true | false — only Left/calorie use red over; Goal never.
 */
function setRing(id, value, max, { r, overMode = "auto" } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const radius = r != null ? r : id === "ringKcal" ? 52 : 42;
  const c = 2 * Math.PI * radius;
  const m = Math.max(0.0001, Number(max) || 1);
  const v = Math.max(0, Number(value) || 0);
  const pct = Math.min(1, v / m);
  el.style.strokeDasharray = String(c);
  el.style.strokeDashoffset = String(c * (1 - pct));
  const isOver =
    overMode === true ? true : overMode === false ? false : v > m + 0.05;
  el.classList.toggle("over", isOver);
}

/**
 * Three circles: Left · Eaten · Goal
 * unit: "g" for macros, "" for calories
 */
function setMacroStat(prefix, eaten, goal, { unit = "g", ringBase, wrapId } = {}) {
  const e = Math.max(0, Number(eaten) || 0);
  const g = Math.max(0, Number(goal) || 0);
  const over = g > 0 && e > g + 0.05;
  const left = Math.max(0, g - e);
  const overBy = Math.max(0, e - g);
  const gSafe = Math.max(1, g);
  const u = unit || "";
  const show = (n, forceInt) =>
    (forceInt || unit === "" ? String(Math.round(n)) : fmt(n)) + u;

  setText("t" + prefix, show(e, unit === ""));
  setText("t" + prefix + "Goal", show(g, true));
  setText(
    "t" + prefix + "Left",
    over ? "+" + show(overBy, unit === "") : show(left, unit === "")
  );

  const leftLab = document.getElementById("t" + prefix + "LeftLab");
  if (leftLab) leftLab.textContent = over ? "Over" : "Left";

  const base =
    ringBase ||
    (prefix === "Pro"
      ? "ringPro"
      : prefix === "Fat"
        ? "ringFat"
        : prefix === "Net"
          ? "ringNet"
          : prefix === "Kcal"
            ? "ringKcal"
            : "ringCarb");
  // Goal: always yellow · Eaten: always blue · Left: green under, red over
  setRing(base + "Goal", Math.min(e, gSafe), gSafe, { r: 42, overMode: false });
  setRing(base, Math.min(e, gSafe), gSafe, { r: 42, overMode: false });
  const eatenEl = document.getElementById(base);
  if (eatenEl) eatenEl.classList.remove("hit-goal", "over");
  setRing(base + "Left", over ? gSafe : left, gSafe, {
    r: 42,
    overMode: over,
  });
  setOverArc(base + "Over", over ? overBy : 0, gSafe, Math.min(e, gSafe) / gSafe);

  const wrap =
    document.getElementById(
      wrapId ||
        (prefix === "Pro"
          ? "macroProWrap"
          : prefix === "Fat"
            ? "macroFatWrap"
            : prefix === "Net"
              ? "macroNetWrap"
              : prefix === "Kcal"
                ? "macroKcalWrap"
                : "macroCarbWrap")
    );
  if (wrap) {
    wrap.classList.toggle("is-over", over);
    wrap.classList.remove("is-almost"); // no amber “almost” — columns stay uniform
  }
}

/**
 * Red arc on Eaten circle: starts after the yellow “hit goal” arc and
 * shows how far over you are (another fraction of a full goal loop).
 * startFrac = portion already drawn by the main ring (0–1), usually 1 when over.
 */
function setOverArc(id, overAmount, goal, startFrac = 1) {
  const el = document.getElementById(id);
  if (!el) return;
  const r = 42;
  const c = 2 * Math.PI * r;
  const g = Math.max(0.0001, Number(goal) || 1);
  const o = Math.max(0, Number(overAmount) || 0);
  const start = Math.min(1, Math.max(0, Number(startFrac) || 0));
  if (o <= 0.05) {
    el.classList.remove("is-on");
    el.style.strokeDasharray = String(c);
    el.style.strokeDashoffset = String(c);
    return;
  }
  // Length of red segment (cap at one full extra loop)
  const redLen = Math.min(1, o / g) * c;
  // Gap after red so only that segment shows; offset so it starts after yellow
  el.style.strokeDasharray = `${redLen} ${c}`;
  // Negative dashoffset advances start past the completed yellow portion
  el.style.strokeDashoffset = String(-start * c);
  el.classList.add("is-on");
}

function applyGoalsFromWatches(statuses) {
  // Onboarding goals win for the main rings (fixes bad "85% of kcal" watch min).
  const fromOnboard =
    window.__ntUser?.goals && typeof window.__ntUser.goals === "object"
      ? pickGoalNums(window.__ntUser.goals)
      : {};
  dayGoals = { ...DEFAULT_GOALS, ...fromOnboard };
  for (const s of statuses || []) {
    const mid = s.measure_id;
    if (dayGoals[mid] == null) continue;
    // Don't let old calorie range watches clobber the real target
    if (fromOnboard[mid] != null) continue;
    const mode = String(s.mode || "floor").toLowerCase();
    const min = s.target_min != null ? Number(s.target_min) : null;
    const max = s.target_max != null ? Number(s.target_max) : null;
    if (mode === "ceiling" && max != null && Number.isFinite(max)) {
      dayGoals[mid] = max;
    } else if (mode === "range" && max != null && Number.isFinite(max)) {
      dayGoals[mid] = max;
    } else if (min != null && Number.isFinite(min)) {
      dayGoals[mid] = min;
    }
  }
  setText("tKcalGoal", String(Math.round(dayGoals.kcal)));
  // Goal labels on macro board are set in setMacroStat during render()
  setText("tKGoal", "/ " + Math.round(dayGoals.potassium) + " mg");
  setText("tMgGoal", "/ " + Math.round(dayGoals.magnesium) + " mg");
}

function pickGoalNums(g) {
  const out = {};
  for (const k of Object.keys(DEFAULT_GOALS)) {
    if (g[k] != null && !Number.isNaN(Number(g[k]))) out[k] = Number(g[k]);
  }
  return out;
}

function configureAccountStorage(account) {
  const nextAccount = String(account || "").trim().toLowerCase() || null;
  if (storageAccount !== nextAccount) {
    memoryRequestEpoch += 1;
    memoryRecords = [];
    memoryLoadedAccount = null;
    renderMemories();
  }
  if (storageAccount && storageAccount !== nextAccount) {
    daySelectionEpoch += 1;
    conversationEpoch += 1;
    conversationLoadEpoch += 1;
    dayRevisions.clear();
  }
  storageAccount = nextAccount;
  if (!storageAccount) return;
  try {
    window.BBFoodStorage?.quarantineLegacyDays(localStorage);
    const legacyConversation = localStorage.getItem("bigbricey-conversation-id");
    if (legacyConversation) {
      if (!localStorage.getItem("bigbricey-unassigned-conversation-id")) {
        localStorage.setItem("bigbricey-unassigned-conversation-id", legacyConversation);
      }
      localStorage.removeItem("bigbricey-conversation-id");
    }
    conversationId = localStorage.getItem(conversationStorageKey()) || null;
  } catch {
    conversationId = null;
  }
}
function conversationStorageKey() {
  if (!storageAccount) throw new Error("account required for chat storage");
  return "bigbricey-conversation-v2-" + encodeURIComponent(storageAccount);
}
function loadLocal(day) {
  if (!storageAccount || !window.BBFoodStorage) return [];
  try {
    return window.BBFoodStorage.load(localStorage, storageAccount, day);
  } catch {
    return [];
  }
}
function saveLocalRows(day, list, account = storageAccount) {
  if (!account || !window.BBFoodStorage || !Array.isArray(list)) return;
  window.BBFoodStorage.save(localStorage, account, day || selectedDay, list);
}
function saveLocal(day) {
  saveLocalRows(day || selectedDay, rows, storageAccount);
}
async function syncCloud(
  immediate,
  {
    allowClear = false,
    day = selectedDay,
    rows: syncRows = rows,
    expectedRevision = getDayRevision(day),
  } = {}
) {
  const requestAccount = storageAccount;
  if (!cloudReady && !immediate) return;
  if (!Array.isArray(syncRows) || (syncRows.length === 0 && !allowClear)) return;
  try {
    const r = await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: day,
        rows: syncRows,
        clear: allowClear,
        expected_revision:
          Number.isInteger(Number(expectedRevision)) && Number(expectedRevision) >= 0
            ? Number(expectedRevision)
            : null,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 409) {
      const selectionEpoch = daySelectionEpoch;
      const refreshed = await loadFromCloud(day, { selectionEpoch });
      if (sameDayContext(requestAccount, day, selectionEpoch)) {
        if (refreshed?.ok) {
          render();
          window.BBBoxes?.loadValuesForDay(day);
        }
        appendChat(
          "bot",
          `The saved log for ${day} changed somewhere else, so I reloaded the latest version instead of overwriting it.`
        );
      }
      return { ok: false, conflict: true };
    }
    if (r.ok) {
      if (storageAccount === requestAccount) cloudReady = true;
      setDayRevision(day, data.revision, requestAccount);
      loadWatches();
      loadAlerts();
      loadCharts();
      return { ok: true, revision: getDayRevision(day, requestAccount) };
    }
    return { ok: false, status: r.status };
  } catch {
    return { ok: false, unavailable: true };
  }
}

/* watches */
async function loadWatches() {
  try {
    const r = await fetch("/api/log?watches=1");
    if (!r.ok) return;
    const d = await r.json();
    renderWatches(d.statuses || []);
  } catch {
    /* ok */
  }
}
function renderWatches(statuses) {
  applyGoalsFromWatches(statuses);
  render(); // refresh rings with goal numbers

  const html = !statuses.length
    ? `<div class="wchip"><div class="wmsg">No watches yet — add one below or chat it.</div></div>`
    : statuses
        .map((s) => {
          const avg = Number(s.average) || 0;
          const avgTxt =
            Math.abs(avg) >= 100 ? String(Math.round(avg)) : avg.toFixed(1).replace(/\.0$/, "");
          const cls = s.ok ? "ok" : "bad";
          return `<div class="wchip ${cls}">
            <div class="wname">${escapeHtml(s.label || s.measure_id)}</div>
            <div class="wavg">${avgTxt}<span style="font-size:11px;font-weight:500;color:#888"> ${escapeHtml(s.unit || "")}/d</span></div>
            <div class="wmsg">${escapeHtml(s.message || "")} · ${s.window_days || 7}d</div>
          </div>`;
        })
        .join("");
  const a = document.getElementById("watchStatuses");
  const b = document.getElementById("watchStatusesGoals");
  if (a) a.innerHTML = html;
  if (b) b.innerHTML = html;

  const bad = (statuses || []).filter((s) => !s.ok && s.days_with_data > 0);
  const banner = document.getElementById("alertBanner");
  if (banner) {
    if (bad.length) {
      banner.hidden = false;
      banner.textContent = bad
        .slice(0, 2)
        .map((s) => s.message || s.label)
        .join(" · ");
    } else {
      banner.hidden = true;
    }
  }
}

async function saveWatchFromForm() {
  const measureId = document.getElementById("wMeasure").value.trim();
  const min = document.getElementById("wMin").value;
  const unit = document.getElementById("wUnit").value.trim();
  const days = document.getElementById("wDays").value || 7;
  if (!measureId || min === "") {
    appendChat("bot", "Need a measure and a min target for the watch.", true);
    setTab("today");
    return;
  }
  try {
    const r = await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "watch",
        measureId,
        label: measureId,
        mode: "floor",
        targetMin: Number(min),
        unit,
        windowDays: Number(days) || 7,
        severity: "yellow",
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "save failed");
    renderWatches(d.statuses || []);
    appendChat("bot", `Watch saved: ${measureId} ≥ ${min} ${unit}`.trim());
    setTab("today");
  } catch (e) {
    appendChat("bot", e.message || String(e), true);
    setTab("today");
  }
}

async function loadAlerts() {
  // watches drive banner; optional fetch kept light
  try {
    await fetch("/api/log?alerts=1");
  } catch {
    /* ok */
  }
}

/* charts */
async function loadCharts() {
  const canvas = document.getElementById("trendCanvas");
  if (!canvas) return;
  const onBtn = document.querySelector("#chartRangeSeg button.on");
  const range = Number(onBtn?.dataset.r || 30);
  const measures = Array.from(
    document.querySelectorAll("#chartToggles input[type=checkbox]:checked")
  ).map((el) => el.dataset.m);
  if (!measures.length) {
    drawEmptyChart(canvas, "Pick at least one measure");
    return;
  }
  const to = todayKey();
  const from = shiftDay(to, -(range - 1));
  try {
    const r = await fetch(
      `/api/log?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&measures=${encodeURIComponent(measures.join(","))}`
    );
    if (!r.ok) {
      drawEmptyChart(canvas, "Couldn't load trends");
      return;
    }
    const d = await r.json();
    drawTrendChart(canvas, d.days || [], d.series || {}, measures);
    const leg = document.getElementById("chartLegend");
    if (leg) {
      leg.innerHTML = measures
        .map(
          (m) =>
            `<span><i style="background:${CHART_COLORS[m] || "#888"}"></i>${escapeHtml(m)}</span>`
        )
        .join("");
    }
  } catch {
    drawEmptyChart(canvas, "Chart error");
  }
}

function drawEmptyChart(canvas, msg) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b101a";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#64748b";
  ctx.font = "16px DM Sans, system-ui";
  ctx.fillText(msg, 24, h / 2);
}

function drawTrendChart(canvas, days, series, measures) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = { l: 48, r: 16, t: 20, b: 36 };
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#080b12";
  ctx.fillRect(0, 0, w, h);
  if (!days.length) {
    drawEmptyChart(canvas, "No days yet — keep logging");
    return;
  }
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }
  measures.forEach((m) => {
    const pts = days.map((day) => {
      const row = (series[m] || []).find((x) => x.day_key === day);
      return row ? Number(row.total) || 0 : 0;
    });
    const max = Math.max(...pts, 1);
    const color = CHART_COLORS[m] || "#aaa";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach((v, i) => {
      const x = pad.l + (days.length === 1 ? plotW / 2 : (plotW * i) / (days.length - 1));
      const y = pad.t + plotH - (v / max) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    pts.forEach((v, i) => {
      if (v <= 0) return;
      const x = pad.l + (days.length === 1 ? plotW / 2 : (plotW * i) / (days.length - 1));
      const y = pad.t + plotH - (v / max) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  });
  ctx.fillStyle = "#64748b";
  ctx.font = "11px DM Sans, system-ui";
  const step = Math.max(1, Math.floor(days.length / 6));
  days.forEach((day, i) => {
    if (i % step !== 0 && i !== days.length - 1) return;
    const x = pad.l + (days.length === 1 ? plotW / 2 : (plotW * i) / (days.length - 1));
    ctx.fillText(day.slice(5), x - 14, h - 12);
  });
}

/* chat */
function displayUserName() {
  const u = window.__ntUser || {};
  const o = u.onboarding || {};
  const raw =
    o.preferred_name ||
    o.call_me ||
    o.first_name ||
    (u.name || "").split(/\s+/)[0] ||
    "";
  const name = String(raw || "").trim();
  return name || "You";
}

function knownMetric(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Build a compact receipt from rows the server actually committed. This is
 * presentation only: no model prose or browser-side nutrition guess becomes a
 * receipt.
 */
function buildVerifiedLogReceipt(addedRows, dayKey = selectedDay) {
  if (!Array.isArray(addedRows) || !addedRows.length) return null;
  const dayLabel = dayKey === todayKey() ? "today" : String(dayKey || "this day");
  const receipt = document.createElement("div");
  receipt.className = "chat-receipt";
  receipt.setAttribute("aria-label", "Verified food log receipt");

  const head = document.createElement("div");
  head.className = "chat-receipt-head";
  const title = document.createElement("strong");
  title.textContent =
    addedRows.length === 1
      ? `Added to ${dayLabel}`
      : `${addedRows.length} foods added to ${dayLabel}`;
  const verified = document.createElement("span");
  verified.textContent = "✓ verified";
  head.append(title, verified);
  receipt.appendChild(head);

  for (const row of addedRows.slice(0, 4)) {
    const item = document.createElement("div");
    item.className = "chat-receipt-item";
    const label = document.createElement("span");
    label.className = "chat-receipt-label";
    label.textContent = String(row?.label || "Food");
    const kcal = document.createElement("strong");
    const kcalValue = knownMetric(row?.kcal);
    kcal.textContent = kcalValue == null ? "— kcal" : `${fmt(kcalValue, 0)} kcal`;
    item.append(label, kcal);

    const macros = document.createElement("div");
    macros.className = "chat-receipt-macros";
    const macroBits = [
      ["P", knownMetric(row?.protein)],
      ["F", knownMetric(row?.fat)],
      ["C", knownMetric(row?.carbs)],
    ]
      .filter(([, value]) => value != null)
      .map(([labelText, value]) => `${labelText} ${fmt(value)}g`);
    macros.textContent = macroBits.length ? macroBits.join(" · ") : "Macros unavailable";
    item.appendChild(macros);
    receipt.appendChild(item);
  }

  if (addedRows.length > 4) {
    const more = document.createElement("div");
    more.className = "chat-receipt-more";
    more.textContent = `+${addedRows.length - 4} more`;
    receipt.appendChild(more);
  }

  const day = totals();
  const footer = document.createElement("div");
  footer.className = "chat-receipt-total";
  const totalBits = [];
  const kcalGoal = knownMetric(dayGoals?.kcal);
  totalBits.push(
    kcalGoal && kcalGoal > 0
      ? `${fmt(day.kcal, 0)} / ${fmt(kcalGoal, 0)} kcal ${dayLabel}`
      : `${fmt(day.kcal, 0)} kcal ${dayLabel}`
  );
  const proteinGoal = knownMetric(dayGoals?.protein);
  if (proteinGoal && proteinGoal > 0) {
    const delta = proteinGoal - day.protein;
    totalBits.push(
      delta >= 0
        ? `${fmt(delta)}g protein left`
        : `${fmt(Math.abs(delta))}g protein over`
    );
  }
  footer.textContent = totalBits.join(" · ");
  receipt.appendChild(footer);
  return receipt;
}

function pulseVerifiedLogUpdate(addedRows) {
  const ids = new Set(
    (Array.isArray(addedRows) ? addedRows : [])
      .map((row) => String(row?.id || ""))
      .filter(Boolean)
  );
  const targets = Array.from(document.querySelectorAll(".macro-row"));
  foodCards?.querySelectorAll(".food-card[data-id]").forEach((card) => {
    if (ids.has(String(card.dataset.id || ""))) {
      card.classList.add("is-just-added");
      targets.push(card);
    }
  });
  targets.forEach((target) => target.classList.add("is-just-updated"));
  setTimeout(() => {
    targets.forEach((target) => target.classList.remove("is-just-updated", "is-just-added"));
  }, 1900);
}

function appendChat(role, text, isError = false, options = {}) {
  if (!chatLog || text == null || String(text).trim() === "") return;
  chatLog.querySelector(".welcome, .chat-empty")?.remove();
  const bubble = document.createElement("div");
  bubble.className =
    "chat-bubble " +
    (role === "user" ? "user" : "bot") +
    (isError ? " err" : "") +
    (options.thinking ? " thinking" : "");
  if (options.thinking) bubble.setAttribute("aria-hidden", "true");
  const who = document.createElement("div");
  who.className = "chat-who";
  who.textContent =
    role === "user" ? displayUserName() : isError ? "Error" : "BigBricey";
  const body = document.createElement("div");
  body.className = "chat-text";
  if (window.BBChatFormat?.renderChatText) {
    window.BBChatFormat.renderChatText(body, text);
  } else {
    body.textContent = text;
  }
  bubble.appendChild(who);
  bubble.appendChild(body);
  if (options.attachment?.nodeType === 1) bubble.appendChild(options.attachment);
  if (options.receipt?.nodeType === 1) bubble.appendChild(options.receipt);
  chatLog.appendChild(bubble);
  if (options.scroll !== false) {
    if (window.BBChatFormat?.scrollChatToBottom) {
      window.BBChatFormat.scrollChatToBottom(chatLog);
    } else {
      chatLog.scrollTop = chatLog.scrollHeight;
    }
  }
  return bubble;
}
function setThinking(on) {
  if (!chatLog) return;
  chatLog.setAttribute("aria-busy", on ? "true" : "false");
  const status = document.getElementById("chatStatus");
  if (status) status.textContent = on ? "BigBricey is thinking." : "";
  const existing = chatLog.querySelector(".thinking");
  if (on) {
    if (!existing) appendChat("bot", "Thinking…", false, { thinking: true });
  } else if (existing) existing.remove();
}

async function requireAuth() {
  try {
    const r = await fetch("/api/auth/me");
    const d = await r.json();
    if (!d.authenticated) {
      location.replace("/?error=" + encodeURIComponent("Please sign in with Google."));
      return false;
    }
    if (!d.member) {
      location.replace("/join.html");
      return false;
    }
    if (!d.onboarding_complete) {
      location.replace("/onboarding.html");
      return false;
    }
    window.__ntUser = d;
    // Prefer onboarding-derived daily goals for rings
    if (d.goals && typeof d.goals === "object") {
      dayGoals = {
        ...DEFAULT_GOALS,
        ...Object.fromEntries(
          Object.entries(d.goals).filter(
            ([k, v]) => k in DEFAULT_GOALS && v != null && !Number.isNaN(Number(v))
          )
        ),
      };
    }
    const chip = document.getElementById("userChip");
    if (chip) chip.textContent = (d.name || d.email) + (d.admin ? " · admin" : "");
    const ye = document.getElementById("youEmail");
    const yr = document.getElementById("youRole");
    if (ye) ye.textContent = d.email || "—";
    if (yr) yr.textContent = d.admin ? "admin" : d.role || "member";
    if (d.admin) {
      const fb = document.getElementById("feedbackBox");
      if (fb) fb.hidden = false;
      const ub = document.getElementById("usageBox");
      if (ub) ub.hidden = false;
    }
    const o = d.onboarding || {};
    const goalMap = {
      lose: "Lose",
      maintain: "Maintain",
      muscle: "Muscle",
      gain: "Muscle",
    };
    const ps = document.getElementById("youProfileSummary");
    if (ps) {
      const bits = [];
      if (o.first_name) bits.push(o.first_name);
      if (o.primary_goal) bits.push(goalMap[o.primary_goal] || o.primary_goal);
      if (o.primary_goal === "lose" && o.lose_rate_lb_week) {
        bits.push(`${o.lose_rate_lb_week} lb/wk`);
      }
      if (o.current_weight_lb != null && o.goal_weight_lb != null) {
        bits.push(`${o.current_weight_lb}→${o.goal_weight_lb} lb`);
      }
      ps.textContent = bits.length ? bits.join(" · ") : "Complete";
    }
    const gs = document.getElementById("youGoalsSummary");
    if (gs && d.goals) {
      gs.textContent = `${d.goals.kcal || "—"} kcal · P ${d.goals.protein || "—"}g · F ${d.goals.fat || "—"}g · C ${d.goals.carbs || "—"}g`;
    }
    return true;
  } catch {
    location.replace("/?error=" + encodeURIComponent("Auth check failed — try again."));
    return false;
  }
}

function setMemoryStatus(message, isError = false) {
  const status = document.getElementById("memoryStatus");
  if (!status) return;
  status.textContent = String(message || "");
  status.classList.toggle("is-error", Boolean(isError));
}

function setMemoryBusy(busy) {
  document
    .getElementById("memoryCenter")
    ?.querySelectorAll("button, input, select")
    .forEach((control) => {
      control.disabled = Boolean(busy);
    });
}

function memorySourceLabel(memory) {
  const labels = {
    user_chat: "You asked in chat",
    user_ui: "Added here",
    legacy: "Imported",
    inferred: "Suggested pattern",
  };
  return labels[memory?.provenance] || "Saved memory";
}

function memoryDateLabel(memory) {
  const raw = memory?.updated_at || memory?.created_at;
  if (!raw || !Number.isFinite(Date.parse(raw))) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(raw));
}

function memoryActionButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `text-btn ${className || ""}`.trim();
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function beginMemoryEdit(memory, card) {
  if (!memory?.id || !card) return;
  const form = document.createElement("form");
  form.className = "memory-edit-form";

  const select = document.createElement("select");
  select.setAttribute("aria-label", "Memory type");
  for (const [value, label] of [["preference", "Preference"], ["fact", "Fact"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = memory.kind === value;
    select.appendChild(option);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 300;
  input.value = memory.text;
  input.setAttribute("aria-label", "Memory text");

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn-primary";
  save.textContent = "Save";
  const cancel = memoryActionButton("Cancel", "", () => renderMemories());

  form.append(select, input, save, cancel);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await mutateMemory(
      {
        op: "update",
        memory_id: memory.id,
        kind: select.value,
        text: input.value,
      },
      "Memory updated."
    );
  });
  card.replaceChildren(form);
  input.focus();
  input.select();
}

function renderMemories() {
  const list = document.getElementById("memoryList");
  const count = document.getElementById("memoryCount");
  if (!list) return;
  list.replaceChildren();
  if (count) count.textContent = String(memoryRecords.length);

  if (!memoryRecords.length) {
    const empty = document.createElement("div");
    empty.className = "memory-empty";
    empty.textContent =
      "Nothing permanent yet. Ask BigBricey to remember something, or add it above.";
    list.appendChild(empty);
    return;
  }

  for (const memory of memoryRecords) {
    const card = document.createElement("article");
    card.className = "memory-card";
    card.setAttribute("role", "listitem");
    card.dataset.memoryId = memory.id || "";

    const main = document.createElement("div");
    main.className = "memory-card-main";
    const copy = document.createElement("div");
    copy.className = "memory-copy";
    const text = document.createElement("p");
    text.className = "memory-text";
    text.textContent = memory.text;
    const meta = document.createElement("span");
    meta.className = "memory-meta";
    const kind = memory.kind === "preference" ? "Preference" : "Fact";
    meta.textContent = [kind, memorySourceLabel(memory), memoryDateLabel(memory)]
      .filter(Boolean)
      .join(" · ");
    copy.append(text, meta);

    const actions = document.createElement("div");
    actions.className = "memory-actions";
    const edit = memoryActionButton("Edit", "", () => beginMemoryEdit(memory, card));
    const forget = memoryActionButton("Forget", "forget", async () => {
      if (!memory.id) return;
      if (!confirm(`Forget “${memory.text}”?`)) return;
      await mutateMemory(
        { op: "delete", memory_id: memory.id },
        "Memory forgotten."
      );
    });
    actions.append(edit, forget);
    main.append(copy, actions);
    card.appendChild(main);
    list.appendChild(card);
  }
}

async function mutateMemory(mutation, successMessage) {
  const requestAccount = storageAccount;
  const requestEpoch = ++memoryRequestEpoch;
  setMemoryBusy(true);
  setMemoryStatus("Saving…");
  try {
    const response = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mutation),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Memory could not be saved.");
    if (
      storageAccount !== requestAccount ||
      memoryRequestEpoch !== requestEpoch
    ) {
      return;
    }
    memoryRecords = Array.isArray(data.memories) ? data.memories : [];
    memoryLoadedAccount = requestAccount;
    renderMemories();
    setMemoryStatus(successMessage || "Memory saved.");
  } catch (error) {
    if (
      storageAccount === requestAccount &&
      memoryRequestEpoch === requestEpoch
    ) {
      renderMemories();
      setMemoryStatus(error.message || "Memory is temporarily unavailable.", true);
    }
  } finally {
    if (
      storageAccount === requestAccount &&
      memoryRequestEpoch === requestEpoch
    ) {
      setMemoryBusy(false);
    }
  }
}

async function loadMemories({ force = false } = {}) {
  if (!storageAccount) return;
  if (!force && memoryLoadedAccount === storageAccount) {
    renderMemories();
    return;
  }
  const requestAccount = storageAccount;
  const requestEpoch = ++memoryRequestEpoch;
  setMemoryStatus("Loading memories…");
  try {
    const response = await fetch("/api/memory");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Memory could not be loaded.");
    if (
      storageAccount !== requestAccount ||
      memoryRequestEpoch !== requestEpoch
    ) {
      return;
    }
    memoryRecords = Array.isArray(data.memories) ? data.memories : [];
    memoryLoadedAccount = requestAccount;
    renderMemories();
    setMemoryStatus("");
  } catch (error) {
    if (
      storageAccount === requestAccount &&
      memoryRequestEpoch === requestEpoch
    ) {
      memoryLoadedAccount = null;
      renderMemories();
      setMemoryStatus(error.message || "Memory is temporarily unavailable.", true);
    }
  }
}

function wireMemoryCenter() {
  const form = document.getElementById("memoryForm");
  if (!form || form.dataset.wired === "true") return;
  form.dataset.wired = "true";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const kind = document.getElementById("memoryKind")?.value || "preference";
    const input = document.getElementById("memoryText");
    const text = input?.value || "";
    if (!text.trim()) {
      setMemoryStatus("Tell BigBricey what to remember.", true);
      input?.focus();
      return;
    }
    await mutateMemory({ op: "create", kind, text }, "Memory saved.");
    if (input && !document.getElementById("memoryStatus")?.classList.contains("is-error")) {
      input.value = "";
      input.focus();
    }
  });
}

async function exportStatsPack(days) {
  const box = document.getElementById("exportBox");
  try {
    const r = await fetch("/api/log?report=1&days=" + (days || 30));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || d.message || "Export failed");
    const text = d.text || "";
    if (box) {
      box.hidden = false;
      box.value = text;
      box.focus();
      box.select();
    }
    try {
      await navigator.clipboard.writeText(text);
      appendChat("bot", `Copied ${days}-day data pack to clipboard. Also in You → export box.`);
    } catch {
      appendChat("bot", `${days}-day pack ready in You tab — select & copy.`);
    }
    setTab("you");
  } catch (e) {
    appendChat("bot", e.message || String(e), true);
  }
}

async function loadUsageInbox() {
  const list = document.getElementById("usageList");
  const totalsEl = document.getElementById("usageTotals");
  if (!list) return;
  try {
    const r = await fetch("/api/log?usage=1&days=30");
    if (!r.ok) {
      list.innerHTML = `<div class="alert-empty">Couldn't load usage.</div>`;
      return;
    }
    const d = await r.json();
    if (d.error === "table_missing") {
      list.innerHTML = `<div class="alert-empty">Usage table not ready yet.</div>`;
      return;
    }
    const t = d.totals || {};
    if (totalsEl) {
      totalsEl.innerHTML = `
        <div class="usage-total-card">
          <span>Requests</span><strong>${t.requests || 0}</strong>
        </div>
        <div class="usage-total-card">
          <span>Total tokens</span><strong>${fmtTokens(t.total_tokens)}</strong>
        </div>
        <div class="usage-total-card">
          <span>In / Out</span><strong>${fmtTokens(t.prompt_tokens)} / ${fmtTokens(t.completion_tokens)}</strong>
        </div>
        <div class="usage-total-card">
          <span>Cost (if reported)</span><strong>${t.cost_usd ? "$" + Number(t.cost_usd).toFixed(4) : "—"}</strong>
        </div>`;
    }
    const users = d.users || [];
    if (!users.length) {
      list.innerHTML = `<div class="alert-empty">No usage logged yet — send a chat message.</div>`;
      return;
    }
    list.innerHTML = users
      .map(
        (u) => `<div class="usage-row">
        <div>
          <div class="atitle">${escapeHtml(u.user_email)}</div>
          <div class="abody">${u.requests} requests · last ${(u.last_at || "").slice(0, 16).replace("T", " ")}</div>
        </div>
        <div class="usage-nums">
          <strong>${fmtTokens(u.total_tokens)}</strong>
          <span>${fmtTokens(u.prompt_tokens)} in · ${fmtTokens(u.completion_tokens)} out</span>
        </div>
      </div>`
      )
      .join("");
  } catch {
    list.innerHTML = `<div class="alert-empty">Usage error.</div>`;
  }
}

function fmtTokens(n) {
  const x = Number(n) || 0;
  if (x >= 1e6) return (x / 1e6).toFixed(2) + "M";
  if (x >= 1e3) return (x / 1e3).toFixed(1) + "k";
  return String(Math.round(x));
}

async function loadFeedbackInbox() {
  const list = document.getElementById("feedbackList");
  const themesEl = document.getElementById("feedbackThemes");
  if (!list) return;
  try {
    const r = await fetch("/api/log?feedback=1");
    if (!r.ok) {
      list.innerHTML = `<div class="alert-empty">Couldn't load feedback.</div>`;
      if (themesEl) themesEl.innerHTML = "";
      return;
    }
    const d = await r.json();
    const items = d.feedback || [];
    const themes = d.summary?.themes || [];

    if (themesEl) {
      if (!themes.length) {
        themesEl.innerHTML = `<div class="alert-empty">No clustered themes yet.</div>`;
      } else {
        themesEl.innerHTML = themes
          .slice(0, 25)
          .map((t) => {
            const imp = t.importance || "low";
            const ex = (t.examples || [])
              .map((e) => escapeHtml((e.message || "").slice(0, 100)))
              .join(" · ");
            return `<div class="theme-rank-card imp-${escapeHtml(imp)}">
              <div class="theme-rank-top">
                <strong>${escapeHtml(t.theme_label || t.theme_key)}</strong>
                <span class="theme-rank-badge">${escapeHtml(imp)}</span>
              </div>
              <div class="theme-rank-meta">
                ${t.unique_users || 0} people · ${t.count || 0} notes · ${escapeHtml(t.category || "other")}
                ${t.new_count ? ` · ${t.new_count} new` : ""}
              </div>
              ${ex ? `<div class="theme-rank-ex">${ex}</div>` : ""}
              <div class="theme-rank-actions">
                <button type="button" class="pill" data-theme-status="${escapeHtml(t.theme_key)}" data-st="read">Mark reviewed</button>
                <button type="button" class="pill" data-theme-status="${escapeHtml(t.theme_key)}" data-st="done">Mark done</button>
              </div>
            </div>`;
          })
          .join("");
        themesEl.querySelectorAll("[data-theme-status]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            await fetch("/api/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                op: "feedback_theme_status",
                theme_key: btn.getAttribute("data-theme-status"),
                status: btn.getAttribute("data-st") || "read",
              }),
            });
            loadFeedbackInbox();
          });
        });
      }
    }

    if (!items.length) {
      list.innerHTML = `<div class="alert-empty">No suggestions yet.</div>`;
      return;
    }
    list.innerHTML = items
      .map((f) => {
        const when = (f.created_at || "").slice(0, 16).replace("T", " ");
        const tag = [f.category, f.theme_key].filter(Boolean).join(" · ");
        return `<div class="alert-item ${f.status === "new" ? "yellow" : ""}">
          <div>
            <div class="atitle">${escapeHtml(f.user_name || f.user_email)}${
              tag ? ` <span class="theme-rank-tag">${escapeHtml(tag)}</span>` : ""
            }</div>
            <div class="abody">${escapeHtml(f.message)}</div>
            <div class="abody" style="margin-top:4px">${escapeHtml(when)} · ${escapeHtml(f.status || "")}</div>
          </div>
          ${
            f.status === "new"
              ? `<button type="button" data-fread="${f.id}">Read</button>`
              : ""
          }
        </div>`;
      })
      .join("");
    list.querySelectorAll("[data-fread]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch("/api/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op: "feedback_status",
            id: btn.dataset.fread,
            status: "read",
          }),
        });
        loadFeedbackInbox();
      });
    });
  } catch {
    list.innerHTML = `<div class="alert-empty">Feedback error.</div>`;
  }
}

async function checkApi() {
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    if (apiStatus) {
      apiStatus.textContent = h.openrouter ? "AI ready · " + (h.model || "") : "Limited mode";
      apiStatus.className = "menu-item muted " + (h.openrouter ? "on" : "off");
    }
  } catch {
    if (apiStatus) {
      apiStatus.textContent = "Server offline";
      apiStatus.className = "menu-item muted off";
    }
  }
}

function setConversationId(id) {
  const next = id || null;
  if (conversationId !== next) {
    conversationEpoch += 1;
    conversationLoadEpoch += 1;
  }
  conversationId = next;
  pendingToolConfirmation = null;
  try {
    const key = conversationStorageKey();
    if (conversationId) localStorage.setItem(key, conversationId);
    else localStorage.removeItem(key);
  } catch {
    /* */
  }
}

function clearChatUi() {
  if (!chatLog) return;
  chatLog.replaceChildren();
  chatLog.setAttribute("aria-busy", "false");
  const empty = document.createElement("div");
  empty.className = "chat-empty";
  empty.textContent = "New conversation";
  chatLog.appendChild(empty);
}

function renderMessagesFromServer(messages) {
  if (!chatLog) return;
  chatLog.innerHTML = "";
  if (!messages || !messages.length) {
    clearChatUi();
    return;
  }
  for (const m of messages) {
    const role = m.role === "user" ? "user" : "bot";
    appendChat(role === "user" ? "user" : "bot", m.content, false, { scroll: false });
  }
  window.BBChatFormat?.scrollChatToBottom?.(chatLog);
}

async function restoreConversation() {
  if (!conversationId) return;
  const requestedId = conversationId;
  const requestAccount = storageAccount;
  const requestConversationEpoch = conversationEpoch;
  const requestLoadEpoch = ++conversationLoadEpoch;
  try {
    const r = await fetch("/api/chat?id=" + encodeURIComponent(requestedId));
    if (!r.ok) {
      if (
        r.status === 404 &&
        storageAccount === requestAccount &&
        conversationId === requestedId &&
        conversationEpoch === requestConversationEpoch &&
        conversationLoadEpoch === requestLoadEpoch
      ) {
        setConversationId(null);
      }
      return;
    }
    const d = await r.json();
    if (
      storageAccount === requestAccount &&
      conversationId === requestedId &&
      conversationEpoch === requestConversationEpoch &&
      conversationLoadEpoch === requestLoadEpoch &&
      Array.isArray(d.messages) &&
      d.messages.length
    ) {
      renderMessagesFromServer(d.messages);
    }
  } catch {
    /* offline */
  }
}

async function loadConversationList() {
  const list = document.getElementById("chatHistoryList");
  if (!list) return;
  list.innerHTML = `<div class="alert-empty">Loading…</div>`;
  try {
    const r = await fetch("/api/chat");
    if (!r.ok) throw new Error("fail");
    const d = await r.json();
    const items = d.conversations || [];
    if (!items.length) {
      list.innerHTML = `<div class="alert-empty">No past chats yet.</div>`;
      return;
    }
    list.innerHTML = items
      .map((c) => {
        const when = (c.updated_at || c.created_at || "").slice(0, 16).replace("T", " ");
        const on = c.id === conversationId ? " on" : "";
        return `<button type="button" class="chat-history-item${on}" data-conv="${escapeHtml(c.id)}">
          ${escapeHtml(c.title || "Chat")}
          <span class="meta">${escapeHtml(when)}</span>
        </button>`;
      })
      .join("");
    list.querySelectorAll("[data-conv]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-conv");
        if (!id) return;
        const requestAccount = storageAccount;
        const requestLoadEpoch = ++conversationLoadEpoch;
        btn.disabled = true;
        try {
          const r2 = await fetch("/api/chat?id=" + encodeURIComponent(id));
          if (!r2.ok) throw new Error("conversation_load_failed");
          const d2 = await r2.json();
          if (
            storageAccount !== requestAccount ||
            conversationLoadEpoch !== requestLoadEpoch
          ) {
            return;
          }
          setConversationId(id);
          renderMessagesFromServer(d2.messages || []);
          const panel = document.getElementById("chatHistoryPanel");
          if (panel) panel.hidden = true;
        } catch {
          if (
            storageAccount === requestAccount &&
            conversationLoadEpoch === requestLoadEpoch
          ) {
            const prior = list.querySelector(".chat-history-load-error");
            prior?.remove();
            const message = document.createElement("div");
            message.className = "alert-empty chat-history-load-error";
            message.textContent =
              "Couldn’t open that conversation. Your current chat is unchanged.";
            list.prepend(message);
          }
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch {
    list.innerHTML = `<div class="alert-empty">Couldn’t load history (need chat tables in Supabase).</div>`;
  }
}

function wireChatHistoryUi() {
  document.getElementById("btnChatHistory")?.addEventListener("click", async () => {
    const panel = document.getElementById("chatHistoryPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await loadConversationList();
  });
  document.getElementById("btnChatHistoryClose")?.addEventListener("click", () => {
    const panel = document.getElementById("chatHistoryPanel");
    if (panel) panel.hidden = true;
  });
  document.getElementById("btnChatNew")?.addEventListener("click", async () => {
    const requestAccount = storageAccount;
    const priorConversationId = conversationId;
    const priorConversationEpoch = conversationEpoch;
    const requestLoadEpoch = ++conversationLoadEpoch;
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "new_conversation" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.conversation?.id) throw new Error("conversation_create_failed");
      if (
        storageAccount !== requestAccount ||
        conversationId !== priorConversationId ||
        conversationEpoch !== priorConversationEpoch ||
        conversationLoadEpoch !== requestLoadEpoch
      ) {
        return;
      }
      setConversationId(d.conversation.id);
      clearChatUi();
      const panel = document.getElementById("chatHistoryPanel");
      if (panel) panel.hidden = true;
    } catch {
      if (
        storageAccount === requestAccount &&
        conversationId === priorConversationId &&
        conversationEpoch === priorConversationEpoch &&
        conversationLoadEpoch === requestLoadEpoch
      ) {
        appendChat(
          "bot",
          "I couldn’t start a new conversation, so I left this chat exactly where it was.",
          true
        );
      }
    }
  });
}

async function onSend() {
  const text = foodInput.value.trim();
  if (!text || sending) return;
  conversationLoadEpoch += 1;
  const requestId = newId();
  const requestAccount = storageAccount;
  const requestDay = selectedDay;
  const requestRows = rows.map((row) => ({ ...row }));
  const requestSelectionEpoch = daySelectionEpoch;
  const requestConversationId = conversationId;
  const requestConversationEpoch = conversationEpoch;
  const confirmsPending =
    pendingToolConfirmation &&
    /^(?:yes|yep|yeah|confirm|confirmed|do it|go ahead|please do|yes,? do it)[.!\s]*$/i.test(text);
  const cancelsPending =
    pendingToolConfirmation &&
    /^(?:no|nope|cancel|never mind|nevermind|don'?t|do not)[.!\s]*$/i.test(text);
  const cancellation = Boolean(cancelsPending);
  const confirmation = confirmsPending ? pendingToolConfirmation : null;
  if (pendingToolConfirmation && !confirmsPending) pendingToolConfirmation = null;
  sending = true;
  addBtn.disabled = true;
  foodInput.value = "";
  if (typeof window.__growFoodInput === "function") window.__growFoodInput();
  else {
    foodInput.style.height = "52px";
  }
  if (activeTab !== "today") setTab("today");
  appendChat("user", text);
  setThinking(true);
  try {
    let verifiedAddedRows = [];
    const data = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        cancellation
          ? {
              op: "cancel_tool",
              text,
              date: requestDay,
              rows: requestRows,
              conversation_id: requestConversationId,
              request_id: requestId,
            }
          : confirmation
          ? {
              op: "confirm_tool",
              confirmation_token: confirmation.token,
              text,
              date: requestDay,
              rows: requestRows,
              conversation_id: requestConversationId,
              request_id: requestId,
            }
          : {
              text,
              date: requestDay,
              rows: requestRows,
              conversation_id: requestConversationId,
              request_id: requestId,
            }
      ),
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || "The request failed. Please try again.");
      return j;
    });
    if (Array.isArray(data.memory_notes)) memoryLoadedAccount = null;
    setThinking(false);
    const conversationStillCurrent =
      storageAccount === requestAccount &&
      conversationEpoch === requestConversationEpoch &&
      conversationId === requestConversationId;
    if (conversationStillCurrent && data.conversation_id) {
      setConversationId(data.conversation_id);
    }
    const responseBelongsToVisibleConversation = conversationStillCurrent;
    pendingToolConfirmation =
      responseBelongsToVisibleConversation &&
      sameDayContext(requestAccount, requestDay, requestSelectionEpoch) &&
      data.pending_confirmation?.token
        ? data.pending_confirmation
        : null;
    setDayRevision(requestDay, data.day_revision, requestAccount);
    if (
      Array.isArray(data.rows) &&
      ((data.changed === true && data.ledger_committed === true) ||
        data.ledger_reloaded === true)
    ) {
      const committedRows = ensureUniqueIds(data.rows);
      if (data.changed === true && data.ledger_committed === true) {
        const priorIds = new Set(
          requestRows.map((row) => String(row?.id || "")).filter(Boolean)
        );
        verifiedAddedRows = committedRows.filter(
          (row) => row?.id != null && !priorIds.has(String(row.id))
        );
      }
      // The server either committed this exact day transactionally or reloaded
      // the newer authoritative snapshot after a conflict. Cache only.
      saveLocalRows(requestDay, committedRows, requestAccount);
      if (sameDayContext(requestAccount, requestDay, requestSelectionEpoch)) {
        rows = committedRows;
        render();
      }
    }
    // Chat can change daily targets (diet/macros) — refresh rings
    if (
      storageAccount === requestAccount &&
      data.goals &&
      typeof data.goals === "object"
    ) {
      window.__ntUser = window.__ntUser || {};
      window.__ntUser.goals = { ...(window.__ntUser.goals || {}), ...data.goals };
      if (window.__ntUser.onboarding) {
        window.__ntUser.onboarding.goals = window.__ntUser.goals;
        if (data.eating_style) window.__ntUser.onboarding.eating_style = data.eating_style;
      }
      applyGoalsFromWatches([]);
      render();
      const gs = document.getElementById("youProfileSummary");
      // refresh You tab goal line if present
      const g = window.__ntUser.goals;
      const youGoals = document.getElementById("youGoalsLine");
      if (youGoals && g) {
        youGoals.textContent = `${g.kcal || "—"} kcal · P ${g.protein || "—"}g · F ${g.fat || "—"}g · C ${g.carbs || "—"}g`;
      }
    }
    // Chat can rearrange Today layout
    if (storageAccount === requestAccount && data.layout && window.BBLayout) {
      window.BBLayout.apply(data.layout, { persist: true });
      window.__ntUser = window.__ntUser || {};
      window.__ntUser.layout = data.layout;
    }
    // Chat can restyle the whole look
    if (storageAccount === requestAccount && data.theme && window.BBTheme) {
      window.BBTheme.apply(data.theme, { persist: true });
      window.__ntUser = window.__ntUser || {};
      window.__ntUser.theme = data.theme;
    }
    if (storageAccount === requestAccount && data.scene != null && window.BBScenes) {
      window.BBScenes.apply(data.scene, { persist: true, theme: !data.theme });
      window.__ntUser = window.__ntUser || {};
      window.__ntUser.scene = data.scene;
    }
    // Do NOT guess scenes from chat text on the client — that re-applied snow
    // whenever someone *mentioned* snow (e.g. "how you made snow").
    // Chat can add/update custom goal boxes
    if (storageAccount === requestAccount && Array.isArray(data.boxes) && window.BBBoxes) {
      window.BBBoxes.setBoxes(data.boxes, { persist: true });
      window.__ntUser = window.__ntUser || {};
      window.__ntUser.boxes = data.boxes;
      window.BBBoxes.loadValuesForDay(selectedDay);
    }
    if (storageAccount === requestAccount) {
      if (Array.isArray(data.watchStatuses)) renderWatches(data.watchStatuses);
      else loadWatches();
    }
    // Refresh custom box totals after logging
    if (
      storageAccount === requestAccount &&
      window.BBBoxes &&
      (data.changed || data.sideEvents?.length || data.boxes)
    ) {
      window.BBBoxes.loadValuesForDay(selectedDay);
    }
    const reply =
      (typeof data.reply === "string" && data.reply.trim()) ||
      (Array.isArray(data.notes) && data.notes.filter(Boolean).join(" "));
    if (responseBelongsToVisibleConversation) {
      const receiptRows = sameDayContext(
        requestAccount,
        requestDay,
        requestSelectionEpoch
      )
        ? verifiedAddedRows
        : [];
      const receipt = buildVerifiedLogReceipt(receiptRows, requestDay);
      if (receiptRows.length) pulseVerifiedLogUpdate(receiptRows);
      if (reply || receipt) {
        appendChat("bot", reply || "Logged successfully.", false, { receipt });
      }
      else appendChat("bot", "No response returned.", true);
    }
  } catch (e) {
    setThinking(false);
    if (
      storageAccount === requestAccount &&
      conversationEpoch === requestConversationEpoch &&
      conversationId === requestConversationId
    ) {
      appendChat("bot", e.message || "The request failed. Please try again.", true);
    }
  } finally {
    sending = false;
    addBtn.disabled = false;
    foodInput.focus();
  }
}

function sortBy(key, type) {
  if (sortKey === key) sortDesc = !sortDesc;
  else {
    sortKey = key;
    sortDesc = type !== "text";
  }
  rows.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (type === "text") {
      return sortDesc
        ? String(bv).localeCompare(String(av))
        : String(av).localeCompare(String(bv));
    }
    return sortDesc ? Number(bv) - Number(av) : Number(av) - Number(bv);
  });
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.remove("sorted-desc", "sorted-asc");
    if (th.dataset.key === key) th.classList.add(sortDesc ? "sorted-desc" : "sorted-asc");
  });
  if (sortStatus) {
    sortStatus.textContent = `Sorted by ${key} (${sortDesc ? "high→low" : "low→high"})`;
  }
  render();
}

function render() {
  rows = ensureUniqueIds(rows);
  renderFoodCards();
  renderTableOnly();
  const t = totals();
  // Uniform: Calories + macros all use Left · Eaten · Goal circles
  setMacroStat("Kcal", t.kcal, dayGoals.kcal, { unit: "" });
  setMacroStat("Pro", t.protein, dayGoals.protein);
  setMacroStat("Fat", t.fat, dayGoals.fat);
  setMacroStat("Carb", t.carbs, dayGoals.carbs);
  const netGoal =
    dayGoals.net_carbs != null ? Number(dayGoals.net_carbs) : dayGoals.carbs;
  setMacroStat("Net", t.netCarbs, netGoal);
  setText("tKcal2", fmt(t.kcal, 0));
  setText("tPro2", fmt(t.protein) + " g");
  setText("tFat2", fmt(t.fat) + " g");
  setText("tFib", fmt(t.fiber));
  setText("tK", fmt(t.potassium, 0));
  setText("tMg", fmt(t.magnesium, 0));
  setText("tNa", fmt(t.sodium, 0));
  setText("tFoodCount", String(rows.length));
  setText("tFoodCount2", String(rows.length));
}

function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}

function renderFoodCards() {
  if (!foodCards) return;
  if (!rows.length) {
    foodCards.innerHTML = "";
    if (foodEmpty) foodEmpty.hidden = false;
    return;
  }
  if (foodEmpty) foodEmpty.hidden = true;
  foodCards.innerHTML = rows
    .map((r) => {
      const id = String(r.id);
      return `<div class="food-card" data-id="${escapeHtml(id)}">
        <div class="name">${escapeHtml(r.label)}</div>
        <div class="kcal">${fmt(r.kcal, 0)}</div>
        <button class="x" type="button" title="Remove" data-id="${escapeHtml(id)}" data-label="${escapeHtml(r.label)}">×</button>
        <div class="macros">
          <span><em>${fmt(r.protein)}</em>p</span>
          <span><em>${fmt(r.fat)}</em>f</span>
          <span><em>${fmt(r.carbs)}</em>c</span>
          <span>K <em>${fmt(r.potassium, 0)}</em></span>
          <span>Mg <em>${fmt(r.magnesium, 0)}</em></span>
        </div>
      </div>`;
    })
    .join("");
  foodCards.querySelectorAll("button.x").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      askDelete(btn.dataset.id, btn.dataset.label || "");
    });
  });
}

function renderTableOnly() {
  if (!tbody) return;
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    const id = String(r.id);
    tr.innerHTML = `
      <td class="label">${escapeHtml(r.label)}</td>
      <td class="num">${fmt(r.kcal, 0)}</td>
      <td class="num">${fmt(r.protein)}</td>
      <td class="num">${fmt(r.fat)}</td>
      <td class="num">${fmt(r.carbs)}</td>
      <td class="num">${fmt(r.potassium, 0)}</td>
      <td class="num">${fmt(r.magnesium, 0)}</td>
      <td><button class="x" type="button" data-id="${escapeHtml(id)}" data-label="${escapeHtml(r.label)}">×</button></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button.x").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      askDelete(btn.dataset.id, btn.dataset.label || "");
    });
  });
}

/** Net carbs for one food row: explicit net if saved, else carbs − fiber */
function rowNetCarbs(r) {
  const extras = r?.extras && typeof r.extras === "object" ? r.extras : {};
  if (extras.net_carbs != null && Number.isFinite(Number(extras.net_carbs))) {
    return Math.max(0, Number(extras.net_carbs));
  }
  if (r?.net_carbs != null && Number.isFinite(Number(r.net_carbs))) {
    return Math.max(0, Number(r.net_carbs));
  }
  const carbs = Number(r?.carbs) || 0;
  const fiber = Number(r?.fiber) || 0;
  return Math.max(0, carbs - fiber);
}

function totals() {
  const t = {
    kcal: 0,
    protein: 0,
    fat: 0,
    carbs: 0,
    fiber: 0,
    netCarbs: 0,
    potassium: 0,
    magnesium: 0,
    sodium: 0,
  };
  for (const r of rows) {
    t.kcal += Number(r.kcal) || 0;
    t.protein += Number(r.protein) || 0;
    t.fat += Number(r.fat) || 0;
    t.carbs += Number(r.carbs) || 0;
    t.fiber += Number(r.fiber) || 0;
    t.netCarbs += rowNetCarbs(r);
    t.potassium += Number(r.potassium) || 0;
    t.magnesium += Number(r.magnesium) || 0;
    t.sodium += Number(r.sodium) || 0;
  }
  return t;
}

function fmt(n, d = 1) {
  const x = Number(n) || 0;
  return d === 0 ? String(Math.round(x)) : x.toFixed(d).replace(/\.0$/, "");
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
