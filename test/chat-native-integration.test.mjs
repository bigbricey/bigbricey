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
  assert.match(source, /continuationPlanForNativeReads/);
  assert.match(source, /selectNativeContinuation/);
  assert.match(source, /unresolvedContinuationReply/);
  assert.match(source, /allowedToolNames/);
  assert.match(source, /executeSavedFoodContinuation/);
  assert.match(source, /chat:\$\{requestId\}:saved_food_continuation/);
  assert.doesNotMatch(
    source,
    /chat:\$\{requestId\}:\$\{followupEvaluation\.tool_call_id\}/
  );
  assert.match(source, /allowedSavedFoodIds/);
  assert.match(source, /allowToolCalls:\s*continuationPlan\.allowedToolNames\.length\s*>\s*0/);
  assert.match(source, /followupEvaluation/);
  assert.match(
    source,
    /selectedContinuation\.kind === "tracker_removal"/
  );
  assert.match(source, /selectedContinuation\.kind === "saved_food_log"/);
  assert.match(source, /"chat_continuation_plan"/);
  assert.match(source, /purpose:\s*"chat_continuation_voice"/);
  assert.match(source, /allowToolCalls:\s*false/);
  assert.match(
    source,
    /catch\s*\{[\s\S]{0,300}unresolvedContinuationReply\(continuationPlan\)/
  );
  assert.match(source, /trackerRemovalConfirmationPrompt/);
  assert.doesNotMatch(source, /CONFIRMATION_ONLY_TOOLS/);
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
