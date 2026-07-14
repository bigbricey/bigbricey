/**
 * BigBricey Living World
 * A bounded procedural home that reacts to chat and turns logged food into
 * visible objects. No user HTML, scripts, or remote images are injected.
 */
(function () {
  const LEGACY_LS_KEY = "bigbricey-world-v1";
  const LS_PREFIX = "bigbricey-world-v2-";
  const QUARANTINE_KEY = "bigbricey-unassigned-world-v1";

  const DEFAULT_WORLD = {
    title: "Midnight Loft",
    sky: "midnight",
    landscape: "loft",
    companion: "orb",
    outfit: "hoodie",
    tone: "focused",
    effects: ["stars"],
    accent: "#38bdf8",
    secondary: "#a78bfa",
    surface: "#08101f",
  };

  const ALLOWED = {
    sky: new Set(["midnight", "daybreak", "sunset", "pastel", "space", "aurora", "storm", "ocean"]),
    landscape: new Set(["loft", "meadow", "clouds", "forest", "mountains", "ocean", "city", "desert", "space", "dojo"]),
    companion: new Set(["orb", "coach", "cat", "dog", "fox", "dragon", "robot", "unicorn", "astronaut", "wizard"]),
    outfit: new Set(["none", "hoodie", "cape", "crown", "armor", "spacesuit", "wizard", "workout", "ninja"]),
    tone: new Set(["cozy", "bold", "calm", "magical", "focused", "playful", "epic"]),
    effects: new Set(["sparkles", "stars", "clouds", "rainbows", "hearts", "fireflies", "bubbles", "snow", "rain", "confetti", "embers", "comets"]),
  };

  const COMPANION_ICONS = {
    orb: "✦",
    coach: "💪",
    cat: "🐱",
    dog: "🐶",
    fox: "🦊",
    dragon: "🐲",
    robot: "🤖",
    unicorn: "🦄",
    astronaut: "🧑‍🚀",
    wizard: "🧙",
  };
  const OUTFIT_ICONS = {
    none: "",
    hoodie: "🎧",
    cape: "🦸",
    crown: "👑",
    armor: "🛡️",
    spacesuit: "🪐",
    wizard: "🪄",
    workout: "🏋️",
    ninja: "🥷",
  };
  const LANDSCAPE_ICONS = {
    loft: "◆  ◇  ◆",
    meadow: "🌸  🌿  🌼  🌿  🌸",
    clouds: "☁️   ☁️   ☁️",
    forest: "🌲  🌳  🌲  🌳  🌲",
    mountains: "⛰️   🏔️   ⛰️",
    ocean: "🌊  〰  🌊  〰  🌊",
    city: "▥  ▤  ▦  ▥  ▤",
    desert: "🏜️   ◌   🏜️",
    space: "🪐   ·   🌙   ·   🪐",
    dojo: "⛩️   ◇   ⛩️",
  };
  const EFFECT_ICONS = {
    sparkles: "✦",
    stars: "✧",
    clouds: "☁",
    rainbows: "🌈",
    hearts: "♥",
    fireflies: "•",
    bubbles: "○",
    snow: "❄",
    rain: "│",
    confetti: "◆",
    embers: "·",
    comets: "☄",
  };

  const FOOD_GLYPHS = [
    [/bacon|pork belly/, "🥓"],
    [/egg/, "🥚"],
    [/butter/, "🧈"],
    [/salt/, "🧂"],
    [/tilapia|salmon|tuna|cod|fish|sardine|trout/, "🐟"],
    [/shrimp|prawn|lobster|crab/, "🦐"],
    [/steak|beef|sirloin|ribeye|brisket/, "🥩"],
    [/chicken|turkey|wing|drumstick/, "🍗"],
    [/burger|hamburger/, "🍔"],
    [/pizza/, "🍕"],
    [/salad|lettuce|spinach|kale/, "🥗"],
    [/avocado/, "🥑"],
    [/cheese/, "🧀"],
    [/yogurt|yoghurt/, "🥣"],
    [/milk|cream/, "🥛"],
    [/coffee|espresso/, "☕"],
    [/shake|smoothie/, "🥤"],
    [/apple/, "🍎"],
    [/banana/, "🍌"],
    [/berry|berries|strawberr/, "🍓"],
    [/orange|citrus/, "🍊"],
    [/grape/, "🍇"],
    [/broccoli/, "🥦"],
    [/potato|fries/, "🥔"],
    [/rice|oat|cereal/, "🍚"],
    [/bread|toast|bagel/, "🍞"],
    [/taco|burrito/, "🌮"],
    [/sushi/, "🍣"],
    [/cake|cupcake/, "🍰"],
    [/cookie/, "🍪"],
    [/water/, "💧"],
  ];

  let world = { ...DEFAULT_WORLD };
  let knownFoodIds = new Set();
  let foodsReady = false;
  let mood = "idle";
  let moodTimer = null;

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

  function normalize(raw) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const next = { ...DEFAULT_WORLD };
    const title = String(source.title || "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48);
    if (title) next.title = title;
    for (const key of ["sky", "landscape", "companion", "outfit", "tone"]) {
      const value = String(source[key] || "").toLowerCase().trim();
      if (ALLOWED[key].has(value)) next[key] = value;
    }
    if (Array.isArray(source.effects)) {
      next.effects = Array.from(
        new Set(
          source.effects
            .map((effect) => String(effect || "").toLowerCase().trim())
            .filter((effect) => ALLOWED.effects.has(effect))
        )
      ).slice(0, 3);
    }
    for (const key of ["accent", "secondary", "surface"]) {
      const value = String(source[key] || "").trim();
      if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) next[key] = value;
    }
    return next;
  }

  function saveLocal() {
    try {
      const key = storageKey();
      if (key) localStorage.setItem(key, JSON.stringify(world));
    } catch {
      /* */
    }
  }

  function loadLocal() {
    try {
      const key = storageKey();
      if (!key) return null;
      const value = localStorage.getItem(key);
      return value ? normalize(JSON.parse(value)) : null;
    } catch {
      return null;
    }
  }

  function ensureBackdrop() {
    let backdrop = document.getElementById("worldBackdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "worldBackdrop";
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.innerHTML = '<div class="world-backdrop-glow"></div><div class="world-backdrop-effects"></div>';
      document.body.prepend(backdrop);
    }
    return backdrop;
  }

  function renderEffects(container, effects, copies) {
    if (!container) return;
    const safe = Array.isArray(effects) ? effects.filter((effect) => ALLOWED.effects.has(effect)) : [];
    const pieces = [];
    for (const effect of safe) {
      const icon = EFFECT_ICONS[effect] || "✦";
      for (let index = 0; index < copies; index += 1) {
        pieces.push(
          `<span class="world-effect world-effect-${effect}" style="--effect-index:${index}">${escapeHtml(icon)}</span>`
        );
      }
    }
    container.innerHTML = pieces.join("");
  }

  function apply(next, { persist = false } = {}) {
    world = normalize(next);
    const panel = document.getElementById("livingWorld");
    const backdrop = ensureBackdrop();
    for (const target of [panel, backdrop]) {
      if (!target) continue;
      target.dataset.sky = world.sky;
      target.dataset.landscape = world.landscape;
      target.dataset.tone = world.tone;
      target.dataset.companion = world.companion;
      target.dataset.outfit = world.outfit;
      target.style.setProperty("--world-accent", world.accent);
      target.style.setProperty("--world-secondary", world.secondary);
      target.style.setProperty("--world-surface", world.surface);
    }
    document.body.dataset.worldSky = world.sky;
    document.body.dataset.worldLandscape = world.landscape;

    setText("worldTitle", world.title);
    setText("worldBuddyIcon", COMPANION_ICONS[world.companion] || "✦");
    const outfit = document.getElementById("worldOutfitIcon");
    if (outfit) {
      outfit.textContent = OUTFIT_ICONS[world.outfit] || "";
      outfit.hidden = world.outfit === "none";
    }
    setText("worldHorizon", LANDSCAPE_ICONS[world.landscape] || "");
    const panelEffects = document.getElementById("worldEffects");
    renderEffects(panelEffects, world.effects, 3);
    renderEffects(backdrop.querySelector(".world-backdrop-effects"), world.effects, 4);
    const live = document.getElementById("worldLiveLabel");
    if (live) live.textContent = `${world.companion} · ${world.outfit}`;
    syncMoodCopy();
    if (persist) saveLocal();
    return { ...world };
  }

  function foodGlyph(label) {
    const text = String(label || "").toLowerCase();
    for (const [pattern, glyph] of FOOD_GLYPHS) {
      if (pattern.test(text)) return glyph;
    }
    return "🍽️";
  }

  function renderFoods(rows, { totals = {}, goals = {}, day = "" } = {}) {
    const container = document.getElementById("worldFoods");
    const empty = document.getElementById("worldEmpty");
    if (!container) return;
    const list = Array.isArray(rows) ? rows : [];
    const nextIds = new Set(list.map((row) => String(row?.id || "")).filter(Boolean));
    const arriving = foodsReady
      ? list.filter((row) => row?.id != null && !knownFoodIds.has(String(row.id)))
      : [];
    knownFoodIds = nextIds;
    foodsReady = true;

    if (!list.length) {
      container.innerHTML = "";
      if (empty) empty.hidden = false;
    } else {
      if (empty) empty.hidden = true;
      const visible = list.slice(-6);
      container.innerHTML = visible
        .map((row, index) => {
          const id = String(row?.id || `food-${index}`);
          const label = String(row?.label || "Food").slice(0, 80);
          const isArriving = arriving.some((item) => String(item.id) === id);
          const kcal = Number(row?.kcal);
          return `<button type="button" class="world-food${isArriving ? " is-arriving" : ""}" data-food-id="${escapeHtml(id)}" aria-label="${escapeHtml(label)}${Number.isFinite(kcal) ? `, ${Math.round(kcal)} calories` : ""}">
            <span class="world-food-glyph" aria-hidden="true">${escapeHtml(foodGlyph(label))}</span>
            <span class="world-food-name">${escapeHtml(shortLabel(label, 18))}</span>
            ${Number.isFinite(kcal) ? `<span class="world-food-kcal">${Math.round(kcal)}</span>` : ""}
          </button>`;
        })
        .join("");
      if (list.length > visible.length) {
        container.insertAdjacentHTML(
          "beforeend",
          `<div class="world-food-more" aria-label="${list.length - visible.length} more foods">+${list.length - visible.length}</div>`
        );
      }
      container.querySelectorAll("[data-food-id]").forEach((button) => {
        button.addEventListener("click", () => focusFood(button.dataset.foodId));
      });
    }

    const kcal = Number(totals?.kcal) || 0;
    const kcalGoal = Number(goals?.kcal) || 0;
    setText("worldFoodCount", `${list.length} ${list.length === 1 ? "food" : "foods"}`);
    setText(
      "worldEnergy",
      kcalGoal > 0 ? `${Math.round(kcal)} / ${Math.round(kcalGoal)} energy` : `${Math.round(kcal)} energy`
    );
    const date = document.getElementById("worldDay");
    if (date) date.textContent = day || "Today";

    if (arriving.length) celebrate(arriving.length);
    else syncMoodCopy(list.length);
  }

  function focusFood(id) {
    const matches = Array.from(document.querySelectorAll(".food-card[data-id]"));
    const card = matches.find((item) => String(item.dataset.id) === String(id));
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("is-spotlit");
    setTimeout(() => card.classList.remove("is-spotlit"), 1500);
  }

  function setMood(next) {
    mood = ["idle", "thinking", "celebrate"].includes(next) ? next : "idle";
    const panel = document.getElementById("livingWorld");
    if (panel) panel.dataset.mood = mood;
    syncMoodCopy();
  }

  function celebrate(count) {
    clearTimeout(moodTimer);
    setMood("celebrate");
    setText("worldBuddyMood", count === 1 ? "Added to your world." : `${count} new pieces just landed.`);
    moodTimer = setTimeout(() => setMood("idle"), 1800);
  }

  function syncMoodCopy(foodCount = knownFoodIds.size) {
    if (mood === "thinking") {
      setText("worldBuddyMood", "Building it with you…");
      return;
    }
    if (mood === "celebrate") return;
    if (!foodCount) setText("worldBuddyMood", "Say it once. I’ll build the day here.");
    else if (foodCount === 1) setText("worldBuddyMood", "The first piece is in.");
    else if (foodCount < 4) setText("worldBuddyMood", "Your day is taking shape.");
    else setText("worldBuddyMood", `${foodCount} pieces are alive in today’s world.`);
  }

  function wirePrompt() {
    const button = document.getElementById("worldRemix");
    if (!button || button.dataset.wired) return;
    button.dataset.wired = "1";
    button.addEventListener("click", () => {
      const input = document.getElementById("foodInput");
      if (!input) return;
      input.value =
        button.dataset.prompt ||
        "Surprise me — rebuild my Living World into something completely different.";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
  }

  function init() {
    quarantineLegacyPreference();
    apply(window.__ntUser?.world || loadLocal() || DEFAULT_WORLD, { persist: false });
    wirePrompt();
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value ?? "");
  }

  function shortLabel(value, max) {
    const text = String(value || "").trim();
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trim()}…` : text;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  window.BBWorld = {
    init,
    apply,
    renderFoods,
    setMood,
    current: () => ({ ...world, effects: world.effects.slice() }),
    foodGlyph,
  };
})();
