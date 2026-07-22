import { llmConfig } from "./_llm.js";
import { visionModels } from "./_vision.js";

export default function healthEndpoint(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const llm = llmConfig();
  const vision = visionModels();
  res.status(200).json({
    ok: true,
    openrouter: llm.ok,
    llm: { provider: llm.provider, model: llm.model, ok: llm.ok },
    model: llm.model,
    vision: {
      model: vision.primary,
      fallback_model: vision.fallback,
      ok: llm.ok,
    },
    app: "BigBricey",
    role: "fitness_data_ledger",
  });
}
