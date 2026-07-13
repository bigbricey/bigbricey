const KEY_PREFIX = "bigbricey-day-";

let selectedDay = todayKey();
let rows = loadLocal(selectedDay);
let sortKey = null;
let sortDesc = true;
let cloudReady = false;
let syncTimer = null;
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
  potassium: 3500,
  magnesium: 350,
};

let dayGoals = { ...DEFAULT_GOALS };
let pendingDeleteId = null;
let sending = false;

init();

async function init() {
  const ok = await requireAuth();
  if (!ok) return;

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => sortBy(th.dataset.key, th.dataset.type));
  });
  addBtn?.addEventListener("click", onSend);
  foodInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSend();
  });

  const clear = async () => {
    if (!confirm(`Clear all food for ${selectedDay}? This cannot be undone.`)) return;
    rows = [];
    save();
    render();
    appendChat("bot", `Cleared ${selectedDay}.`);
    await syncCloud(true);
    loadCharts();
  };
  document.getElementById("clearDay")?.addEventListener("click", clear);
  document.getElementById("clearDay2")?.addEventListener("click", clear);

  document.getElementById("wSave")?.addEventListener("click", saveWatchFromForm);
  document.getElementById("refreshFeedback")?.addEventListener("click", loadFeedbackInbox);
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
  personalizeWelcome();
  await loadFromCloud(selectedDay);
  render();
  loadWatches();
  loadAlerts();
  loadCharts();
  setTab("today");
}

function personalizeWelcome() {
  const u = window.__ntUser;
  if (!u) return;
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
  const welcome = document.querySelector("#chatLog .welcome .chat-text");
  if (!welcome) return;
  const justOnboarded = new URLSearchParams(location.search).has("welcome");
  if (justOnboarded) {
    history.replaceState({}, "", "/app.html");
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
    welcome.textContent = bits.join(" ");
    const who = document.querySelector("#chatLog .welcome .chat-who");
    if (who) who.textContent = "Coach";
  } else if (name) {
    welcome.textContent = `Hey ${name} — tell me what you ate, a workout, steps, or a goal. I’ll log real numbers and keep your forever ledger.`;
  }
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
  if (activeTab === "you" && window.__ntUser?.admin) loadFeedbackInbox();
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
  await syncCloud(true);
  selectedDay = day;
  rows = loadLocal(selectedDay);
  updateDayLabel();
  await loadFromCloud(selectedDay);
  render();
}

async function loadFromCloud(day) {
  try {
    const r = await fetch("/api/log?date=" + encodeURIComponent(day || selectedDay));
    if (r.status === 503) {
      cloudReady = false;
      return;
    }
    if (!r.ok) return;
    const d = await r.json();
    cloudReady = true;
    if (Array.isArray(d.rows)) {
      if (d.rows.length || day !== todayKey() || !rows.length) {
        rows = ensureUniqueIds(d.rows);
        saveLocal(selectedDay);
      } else if (rows.length) {
        rows = ensureUniqueIds(rows);
        await syncCloud(true);
      }
    }
  } catch {
    cloudReady = false;
  }
}

