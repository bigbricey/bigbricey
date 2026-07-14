/**
 * Ambient scenes / effects — bot picks a named scene, we run the visuals.
 */
(function () {
  const LS_KEY = "bigbricey-scene-v1";
  const SCENES = {
    none: { label: "None", bg: null, particles: null },
    rain: {
      label: "Rain",
      particles: "rain",
      palette: {
        bg0: "#0a1018",
        accent: "#60a5fa",
        ring_eaten: "#38bdf8",
        glow1: "56,189,248",
        glow2: "30,64,175",
        glow3: "14,165,233",
      },
    },
    snow: {
      label: "Snow",
      particles: "snow",
      palette: {
        bg0: "#0c1220",
        accent: "#e2e8f0",
        ring_eaten: "#93c5fd",
        glow1: "226,232,240",
        glow2: "147,197,253",
        glow3: "186,230,253",
      },
    },
    desert: {
      label: "Desert dust",
      particles: "dust",
      palette: {
        bg0: "#1a1208",
        accent: "#fbbf24",
        ring_eaten: "#f59e0b",
        ring_goal: "#fde68a",
        glow1: "251,191,36",
        glow2: "217,119,6",
        glow3: "180,83,9",
      },
    },
    ocean: {
      label: "Ocean",
      particles: "bubbles",
      palette: {
        bg0: "#04151c",
        accent: "#22d3ee",
        ring_eaten: "#06b6d4",
        glow1: "6,182,212",
        glow2: "14,165,233",
        glow3: "45,212,191",
      },
    },
    matrix: {
      label: "Matrix",
      particles: "matrix",
      palette: {
        bg0: "#020403",
        accent: "#4ade80",
        ring_eaten: "#22c55e",
        ring_left: "#86efac",
        glow1: "74,222,128",
        glow2: "22,163,74",
        glow3: "34,197,94",
      },
    },
    stars: {
      label: "Stars",
      particles: "stars",
      palette: {
        bg0: "#050510",
        accent: "#a78bfa",
        ring_eaten: "#818cf8",
        glow1: "167,139,250",
        glow2: "99,102,241",
        glow3: "56,189,248",
      },
    },
    confetti: {
      label: "Confetti",
      particles: "confetti",
      palette: {
        bg0: "#12081a",
        accent: "#f472b6",
        ring_eaten: "#fb7185",
        glow1: "244,114,182",
        glow2: "251,191,36",
        glow3: "52,211,153",
      },
    },
    fireflies: {
      label: "Fireflies",
      particles: "fireflies",
      palette: {
        bg0: "#07140a",
        accent: "#a3e635",
        ring_eaten: "#84cc16",
        glow1: "163,230,53",
        glow2: "34,197,94",
        glow3: "250,204,21",
      },
    },
    aurora: {
      label: "Aurora",
      particles: "aurora",
      palette: {
        bg0: "#060814",
        accent: "#34d399",
        ring_eaten: "#2dd4bf",
        glow1: "52,211,153",
        glow2: "129,140,248",
        glow3: "244,114,182",
      },
    },
    mist: {
      label: "Mist",
      particles: "mist",
      palette: {
        bg0: "#0e1118",
        accent: "#94a3b8",
        ring_eaten: "#64748b",
        glow1: "148,163,184",
        glow2: "100,116,139",
        glow3: "71,85,105",
      },
    },
    neon_city: {
      label: "Neon city",
      particles: "neon",
      palette: {
        bg0: "#0a0514",
        accent: "#e879f9",
        ring_eaten: "#c084fc",
        ring_goal: "#f0abfc",
        glow1: "232,121,249",
        glow2: "34,211,238",
        glow3: "244,63,94",
      },
    },
  };

  let current = "none";
  let canvas;
  let ctx;
  let raf = 0;
  let particles = [];
  let mode = null;
  let w = 0;
  let h = 0;

  function ensureCanvas() {
    let el = document.getElementById("sceneFx");
    if (!el) {
      el = document.createElement("canvas");
      el.id = "sceneFx";
      el.setAttribute("aria-hidden", "true");
      document.body.prepend(el);
    }
    canvas = el;
    ctx = canvas.getContext("2d");
    resize();
    if (!canvas.dataset.bound) {
      canvas.dataset.bound = "1";
      window.addEventListener("resize", resize);
    }
  }

  function resize() {
    if (!canvas) return;
    w = canvas.width = window.innerWidth * (window.devicePixelRatio || 1);
    h = canvas.height = window.innerHeight * (window.devicePixelRatio || 1);
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";
    spawn();
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    particles = [];
    mode = null;
    if (ctx && canvas) ctx.clearRect(0, 0, w, h);
    document.body.dataset.scene = "none";
  }

  function spawn() {
    particles = [];
    if (!mode || mode === "none") return;
    const n =
      mode === "matrix"
        ? 40
        : mode === "stars"
          ? 80
          : mode === "confetti"
            ? 50
            : mode === "mist"
              ? 25
              : 60;
    for (let i = 0; i < n; i++) particles.push(makeParticle(mode, true));
  }

  function makeParticle(type, randomY) {
    const x = Math.random() * w;
    const y = randomY ? Math.random() * h : -20;
    if (type === "rain") {
      return { type, x, y, len: 10 + Math.random() * 14, vy: 6 + Math.random() * 8, vx: -0.6 };
    }
    if (type === "snow") {
      return { type, x, y, r: 1 + Math.random() * 2.2, vy: 0.35 + Math.random() * 0.8, vx: Math.sin(Math.random() * 6) * 0.35 };
    }
    if (type === "dust") {
      return { type, x, y: Math.random() * h, r: 0.8 + Math.random() * 2, vx: 0.25 + Math.random() * 0.7, vy: (Math.random() - 0.5) * 0.25 };
    }
    if (type === "bubbles") {
      return { type, x, y: h + Math.random() * 40, r: 2 + Math.random() * 6, vy: -(0.5 + Math.random() * 1.5), vx: (Math.random() - 0.5) * 0.6 };
    }
    if (type === "matrix") {
      return { type, x: Math.floor(Math.random() * 40) * (w / 40), y, vy: 1.2 + Math.random() * 3, ch: String.fromCharCode(0x30a0 + Math.random() * 96) };
    }
    if (type === "stars") {
      return { type, x, y: Math.random() * h, r: Math.random() * 1.6, a: Math.random(), da: 0.01 + Math.random() * 0.02 };
    }
    if (type === "confetti") {
      const colors = ["#f472b6", "#38bdf8", "#fbbf24", "#34d399", "#a78bfa"];
      return { type, x, y, w: 4 + Math.random() * 6, h: 3 + Math.random() * 4, vy: 1.2 + Math.random() * 2.2, vx: (Math.random() - 0.5) * 1.2, color: colors[0], rot: Math.random() * 6 };
    }
    if (type === "fireflies") {
      return { type, x, y: Math.random() * h, r: 1.5 + Math.random() * 2, a: Math.random(), phase: Math.random() * 6 };
    }
    if (type === "aurora") {
      return { type, x: Math.random() * w, y: Math.random() * h * 0.5, w: w * 0.2, phase: Math.random() * 6 };
    }
    if (type === "mist") {
      return { type, x, y: Math.random() * h, r: 40 + Math.random() * 80, vx: 0.2 + Math.random() * 0.4, a: 0.03 + Math.random() * 0.04 };
    }
    if (type === "neon") {
      return { type, x, y: Math.random() * h, len: 20 + Math.random() * 40, vy: 1 + Math.random() * 3, color: Math.random() > 0.5 ? "#e879f9" : "#22d3ee" };
    }
    return { type: "stars", x, y, r: 1, a: 1, da: 0 };
  }

  // fix confetti color index
  function makeParticleFixed(type, randomY, i) {
    const p = makeParticle(type, randomY);
    if (type === "confetti") {
      const colors = ["#f472b6", "#38bdf8", "#fbbf24", "#34d399", "#a78bfa"];
      p.color = colors[i % colors.length];
    }
    if (type === "bubbles") p.vx = Math.sin(i) * 0.3;
    return p;
  }

  function spawnFixed() {
    particles = [];
    if (!mode || mode === "none") return;
    const n =
      mode === "matrix" ? 40 : mode === "stars" ? 90 : mode === "confetti" ? 55 : mode === "mist" ? 28 : 65;
    for (let i = 0; i < n; i++) particles.push(makeParticleFixed(mode, true, i));
  }

  function tick() {
    if (!ctx || !mode || mode === "none") return;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.type === "rain") {
        ctx.strokeStyle = "rgba(147,197,253,0.35)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.vx * 4, p.y + p.len);
        ctx.stroke();
        p.y += p.vy;
        p.x += p.vx;
        if (p.y > h) Object.assign(p, makeParticleFixed("rain", false, i));
      } else if (p.type === "snow") {
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        p.y += p.vy;
        p.x += p.vx;
        if (p.y > h) Object.assign(p, makeParticleFixed("snow", false, i));
      } else if (p.type === "dust") {
        ctx.fillStyle = "rgba(251,191,36,0.25)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        p.x += p.vx;
        p.y += p.vy;
        if (p.x > w) p.x = 0;
      } else if (p.type === "bubbles") {
        ctx.strokeStyle = "rgba(34,211,238,0.35)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.stroke();
        p.y += p.vy;
        p.x += p.vx;
        if (p.y < -20) Object.assign(p, makeParticleFixed("bubbles", false, i), { y: h + 10 });
      } else if (p.type === "matrix") {
        ctx.fillStyle = "rgba(74,222,128,0.55)";
        ctx.font = `${12 * (window.devicePixelRatio || 1)}px monospace`;
        ctx.fillText(p.ch, p.x, p.y);
        p.y += p.vy;
        if (p.y > h) {
          p.y = 0;
          p.ch = String.fromCharCode(0x30a0 + Math.random() * 96);
        }
      } else if (p.type === "stars") {
        p.a += p.da;
        if (p.a > 1 || p.a < 0.2) p.da *= -1;
        ctx.fillStyle = `rgba(226,232,240,${p.a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === "confetti") {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
        p.y += p.vy;
        p.x += p.vx;
        p.rot += 0.05;
        if (p.y > h) Object.assign(p, makeParticleFixed("confetti", false, i));
      } else if (p.type === "fireflies") {
        p.phase += 0.04;
        p.a = 0.3 + Math.sin(p.phase) * 0.4;
        p.x += Math.sin(p.phase) * 0.4;
        p.y += Math.cos(p.phase * 0.7) * 0.3;
        ctx.fillStyle = `rgba(163,230,53,${Math.max(0.1, p.a)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === "aurora") {
        p.phase += 0.01;
        const grd = ctx.createLinearGradient(p.x, 0, p.x + p.w, h * 0.5);
        grd.addColorStop(0, "rgba(52,211,153,0)");
        grd.addColorStop(0.5, `rgba(129,140,248,${0.08 + Math.sin(p.phase) * 0.04})`);
        grd.addColorStop(1, "rgba(244,114,182,0)");
        ctx.fillStyle = grd;
        ctx.fillRect(p.x - p.w / 2, 0, p.w, h * 0.55);
      } else if (p.type === "mist") {
        ctx.fillStyle = `rgba(148,163,184,${p.a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        p.x += p.vx;
        if (p.x - p.r > w) p.x = -p.r;
      } else if (p.type === "neon") {
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x, p.y + p.len);
        ctx.stroke();
        ctx.globalAlpha = 1;
        p.y += p.vy;
        if (p.y > h) Object.assign(p, makeParticleFixed("neon", false, i));
      }
    }
    raf = requestAnimationFrame(tick);
  }

  function applyScene(id, { persist = true, theme = true } = {}) {
    let key = String(id || "none")
      .toLowerCase()
      .replace(/\s+/g, "_");
    const aliases = {
      raining: "rain",
      rainy: "rain",
      cats_and_dogs: "rain",
      dust: "desert",
      sandy: "desert",
      beach: "ocean",
      sea: "ocean",
      space: "stars",
      night: "stars",
      party: "confetti",
      clear: "none",
      off: "none",
      default: "none",
    };
    if (aliases[key]) key = aliases[key];
    if (!SCENES[key]) key = "none";
    current = key;
    document.body.dataset.scene = key;

    const scene = SCENES[key];
    if (theme && scene.palette && window.BBTheme?.patch) {
      window.BBTheme.patch({ ...scene.palette, preset: "custom" });
    }

    stop();
    if (key === "none" || !scene.particles) {
      if (persist) saveLocal();
      syncUi();
      return current;
    }

    ensureCanvas();
    mode = scene.particles;
    spawnFixed();
    raf = requestAnimationFrame(tick);
    if (persist) saveLocal();
    syncUi();
    return current;
  }

  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, current);
    } catch {
      /* */
    }
  }

  function loadLocal() {
    try {
      return localStorage.getItem(LS_KEY) || "none";
    } catch {
      return "none";
    }
  }

  function syncUi() {
    const el = document.getElementById("sceneActiveName");
    if (el) el.textContent = (SCENES[current] && SCENES[current].label) || current;
    document.querySelectorAll("[data-scene]").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset.scene === current);
    });
  }

  function wireUi() {
    const grid = document.getElementById("scenePresetGrid");
    if (grid && !grid.dataset.wired) {
      grid.dataset.wired = "1";
      grid.innerHTML = Object.entries(SCENES)
        .map(
          ([id, s]) =>
            `<button type="button" class="theme-swatch" data-scene="${id}"><span class="theme-swatch-dot" style="background:${(s.palette && s.palette.accent) || "#334155"}"></span><span>${s.label}</span></button>`
        )
        .join("");
      grid.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-scene]");
        if (btn) applyScene(btn.dataset.scene);
      });
    }
    syncUi();
  }

  function applyFromAction(action) {
    if (!action) return current;
    const id =
      action.scene ||
      action.effect ||
      action.name ||
      action.id ||
      (action.reset ? "none" : null);
    if (!id) return current;
    return applyScene(id, { persist: true, theme: action.keep_theme ? false : true });
  }

  function initScenes() {
    const cloud = window.__ntUser?.scene;
    applyScene(cloud || loadLocal() || "none", { persist: false, theme: false });
    wireUi();
  }

  window.BBScenes = {
    init: initScenes,
    apply: applyScene,
    applyFromAction,
    current: () => current,
    SCENES,
  };
})();
