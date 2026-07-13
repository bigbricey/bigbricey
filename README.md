# NutriTable (fitnessfixzone.com)

Living nutrition table — type food, get amounts, sort columns, day totals.

- **Live:** https://www.fitnessfixzone.com  
- **Parse model:** DeepSeek V4 Flash via OpenRouter  
- **Numbers:** USDA FoodData Central (+ custom HLTH Code)

## Local

```bash
cp .env.example .env   # OPENROUTER_API_KEY + OPENROUTER_MODEL
npm install
npm run dev            # http://127.0.0.1:3847
```

## Deploy (Vercel)

Env vars on Vercel project `fitnessfixzone`:

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL=deepseek/deepseek-v4-flash`

```bash
vercel --prod
```

## Phone app

Safari/Chrome → open site → **Add to Home Screen**.
