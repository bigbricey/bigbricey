import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { normalizeUserWorld } from "../api/_supabase.js";

test("Living World recipes stay expressive but bounded and safe", () => {
  const world = normalizeUserWorld({
    title: "  Rainbow\u0000 Meadow  ",
    sky: "pastel",
    landscape: "meadow",
    companion: "unicorn",
    outfit: "crown",
    tone: "magical",
    effects: ["rainbows", "sparkles", "rainbows", "hearts", "comets"],
    accent: "#f472b6",
    secondary: "#a78bfa",
    surface: "url(javascript:evil)",
  });

  assert.equal(world.title, "Rainbow Meadow");
  assert.equal(world.sky, "pastel");
  assert.equal(world.landscape, "meadow");
  assert.equal(world.companion, "unicorn");
  assert.equal(world.outfit, "crown");
  assert.deepEqual(world.effects, ["rainbows", "sparkles", "hearts"]);
  assert.equal(world.accent, "#f472b6");
  assert.equal(world.surface, "#08101f");

  const invalid = normalizeUserWorld({
    sky: "javascript",
    landscape: "iframe",
    companion: "licensed_character",
  });
  assert.equal(invalid.sky, "midnight");
  assert.equal(invalid.landscape, "loft");
  assert.equal(invalid.companion, "orb");
});

test("the frontend turns common foods into visible world objects", async () => {
  const source = await readFile(
    new URL("../public/world.js", import.meta.url),
    "utf8"
  );
  const sandbox = { window: {}, document: {}, localStorage: {}, setTimeout, clearTimeout };
  vm.runInNewContext(source, sandbox, { filename: "world.js" });

  assert.equal(sandbox.window.BBWorld.foodGlyph("1 lb bacon"), "🥓");
  assert.equal(sandbox.window.BBWorld.foodGlyph("Frozen tilapia fillet"), "🐟");
  assert.equal(sandbox.window.BBWorld.foodGlyph("Salted butter"), "🧈");
  assert.equal(sandbox.window.BBWorld.foodGlyph("Unknown custom recipe"), "🍽️");
});

test("Today exposes the reactive world and keeps it connected to chat and food state", async () => {
  const [html, app, layout, css] = await Promise.all([
    readFile(new URL("../public/app.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/layout.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /data-panel="world"/);
  assert.match(html, /id="worldFoods"/);
  assert.match(html, /world\.js/);
  assert.match(app, /BBWorld\.renderFoods\(rows/);
  assert.match(app, /BBWorld\.setMood\(on \? "thinking" : "idle"\)/);
  assert.match(layout, /"chat",\s*"world"/);
  assert.match(css, /@keyframes world-food-arrive/);
  assert.match(css, /body:not\(\.layout-editing\) \.layout-panel-chrome/);
});
