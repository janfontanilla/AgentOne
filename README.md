# Gold Forecast Daily AI Agent V1

**Project:** AI Michel - Gold Forecast Agent (V1 Prototype)
**Student:** Jan Fontanilla
**Organization:** AI SYNT (Canada)
**Supervisor:** Architecture Implementation Manager Olga Grass
**Date:** March 2026

**Live Dashboard:** [https://agentone-theta.vercel.app](https://agentone-theta.vercel.app)
**GitHub Repository:** [https://github.com/janfontanilla/AgentOne](https://github.com/janfontanilla/AgentOne)

---

A fully automated AI agent that forecasts gold price movement by analyzing news sentiment,
mining stock performance, forex rates, and silver prices. Runs daily at **10:00 AM Toronto time**
with automatic DST handling. Deployed to the cloud via **Vercel** with a live web dashboard
featuring an Actual vs Predicted chart and per-day analysis history.

This agent is the V1 prototype for the larger AI Michel project — a three-level neurotropic
architecture AI system for predictive financial modeling.

---

## Table of Contents

1. [Live Demo](#live-demo)
2. [Prerequisites](#prerequisites)
3. [Installation & Setup](#installation--setup)
4. [How It Works](#how-it-works)
5. [Pipeline Actions (PDF Spec)](#pipeline-actions-pdf-spec)
6. [Dashboard Features](#dashboard-features)
7. [Data Sources & APIs](#data-sources--apis)
8. [Formulas & Calculations](#formulas--calculations)
9. [Self-Learning / Adaptive Weighting](#self-learning--adaptive-weighting)
10. [Output Format](#output-format)
11. [Error Handling](#error-handling)
12. [Deployment](#deployment)
13. [Testing](#testing)
14. [Project Structure](#project-structure)
15. [Tech Stack](#tech-stack)
16. [Configuration](#configuration)

---

## Live Demo

The agent is deployed and running automatically every day:

- **Dashboard:** [https://agentone-theta.vercel.app](https://agentone-theta.vercel.app) — view today's gold price, tomorrow's prediction, accuracy tracking, chart, and daily analysis
- **API (forecast history):** [https://agentone-theta.vercel.app/api/history](https://agentone-theta.vercel.app/api/history) — JSON endpoint returning all forecast data
- **Cron trigger:** Runs automatically at 10:00 AM Toronto time (14:00 UTC) every day

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | 18 or higher | Required for native `fetch()` support |
| **npm** | 9 or higher | Comes with Node.js |
| **Groq API Key** | Free tier | Get one at [console.groq.com](https://console.groq.com/) |

Optional (for cloud deployment):
| Requirement | Notes |
|-------------|-------|
| **Vercel account** | Free Hobby tier is sufficient |
| **Vercel CLI** | Install with `npm i -g vercel` |

---

## Installation & Setup

### Step 1: Clone the Repository

```bash
git clone https://github.com/janfontanilla/AgentOne.git
cd AgentOne
```

### Step 2: Install Dependencies

```bash
npm install
```

This installs:
- `@vercel/blob` — cloud storage for Vercel deployment
- `@vercel/node` — serverless function types (dev dependency)
- `@types/node` — TypeScript type definitions (dev dependency)

### Step 3: Configure Environment (API Key Setup)

The agent needs a `.env` file containing the API key. There are two ways to set this up:

**Option A — If you received a `.env` file by email:**

Simply place the `.env` file you received into the `AgentOne/` project folder (the same folder as `package.json`). That's it — skip to Step 4.

**Option B — Create the `.env` file yourself:**

1. In the `AgentOne/` project folder, create a new file called `.env` (no file extension, just `.env`)
   - **On Windows:** Open Notepad, paste the content below, then go to File > Save As. Change "Save as type" to "All Files", type `.env` as the filename, and save it in the AgentOne folder.
   - **On Mac/Linux:** Run `cp .env.example .env` in the terminal, then edit the file.
2. The `.env` file should contain this single line (replace with your real key):
   ```
   GROQ_API_KEY=your_groq_api_key_here
   ```
3. Get a free API key at [https://console.groq.com/](https://console.groq.com/) if you don't have one.

> **Note:** The `.env` file contains secret API keys and is intentionally excluded from GitHub. It must be created locally.

### Step 4: Run the Agent (Local)

```bash
npx tsx gold_forecast_agent.ts
```

This executes the full 7-action pipeline once and outputs results to the console. Data is saved locally in the `data/` directory.

### Step 5: Run Tests

```bash
# Unit tests (no API calls, fast)
npm test

# Full integration test (requires GROQ_API_KEY, ~15 seconds)
npm run test:long
```

---

## How It Works

Every day at 10:00 AM Toronto time, the agent executes a **7-action sequential pipeline**:

1. Scrapes up to 20 gold-related web pages and synthesizes a short article using Llama 3.3 70B via Groq
2. Calculates three financial coefficients from mining stocks, forex, and silver
3. Averages the coefficients to produce a forecast percentage
4. Converts the percentage into a dollar prediction for tomorrow's gold price
5. Compares today's actual gold price against yesterday's prediction
6. Tracks accuracy over time in a persistent CSV table updated daily

The forecast formula:
```
predicted_price = today_actual_gold_price * (1 + average_coefficient / 100)
```

---

## Pipeline Actions (PDF Spec)

### Action 1 — News Analysis & Short Article

- **Search:** Queries Google for "gold price tomorrow" to collect up to 20 URLs
- **Fallback sources:** DuckDuckGo API, known gold news sites (kitco, reuters, bloomberg, etc.), Yahoo Finance RSS
- **Extract:** Fetches each page and strips HTML to extract relevant text
- **Synthesize:** Sends extracted text to **Groq API (Llama 3.3 70B)** with instructions to produce a short article answering "What will happen to the gold price in the near future?" in **no more than 25 words**
- **Output:** Article text stored for display in Action 5 and saved to analysis history

### Action 2 — Gold Mining Stocks (Coefficient #1)

- **Symbols:** Newmont Corp (NEM) and Barrick Gold Corp (GOLD)
- **Data:** Fetches current price and price 24 hours ago via Yahoo Finance HTTP API
- **Calculation:** Average of the two stocks' percentage changes
- **Fallback:** If either stock fetch fails, that stock's change defaults to 0.0%
- **Output:** `C1 = (NEM% + GOLD%) / 2`

### Action 3 — AUD/USD Exchange Rate (Coefficient #2)

- **Pair:** Australian Dollar / US Dollar (AUDUSD=X)
- **Data:** Fetches current rate and rate 24 hours ago
- **Fallback:** Defaults to 0.0% on failure
- **Output:** `C2 = AUD/USD percentage change`

### Action 4 — Silver Price (Coefficient #3)

- **Symbol:** iShares Silver Trust (SLV)
- **Data:** Fetches current price and price 24 hours ago
- **Fallback:** Defaults to 0.0% on failure
- **Output:** `C3 = SLV percentage change`

### Action 5 — Display Forecast & Save Analysis

- **Output format** (exact match to PDF spec):
  ```
  Result of Action #1: [article_text]
  Forecast coefficient (average of C1, C2, C3): X.XX
  ```
- **Stores** `today_forecast` in `last_forecast.json` for next day's comparison
- **Saves** daily analysis entry (article + C1, C2, C3) to `analysis_history.json`
- The percentage forecast is converted to a **dollar prediction** after Action 6 fetches the actual gold price:
  ```
  dollar_forecast = actual_gold_price * (1 + average_coefficient / 100)
  ```

### Action 6 — Build Today's Table Row

- **Gold price source:** kitco.com (spot price, USD per troy ounce)
- **Fallback:** Yahoo Finance GC=F (gold futures)
- **Validation:** Price must be between $1,000 and $10,000
- **Yesterday's forecast:** Loaded from `last_forecast.json`
- **First run:** Forecast and deviation columns are left empty
- **Appends** one row to `gold_forecast_history.csv`
- **Critical rule:** If gold price fetch fails, **skip Action 6 AND Action 7 entirely**

### Action 7 — Update Deviation

- **Formula:** `Deviation = Actual Gold Price - Yesterday's Forecast`
- **Updates** the last row with the calculated deviation
- **Skipped** if this is the first run or if the gold price was unavailable

---

## Dashboard Features

The live web dashboard at the root URL provides:

### Summary Cards
- **Today's Gold Price** — current spot price from kitco.com
- **Our Prediction for Tomorrow** — the dollar forecast based on today's coefficients
- **How Close Were We?** — deviation between today's actual price and yesterday's prediction

### News Analysis
- AI-generated summary from 20 scraped gold news sources (Llama 3.3 70B)
- Lists all three data sources used: Mining Stocks (NEM + GOLD), Forex (AUD/USD), Silver (SLV)

### Actual vs Predicted Chart
- Line chart (Chart.js) with gold line for actual prices and blue dashed line for predictions
- Visual comparison of forecast accuracy over time

### Prediction History Table
- Full history of daily forecasts with date, actual price, predicted price, and deviation
- Click any row to expand and see that day's AI news summary and individual coefficient values (C1, C2, C3)
- Today's row is highlighted

---

## Data Sources & APIs

| Source | Used For | Auth Required |
|--------|----------|---------------|
| Google Search | Top 20 URLs for "gold price tomorrow" | No (may CAPTCHA) |
| DuckDuckGo JSON API | Fallback URL collection | No |
| Known gold sites (kitco, reuters, etc.) | Reliable URL supplements | No |
| Yahoo Finance RSS | Additional gold news URLs | No |
| Groq API (Llama 3.3 70B) | Article synthesis (25 words max) | Yes (`GROQ_API_KEY`) |
| Yahoo Finance HTTP API | NEM, GOLD, AUDUSD=X, SLV prices | No |
| kitco.com | Actual gold spot price (USD/oz) | No |
| Yahoo Finance GC=F | Gold price fallback (futures) | No |

**Yahoo Finance endpoint:**
```
https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d
```
The 5-day range ensures enough data points for 24-hour comparisons, including weekends and holidays.

---

## Formulas & Calculations

### Percentage Change (per PDF spec)
```
pct_change = ((current_price - price_24h_ago) / price_24h_ago) * 100
```

### Coefficients
```
C1 = (NEM_pct + GOLD_pct) / 2        # Mining stocks average
C2 = AUDUSD_pct                       # Forex rate
C3 = SLV_pct                          # Silver ETF
```

### Forecast
```
average_coefficient = (C1 + C2 + C3) / 3       # Formatted to 2 decimal places
dollar_forecast = actual_gold_price * (1 + average_coefficient / 100)
```

### Deviation
```
deviation = actual_gold_price - yesterday_dollar_forecast
```

### 24-Hour Price Fallback
If 24-hour data is not available at the exact time (weekends, holidays, pre-market):
- Use the **previous close** as the closest available market price
- The 5-day Yahoo Finance range ensures sufficient historical data

---

## Self-Learning / Adaptive Weighting

The agent self-learns which indicators have been most predictive lately and weights tomorrow's forecast accordingly. This implements the upgrade spec's "Adaptive Weighting via Historical Accuracy" mechanism.

### How it works

Each day, after fetching today's actual gold price change (close-to-close on `GC=F`), the agent scores **yesterday's** six indicator predictions:

- **Direct group** — `D1` Mining stocks, `D2` AUD/USD, `D3` Silver
- **Reversal group** — `R1` US Equities, `R2` Dollar Index, `R3` Bond Yields (values negated to express gold direction)

Within each group of three, the indicator closest to the actual change earns **+10**, the runner-up **+5**, the worst **0**. Ties split the points evenly. Bonuses accumulate over a rolling **10-day window**. Tomorrow's forecast then weights each indicator by:

```
weight_i = 100 + cumulative_bonus_i
```

so an indicator that has been consistently right gets up to ~30% more pull than its peers.

### Where state lives

Both keys are stored in Upstash Redis (production) and reset to empty on first run:

| Redis key | Contents |
|-----------|----------|
| `adaptive_state.json` | Rolling 10-day FIFO window of `{date, actualChangePct, preds, errors, bonuses}` |
| `gold_forecast_accuracy.csv` | Audit log: one row per day, columns per upgrade spec §3.5 (`pred_direct_*`, `pred_reversal_*_converted`, `err_*`, `bonus_*`, `cum_*`) |

If the audit CSV's header drifts from the spec (e.g. after a column-rename rollout), the file is automatically archived to `gold_forecast_accuracy_legacy.csv` and a fresh file is started.

### How to inspect

- **Dashboard** — the Net Signal panel now uses adaptive weights when ≥1 day of history exists, and shows a per-indicator weights breakdown beneath the signal pills.
- **API** — `GET /api/history` returns an `adaptive` object alongside the rows: `{ cumBonuses, weights, historyDays }`.
- **Audit CSV** — pull `gold_forecast_accuracy.csv` from Redis for the full per-day score trail.

### Daily run

The same Vercel cron (`0 14 * * *`, 10:00 AM Toronto) runs both halves: it scores yesterday's predictions against today's actual price first, *then* generates today's new forecast using the freshly updated weights. No second cron is needed.

---

## Output Format

### Console Log (matches PDF spec)
```
2026-03-30, 10:00:05 === Gold Forecast Daily — 2026-03-30 ===
2026-03-30, 10:00:05 Action 1: Fetching gold price news and synthesizing article...
2026-03-30, 10:00:10 Article: Gold prices may rise amid trade war tensions and safe-haven demand...
2026-03-30, 10:00:10 Action 2: Fetching NEM and GOLD stock prices...
2026-03-30, 10:00:10 NEM: 49.32 → 49.81 (0.99%)
2026-03-30, 10:00:10 GOLD: 20.95 → 21.14 (0.91%)
2026-03-30, 10:00:10 Coefficient 1 (avg NEM+GOLD): 0.95%
2026-03-30, 10:00:10 Action 3: Fetching AUD/USD exchange rate...
2026-03-30, 10:00:10 Coefficient 2 (AUD/USD): -0.12%
2026-03-30, 10:00:10 Action 4: Fetching SLV (iShares Silver Trust) price...
2026-03-30, 10:00:10 Coefficient 3 (SLV): 1.30%
2026-03-30, 10:00:10 Action 5: Result of Action #1: Gold prices may rise...
Forecast coefficient (average of C1, C2, C3): 0.71
2026-03-30, 10:00:10 Action 6: Actual gold price: $4555.30
2026-03-30, 10:00:10 Action 6: Dollar forecast for tomorrow: $4587.64
2026-03-30, 10:00:10 === Pipeline complete ===
```

### CSV Output (`gold_forecast_history.csv`)
```csv
date,actual_gold_price,forecast,deviation
2026-03-30,4555.30,,
2026-03-31,4580.00,4587.64,-7.64
```

### Forecast Persistence (`last_forecast.json`)
```json
{
  "date": "2026-03-30",
  "forecast": 4587.64,
  "article": "Gold prices may rise amid trade war tensions and safe-haven demand...",
  "c1": 0.95,
  "c2": -0.12,
  "c3": 1.30
}
```

### Analysis History (`analysis_history.json`)
Each pipeline run appends an entry with the day's article and coefficients. This powers the per-day breakdown in the dashboard's prediction table.
```json
[
  { "date": "2026-03-30", "article": "Gold prices may rise amid trade war tensions...", "c1": 0.95, "c2": -0.12, "c3": 1.30 }
]
```

---

## Error Handling

Per the PDF spec, the agent implements **independent error isolation** for each action:

| Scenario | Behavior |
|----------|----------|
| Any single action fails | Pipeline continues with remaining actions |
| NEM or GOLD fetch fails | That stock's % change = 0.0, other stock still counted |
| AUD/USD fetch fails | C2 = 0.0 |
| SLV fetch fails | C3 = 0.0 |
| Gold price from kitco fails | Try Yahoo GC=F fallback |
| Both gold price sources fail | **Skip Action 6 AND Action 7 entirely** |
| First run (no yesterday forecast) | Row has empty forecast and deviation columns |
| Groq API fails or no key set | Use static fallback article text |
| URL scraping fails for some pages | Skip those pages, continue with successful extractions |

All errors are logged with timestamps and action numbers.

---

## Deployment

### Vercel Cloud Deployment (Recommended)

The agent is designed to run on Vercel with automatic daily scheduling.

#### Step 1: Install Vercel CLI

```bash
npm i -g vercel
```

#### Step 2: Deploy

```bash
vercel
```

Follow the prompts to link your Vercel account and project.

#### Step 3: Add Vercel Blob Storage

1. Go to your project in the [Vercel Dashboard](https://vercel.com/dashboard)
2. Navigate to the **Storage** tab
3. Click **Create** > **Blob**
4. The `BLOB_READ_WRITE_TOKEN` environment variable is added automatically

#### Step 4: Add Environment Variables

In the Vercel Dashboard, go to **Settings** > **Environment Variables** and add:

| Variable | Value |
|----------|-------|
| `GROQ_API_KEY` | Your Groq API key from [console.groq.com](https://console.groq.com/) |
| `CRON_SECRET` | (Optional) A secret string to secure the cron endpoint |

`BLOB_READ_WRITE_TOKEN` is added automatically from Step 3.

#### Step 5: Deploy to Production

```bash
vercel --prod
```

#### After Deployment

- **Dashboard:** `https://yourapp.vercel.app` — live forecast dashboard
- **Cron:** Runs automatically at 14:00 UTC (10:00 AM Toronto EDT) every day
- **Manual trigger:** `curl https://yourapp.vercel.app/api/forecast`

### Vercel Architecture

| Component | File | Purpose |
|-----------|------|---------|
| Cron endpoint | `api/forecast.ts` | Runs the full 7-action pipeline on schedule |
| History API | `api/history.ts` | Returns JSON data for the dashboard |
| Dashboard | `public/index.html` | Frontend with chart, table, and analysis |
| Cron config | `vercel.json` | Schedule: `0 14 * * *` (daily at 14:00 UTC) |
| Storage | Vercel Blob | Persists CSV and JSON data between runs |
| Max duration | 300 seconds | Vercel Fluid Compute for long-running pipeline |

### Local Development

For local testing without Vercel:
```bash
npx tsx gold_forecast_agent.ts
```
This uses the local `data/` directory for persistence instead of Vercel Blob.

### Future: AI Michel Expansion

This V1 agent is structured to evolve into the full AI Michel 3-agent neurotropic system:
- Agent #1 "Sensor Stream" — data collection (this agent)
- Agent #2 "Stream of Consciousness" — analysis + ChromaDB + Ollama
- Agent #3 "Stream of Action" — prediction generation

---

## Testing

The project includes 81 tests across multiple categories:

```bash
# Unit tests only (no API calls, ~0.4s)
npm test

# Full integration test (runs the real pipeline, ~15s)
# Requires GROQ_API_KEY in .env
npm run test:long
```

### Test Coverage

| Category | Tests | What It Verifies |
|----------|-------|------------------|
| `toPercent()` | 7 | Percentage change formula matches PDF |
| `torontoDateStr()` / `torontoNow()` | 4 | YYYY-MM-DD format, Toronto timezone |
| CSV operations | 9 | Create, append, update deviation, column count |
| JSON operations | 6 | Save, load, first-run null, corruption handling |
| Coefficient logic | 5 | Averages, 0.0 defaults, deviation formula |
| CSV format compliance | 4 | Column names, date format, first-run empty fields |
| Vercel deployment | 10 | vercel.json, API routes, Blob storage, dashboard |
| Security audit | 5 | No hardcoded keys, .env excluded, env-only loading |
| PDF spec compliance | 19 | All 7 actions, output strings, symbols, model ID |
| Project structure | 9 | All files exist, README content |
| Integration (full pipeline) | 17 | End-to-end run, output markers, file outputs |

---

## Project Structure

```
AgentOne/
├── gold_forecast_agent.ts       # Local-dev runner + shared helpers (Yahoo, kitco, Groq, CSV, time)
├── test_gold_forecast.ts        # Pipeline unit + structural tests
├── test_adaptive.ts             # Adaptive-weighting unit tests (rank, cum bonuses, forecast)
├── api/
│   ├── forecast.ts              # Vercel cron handler — full 10-action production pipeline
│   ├── adaptive.ts              # Stage 3 self-learning module (10/5/0 ranking, weights)
│   └── history.ts               # Read-only JSON endpoint that powers the dashboard
├── public/
│   └── index.html               # Live dashboard (chart, table, per-day analysis)
├── vercel.json                  # Cron schedule: 0 14 * * * (10 AM Toronto)
├── package.json                 # Dependencies and npm scripts
├── package-lock.json            # Locked dependency versions
├── tsconfig.json                # TypeScript strict mode, ES2022, ESNext modules
├── .env                         # GROQ_API_KEY (NOT committed — see .env.example)
├── .env.example                 # Template for environment setup
├── .gitignore                   # Excludes .env, node_modules, data/, .vercel
├── README.md                    # This file
└── data/                        # Local persistence directory (NOT committed)
    ├── gold_forecast_history.csv  # Append-only daily forecast history
    ├── last_forecast.json         # Today's dollar forecast for tomorrow
    └── analysis_history.json      # Per-day article + coefficient archive
```

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| TypeScript | Agent source code (strict mode enabled) |
| Node.js 18+ | Runtime with native `fetch()` — no external HTTP library |
| `npx tsx` | Direct TypeScript execution without a build step |
| Groq API | Cloud inference for Llama 3.3 70B |
| Llama 3.3 70B | LLM for news synthesis (25-word article from 20 sources) |
| Yahoo Finance HTTP API | Stock prices (NEM, GOLD), forex (AUDUSD=X), ETF (SLV), gold futures (GC=F) |
| kitco.com | Primary gold spot price source (USD per troy ounce) |
| Vercel | Cloud deployment with serverless functions and cron scheduling (Stage 4 will migrate to AWS Lambda + EventBridge + S3/CloudFront) |
| Upstash Redis | Cloud persistence for CSV history, last-forecast blob, adaptive state, and accuracy audit log |
| Chart.js 4 | Actual vs Predicted line chart on dashboard (loaded via CDN) |
| CSV + JSON | Data formats for forecast history and pipeline state |

---

## Configuration

### Environment Variables

| Variable | Required | Where | Description |
|----------|----------|-------|-------------|
| `GROQ_API_KEY` | Yes | Local + Vercel | API key for Groq cloud inference ([get one free](https://console.groq.com/)) |
| `UPSTASH_REDIS_REST_URL` | Vercel + AWS | Vercel/AWS | Upstash Redis REST endpoint URL |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel + AWS | Vercel/AWS | Upstash Redis REST auth token |
| `CRON_SECRET` | Required | Vercel | Bearer token the cron handler verifies (default-deny if unset) |

### Configuration Files

| File | Purpose |
|------|---------|
| `.env` | Local environment variables (not committed) |
| `.env.example` | Template showing required variables |
| `vercel.json` | Vercel cron schedule and serverless function config |
| `tsconfig.json` | TypeScript: strict mode, ES2022 target, NodeNext modules, `noEmit` (run via tsx) |
| `package.json` | Type: module, dependencies, npm scripts for run/test |

---

---

## Documentation

The project keeps three canonical docs. Start here based on what you need:

| If you want to... | Read |
|---|---|
| Run the agent locally or understand what it does | [README.md](README.md) (this file) |
| Onboard onto the team and start contributing | [docs/ONBOARDING.md](docs/ONBOARDING.md) |
| Understand *why* the agent is shaped the way it is — design decisions, stage roadmap, PDF discrepancies, AWS migration state | [PLANNING.md](PLANNING.md) |

Supervisor source materials (in `docs/`): `Gold_Forecast_Spec_v1.pdf`, `Prompt_for_Upgrading_AI_Agent_v3.docx`, `AI_Michel_Project_v1.pdf`, `Server_Hosting_Meeting_Notes.docx`.

---

**Student:** Jan Fontanilla
**Architecture Implementation Manager:** Olga Grass (AI SYNT)
**Project:** AI Michel - Experimental Simulation of a Three-Level Neurotropic Architecture
