import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the You tab exposes understandable accessible companion controls", async () => {
  const html = await readFile(new URL("public/app.html", root), "utf8");
  assert.match(html, /id="companionSettingsForm"/);
  assert.match(html, /<fieldset class="companion-mode-fieldset">/);
  assert.match(html, /<legend>Proactive help<\/legend>/);
  assert.match(html, /value="quiet"/);
  assert.match(html, /value="helpful"/);
  assert.match(html, /value="coach"/);
  assert.match(html, /for="companionNickname"/);
  assert.match(html, /id="companionSettingsStatus" role="status" aria-live="polite"/);
  assert.match(html, /src="\/companion\.js/);
});

test("companion UI saves one validated account setting and renders suggestions as text", async () => {
  const source = await readFile(new URL("public/companion.js", root), "utf8");
  assert.match(source, /fetch\("\/api\/companion"/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /body: JSON\.stringify\(\{ settings: formPatch\(\) \}\)/);
  assert.match(source, /message\.textContent = suggestion\.message/);
  assert.match(source, /dismissSuggestion\(suggestion\.id\)/);
  assert.doesNotMatch(source, /innerHTML/);
});

test("companion API is authenticated, bounded, additive, and never returns profile email", async () => {
  const source = await readFile(new URL("api/_companion_endpoint.js", root), "utf8");
  assert.match(source, /requireUser\(req, res\)/);
  assert.match(source, /maxBytes: 4_096/);
  assert.match(source, /validateCompanionSettingsPatch/);
  assert.match(source, /saveCompanionSettings\(user\.email, patch\)/);
  assert.doesNotMatch(source, /email:\s*user\.email/);
});

test("proactive banner comes only from server-grounded suggestions", async () => {
  const server = await readFile(new URL("api/log.js", root), "utf8");
  const client = await readFile(new URL("public/app.js", root), "utf8");
  assert.match(server, /buildGroundedSuggestions/);
  assert.match(server, /statuses: evaluated\.statuses/);
  assert.match(server, /suggestions,/);
  assert.match(client, /renderWatches\(d\.statuses \|\| \[\], d\.suggestions \|\| \[\]\)/);
  assert.doesNotMatch(client, /const bad = \(statuses/);
});
