import assert from "node:assert/strict";
import test from "node:test";

import { llmChat, usageForMetering } from "../api/_llm.js";

test("usage metering records a provider hit even when token counts are omitted", () => {
  assert.deepEqual(usageForMetering(), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 1,
    cost_usd: null,
  });
  assert.deepEqual(
    usageForMetering({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      cost_usd: 0.002,
    }),
    {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      cost_usd: 0.002,
    }
  );
  assert.deepEqual(
    usageForMetering({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 1,
      cost_usd: null,
    }),
    {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      cost_usd: null,
    }
  );
});

test("llmChat forwards native tools and returns the complete assistant message", async () => {
  const priorFetch = globalThis.fetch;
  const priorKey = process.env.OPENROUTER_API_KEY;
  const priorModel = process.env.OPENROUTER_MODEL;
  let requestBody = null;

  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "z-ai/glm-5.2";
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          model: "z-ai/glm-5.2",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "get_today_summary",
                      arguments: "{}",
                      provider_only: true,
                    },
                    provider_only: true,
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        };
      },
    };
  };

  try {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_today_summary",
          description: "Read today's recorded nutrition totals.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
    ];
    const out = await llmChat({
      messages: [{ role: "user", content: "How much fiber today?" }],
      tools,
      toolChoice: "auto",
      parallelToolCalls: false,
      maxTokens: 900,
    });

    assert.deepEqual(requestBody.tools, tools);
    assert.equal(requestBody.tool_choice, "auto");
    assert.equal(requestBody.parallel_tool_calls, false);
    assert.equal(requestBody.max_tokens, 900);
    assert.equal(out.content, "");
    assert.deepEqual(out.toolCalls, out.message.tool_calls);
    assert.deepEqual(out.toolCalls, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "get_today_summary",
          arguments: "{}",
        },
      },
    ]);
    assert.equal(out.message.role, "assistant");
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
    if (priorModel == null) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = priorModel;
  }
});

test("llmChat forwards tool-result messages for the verified final-answer pass", async () => {
  const priorFetch = globalThis.fetch;
  const priorKey = process.env.OPENROUTER_API_KEY;
  let requestBody = null;

  process.env.OPENROUTER_API_KEY = "test-key";
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: "You recorded 54 grams of fiber today.",
              },
            },
          ],
        };
      },
    };
  };

  const messages = [
    { role: "user", content: "How much fiber today?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_today_summary", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      name: "get_today_summary",
      content: JSON.stringify({ status: "success", fiber: 54 }),
    },
  ];

  try {
    const out = await llmChat({ messages, toolChoice: "none", maxTokens: 500 });
    assert.deepEqual(requestBody.messages, messages);
    assert.equal(requestBody.tool_choice, "none");
    assert.equal(out.content, "You recorded 54 grams of fiber today.");
    assert.deepEqual(out.toolCalls, []);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
  }
});

test("llmChat can route a vision request to a model without changing the chat model", async () => {
  const priorFetch = globalThis.fetch;
  const priorKey = process.env.OPENROUTER_API_KEY;
  const priorModel = process.env.OPENROUTER_MODEL;
  let requestBody = null;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "z-ai/glm-5.2";
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          model: requestBody.model,
          choices: [{ message: { role: "assistant", content: "{}" } }],
        };
      },
    };
  };
  try {
    await llmChat({
      model: "google/gemini-3.1-flash-lite",
      messages: [{ role: "user", content: "look" }],
    });
    assert.equal(requestBody.model, "google/gemini-3.1-flash-lite");
    assert.equal(process.env.OPENROUTER_MODEL, "z-ai/glm-5.2");
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
    if (priorModel == null) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = priorModel;
  }
});
