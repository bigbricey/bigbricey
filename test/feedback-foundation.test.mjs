import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { submitFeedback } from "../api/_members.js";

test("feedback requires an explicit user confirmation before any database work", async () => {
  await assert.rejects(
    submitFeedback("person@example.test", "Please change this", {
      consent: false,
    }),
    (error) => error?.code === "feedback_consent_required" && error?.status === 400
  );
});

test("specific-interaction feedback can include context only by explicit opt-in", async () => {
  const route = await readFile(new URL("../api/_feedback_endpoint.js", import.meta.url), "utf8");
  assert.match(route, /body\?\.consent !== true/);
  assert.match(route, /const includeContext = body\.include_context === true/);
  assert.match(route, /account_id: `eq\.\$\{accountId\}`/);
  assert.match(route, /id: `eq\.\$\{id\}`/);
  assert.match(route, /const context = includeContext\s*\?\s*await interactionContext/);
  assert.match(route, /contextExcerpt: context/);
  assert.doesNotMatch(route, /contextExcerpt:\s*body\./);
});

test("one account cannot attach another account's interaction to feedback", async () => {
  const route = await readFile(new URL("../api/_feedback_endpoint.js", import.meta.url), "utf8");
  const interactionRead = route.slice(
    route.indexOf("async function interactionContext"),
    route.indexOf("export default async function handler")
  );
  assert.match(interactionRead, /id: `eq\.\$\{id\}`/);
  assert.match(interactionRead, /account_id: `eq\.\$\{accountId\}`/);
  assert.match(interactionRead, /selected\.role !== "assistant"/);
});

test("the app attaches a clear wrong-answer action to persisted assistant interactions", async () => {
  const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const ui = await readFile(new URL("../public/feedback.js", import.meta.url), "utf8");
  assert.match(chat, /interaction_id: assistantMessageId/);
  assert.match(app, /data\.interaction_id \|\| null/);
  assert.match(app, /const isUser = m\.role === "user"/);
  assert.match(app, /interactionId: isUser \? null : m\.id/);
  assert.match(ui, /button\.textContent = "That was wrong"/);
  assert.match(ui, /include_context: includeContext/);
  assert.match(ui, /consent: true/);
  assert.doesNotMatch(ui, /innerHTML/);
});

test("admin feedback views use random tester ids rather than returning login emails", async () => {
  const members = await readFile(new URL("../api/_members.js", import.meta.url), "utf8");
  const listBlock = members.slice(
    members.indexOf("export async function listFeedback"),
    members.indexOf("export async function markFeedback")
  );
  assert.match(listBlock, /account_id/);
  assert.doesNotMatch(listBlock, /select:\s*"\*"/);
  assert.doesNotMatch(listBlock, /f\.user_email/);
});

test("feedback UI explains consent and makes conversation context optional", async () => {
  const html = await readFile(new URL("../public/app.html", import.meta.url), "utf8");
  assert.match(html, /id="feedbackIncludeContext"/);
  assert.match(html, /id="feedbackConsent"/);
  assert.match(html, /Nothing from your conversation is included unless you explicitly choose it/);
  assert.match(html, /data-trust-rating="5"/);
});
