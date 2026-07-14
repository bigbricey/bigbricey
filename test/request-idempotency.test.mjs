import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("browser gives each chat request a transport idempotency key", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function onSend()");
  const end = source.indexOf("function setThinking", start);
  const block = source.slice(start, end > start ? end : start + 9000);

  assert.match(block, /const requestId = newId\(\)/);
  assert.match(block, /request_id:\s*requestId/g);
});

test("server binds native writes to its request id instead of a model-picked id", async () => {
  const source = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  assert.match(source, /normalizeClientRequestId\(body\?\.request_id\)/);
  assert.match(source, /__request_id:/);
  assert.match(source, /resolved\.row\.id = action\.__request_id/);
  assert.match(source, /clientId:\s*action\.__request_id/);
});

test("direct food fallback commits before claiming the ledger changed", async () => {
  const source = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  const start = source.indexOf("async function doAdd(");
  const end = source.indexOf("const ABILITIES_REPLY", start);
  const block = source.slice(start, end);

  assert.match(block, /await syncFoodDay\(/);
  assert.match(block, /ledger_committed:\s*true/);
  assert.match(block, /could not be safely saved/i);
});
