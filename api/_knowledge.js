/**
 * Short static knowledge snippets for the coach system prompt.
 * Facts only — not medical advice. Not a full RAG corpus.
 */

export const METABOLIC_FACTS_KB = `KNOWLEDGE SNIPPETS (general education — not medical advice; not a prescription):
- Protein supports satiety and muscle retention; many active adults aim roughly 0.7–1g protein per lb goal body weight as a common training heuristic (individual needs vary).
- Refined starches/sugars often raise blood glucose/insulin more quickly than equal calories from protein or fat for many people; whole-food context matters.
- Ultra-processed junk can be low in potassium, magnesium, and protein vs whole foods at similar calories (e.g. cookies vs eggs/meat/vegetables).
- Common reference targets often cited in public guidance: potassium ~3400–4700 mg/day range by source, magnesium ~310–420 mg/day by age/sex — use as baselines for watches, not prescriptions.
- Very low calorie intakes long-term can impair hormones, recovery, and adherence; product floors exist for a reason.
- Vegan patterns: complete protein via variety (legumes, soy, seitan, grains); B12 typically needs fortified foods or supplements (general fact).
- Carnivore/animal-based: organ meats are micronutrient-dense; fiber is low if no plants — state as data if user asks.
- Never tell the user their labs mean a disease. Suggest discussing labs/symptoms with a clinician.`;

export function knowledgeForSystemPrompt() {
  return METABOLIC_FACTS_KB;
}
