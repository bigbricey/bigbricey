import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("cloud empty is authoritative and day writes carry a revision", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const loadStart = source.indexOf("async function loadFromCloud");
  const loadEnd = source.indexOf("function ensureUniqueIds", loadStart);
  const loadBlock = source.slice(loadStart, loadEnd);
  const syncStart = source.indexOf("async function syncCloud");
  const syncEnd = source.indexOf("/* watches */", syncStart);
  const syncBlock = source.slice(syncStart, syncEnd);

  assert.match(loadBlock, /cloudRows = ensureUniqueIds\(d\.rows\)/);
  assert.match(loadBlock, /rows = cloudRows/);
  assert.doesNotMatch(loadBlock, /if \(rows\.length\)[\s\S]{0,160}syncCloud/);
  assert.match(syncBlock, /expected_revision/);
  assert.match(syncBlock, /r\.status === 409/);
  assert.match(syncBlock, /loadFromCloud/);
});

test("chat responses are bound to their initiating account day and conversation", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function onSend");
  const end = source.indexOf("function sortBy", start);
  const block = source.slice(start, end);

  assert.match(block, /const requestAccount = storageAccount/);
  assert.match(block, /const requestDay = selectedDay/);
  assert.match(block, /const requestConversationId = conversationId/);
  assert.match(block, /sameDayContext\(requestAccount, requestDay, requestSelectionEpoch\)/);
  assert.match(block, /conversationEpoch === requestConversationEpoch/);
  assert.match(block, /saveLocalRows\(requestDay, committedRows, requestAccount\)/);
});

test("conversation navigation commits only the newest successful load", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const restoreStart = source.indexOf("async function restoreConversation");
  const historyStart = source.indexOf("async function loadConversationList", restoreStart);
  const wireStart = source.indexOf("function wireChatHistoryUi", historyStart);
  const sendStart = source.indexOf("async function onSend", wireStart);
  const restoreBlock = source.slice(restoreStart, historyStart);
  const historyBlock = source.slice(historyStart, wireStart);
  const newChatBlock = source.slice(wireStart, sendStart);

  assert.match(restoreBlock, /const requestLoadEpoch = \+\+conversationLoadEpoch/);
  assert.match(restoreBlock, /conversationLoadEpoch === requestLoadEpoch/);
  assert.match(historyBlock, /if \(!r2\.ok\) throw/);
  assert.ok(
    historyBlock.indexOf("await r2.json()") < historyBlock.indexOf("setConversationId(id)")
  );
  assert.match(historyBlock, /conversationLoadEpoch !== requestLoadEpoch/);
  assert.doesNotMatch(historyBlock, /setConversationId\(id\)[\s\S]{0,120}await fetch/);
  assert.ok(
    newChatBlock.indexOf("if (!r.ok || !d.conversation?.id) throw") <
      newChatBlock.indexOf("setConversationId(d.conversation.id)")
  );
  assert.ok(
    newChatBlock.indexOf("setConversationId(d.conversation.id)") <
      newChatBlock.indexOf("clearChatUi()")
  );
  assert.doesNotMatch(newChatBlock, /catch\s*\{[\s\S]{0,300}setConversationId\(null\)/);
});

test("tool cancellation is persisted through the server conversation", async () => {
  const browser = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  assert.match(browser, /op:\s*"cancel_tool"/);
  assert.match(server, /body\?\.op === "cancel_tool"/);
  assert.match(server, /appendMessage\(session\.email, conversationId, "assistant", reply\)/);
});

test("all local presentation preferences are account scoped", async () => {
  const html = await readFile(new URL("../public/app.html", import.meta.url), "utf8");
  assert.match(html, /account-storage\.js/);
  for (const file of ["theme.js", "layout.js", "scenes.js", "boxes.js"]) {
    const source = await readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
    assert.match(source, /BBAccountStorage\?\.key/);
    assert.match(source, /quarantineLegacyKey/);
  }
});

test("manual food buttons claim success only after a committed revision", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  const clearStart = source.indexOf("const clear = async () =>");
  const clearEnd = source.indexOf('document.getElementById("clearDay")', clearStart);
  const clearBlock = source.slice(clearStart, clearEnd);
  assert.ok(clearBlock.indexOf("await syncCloud") < clearBlock.indexOf("`Cleared ${day}.`"));
  assert.match(clearBlock, /previousRows/);

  const removeStart = source.indexOf("async function confirmDelete");
  const removeEnd = source.indexOf("async function addManualFood", removeStart);
  const removeBlock = source.slice(removeStart, removeEnd);
  assert.ok(removeBlock.indexOf("await syncCloud") < removeBlock.indexOf("`Removed:"));
  assert.match(removeBlock, /previousRows/);

  const manualStart = source.indexOf("async function addManualFood");
  const manualEnd = source.indexOf("function setRing", manualStart);
  const manualBlock = source.slice(manualStart, manualEnd);
  assert.ok(manualBlock.indexOf("await syncCloud") < manualBlock.indexOf("`Added manually:"));
  assert.doesNotMatch(manualBlock, /fiber:\s*0|magnesium:\s*0|sodium:\s*0/);
  assert.match(manualBlock, /Potassium is optional/);
});

test("custom charts never turn missing metric days into fake zero measurements", async () => {
  const source = await readFile(new URL("../public/boxes.js", import.meta.url), "utf8");
  const pointsStart = source.indexOf("function seriesPoints");
  const pointsEnd = source.indexOf("function drawLines", pointsStart);
  const pointsBlock = source.slice(pointsStart, pointsEnd);

  assert.match(pointsBlock, /return null/);
  assert.doesNotMatch(pointsBlock, /return row \? Number\(row\.total\) \|\| 0 : 0/);
  assert.match(source, /No recorded data in this range yet/);
  assert.match(source, /observedMin/);
  assert.match(source, /No recorded points yet[^\n]{0,100}start this chart/);
  assert.match(source, /role="img"[^\n]{0,100}aria-label/);
  assert.doesNotMatch(source, /function setBoxes\(list,/);
});