function ensureUniqueIds(list) {
  const seen = new Set();
  return (list || []).map((r, i) => {
    let id = r.id || newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    return { ...r, id };
  });
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

function confirmDelete() {
  const id = pendingDeleteId;
  closeConfirm();
  if (!id) return;
  const before = rows.length;
  rows = rows.filter((r) => String(r.id) !== String(id));
  if (rows.length === before) return;
  save();
  render();
  scheduleSync();
}

function addManualFood() {
  const name = document.getElementById("mName")?.value?.trim();
  if (!name) return;
  const row = {
    id: newId(),
    label: name,
    kcal: Number(document.getElementById("mKcal")?.value) || 0,
    protein: Number(document.getElementById("mPro")?.value) || 0,
    fat: Number(document.getElementById("mFat")?.value) || 0,
    carbs: Number(document.getElementById("mCarb")?.value) || 0,
    fiber: 0,
    potassium: Number(document.getElementById("mK")?.value) || 0,
    magnesium: 0,
    sodium: 0,
  };
  rows = ensureUniqueIds([...rows, row]);
  save();
  render();
  scheduleSync();
  const m = document.getElementById("manualModal");
  if (m) m.hidden = true;
  ["mName", "mKcal", "mPro", "mFat", "mCarb", "mK"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  appendChat("bot", `Added manually: ${name}`);
}

function setRing(id, eaten, goal) {
  const el = document.getElementById(id);
  if (!el) return;
  const r = id === "ringKcal" ? 52 : 40;
  const c = 2 * Math.PI * r;
  const g = Math.max(1, Number(goal) || 1);
  const e = Math.max(0, Number(eaten) || 0);
  // fill = how much of goal eaten (cap 100%)
  const pct = Math.min(1, e / g);
  el.style.strokeDasharray = String(c);
  el.style.strokeDashoffset = String(c * (1 - pct));
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
  setText("tProGoal", "/ " + Math.round(dayGoals.protein) + "g");
  setText("tFatGoal", "/ " + Math.round(dayGoals.fat) + "g");
  setText("tCarbGoal", "/ " + Math.round(dayGoals.carbs) + "g");
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

function localKey(day) {
  return KEY_PREFIX + (day || selectedDay);
}
function loadLocal(day) {
  try {
    return JSON.parse(localStorage.getItem(localKey(day)) || "[]");
  } catch {
    return [];
  }
}
function saveLocal(day) {
  localStorage.setItem(localKey(day || selectedDay), JSON.stringify(rows));
}
function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncCloud(false), 400);
}
async function syncCloud(immediate) {
  if (!cloudReady && !immediate) return;
  try {
    const r = await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: selectedDay, rows }),
    });
    if (r.ok) {
      cloudReady = true;
      loadWatches();
      loadAlerts();
      loadCharts();
    }
  } catch {
    /* offline */
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
function appendChat(role, text, isError) {
  if (!chatLog || !text) return;
  const welcome = chatLog.querySelector(".welcome");
  if (welcome) welcome.remove();
  const bubble = document.createElement("div");
  bubble.className =
    "chat-bubble " +
    (role === "user" ? "user" : "bot") +
    (isError ? " err" : "") +
    (text === "Working…" ? " thinking" : "");
  const who = document.createElement("div");
  who.className = "chat-who";
  who.textContent = role === "user" ? "You" : isError ? "Error" : "Coach";
  const body = document.createElement("div");
  body.className = "chat-text";
  body.textContent = text;
  bubble.appendChild(who);
  bubble.appendChild(body);
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}
function setThinking(on) {
  if (!chatLog) return;
  const existing = chatLog.querySelector(".thinking");
  if (on) {
    if (!existing) appendChat("bot", "Working…");
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

async function loadFeedbackInbox() {
  const list = document.getElementById("feedbackList");
  if (!list) return;
  try {
    const r = await fetch("/api/log?feedback=1");
    if (!r.ok) {
      list.innerHTML = `<div class="alert-empty">Couldn't load feedback.</div>`;
      return;
    }
    const d = await r.json();
    const items = d.feedback || [];
    if (!items.length) {
      list.innerHTML = `<div class="alert-empty">No suggestions yet.</div>`;
      return;
    }
    list.innerHTML = items
      .map((f) => {
        const when = (f.created_at || "").slice(0, 16).replace("T", " ");
        return `<div class="alert-item ${f.status === "new" ? "yellow" : ""}">
          <div>
            <div class="atitle">${escapeHtml(f.user_name || f.user_email)}</div>
            <div class="abody">${escapeHtml(f.message)}</div>
            <div class="abody" style="margin-top:4px">${escapeHtml(when)}</div>
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

async function onSend() {
  const text = foodInput.value.trim();
  if (!text || sending) return;
  sending = true;
  addBtn.disabled = true;
  foodInput.value = "";
  if (activeTab !== "today") setTab("today");
  appendChat("user", text);
  setThinking(true);
  try {
    const data = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, rows }),
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok && j.error) throw new Error(j.error);
      return j;
    });
    setThinking(false);
    if (Array.isArray(data.rows)) {
      rows = ensureUniqueIds(data.rows);
      save();
      render();
      await syncCloud(true);
    }
    if (Array.isArray(data.watchStatuses)) renderWatches(data.watchStatuses);
    else loadWatches();
    appendChat("bot", data.reply || data.notes?.join(" ") || "Done.");
  } catch (e) {
    setThinking(false);
    appendChat("bot", e.message || String(e), true);
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
  save();
}

function render() {
  rows = ensureUniqueIds(rows);
  renderFoodCards();
  renderTableOnly();
  const t = totals();
  const remain = Math.max(0, Math.round(dayGoals.kcal - t.kcal));
  setText("tKcalRemain", String(remain));
  setText("tKcal", fmt(t.kcal, 0));
  setText("tKcal2", fmt(t.kcal, 0));
  setText("tPro", fmt(t.protein));
  setText("tPro2", fmt(t.protein) + " g");
  setText("tFat", fmt(t.fat));
  setText("tFat2", fmt(t.fat) + " g");
  setText("tCarb", fmt(t.carbs));
  setText("tFib", fmt(t.fiber));
  setText("tK", fmt(t.potassium, 0));
  setText("tMg", fmt(t.magnesium, 0));
  setText("tNa", fmt(t.sodium, 0));
  setText("tFoodCount", String(rows.length));
  setText("tFoodCount2", String(rows.length));
  setRing("ringKcal", t.kcal, dayGoals.kcal);
  setRing("ringPro", t.protein, dayGoals.protein);
  setRing("ringFat", t.fat, dayGoals.fat);
  setRing("ringCarb", t.carbs, dayGoals.carbs);
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

function totals() {
  const t = {
    kcal: 0,
    protein: 0,
    fat: 0,
    carbs: 0,
    fiber: 0,
    potassium: 0,
    magnesium: 0,
    sodium: 0,
  };
  for (const r of rows) {
    for (const k of Object.keys(t)) t[k] += Number(r[k]) || 0;
  }
  return t;
}

function save() {
  saveLocal(selectedDay);
  scheduleSync();
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
