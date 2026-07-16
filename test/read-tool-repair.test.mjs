import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateProviderToolCalls,
  repairInvalidReadTurn,
  shouldRepairInvalidReadCalls,
} from "../api/_read_tool_repair.js";

function call(name, args, id = `call_${name}`) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

test("only malformed known read calls qualify for one safe repair pass", () => {
  const malformedRead = evaluateProviderToolCalls([
    call("inspect_app", {
      focus: "Weight card",
      allow_removal: false,
      invented_field: true,
    }),
  ]);
  assert.equal(shouldRepairInvalidReadCalls(malformedRead), true);

  const malformedMutation = evaluateProviderToolCalls([
    call("remove_tracker", { id: "not-a-tracker-id" }),
  ]);
  assert.equal(shouldRepairInvalidReadCalls(malformedMutation), false);

  const unknown = evaluateProviderToolCalls([call("read_anything", {})]);
  assert.equal(shouldRepairInvalidReadCalls(unknown), false);
});

test("repair exposes read-only tools and accepts one fully valid retry", async () => {
  const initial = evaluateProviderToolCalls([
    call("inspect_app", {
      focus: "Weight card",
      allow_removal: false,
      invented_field: true,
    }),
  ]);
  let attempts = 0;
  const result = await repairInvalidReadTurn({
    evaluations: initial,
    runTurn: async ({ tools }) => {
      attempts += 1;
      assert.deepEqual(
        tools.map((tool) => tool.function.name),
        ["inspect_app"]
      );
      return {
        reply: "",
        toolCalls: [
          call("inspect_app", {
            focus: "Weight card",
            allow_removal: false,
          }),
        ],
      };
    },
  });

  assert.equal(attempts, 1);
  assert.equal(result.attempted, true);
  assert.equal(result.repaired, true);
  assert.equal(result.evaluations[0].ok, true);
});

test("repair never accepts prose-only or another malformed retry", async () => {
  const initial = evaluateProviderToolCalls([
    call("read_today", { include: ["made_up_section"] }),
  ]);
  const proseOnly = await repairInvalidReadTurn({
    evaluations: initial,
    runTurn: async () => ({ reply: "I think it says 215.", toolCalls: [] }),
  });
  assert.equal(proseOnly.attempted, true);
  assert.equal(proseOnly.repaired, false);
  assert.deepEqual(proseOnly.evaluations, initial);

  let mutationToolNames = [];
  const mutation = evaluateProviderToolCalls([
    call("set_tracker", { kind: "chart", title: "Weight" }),
  ]);
  const notAttempted = await repairInvalidReadTurn({
    evaluations: mutation,
    runTurn: async ({ tools }) => {
      mutationToolNames = tools.map((tool) => tool.function.name);
      return { reply: "", toolCalls: [] };
    },
  });
  assert.equal(notAttempted.attempted, false);
  assert.deepEqual(mutationToolNames, []);
});

test("repair cannot switch a malformed read into a different read tool", async () => {
  const initial = evaluateProviderToolCalls([
    call("inspect_app", {
      focus: "Weight card",
      allow_removal: false,
      invented_field: true,
    }),
  ]);
  const switched = await repairInvalidReadTurn({
    evaluations: initial,
    runTurn: async ({ tools }) => {
      assert.deepEqual(
        tools.map((tool) => tool.function.name),
        ["inspect_app"]
      );
      return {
        reply: "",
        toolCalls: [call("read_today", { include: ["home"] })],
      };
    },
  });

  assert.equal(switched.attempted, true);
  assert.equal(switched.repaired, false);
  assert.deepEqual(switched.evaluations, initial);
});
