import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("read_today fails closed when requested private state is unavailable", async () => {
  const source = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  const start = source.indexOf('if (type === "read_today")');
  const end = source.indexOf('if (\n        type === "remember"', start);
  const block = source.slice(start, end);

  assert.match(block, /readFailures/);
  assert.match(block, /authoritativeRowsLoaded/);
  assert.match(block, /Couldn't read the requested private app data/);
  assert.match(block, /layoutOut \?\? layoutSnap/);
  assert.match(block, /boundedLedgerToolRead/);
  assert.match(block, /limit:\s*"101"/);
  assert.match(block, /slice\(0, 40\)/);
  assert.doesNotMatch(block, /catch \{\s*readRows = \[\];\s*\}/);
});

test("read tool results stay bounded and are not duplicated into the voice pass", async () => {
  const source = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /evaluation\.tool_name\.includes\("food"\)\s*\|\|\s*evaluation\.tool_name === "read_today"/
  );
  assert.match(source, /food_omitted_count/);
  assert.match(source, /Math\.min\(\s*50,[\s\S]{0,120}Number\(action\.limit\)/);
});

test("any invalid native call rejects the whole proposed tool batch", async () => {
  const source = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  assert.match(source, /const allCallsValid = evaluations\.every/);
  assert.match(source, /allCallsValid\s*\?\s*valid/);
  assert.match(source, /I couldn't safely use that app action\. Nothing changed\./);
});
