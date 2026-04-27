# Project Conventions — Do's & Don'ts

## Do's

### Coding
- Use TypeScript strict mode (`"strict": true` in tsconfig)
- Format coefficients to exactly 2 decimal places (`toFixed(2)`)
- Use `America/Toronto` timezone for all date strings via `Intl.DateTimeFormat`
- Wrap every external API call in try/catch
- Use native `fetch()` (Node.js 18+) for all HTTP requests
- Log all actions with timestamps via the `log()` helper

### Error Handling (from PDF spec)
- Each action fails independently — errors don't stop the pipeline
- If a data source fails, set corresponding coefficient to **0.0** and log warning
- If gold price from kitco.com fails, **skip the entire table update**
- If this is the first run (no yesterday forecast), use **null** and skip deviation
- Log all errors with timestamp and action number

### Data
- CSV columns exactly: `date,actual_gold_price,forecast,deviation`
- Date format: `YYYY-MM-DD`
- Append one row per day — never overwrite existing rows
- Store `today_forecast` in `agentone/data/last_forecast.json` after each run
- 24-hour price fallback: use previous close if market is closed at exact time

### Git
- Commit messages: imperative mood ("Add feature" not "Added feature")
- Never commit `.env`, `data/*.csv`, or `node_modules/`
- Run secret scan before every commit (enforced by hook)

## Don'ts

### Security
- NEVER hardcode API keys, tokens, or secrets in source code
- NEVER commit `.env` files
- NEVER store passwords or credentials in any tracked file
- NEVER disable the pre-commit secret detection hook

### Coding
- Do NOT silence exceptions without logging them — no empty `catch {}` blocks
- Do NOT scrape more than 20 URLs per run (PDF spec limit)
- Do NOT modify the CSV column names or order

### Architecture
- Do NOT skip Action 7 even though it overlaps with Action 6 — follow the PDF
- Do NOT add AI Michel features to V1 — that's a future iteration

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Files | snake_case | `gold_forecast_agent.ts` |
| Functions | camelCase | `fetchYahooQuote()` |
| Constants | UPPER_SNAKE | `TORONTO_TZ`, `CSV_PATH` |
| Types/Interfaces | PascalCase | `QuoteResult` |
| Test files | test_ prefix | `test_actions.ts` |
