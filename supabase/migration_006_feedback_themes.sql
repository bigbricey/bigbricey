-- Product feedback themes for clustering (admin review, not auto-build)
ALTER TABLE product_feedback
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS theme_key TEXT,
  ADD COLUMN IF NOT EXISTS theme_label TEXT;

CREATE INDEX IF NOT EXISTS product_feedback_theme_idx
  ON product_feedback (theme_key, created_at DESC)
  WHERE theme_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_feedback_category_idx
  ON product_feedback (category, created_at DESC)
  WHERE category IS NOT NULL;
