import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_CATALOG,
  abilitiesReplyText,
  capabilitiesForSystemPrompt,
} from "../api/_capabilities.js";
import { DOMAIN_CONTRACT } from "../api/_llm.js";

const unsupportedClaims = /custom (?:box|tracker)|chart|graph|export|watch(?:es)?|feedback|backlog/i;

test("system and user capability copy claim only supported product abilities", () => {
  const systemCopy = `${DOMAIN_CONTRACT}\n${capabilitiesForSystemPrompt()}`;
  const userCopy = abilitiesReplyText();

  for (const copy of [systemCopy, userCopy]) {
    assert.doesNotMatch(copy, unsupportedClaims);
    assert.match(copy, /talk|conversation|normal question/i);
    assert.match(copy, /food/i);
    assert.match(copy, /saved food/i);
    assert.match(copy, /ongoing[^\n]{0,80}goal|goal[^\n]{0,80}ongoing/i);
    assert.match(copy, /workout/i);
    assert.match(copy, /steps/i);
    assert.match(copy, /metric/i);
    assert.match(copy, /theme|color/i);
    assert.match(copy, /scene/i);
    assert.match(copy, /layout/i);
    assert.match(copy, /memory|remember/i);
    assert.match(copy, /chat history/i);
  }
});

test("catalog distinguishes native actions from UI-only chat history", () => {
  const ids = CAPABILITY_CATALOG.map((item) => item.id);
  assert.deepEqual(ids, [
    "normal_chat",
    "food_log",
    "saved_foods",
    "goals",
    "activity",
    "layout",
    "theme",
    "scenes",
    "memory",
    "chat_history",
  ]);

  const history = CAPABILITY_CATALOG.find((item) => item.id === "chat_history");
  const normalChat = CAPABILITY_CATALOG.find((item) => item.id === "normal_chat");
  assert.equal(normalChat?.kind, "conversation");
  assert.equal(history?.kind, "ui");
  assert.doesNotMatch(capabilitiesForSystemPrompt(), /chat_history:[^\n]*(?:tool|action)/i);
});

test("ongoing goals are not advertised as per-day overrides", () => {
  const copy = `${DOMAIN_CONTRACT}\n${capabilitiesForSystemPrompt()}\n${abilitiesReplyText()}`;
  assert.match(copy, /ongoing[^\n]{0,80}(?:goal|target)|(?:goal|target)[^\n]{0,80}ongoing/i);
  assert.doesNotMatch(copy, /goals?[^\n]{0,100}(?:any day|today[- ]only|today)|(?:any day|today[- ]only)[^\n]{0,100}goals?/i);
});
