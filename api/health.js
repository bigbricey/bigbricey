import { llmConfig } from "./_llm.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const llm = llmConfig();
  res.status(200).json({
    ok: true,
    openrouter: llm.ok,
    llm: { provider: llm.provider, model: llm.model, ok: llm.ok },
    model: llm.model,
    app: "BigBricey",
    role: "fitness_data_ledger",
  });
}
