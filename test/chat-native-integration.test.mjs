import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("chat endpoint uses the native catalog and verified tool-result second pass", async () => {
  const source = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");

  assert.match(source, /BIGBRICEY_TOOLS/);
  assert.match(source, /validateNativeToolCall/);
  assert.match(source, /buildToolResultEnvelope/);
  assert.match(source, /buildNativeToolResultMessage/);
  assert.match(source, /callBuddyFirstPass/);
  assert.match(source, /callBuddyAfterTools/);
  assert.match(source, /classifyNativeToolExecution/);
  assert.match(source, /invalidNativeToolExecution/);
  assert.match(source, /selectVerifiedNativeToolReply/);
  assert.match(source, /verifiedToolResults/);
  assert.match(source, /buildAppInspection/);
  assert.match(source, /type === "inspect_app"/);
  assert.match(source, /trackers:\s*boxesSnap/);
  assert.match(source, /layout:\s*layoutSnap/);
  assert.match(source, /CONFIRMATION_ONLY_TOOLS/);
  assert.match(source, /allowToolCalls:\s*canContinueAfterRead/);
  assert.match(source, /followupEvaluation/);
  assert.match(
    source,
    /followupEvaluation\.tool_name === "remove_tracker"/
  );
  assert.match(source, /trackerRemovalConfirmationPrompt/);
  assert.doesNotMatch(source, /OUTPUT FORMAT:/);
  assert.doesNotMatch(source, /use JSON actions when changing the app/i);
});

test("chat endpoint reads ledger state through a native read action", async () => {
  const source = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  assert.match(source, /type === "read_today"/);
  assert.match(source, /buildCurrentLogContext\(next\)/);
  assert.match(source, /action\.day !== requestedDay/);
  assert.match(source, /if \(action\.food_text\)[\s\S]{0,180}else if \(amount != null\)/);
});
