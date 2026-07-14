import assert from "node:assert/strict";
import test from "node:test";

import {
  callBuddyAfterTools,
  callBuddyFirstPass,
} from "../api/_buddy_turn.js";

const tools = [
  {
    type: "function",
    function: {
      name: "set_scene",
      description: "Set scene",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

test("ordinary conversation is one native model call with bounded history", async () => {
  const calls = [];
  const llm = async (options) => {
    calls.push(options);
    return { content: "Yeah, I'm here.", toolCalls: [], usage: { total_tokens: 10 } };
  };

  const result = await callBuddyFirstPass({
    llm,
    systemPrompt: "system",
    history: [{ role: "assistant", content: "Earlier" }],
    userText: "Are you there?",
    tools,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolChoice, "auto");
  assert.equal(calls[0].parallelToolCalls, false);
  assert.deepEqual(calls[0].tools, tools);
  assert.deepEqual(calls[0].messages, [
    { role: "system", content: "system" },
    { role: "assistant", content: "Earlier" },
    { role: "user", content: "Are you there?" },
  ]);
  assert.equal(result.reply, "Yeah, I'm here.");
  assert.deepEqual(result.toolCalls, []);
});

test("tool completion performs a verified second pass with tool choice disabled", async () => {
  const calls = [];
  const llm = async (options) => {
    calls.push(options);
    return { content: "Done — aurora is on.", toolCalls: [] };
  };
  const baseMessages = [
    { role: "system", content: "system" },
    { role: "user", content: "Make it aurora" },
  ];
  const assistantMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_scene",
        type: "function",
        function: { name: "set_scene", arguments: '{"scene":"aurora"}' },
      },
    ],
  };
  const toolResultMessages = [
    {
      role: "tool",
      tool_call_id: "call_scene",
      content: '{"status":"success","changed":true}',
    },
  ];

  const result = await callBuddyAfterTools({
    llm,
    baseMessages,
    assistantMessage,
    toolResultMessages,
    tools,
    fallbackReply: "Scene set to aurora.",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolChoice, "none");
  assert.equal(calls[0].parallelToolCalls, false);
  assert.deepEqual(calls[0].messages, [
    ...baseMessages,
    assistantMessage,
    ...toolResultMessages,
  ]);
  assert.equal(result.reply, "Done — aurora is on.");
});

test("empty second-pass text falls back only to verified executor wording", async () => {
  const result = await callBuddyAfterTools({
    llm: async () => ({ content: "", toolCalls: [] }),
    baseMessages: [],
    assistantMessage: { role: "assistant", content: null, tool_calls: [] },
    toolResultMessages: [],
    tools,
    fallbackReply: "Saved the verified change.",
  });
  assert.equal(result.reply, "Saved the verified change.");
});
