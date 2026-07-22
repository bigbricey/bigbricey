import assert from "node:assert/strict";
import test from "node:test";

import {
  callBuddyAfterTools,
  callBuddyFirstPass,
  minimalFoodQuantityReply,
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

test("conversation without tools disables provider tool choice", async () => {
  const calls = [];
  await callBuddyFirstPass({
    llm: async (options) => {
      calls.push(options);
      return { content: "A medium one is much smaller than three-quarters of a pound.", toolCalls: [] };
    },
    systemPrompt: "system",
    history: [],
    userText: "How big is an average sweet potato?",
    tools: [],
  });

  assert.equal(calls[0].toolChoice, "none");
  assert.deepEqual(calls[0].tools, []);
});

test("a vague food report asks only for the missing amount", () => {
  const reply = minimalFoodQuantityReply({
    userText: "I'm having brisket.",
    routeMode: "write_ambiguous",
    toolCallCount: 0,
    reply: "How much, and how was it prepared?",
  });

  assert.equal(reply, "About how much brisket are you having?");
  assert.equal(
    minimalFoodQuantityReply({
      userText: "I had one pound of brisket.",
      routeMode: "write_explicit",
      toolCallCount: 0,
      reply: "I'll log it.",
    }),
    "I'll log it."
  );
  assert.equal(
    minimalFoodQuantityReply({
      userText: "I'm having brisket tomorrow.",
      routeMode: "write_ambiguous",
      toolCallCount: 0,
      reply: "Sounds good.",
    }),
    "Sounds good."
  );
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
  assert.deepEqual(result.toolCalls, []);
});

test("a successful read can continue the original request with confirmation-only tools", async () => {
  const calls = [];
  const followupCall = {
    id: "call_remove_tracker",
    type: "function",
    function: {
      name: "remove_tracker",
      arguments: '{"id":"c_weight_30d"}',
    },
  };
  const result = await callBuddyAfterTools({
    llm: async (options) => {
      calls.push(options);
      return { content: "", toolCalls: [followupCall] };
    },
    baseMessages: [{ role: "user", content: "What is this, and remove it?" }],
    assistantMessage: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_inspect",
          type: "function",
          function: { name: "inspect_app", arguments: "{}" },
        },
      ],
    },
    toolResultMessages: [
      {
        role: "tool",
        tool_call_id: "call_inspect",
        content: '{"status":"success"}',
      },
    ],
    tools,
    allowToolCalls: true,
    fallbackReply: "Inspected the app.",
  });

  assert.equal(calls[0].toolChoice, "auto");
  assert.deepEqual(result.toolCalls, [followupCall]);
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

test("a no-tools voice pass strips any provider tool calls it was not allowed to make", async () => {
  const result = await callBuddyAfterTools({
    llm: async () => ({
      content: "The verified change is saved.",
      toolCalls: [
        {
          id: "unexpected_call",
          type: "function",
          function: { name: "set_scene", arguments: '{"scene":"snow"}' },
        },
      ],
    }),
    baseMessages: [],
    assistantMessage: { role: "assistant", content: null, tool_calls: [] },
    toolResultMessages: [],
    tools: [],
    fallbackReply: "The verified change is saved.",
    allowToolCalls: false,
  });

  assert.deepEqual(result.toolCalls, []);
});
