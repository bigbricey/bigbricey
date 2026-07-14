import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolConfirmationToken,
  verifyToolConfirmationToken,
} from "../api/_tool_confirmation.js";

const secret = "test-secret-with-enough-entropy-for-signing";
const pending = {
  ok: true,
  status: "needs_confirmation",
  tool_call_id: "call_clear_123",
  tool_name: "clear_food_day",
  arguments: { day: "2026-07-13" },
  confirmation: { required: true, prompt: "Clear this food day?" },
};

test("confirmation token binds canonical tool arguments to one account", () => {
  const token = createToolConfirmationToken({
    email: "Brice@example.com",
    validatedCall: pending,
    secret,
    now: 1_000_000,
  });
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const call = verifyToolConfirmationToken(token, {
    email: "brice@example.com",
    secret,
    now: 1_000_001,
  });
  assert.deepEqual(call, {
    id: "call_clear_123",
    type: "function",
    function: {
      name: "clear_food_day",
      arguments: '{"day":"2026-07-13"}',
    },
  });

  assert.throws(
    () =>
      verifyToolConfirmationToken(token, {
        email: "someone-else@example.com",
        secret,
        now: 1_000_001,
      }),
    (error) => error?.code === "confirmation_account_mismatch"
  );
});

test("tampered and expired confirmation tokens fail closed", () => {
  const token = createToolConfirmationToken({
    email: "brice@example.com",
    validatedCall: pending,
    secret,
    now: 5_000,
    ttlMs: 60_000,
  });
  const tampered = `${token.slice(0, -2)}aa`;
  assert.throws(
    () =>
      verifyToolConfirmationToken(tampered, {
        email: "brice@example.com",
        secret,
        now: 5_001,
      }),
    (error) => error?.code === "invalid_confirmation"
  );
  assert.throws(
    () =>
      verifyToolConfirmationToken(token, {
        email: "brice@example.com",
        secret,
        now: 65_001,
      }),
    (error) => error?.code === "confirmation_expired"
  );
});

test("only confirmation-gated validated calls can be signed", () => {
  assert.throws(
    () =>
      createToolConfirmationToken({
        email: "brice@example.com",
        validatedCall: { ...pending, status: "ready" },
        secret,
      }),
    (error) => error?.code === "confirmation_not_required"
  );
  assert.throws(
    () =>
      createToolConfirmationToken({
        email: "brice@example.com",
        validatedCall: pending,
        secret: "",
      }),
    (error) => error?.code === "confirmation_secret_missing"
  );
});
