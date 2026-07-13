/**
 * Custom boxes — counters + AI chart boxes (line/bar/pie over any range).
 */
(function () {
  const LS_KEY = "bigbricey-boxes-v1";
  const MAX = 20;
  const CORE = new Set([
    "chat",
    "kcal",
    "pro",
    "fat",
    "carb",
    "net",
    "minerals",
    "summary",
    "food",
  ]);
  const CHART_PALETTE = [
    "#38bdf8",
    "#34d399",
    "#a78bfa",
    "#fbbf24",
    "#f472b6",
    "#2dd4bf",
    "#fb923c",
    "#f87171",
  ];

  let boxes = [];
  let values = {}; // today counters
  let chartCache = {}; // id -> { days, series }
  let saveTimer = null;

  function slug(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
  }

  function parseDays(raw) {
    if (raw == null || raw === "") return 30;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.min(1095, Math.max(1, Math.round(raw)));
    }
    const s = String(raw).toLowerCase().trim();
    const n = parseInt(s, 10);
    if (/year/.test(s)) return Math.min(1095, (n || 1) * 365);
    if (/month/.test(s)) return Math.min(1095, (n || 1) * 30);
    if (/week/.test(s)) return Math.min(1095, (n || 1) * 7);
    if (/day/.test(s)) return Math.min(1095, n || 7);
    if (Number.isFinite(n)) return Math.min(1095, Math.max(1, n));
    return 30;
  }

  function normalizeBox(raw) {
    if (!raw || typeof raw !== "object") return null;

    let kind = String(raw.kind || raw.type || "counter").toLowerCase();
    if (kind === "graph" || kind === "trend" || kind === "plot") kind = "chart";
    if (kind !== "chart") kind = "counter";

    let measures = [];
    if (Array.isArray(raw.measures)) {
      measures = raw.measures.map(slug).filter(Boolean);
    } else if (raw.measure_id || raw.measure) {
      measures = [slug(raw.measure_id || raw.measure)];
    }
    if (kind === "chart" && !measures.length) {
      measures = [slug(raw.title) || "protein"].filter(Boolean);
    }

    const measure_id = measures[0] || slug(raw.measure_id || raw.measure || raw.title || "custom") || "custom";

    let id = String(raw.id || "").toLowerCase().trim();
    if (!id) {
      if (kind === "chart") {
        id = "c_chart_" + measures.slice(0, 2).join("_") + "_" + parseDays(raw.days || raw.range || raw.window);
      } else {
        id = "c_" + measure_id;
      }
    }
    if (!id.startsWith("c_")) id = "c_" + slug(id);
    id = id.slice(0, 48);
    if (CORE.has(id) || id.length < 3) return null;

    let goal = raw.goal != null ? Number(raw.goal) : raw.target != null ? Number(raw.target) : null;
    if (goal != null && !Number.isFinite(goal)) goal = null;

    const color =
      typeof raw.color === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw.color)
        ? raw.color
        : raw.accent || (kind === "chart" ? CHART_PALETTE[0] : "#38bdf8");

    let size = raw.size;
    if (!["full", "half", "third"].includes(size)) {
      size = kind === "chart" ? "full" : "half";
    }
    const mode = String(raw.mode || "floor").toLowerCase() === "ceiling" ? "ceiling" : "floor";

    let chart = String(raw.chart || raw.chart_type || raw.style || "line").toLowerCase();
    if (!["line", "bar", "pie"].includes(chart)) chart = "line";

    const days = kind === "chart" ? parseDays(raw.days ?? raw.range ?? raw.window ?? 30) : null;

    let title = String(raw.title || raw.label || "").slice(0, 48);
    if (!title) {
      title =
        kind === "chart"
          ? `${measures.join(" + ")} · ${days}d`
          : measure_id;
    }

    return {
      id,
      kind,
      title,
      measure_id,
      measures: kind === "chart" ? measures.slice(0, 6) : [measure_id],
      unit: String(raw.unit || "").slice(0, 16),
      goal,
      mode,
      color,
      icon: String(raw.icon || (kind === "chart" ? "📈" : "◎")).slice(0, 4),
      size,
      chart,
      days,
    };
  }

  function normalizeList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const b = normalizeBox(raw);
      if (!b || seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
      if (out.length >= MAX) break;
    }
    return out;
  }

  function ids() {
    return boxes.map((b) => b.id);
  }

  function list() {
    return boxes.map((b) => ({ ...b }));
  }

  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(boxes));
    } catch {
      /* */
    }
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return normalizeList(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function scheduleCloud() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch("/api/auth/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boxes }),
      }).catch(() => {});
    }, 400);
  }

  function board() {
    return document.getElementById("layoutBoard");
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

  function fmt(n) {
    const x = Number(n) || 0;
    if (Math.abs(x) >= 100) return String(Math.round(x));
    return String(Math.round(x * 10) / 10).replace(/\.0$/, "");
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function chrome(box) {
    const sizeLab = box.size === "third" ? "1/3" : box.size === "full" ? "Full" : "Half";
    return `
      <div class="layout-panel-chrome">
        <span class="layout-drag" title="Drag">⠿</span>
        <span class="layout-panel-title">${escapeHtml(box.icon || "")} ${escapeHtml(box.title)}</span>
        <button type="button" class="layout-size-btn" data-size-cycle>${sizeLab}</button>
        <button type="button" class="layout-box-remove" data-remove-box="${escapeHtml(box.id)}" title="Remove box" aria-label="Remove">×</button>
      </div>`;
  }

  function ensurePanel(box) {
    const b = board();
    if (!b) return null;
    let el = b.querySelector(`.layout-panel[data-panel="${box.id}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "layout-panel layout-panel-custom";
      el.dataset.panel = box.id;
      el.id = "panel_" + box.id;
      b.appendChild(el);
    }
    el.dataset.size = box.size || "half";
    el.dataset.kind = box.kind || "counter";
    el.classList.toggle("size-full", box.size === "full");
    el.classList.toggle("size-half", box.size === "half" || !box.size);
    el.classList.toggle("size-third", box.size === "third");
    el.classList.toggle("is-chart-box", box.kind === "chart");
    el.style.setProperty("--box-accent", box.color || "#38bdf8");

    if (box.kind === "chart") {
      el.innerHTML =
        chrome(box) +
        `<article class="custom-box-card custom-chart-card">
          <div class="custom-box-head">
            <span class="custom-box-icon">${escapeHtml(box.icon || "📈")}</span>
            <div>
              <div class="custom-box-title">${escapeHtml(box.title)}</div>
              <div class="custom-box-sub">${escapeHtml((box.measures || []).join(", "))} · ${box.days || 30}d · ${escapeHtml(box.chart || "line")}</div>
            </div>
          </div>
          <div class="custom-chart-wrap">
            <canvas class="custom-chart-canvas" data-chart-box="${escapeHtml(box.id)}" width="640" height="220"></canvas>
          </div>
          <div class="custom-chart-legend" data-chart-legend="${escapeHtml(box.id)}"></div>
        </article>`;
      // paint after layout
      requestAnimationFrame(() => paintChart(box));
      return el;
    }

    // counter
    const eaten = Number(values[box.measure_id]) || 0;
    const goal = box.goal != null ? Number(box.goal) : null;
    const gSafe = goal != null && goal > 0 ? goal : 0;
    const pct = gSafe > 0 ? Math.min(1, eaten / gSafe) : 0;
    const left = gSafe > 0 ? gSafe - eaten : null;
    const over = gSafe > 0 && eaten > gSafe;
    const circ = 263.9;
    const offset = circ * (1 - pct);
    const unit = box.unit || "";

    el.innerHTML =
      chrome(box) +
      `<article class="custom-box-card${over ? " is-over" : ""}">
        <div class="custom-box-head">
          <span class="custom-box-icon">${escapeHtml(box.icon || "◎")}</span>
          <div>
            <div class="custom-box-title">${escapeHtml(box.title)}</div>
            <div class="custom-box-sub">${escapeHtml(box.measure_id)}${unit ? " · " + escapeHtml(unit) : ""}</div>
          </div>
        </div>
        <div class="custom-box-body">
          <div class="custom-box-ring-wrap">
            <svg class="mt-ring" viewBox="0 0 100 100" aria-hidden="true">
              <circle class="mt-track custom-box-track" cx="50" cy="50" r="42" />
              <circle class="mt-fill custom-box-fill" cx="50" cy="50" r="42"
                style="stroke-dasharray:${circ};stroke-dashoffset:${offset}" />
            </svg>
            <div class="mt-center"><strong>${fmt(eaten)}</strong></div>
          </div>
          <ul class="custom-box-stats">
            <li><span>Today</span><strong>${fmt(eaten)}${unit ? " " + escapeHtml(unit) : ""}</strong></li>
            <li><span>Goal</span><strong>${goal != null ? fmt(goal) + (unit ? " " + escapeHtml(unit) : "") : "—"}</strong></li>
            <li><span>${over ? "Over" : "Left"}</span><strong>${
              left == null ? "—" : fmt(Math.abs(left)) + (unit ? " " + escapeHtml(unit) : "")
            }</strong></li>
          </ul>
        </div>
      </article>`;
    return el;
  }

  function getCanvas(boxId) {
    return document.querySelector(`canvas[data-chart-box="${boxId}"]`);
  }

  function paintChart(box) {
    const canvas = getCanvas(box.id);
    if (!canvas) return;
    const cached = chartCache[box.id];
    const measures = box.measures || [box.measure_id];
    if (!cached || !cached.days) {
      drawChartEmpty(canvas, "Loading…");
      return;
    }
    const type = box.chart || "line";
    if (type === "pie") drawPie(canvas, cached, measures, box);
    else if (type === "bar") drawBars(canvas, cached, measures, box);
    else drawLines(canvas, cached, measures, box);

    const leg = document.querySelector(`[data-chart-legend="${box.id}"]`);
    if (leg) {
      leg.innerHTML = measures
        .map((m, i) => {
          const c = CHART_PALETTE[i % CHART_PALETTE.length];
          return `<span><i style="background:${c}"></i>${escapeHtml(m)}</span>`;
        })
        .join("");
    }
  }

  function drawChartEmpty(canvas, msg) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#64748b";
    ctx.font = "14px DM Sans, system-ui";
    ctx.fillText(msg, 16, h / 2);
  }

  function seriesPoints(cached, measure) {
    const rows = cached.series?.[measure] || [];
    return (cached.days || []).map((day) => {
      const row = rows.find((x) => x.day_key === day);
      return row ? Number(row.total) || 0 : 0;
    });
  }

  function drawLines(canvas, cached, measures, box) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const pad = { l: 40, r: 12, t: 14, b: 28 };
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.fillRect(0, 0, w, h);
    const days = cached.days || [];
    if (!days.length) {
      drawChartEmpty(canvas, "No data in range yet");
      return;
    }
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    let max = 1;
    const all = measures.map((m) => seriesPoints(cached, m));
    all.forEach((pts) => pts.forEach((v) => { if (v > max) max = v; }));

    ctx.strokeStyle = "rgba(148,163,184,0.15)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + (plotH * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
    }

    measures.forEach((m, mi) => {
      const pts = all[mi];
      const color = CHART_PALETTE[mi % CHART_PALETTE.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
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
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    ctx.fillStyle = "#64748b";
    ctx.font = "10px DM Sans, system-ui";
    const step = Math.max(1, Math.floor(days.length / 5));
    days.forEach((day, i) => {
      if (i % step !== 0 && i !== days.length - 1) return;
      const x = pad.l + (days.length === 1 ? plotW / 2 : (plotW * i) / (days.length - 1));
      ctx.fillText(String(day).slice(5), x - 12, h - 10);
    });
  }

  function drawBars(canvas, cached, measures, box) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const pad = { l: 40, r: 12, t: 14, b: 28 };
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.fillRect(0, 0, w, h);
    const days = cached.days || [];
    if (!days.length) {
      drawChartEmpty(canvas, "No data in range yet");
      return;
    }
    // For many days, aggregate weekly averages if > 60
    let labels = days;
    let series = measures.map((m) => seriesPoints(cached, m));
    if (days.length > 60) {
      const bucket = Math.ceil(days.length / 40);
      const nLabels = [];
      const nSeries = measures.map(() => []);
      for (let i = 0; i < days.length; i += bucket) {
        nLabels.push(days[i]);
        measures.forEach((_, mi) => {
          const slice = series[mi].slice(i, i + bucket);
          const avg = slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
          nSeries[mi].push(avg);
        });
      }
      labels = nLabels;
      series = nSeries;
    }
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    let max = 1;
    series.forEach((pts) => pts.forEach((v) => { if (v > max) max = v; }));
    const groupW = plotW / labels.length;
    const barW = Math.max(2, (groupW * 0.7) / Math.max(1, measures.length));

    measures.forEach((m, mi) => {
      const color = CHART_PALETTE[mi % CHART_PALETTE.length];
      ctx.fillStyle = color;
      series[mi].forEach((v, i) => {
        const bh = (v / max) * plotH;
        const x = pad.l + i * groupW + groupW * 0.15 + mi * barW;
        const y = pad.t + plotH - bh;
        ctx.fillRect(x, y, barW, bh);
      });
    });
    ctx.fillStyle = "#64748b";
    ctx.font = "10px DM Sans, system-ui";
    const step = Math.max(1, Math.floor(labels.length / 5));
    labels.forEach((day, i) => {
      if (i % step !== 0 && i !== labels.length - 1) return;
      const x = pad.l + i * groupW + groupW * 0.2;
      ctx.fillText(String(day).slice(5), x, h - 10);
    });
  }

  function drawPie(canvas, cached, measures, box) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.fillRect(0, 0, w, h);

    // Sum each measure over range
    const totals = measures.map((m) => {
      const pts = seriesPoints(cached, m);
      return pts.reduce((a, b) => a + b, 0);
    });
    const sum = totals.reduce((a, b) => a + b, 0);
    if (sum <= 0) {
      drawChartEmpty(canvas, "No data in range yet");
      return;
    }
    const cx = w * 0.38;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.32;
    let ang = -Math.PI / 2;
    totals.forEach((t, i) => {
      const slice = (t / sum) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, ang, ang + slice);
      ctx.closePath();
      ctx.fillStyle = CHART_PALETTE[i % CHART_PALETTE.length];
      ctx.fill();
      ang += slice;
    });
    // labels
    ctx.font = "12px DM Sans, system-ui";
    measures.forEach((m, i) => {
      const pct = Math.round((totals[i] / sum) * 100);
      const y = 28 + i * 22;
      ctx.fillStyle = CHART_PALETTE[i % CHART_PALETTE.length];
      ctx.fillRect(w * 0.62, y - 10, 10, 10);
      ctx.fillStyle = "#cbd5e1";
      ctx.fillText(`${m}: ${fmt(totals[i])} (${pct}%)`, w * 0.62 + 16, y);
    });
  }

  async function loadChartData(box) {
    const days = box.days || 30;
    const to = todayKey();
    const from = shiftDay(to, -(days - 1));
    const measures = (box.measures || [box.measure_id]).filter(Boolean);
    if (!measures.length) return;
    try {
      const r = await fetch(
        `/api/log?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&measures=${encodeURIComponent(measures.join(","))}`
      );
      if (!r.ok) {
        chartCache[box.id] = { days: [], series: {} };
        paintChart(box);
        return;
      }
      const d = await r.json();
      chartCache[box.id] = {
        days: d.days || [],
        series: d.series || {},
        from,
        to,
      };
      paintChart(box);
    } catch {
      chartCache[box.id] = { days: [], series: {} };
      paintChart(box);
    }
  }

  function refreshCharts() {
    boxes.filter((b) => b.kind === "chart").forEach((b) => loadChartData(b));
  }

  function pruneDom() {
    const b = board();
    if (!b) return;
    const keep = new Set(ids());
    b.querySelectorAll(".layout-panel-custom").forEach((el) => {
      if (!keep.has(el.dataset.panel)) el.remove();
    });
  }

  function render() {
    pruneDom();
    for (const box of boxes) ensurePanel(box);
    if (window.BBLayout?.registerExtraIds) {
      window.BBLayout.registerExtraIds(ids());
    }
    if (window.BBLayout?.syncSizesFromBoxes) {
      window.BBLayout.syncSizesFromBoxes(boxes);
    }
    if (window.BBLayout?.current && window.BBLayout?.apply) {
      const cur = window.BBLayout.current();
      let order = cur.order.slice();
      for (const id of ids()) {
        if (!order.includes(id)) order.push(id);
      }
      order = order.filter((id) => CORE.has(id) || ids().includes(id));
      const sizes = { ...cur.sizes };
      for (const box of boxes) sizes[box.id] = box.size || (box.kind === "chart" ? "full" : "half");
      window.BBLayout.apply({ order, sizes }, { persist: false });
    }
    // kick chart loads
    requestAnimationFrame(refreshCharts);
  }

  function setBoxes(list, { persist = false, cloud = false } = {}) {
    boxes = normalizeList(list);
    if (persist) saveLocal();
    if (cloud) scheduleCloud();
    render();
    return list();
  }

  function upsert(raw, opts = {}) {
    const b = normalizeBox(raw);
    if (!b) return list();
    const i = boxes.findIndex((x) => x.id === b.id);
    if (i >= 0) boxes[i] = { ...boxes[i], ...b };
    else {
      if (boxes.length >= MAX) boxes.shift();
      boxes.push(b);
    }
    if (opts.persist !== false) saveLocal();
    if (opts.cloud !== false) scheduleCloud();
    render();
    return list();
  }

  function remove(id) {
    const key = String(id || "").toLowerCase();
    boxes = boxes.filter(
      (b) =>
        b.id !== key &&
        b.measure_id !== key &&
        !(b.title || "").toLowerCase().includes(key)
    );
    saveLocal();
    scheduleCloud();
    render();
    if (window.BBLayout?.current && window.BBLayout?.apply) {
      const cur = window.BBLayout.current();
      window.BBLayout.apply(
        {
          order: cur.order.filter((x) => ids().includes(x) || CORE.has(x)),
          sizes: cur.sizes,
        },
        { persist: true, cloud: true }
      );
    }
    return list();
  }

  function applyFromAction(action) {
    if (!action || typeof action !== "object") return list();
    const type = String(action.type || "").toLowerCase();

    if (type === "remove_box" || type === "delete_box" || action.remove) {
      remove(action.id || action.box || action.measure_id || action.name || action.title);
      return list();
    }
    if (type === "clear_boxes") {
      boxes = [];
      saveLocal();
      scheduleCloud();
      render();
      return list();
    }

    let kind = action.kind || action.type;
    if (type === "add_chart" || type === "set_chart" || type === "chart_box") kind = "chart";
    if (kind === "graph" || kind === "trend") kind = "chart";

    const box = {
      id: action.id,
      kind: kind === "chart" ? "chart" : action.kind || "counter",
      title: action.title || action.label || action.name,
      measure_id: action.measure_id || action.measure || action.name,
      measures: action.measures,
      unit: action.unit,
      goal: action.goal ?? action.target ?? action.target_min,
      mode: action.mode,
      color: action.color || action.accent,
      icon: action.icon || action.emoji,
      size: action.size,
      chart: action.chart || action.chart_type || action.style,
      days: action.days ?? action.range ?? action.window,
    };
    // natural language helpers
    if (action.weeks != null) box.days = Number(action.weeks) * 7;
    if (action.months != null) box.days = Number(action.months) * 30;
    if (action.years != null) box.days = Number(action.years) * 365;

    upsert(box);
    return list();
  }

  async function loadValuesForDay(day) {
    const dayKey = day || null;
    const counters = boxes.filter((b) => b.kind !== "chart");
    if (counters.length) {
      try {
        const qs = new URLSearchParams({ boxes: "1" });
        if (dayKey) qs.set("date", dayKey);
        const r = await fetch("/api/log?" + qs.toString());
        if (r.ok) {
          const d = await r.json();
          values = d.values && typeof d.values === "object" ? d.values : {};
          if (d.totals && typeof d.totals === "object") {
            values = { ...values, ...d.totals };
          }
        }
      } catch {
        /* */
      }
    }
    render();
  }

  function setValue(measureId, n) {
    values[slug(measureId)] = Number(n) || 0;
    render();
  }

  function wire() {
    const b = board();
    if (!b || b.dataset.boxesWired) return;
    b.dataset.boxesWired = "1";
    b.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-box]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute("data-remove-box");
      if (id && confirm("Remove this box?")) remove(id);
    });
    b.addEventListener("click", (e) => {
      const sizeBtn = e.target.closest(".layout-panel-custom [data-size-cycle]");
      if (!sizeBtn) return;
      const panel = sizeBtn.closest(".layout-panel");
      if (!panel) return;
      const id = panel.dataset.panel;
      const box = boxes.find((x) => x.id === id);
      if (!box) return;
      setTimeout(() => {
        box.size = panel.dataset.size || "half";
        saveLocal();
        scheduleCloud();
        if (box.kind === "chart") paintChart(box);
      }, 0);
    });
  }

  function initBoxes() {
    wire();
    const cloud = window.__ntUser?.boxes;
    const local = loadLocal();
    boxes = normalizeList(cloud || local || []);
    if (cloud && !local) saveLocal();
    render();
    loadValuesForDay();
  }

  window.BBBoxes = {
    init: initBoxes,
    list,
    ids,
    setBoxes,
    upsert,
    remove,
    applyFromAction,
    loadValuesForDay,
    setValue,
    render,
    refreshCharts,
    MAX,
  };
})();
