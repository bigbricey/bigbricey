/**
 * BigBricey look customization — presets, colors, rings, font, corners.
 */
(function () {
  const LEGACY_LS_KEY = "bigbricey-theme-v1";
  const LS_PREFIX = "bigbricey-theme-v2-";
  const QUARANTINE_KEY = "bigbricey-unassigned-theme-v1";

  const PRESETS = {
    midnight: {
      label: "Midnight",
      accent: "#38bdf8",
      good: "#34d399",
      warn: "#fbbf24",
      bad: "#f87171",
      bg0: "#06080f",
      text: "#f1f5f9",
      muted: "#8b95a8",
      card: "rgba(14, 18, 28, 0.75)",
      ring_left: "#34d399",
      ring_eaten: "#38bdf8",
      ring_goal: "#facc15",
      ring_over: "#f87171",
      glow1: "56,189,248",
      glow2: "52,211,153",
      glow3: "167,139,250",
      font_scale: 1,
      radius: 20,
      density: "cozy",
    },
    light: {
      label: "Clean light",
      accent: "#0284c7",
      good: "#059669",
      warn: "#d97706",
      bad: "#dc2626",
      bg0: "#f1f5f9",
      text: "#0f172a",
      muted: "#64748b",
      card: "rgba(255,255,255,0.88)",
      ring_left: "#059669",
      ring_eaten: "#0284c7",
      ring_goal: "#ca8a04",
      ring_over: "#dc2626",
      glow1: "14,165,233",
      glow2: "16,185,129",
      glow3: "139,92,246",
      font_scale: 1,
      radius: 20,
      density: "cozy",
    },
    neon: {
      label: "Neon",
      accent: "#22d3ee",
      good: "#a3e635",
      warn: "#fde047",
      bad: "#fb7185",
      bg0: "#050510",
      text: "#f5f3ff",
      muted: "#a5b4fc",
      card: "rgba(20, 10, 40, 0.8)",
      ring_left: "#a3e635",
      ring_eaten: "#e879f9",
      ring_goal: "#fde047",
      ring_over: "#fb7185",
      glow1: "232,121,249",
      glow2: "34,211,238",
      glow3: "163,230,53",
      font_scale: 1,
      radius: 16,
      density: "cozy",
    },
    forest: {
      label: "Forest",
      accent: "#34d399",
      good: "#4ade80",
      warn: "#fbbf24",
      bad: "#f87171",
      bg0: "#07140f",
      text: "#ecfdf5",
      muted: "#86efac",
      card: "rgba(6, 28, 18, 0.8)",
      ring_left: "#4ade80",
      ring_eaten: "#2dd4bf",
      ring_goal: "#fbbf24",
      ring_over: "#f87171",
      glow1: "52,211,153",
      glow2: "16,185,129",
      glow3: "251,191,36",
      font_scale: 1,
      radius: 20,
      density: "cozy",
    },
    pink: {
      label: "Pink",
      accent: "#f472b6",
      good: "#fb7185",
      warn: "#fbbf24",
      bad: "#e11d48",
      bg0: "#1a0a14",
      text: "#fdf2f8",
      muted: "#f9a8d4",
      card: "rgba(40, 12, 28, 0.8)",
      ring_left: "#fb7185",
      ring_eaten: "#f472b6",
      ring_goal: "#fde047",
      ring_over: "#e11d48",
      glow1: "244,114,182",
      glow2: "251,113,133",
      glow3: "192,132,252",
      font_scale: 1,
      radius: 22,
      density: "cozy",
    },
    terminal: {
      label: "Terminal",
      accent: "#4ade80",
      good: "#22c55e",
      warn: "#eab308",
      bad: "#ef4444",
      bg0: "#020403",
      text: "#d1fae5",
      muted: "#6ee7b7",
      card: "rgba(0, 20, 10, 0.85)",
      ring_left: "#4ade80",
      ring_eaten: "#22c55e",
      ring_goal: "#a3e635",
      ring_over: "#ef4444",
      glow1: "74,222,128",
      glow2: "34,197,94",
      glow3: "163,230,53",
      font_scale: 1,
      radius: 8,
      density: "compact",
    },
    pastel: {
      label: "Pastel",
      accent: "#c084fc",
      good: "#86efac",
      warn: "#fcd34d",
      bad: "#f9a8d4",
      bg0: "#1e1230",
      text: "#faf5ff",
      muted: "#d8b4fe",
      card: "rgba(45, 25, 70, 0.75)",
      ring_left: "#86efac",
      ring_eaten: "#f9a8d4",
      ring_goal: "#fde68a",
      ring_over: "#fb7185",
      glow1: "244,114,182",
      glow2: "192,132,252",
      glow3: "125,211,252",
      font_scale: 1.05,
      radius: 24,
      density: "cozy",
    },
    sunset: {
      label: "Sunset",
      accent: "#fb923c",
      good: "#fbbf24",
      warn: "#f97316",
      bad: "#ef4444",
      bg0: "#1a0c08",
      text: "#fff7ed",
      muted: "#fdba74",
      card: "rgba(40, 18, 12, 0.8)",
      ring_left: "#fbbf24",
      ring_eaten: "#fb923c",
      ring_goal: "#fde047",
      ring_over: "#ef4444",
      glow1: "251,146,60",
      glow2: "244,63,94",
      glow3: "250,204,21",
      font_scale: 1,
      radius: 18,
      density: "cozy",
    },
  };

  // vibe aliases → preset
  const VIBE_ALIAS = {
    my_little_pony: "pastel",
    mlp: "pastel",
    pony: "pastel",
    kawaii: "pastel",
    cute: "pastel",
    barbie: "pink",
    matrix: "terminal",
    hacker: "terminal",
    cyber: "neon",
    nature: "forest",
    green: "forest",
    dark: "midnight",
    default: "midnight",
  };

  const DEFAULT_THEME = { preset: "midnight", ...PRESETS.midnight };

  let theme = { ...DEFAULT_THEME };
  let saveTimer = null;

  function storageKey() {
    try {
      return window.BBAccountStorage?.key(
        LS_PREFIX,
        window.__ntUser?.account_id || window.__ntUser?.email
      ) || null;
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

  function hexOk(v) {
    return typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim());
  }

  function glowOk(v) {
    return typeof v === "string" && /^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(v.trim());
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function normalizeTheme(raw) {
    const base = { ...DEFAULT_THEME };
    if (!raw || typeof raw !== "object") return base;

    let preset = String(raw.preset || raw.vibe || raw.theme || "custom")
      .toLowerCase()
      .replace(/\s+/g, "_");
    if (VIBE_ALIAS[preset]) preset = VIBE_ALIAS[preset];
    if (PRESETS[preset]) {
      Object.assign(base, PRESETS[preset], { preset });
    } else {
      base.preset = "custom";
    }

    const keys = [
      "accent",
      "good",
      "warn",
      "bad",
      "bg0",
      "text",
      "muted",
      "ring_left",
      "ring_eaten",
      "ring_goal",
      "ring_over",
    ];
    for (const k of keys) {
      if (hexOk(raw[k])) base[k] = raw[k].trim();
    }
    // aliases
    if (hexOk(raw.eaten)) base.ring_eaten = raw.eaten.trim();
    if (hexOk(raw.left)) base.ring_left = raw.left.trim();
    if (hexOk(raw.goal)) base.ring_goal = raw.goal.trim();
    if (hexOk(raw.background)) base.bg0 = raw.background.trim();
    if (hexOk(raw.bg)) base.bg0 = raw.bg.trim();

    if (typeof raw.card === "string" && raw.card.length < 80) base.card = raw.card;
    if (glowOk(raw.glow1)) base.glow1 = raw.glow1.replace(/\s/g, "");
    if (glowOk(raw.glow2)) base.glow2 = raw.glow2.replace(/\s/g, "");
    if (glowOk(raw.glow3)) base.glow3 = raw.glow3.replace(/\s/g, "");
    if (raw.label) base.label = String(raw.label).slice(0, 40);

    // shape / type
    if (raw.radius != null || raw.corners != null || raw.shape != null) {
      let r = raw.radius != null ? Number(raw.radius) : null;
      const shape = String(raw.shape || raw.corners || "").toLowerCase();
      if (shape === "square" || shape === "sharp" || shape === "boxy") r = 6;
      if (shape === "round" || shape === "pill" || shape === "soft") r = 24;
      if (shape === "circle" || shape === "max") r = 32;
      if (r != null && Number.isFinite(r)) base.radius = clamp(Math.round(r), 0, 40);
    }

    if (raw.font_scale != null || raw.fontScale != null || raw.font_size != null) {
      const fs = Number(raw.font_scale ?? raw.fontScale ?? raw.font_size);
      if (Number.isFinite(fs)) {
        // accept 0.85–1.35 or 85–135 as percent
        base.font_scale = clamp(fs > 3 ? fs / 100 : fs, 0.85, 1.35);
      }
    }
    if (raw.density === "compact" || raw.density === "cozy") base.density = raw.density;
    if (raw.compact === true) base.density = "compact";

    if (preset !== "custom" && PRESETS[preset]) {
      const p = PRESETS[preset];
      const changed = ["accent", "bg0", "ring_left", "ring_eaten", "ring_goal", "radius", "font_scale"].some(
        (k) => base[k] != null && p[k] != null && String(base[k]).toLowerCase() !== String(p[k]).toLowerCase()
      );
      if (changed) base.preset = "custom";
    }

    return base;
  }

  function applyTheme(next, { persist = false, cloud = false } = {}) {
    theme = normalizeTheme(next);
    const root = document.documentElement;
    const map = {
      "--accent": theme.accent,
      "--good": theme.good,
      "--warn": theme.warn,
      "--bad": theme.bad,
      "--bg0": theme.bg0,
      "--text": theme.text,
      "--muted": theme.muted,
      "--card": theme.card,
      "--ring-left": theme.ring_left,
      "--ring-eaten": theme.ring_eaten,
      "--ring-goal": theme.ring_goal,
      "--ring-over": theme.ring_over,
      "--glow-1": theme.glow1,
      "--glow-2": theme.glow2,
      "--glow-3": theme.glow3,
      "--radius": (theme.radius != null ? theme.radius : 20) + "px",
      "--radius-sm": Math.max(6, Math.round((theme.radius != null ? theme.radius : 20) * 0.7)) + "px",
      "--font-scale": String(theme.font_scale != null ? theme.font_scale : 1),
    };
    for (const [k, v] of Object.entries(map)) {
      if (v != null) root.style.setProperty(k, v);
    }
    document.body.dataset.theme = theme.preset || "custom";
    document.body.dataset.density = theme.density || "cozy";
    document.documentElement.style.fontSize =
      16 * (theme.font_scale != null ? Number(theme.font_scale) : 1) + "px";

    syncUi();
    if (persist) saveLocal();
    if (cloud) scheduleCloudSave();
    return theme;
  }

  function current() {
    return { ...theme };
  }

  function saveLocal() {
    try {
      const key = storageKey();
      if (key) localStorage.setItem(key, JSON.stringify(theme));
    } catch {
      /* */
    }
  }

  function loadLocal() {
    try {
      const key = storageKey();
      if (!key) return null;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return normalizeTheme(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function scheduleCloudSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveCloud(theme).catch(() => {});
    }, 350);
  }

  async function saveCloud(t) {
    try {
      await fetch("/api/auth/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: normalizeTheme(t) }),
      });
    } catch {
      /* */
    }
  }

  function applyPreset(id, opts = {}) {
    let key = String(id || "").toLowerCase().replace(/\s+/g, "_");
    if (VIBE_ALIAS[key]) key = VIBE_ALIAS[key];
    const p = PRESETS[key];
    if (!p) return theme;
    return applyTheme({ preset: key, ...p }, { persist: true, cloud: true, ...opts });
  }

  function patch(partial) {
    return applyTheme(
      { ...theme, ...partial, preset: partial.preset || "custom" },
      { persist: true, cloud: true }
    );
  }

  function applyFromAction(action) {
    if (!action || typeof action !== "object") return theme;
    if (action.reset || action.type === "reset_theme") {
      return applyTheme(DEFAULT_THEME, { persist: true, cloud: true });
    }
    let preset = action.preset || action.theme || action.name || action.vibe;
    if (preset) {
      preset = String(preset).toLowerCase().replace(/\s+/g, "_");
      if (VIBE_ALIAS[preset]) preset = VIBE_ALIAS[preset];
    }
    if (preset && PRESETS[preset]) {
      return applyTheme(
        { ...PRESETS[preset], ...action, preset },
        { persist: true, cloud: true }
      );
    }
    return applyTheme({ ...theme, ...action, preset: "custom" }, { persist: true, cloud: true });
  }

  function syncUi() {
    const grid = document.getElementById("themePresetGrid");
    if (grid) {
      grid.querySelectorAll("[data-preset]").forEach((btn) => {
        btn.classList.toggle("on", btn.dataset.preset === theme.preset);
      });
    }
    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el && v != null && el.type === "color") el.value = v.length === 7 ? v : el.value;
      else if (el && v != null) el.value = v;
    };
    setVal("themeAccent", theme.accent);
    setVal("themeBg", theme.bg0);
    setVal("themeRingLeft", theme.ring_left);
    setVal("themeRingEaten", theme.ring_eaten);
    setVal("themeRingGoal", theme.ring_goal);
    setVal("themeRingOver", theme.ring_over);
    const fs = document.getElementById("themeFontScale");
    if (fs) fs.value = String(theme.font_scale != null ? theme.font_scale : 1);
    const rad = document.getElementById("themeRadius");
    if (rad) rad.value = String(theme.radius != null ? theme.radius : 20);
    const dens = document.getElementById("themeDensity");
    if (dens) dens.value = theme.density || "cozy";
    const name = document.getElementById("themeActiveName");
    if (name) {
      name.textContent =
        theme.preset && PRESETS[theme.preset]
          ? PRESETS[theme.preset].label
          : "Custom";
    }
    const fsLab = document.getElementById("themeFontScaleLab");
    if (fsLab) fsLab.textContent = Math.round((theme.font_scale || 1) * 100) + "%";
    const rLab = document.getElementById("themeRadiusLab");
    if (rLab) rLab.textContent = (theme.radius != null ? theme.radius : 20) + "px";
  }

  function wireUi() {
    const grid = document.getElementById("themePresetGrid");
    if (grid && !grid.dataset.wired) {
      grid.dataset.wired = "1";
      grid.innerHTML = Object.entries(PRESETS)
        .map(
          ([id, p]) =>
            `<button type="button" class="theme-swatch" data-preset="${id}" title="${p.label}" style="--sw:${p.accent};--swbg:${p.bg0}">
              <span class="theme-swatch-dot"></span>
              <span>${p.label}</span>
            </button>`
        )
        .join("");
      grid.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-preset]");
        if (btn) applyPreset(btn.dataset.preset);
      });
    }

    const bindColor = (id, key) => {
      const el = document.getElementById(id);
      if (!el || el.dataset.wired) return;
      el.dataset.wired = "1";
      el.addEventListener("input", () => patch({ [key]: el.value }));
    };
    bindColor("themeAccent", "accent");
    bindColor("themeBg", "bg0");
    bindColor("themeRingLeft", "ring_left");
    bindColor("themeRingEaten", "ring_eaten");
    bindColor("themeRingGoal", "ring_goal");
    bindColor("themeRingOver", "ring_over");

    const fs = document.getElementById("themeFontScale");
    if (fs && !fs.dataset.wired) {
      fs.dataset.wired = "1";
      fs.addEventListener("input", () => patch({ font_scale: Number(fs.value) }));
    }
    const rad = document.getElementById("themeRadius");
    if (rad && !rad.dataset.wired) {
      rad.dataset.wired = "1";
      rad.addEventListener("input", () => patch({ radius: Number(rad.value) }));
    }
    const dens = document.getElementById("themeDensity");
    if (dens && !dens.dataset.wired) {
      dens.dataset.wired = "1";
      dens.addEventListener("change", () => patch({ density: dens.value }));
    }

    document.getElementById("btnResetTheme")?.addEventListener("click", () => {
      applyTheme(DEFAULT_THEME, { persist: true, cloud: true });
    });
    document.getElementById("btnShapeSquare")?.addEventListener("click", () => {
      patch({ shape: "square", radius: 6 });
    });
    document.getElementById("btnShapeRound")?.addEventListener("click", () => {
      patch({ shape: "round", radius: 24 });
    });

    syncUi();
  }

  function initTheme() {
    quarantineLegacyPreference();
    const cloud = window.__ntUser?.theme;
    const local = loadLocal();
    applyTheme(cloud || local || DEFAULT_THEME, { persist: false });
    if (cloud && !local) saveLocal();
    wireUi();
  }

  window.BBTheme = {
    init: initTheme,
    apply: applyTheme,
    applyPreset,
    applyFromAction,
    patch,
    current,
    reset: () => applyTheme(DEFAULT_THEME, { persist: true, cloud: true }),
    PRESETS,
    DEFAULT: DEFAULT_THEME,
  };
})();
