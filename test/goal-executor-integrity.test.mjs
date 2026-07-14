import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mineral-only native goal changes reach the goal updater and receipt", async () => {
  const source = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  const start = source.indexOf('type === "set_goals"');
  const end = source.indexOf('if (type === "add"', start);
  const block = source.slice(start, end);

  assert.match(block, /patch\.potassium != null/);
  assert.match(block, /patch\.magnesium != null/);
  assert.match(block, /K \$\{g\.potassium\}mg/);
  assert.match(block, /Mg \$\{g\.magnesium\}mg/);
  assert.match(block, /await updateUserGoals/);
});
