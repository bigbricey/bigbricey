import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { publicMemoryError, validateMemoryMutation } from "../api/memory.js";

const MEMORY_ID = "8d9b0195-9f4c-4d66-a9cc-83d868e2b8c2";

test("memory API accepts only explicit fact and preference mutations", () => {
  assert.deepEqual(
    validateMemoryMutation({ op: "create", kind: "preference", text: "  Be direct  " }),
    { op: "create", kind: "preference", text: "Be direct" }
  );
  assert.deepEqual(
    validateMemoryMutation({
      op: "update",
      memory_id: MEMORY_ID,
      kind: "fact",
      text: "Call me Brice",
    }),
    { op: "update", memory_id: MEMORY_ID, kind: "fact", text: "Call me Brice" }
  );
  assert.deepEqual(validateMemoryMutation({ op: "delete", memory_id: MEMORY_ID }), {
    op: "delete",
    memory_id: MEMORY_ID,
  });

  for (const body of [
    { op: "create", kind: "inference", text: "Probably hungry" },
    { op: "create", kind: "fact", text: "x".repeat(301) },
    { op: "delete", memory_id: "not-a-uuid" },
    { op: "update", memory_id: MEMORY_ID, kind: "fact", text: "ok", confidence: 0 },
    { op: "unknown", text: "hello" },
  ]) {
    assert.throws(() => validateMemoryMutation(body), /memory/i);
  }
});

test("memory route is authenticated, bounded, and never accepts client provenance or confidence", async () => {
  const source = await readFile(new URL("../api/memory.js", import.meta.url), "utf8");

  assert.match(source, /await requireUser\(req, res\)/);
  assert.match(source, /readBody\(req, \{ maxBytes:/);
  assert.match(source, /provenance:\s*"user_ui"/);
  assert.match(source, /listProfileMemories/);
  assert.match(source, /createProfileMemory/);
  assert.match(source, /updateProfileMemory/);
  assert.match(source, /deleteProfileMemory/);
  assert.doesNotMatch(source, /body\.(?:confidence|provenance)/);
});

test("memory conflicts distinguish duplicates from a full memory center", () => {
  assert.deepEqual(
    publicMemoryError({
      status: 409,
      code: "memory_limit_reached",
      message: "BigBricey can remember up to 40 permanent items.",
    }),
    {
      status: 409,
      body: {
        error: "memory_limit_reached",
        message: "BigBricey can remember up to 40 permanent items. Edit or forget one first.",
      },
    }
  );
  assert.equal(
    publicMemoryError({ status: 409, detail: { code: "23505" } }).body.error,
    "memory_already_exists"
  );
});
