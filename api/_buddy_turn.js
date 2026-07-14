import { llmChat } from "./_llm.js";
import { safeAssistantReply } from "./_native_tool_loop.js";

export async function callBuddyFirstPass({
  llm = llmChat,
  systemPrompt,
  history = [],
  userText,
  tools = [],
} = {}) {
  const baseMessages = [
    { role: "system", content: String(systemPrompt || "") },
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: String(userText || "") },
  ];
  const output = await llm({
    temperature: 0.6,
    title: "BigBricey-Chat",
    messages: baseMessages,
    tools,
    toolChoice: "auto",
    parallelToolCalls: false,
    maxTokens: 900,
  });

  return {
    baseMessages,
    reply: safeAssistantReply(output?.content),
    toolCalls: Array.isArray(output?.toolCalls) ? output.toolCalls : [],
    output,
  };
}

export async function callBuddyAfterTools({
  llm = llmChat,
  baseMessages = [],
  assistantMessage,
  toolResultMessages = [],
  tools = [],
  fallbackReply = "",
} = {}) {
  const messages = [
    ...(Array.isArray(baseMessages) ? baseMessages : []),
    assistantMessage,
    ...(Array.isArray(toolResultMessages) ? toolResultMessages : []),
  ].filter(Boolean);
  const output = await llm({
    temperature: 0.6,
    title: "BigBricey-Chat-After-Tools",
    messages,
    tools,
    toolChoice: "none",
    parallelToolCalls: false,
    maxTokens: 700,
  });

  return {
    reply: safeAssistantReply(output?.content, fallbackReply),
    output,
  };
}
