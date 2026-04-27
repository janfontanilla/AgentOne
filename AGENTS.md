# HappyNutrition — Gold Forecast Daily AI Agent V1

## Project
Daily AI agent that runs at 10:00 AM Toronto time (America/Toronto, handles DST).
Scrapes gold sentiment, calculates 3 financial coefficients, forecasts gold price movement,
and tracks accuracy in a persistent CSV table.

Supervisor: Olga Grass (AI SYNT). Follow the Gold Forecast PDF spec exactly.
Future iterations will expand into AI Michel (3-agent neurotropic architecture).

## Tech Stack
- TypeScript (standalone, runs via `npx tsx`)
- Node.js 18+ (native fetch, no external HTTP library)
- Groq API with Llama 3.3 70B (news synthesis)
- Yahoo Finance HTTP API (stocks, forex, ETFs — free, no API key)
- HTML stripping for readability extraction (no external library)
- Local CSV + JSON file I/O for persistence

## Architecture
Single-file agent: `agentone/gold_forecast_agent.ts` (~518 lines)
7-action sequential pipeline. See @PLANNING.md for full details.

1. News Analysis → Google search + page scraping + Groq Llama 3.3 70B ≤25-word synthesis
2. Mining Stocks → NEM + GOLD 24h % change → Coefficient #1
3. Forex Rate → AUD/USD 24h % change → Coefficient #2
4. Silver Price → SLV 24h % change → Coefficient #3
5. Display → Article text + average(C1, C2, C3) formatted to 2 decimals + save forecast
6. Build Table Row → Actual gold price (kitco, Yahoo fallback) + yesterday's forecast → CSV
7. Update Deviation → deviation = actual - forecast → update CSV row

## Key Rules
- IMPORTANT: Follow supervisor's PDF instructions exactly — do not deviate
- Coefficients that fail to fetch default to 0.0 (not skipped)
- If gold price from kitco fails, skip table update entirely
- Store today's forecast in `agentone/data/last_forecast.json` for next day's run
- First run: use null for yesterday's forecast, skip deviation
- CSV columns exactly: `date,actual_gold_price,forecast,deviation`
- All timestamps in Toronto local time
- 24h price fallback: use previous close if market is closed

## Conventions
See @CONVENTIONS.md for full coding standards.
- camelCase functions, PascalCase types, UPPER_SNAKE constants
- TypeScript strict mode enabled
- console.log with timestamp prefix for all output
- Each action is independent — wrapped in try/catch

## Commands
- `/run-forecast` — trigger full pipeline manually
- `/view-history` — display forecast history table
- `/check-coefficients` — fetch current C1/C2/C3

## Build & Run
```bash
cd agentone
npm install            # Install @types/node
npx tsx gold_forecast_agent.ts   # Run full pipeline once
```

## Security
- API keys in `agentone/.env` only — NEVER hardcode
- PreCommit hook scans for secrets before git commits
- Never scrape more than 20 URLs per run
- Respect rate limits on all external APIs
