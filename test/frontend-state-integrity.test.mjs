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

test("chat food receipts come only from newly committed ledger rows", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const sendStart = source.indexOf("async function onSend");
  const sendEnd = source.indexOf("function sortBy", sendStart);
  const sendBlock = source.slice(sendStart, sendEnd);
  const receiptStart = source.indexOf("function buildVerifiedLogReceipt");
  const receiptEnd = source.indexOf("function pulseVerifiedLogUpdate", receiptStart);
  const receiptBlock = source.slice(receiptStart, receiptEnd);

  assert.match(sendBlock, /data\.changed === true && data\.ledger_committed === true/);
  assert.match(sendBlock, /priorIds/);
  assert.match(sendBlock, /!priorIds\.has\(String\(row\.id\)\)/);
  assert.match(sendBlock, /sameDayContext[\s\S]{0,180}verifiedAddedRows/);
  assert.match(sendBlock, /buildVerifiedLogReceipt\(receiptRows, requestDay\)/);
  assert.match(sendBlock, /reply \|\| receipt/);
  assert.doesNotMatch(receiptBlock, /innerHTML/);
  assert.match(receiptBlock, /knownMetric\(row\?\.kcal\)/);
  assert.match(receiptBlock, /textContent/);
});

test("layout controls stay inert and hidden until Customize mode", async () => {
  const layout = await readFile(new URL("../public/layout.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/app.html", import.meta.url), "utf8");

  const pointerStart = layout.indexOf("function onPointerDown");
  const pointerEnd = layout.indexOf("function onPointerMove", pointerStart);
  assert.match(layout.slice(pointerStart, pointerEnd), /if \(!editMode\) return/);
  assert.match(styles, /body:not\(\.layout-editing\) \.layout-panel-chrome/);
  assert.match(html, /id="btnEditLayout">Customize</);
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

test("the You tab exposes transparent, safely rendered, account-bound memory controls", async () => {
  const html = await readFile(new URL("../public/app.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const privacy = await readFile(new URL("../public/privacy.html", import.meta.url), "utf8");

  assert.match(html, /id="memoryCenter"/);
  assert.match(html, /What BigBricey knows about me/);
  assert.match(html, /id="memoryForm"/);
  assert.match(html, /id="memoryStatus"[^>]+role="status"/);

  const renderStart = source.indexOf("function renderMemories");
  const renderEnd = source.indexOf("async function mutateMemory", renderStart);
  const renderBlock = source.slice(renderStart, renderEnd);
  assert.ok(renderStart > 0 && renderEnd > renderStart);
  assert.match(renderBlock, /replaceChildren/);
  assert.match(renderBlock, /textContent/);
  assert.doesNotMatch(renderBlock, /innerHTML/);
  assert.match(renderBlock, /memory\.id/);

  const loadStart = source.indexOf("async function loadMemories");
  const loadEnd = source.indexOf("function wireMemoryCenter", loadStart);
  const loadBlock = source.slice(loadStart, loadEnd);
  assert.match(loadBlock, /const requestAccount = storageAccount/);
  assert.match(loadBlock, /const requestEpoch = \+\+memoryRequestEpoch/);
  assert.match(loadBlock, /storageAccount !== requestAccount/);
  assert.match(loadBlock, /memoryRequestEpoch !== requestEpoch/);
  assert.match(loadBlock, /fetch\("\/api\/memory"/);

  const storageStart = source.indexOf("function configureAccountStorage");
  const storageEnd = source.indexOf("function conversationStorageKey", storageStart);
  const storageBlock = source.slice(storageStart, storageEnd);
  assert.match(storageBlock, /memoryRequestEpoch\s*\+=\s*1/);
  assert.match(storageBlock, /memoryRecords\s*=\s*\[\]/);
  assert.match(storageBlock, /memoryLoadedAccount\s*=\s*null/);

  assert.match(source, /op:\s*"delete",\s*memory_id:/);
  assert.match(privacy, /facts and preferences/i);
  assert.match(privacy, /where the memory came from/i);
});

test("the adaptive home companion reports only real app lifecycle states", async () => {
  const html = await readFile(new URL("../public/app.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="companionCore"/);
  assert.match(html, /id="companionStateLabel"/);
  assert.match(html, /id="companionStateDetail"/);
  assert.match(html, /home\.js/);
  assert.doesNotMatch(html, /data-panel=["']companion["']/);

  const renderStart = source.indexOf("function render()");
  const renderEnd = source.indexOf("function setText", renderStart);
  assert.match(source.slice(renderStart, renderEnd), /BBHome\?\.render/);

  const thinkingStart = source.indexOf("function setThinking");
  const thinkingEnd = source.indexOf("async function requireAuth", thinkingStart);
  assert.match(source.slice(thinkingStart, thinkingEnd), /BBHome\?\.set\(["']thinking["']/);

  const sendStart = source.indexOf("async function onSend");
  const sendEnd = source.indexOf("function sortBy", sendStart);
  const sendBlock = source.slice(sendStart, sendEnd);
  assert.match(sendBlock, /verifiedHomeItemCount = rows\.length/);
  assert.match(sendBlock, /data\.pending_confirmation\?\.token/);
  assert.match(sendBlock, /BBHome\?\.set\(["']reviewing["']/);
  assert.match(sendBlock, /let verifiedHomeItemCount = null/);
  assert.match(
    sendBlock,
    /if \(pendingToolConfirmation\)[\s\S]{0,220}else if \(verifiedHomeItemCount != null\)/
  );
  assert.ok(
    sendBlock.lastIndexOf('BBHome?.set("reviewing"') >
      sendBlock.lastIndexOf("render();"),
    "pending review must be applied after renders so it wins state precedence"
  );
  assert.match(sendBlock, /catch \(e\)[\s\S]{0,240}BBHome\?\.set\(["']error["']/);
});
