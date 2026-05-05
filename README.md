# Gold Forecast Daily AI Agent V1

**Project:** AI Michel - Gold Forecast Agent (V1 Prototype)
**Student:** Jan Fontanilla
**Organization:** AI SYNT (Canada)
**Supervisor:** Architecture Implementation Manager Olga Grass
**Date:** May 2026

**GitHub Repository:** [https://github.com/janfontanilla/AgentOne](https://github.com/janfontanilla/AgentOne)

---

A fully automated AI agent that forecasts gold price movement by analyzing news sentiment,
mining stock performance, forex rates, and silver prices. Runs daily at **10:00 AM Toronto time**
with automatic DST handling. Deployed to **AWS** (Lambda + EventBridge + S3) with a live web
dashboard featuring an Actual vs Predicted chart and per-day analysis history.

This agent is the V1 prototype for the larger AI Michel project — a three-level neurotropic
architecture AI system for predictive financial modeling.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation & Setup](#installation--setup)
3. [How It Works](#how-it-works)
4. [Pipeline Actions (PDF Spec)](#pipeline-actions-pdf-spec)
5. [Dashboard Features](#dashboard-features)
6. [Data Sources & APIs](#data-sources--apis)
7. [Formulas & Calculations](#formulas--calculations)
8. [Self-Learning / Adaptive Weighting](#self-learning--adaptive-weighting)
9. [Output Format](#output-format)
10. [Error Handling](#error-handling)
11. [Deployment](#deployment)
12. [Testing](#testing)
13. [Project Structure](#project-structure)
14. [Tech Stack](#tech-stack)
15. [Configuration](#configuration)

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | 18 or higher | Required for native `fetch()` support |
| **npm** | 9 or higher | Comes with Node.js |
| **Groq API Key** | Free tier | Get one at [console.groq.com](https://console.groq.com/) |

Optional (for AWS deployment):
| Requirement | Notes |
|-------------|-------|
| **AWS account** | Free tier is sufficient for this workload |
| **AWS CLI** | Install from [aws.amazon.com/cli](https://aws.amazon.com/cli/), then run `aws configure` |
| **AWS SAM CLI** | Install with `pip install aws-sam-cli` |
| **Alpha Vantage API Key** | Free tier (25 requests/day) — get one at [alphavantage.co](https://www.alphavantage.co/) |

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
- `@upstash/redis` — cloud persistence (CSV history, forecast state, adaptive weights)
- `@types/aws-lambda` — AWS Lambda type definitions (dev dependency)
- `@types/node` — TypeScript type definitions (dev dependency)
- `esbuild` — bundles TypeScript for Lambda deployment (dev dependency)

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

- **Source:** Alpha Vantage NEWS_SENTIMENT API — fetches up to 20 structured gold-related news articles (requires `ALPHA_VANTAGE_KEY`, free tier: 25 requests/day)
- **Synthesize:** Sends article headlines and summaries to **Groq API (Llama 3.3 70B)** with instructions to produce a short article answering "What will happen to the gold price in the near future?" in **no more than 25 words**
- **Output:** Article text stored for display in Action 5 and saved to analysis history
- **Why Alpha Vantage:** Direct web scraping (Google + DuckDuckGo + news sites) was blocked by CAPTCHAs and rate limits — only ~3 of 20 pages succeeded. Alpha Vantage gives a reliable, structured feed with no scraping required.

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
| Alpha Vantage NEWS_SENTIMENT API | Top 20 gold-related news articles for Action 1 | Yes (`ALPHA_VANTAGE_KEY`) |
| Groq API (Llama 3.3 70B) | Article synthesis (25 words max) | Yes (`GROQ_API_KEY`) |
| Yahoo Finance HTTP API | NEM, GOLD, AUDUSD=X, SLV, GLD prices | No |
| kitco.com | Actual gold spot price (USD/oz) | No |
| Yahoo Finance GC=F | Gold price fallback (futures) | No |

### Action 1 — Original Approach & Why It Was Replaced

The original spec called for scraping up to 20 URLs from multiple sources:

| Original Source | Role | Outcome |
|----------------|------|---------|
| Google Search (`"gold price tomorrow"`) | Primary URL collection | Blocked by CAPTCHA — returned 0 usable results |
| DuckDuckGo JSON API | Fallback URL collection | Rate-limited — intermittently returned 0 results |
| Known gold sites (kitco, reuters, bloomberg, etc.) | Reliable URL supplements | ~7 of 10 sites returned 403 / 404 / 401 |
| Yahoo Finance RSS | Additional gold news URLs | Worked but only provided a few URLs |

In practice only ~3 of 20 pages succeeded on any given day, meaning the Groq synthesis was running on nearly empty input. The pipeline was technically completing but producing low-quality articles.

**Solution:** Replaced all scraping in Action 1 with the **Alpha Vantage NEWS_SENTIMENT API**, which provides a structured feed of up to 20 gold-related articles per request. Same Groq synthesis step, same 25-word output format — better and more reliable input data. Free tier allows 25 requests/day, well within the 1 request/day pipeline cadence.

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

The EventBridge Scheduler fires the `goldforecast-forecast-cron` Lambda at 10:00 AM Toronto time (DST-aware). It scores yesterday's predictions against today's actual price first, *then* generates today's new forecast using the freshly updated weights. No second cron is needed.

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

### AWS Deployment (Current — Production)

The agent runs on AWS using Lambda + EventBridge Scheduler + S3. Infrastructure is managed with AWS SAM. All secrets are stored in SSM Parameter Store and resolved at deploy time (zero runtime cost).

#### Architecture

| Component | AWS Service | Purpose |
|-----------|-------------|---------|
| Daily cron | EventBridge Scheduler | Fires at 10:00 AM Toronto time (DST-aware) |
| Pipeline runner | Lambda `goldforecast-forecast-cron` | Runs the full pipeline via `runPipeline()` |
| History API | Lambda `goldforecast-history-api` + API Gateway HTTP v2 | `GET /api/history` endpoint |
| Dashboard | S3 static website | Hosts `public/index.html` |
| State / persistence | Upstash Redis | CSV history, last forecast blob, adaptive state |
| Secrets | SSM Parameter Store | All API keys and tokens, resolved at deploy time |
| IaC | AWS SAM (`template.yaml`) | Defines all resources |

#### Code Changes Made for Lambda Compatibility

The agent was refactored to export clean functions that Lambda handlers call directly — no mock Vercel `req`/`res` objects needed:

- `api/forecast.ts` — exports `runPipeline()` (pure pipeline logic, no Vercel deps)
- `api/history.ts` — exports `getHistoryData()` (pure read logic)
- `lambda/forecast-handler.ts` — Lambda entry point, calls `runPipeline()`
- `lambda/history-handler.ts` — Lambda entry point, calls `getHistoryData()`, adds CORS headers
- `esbuild.config.mjs` — bundles both handlers to `dist/` for Lambda deployment

#### Step 1: Store Secrets in SSM

```powershell
$REGION = "us-east-1"

aws ssm put-parameter --name "/gold-forecast/upstash-url"    --value "YOUR_UPSTASH_URL"   --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/upstash-token"  --value "YOUR_UPSTASH_TOKEN" --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/groq-api-key"   --value "YOUR_GROQ_KEY"      --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/alpha-vantage-key" --value "YOUR_AV_KEY"     --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/cron-secret"    --value "YOUR_CRON_SECRET"   --type SecureString --region $REGION --overwrite
```

#### Step 2: Build

```bash
npm run build
# Outputs: dist/forecast-handler.js, dist/history-handler.js
```

#### Step 3: Deploy with SAM

```bash
sam validate --template template.yaml
sam build --template template.yaml
sam deploy \
  --stack-name goldforecast-stack \
  --region us-east-1 \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-confirm-changeset \
  --resolve-s3
```

SAM will output your live URLs:
- `CloudFrontUrl` or `HistoryApiUrl` — the `/api/history` endpoint
- `DashboardBucketName` — S3 bucket name for the static dashboard

#### Step 4: Upload Dashboard to S3

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name goldforecast-stack \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardBucketName'].OutputValue" \
  --output text --region us-east-1)

aws s3 sync ./public s3://$BUCKET --delete --region us-east-1
```

#### Step 5: Verify Deployment

```bash
# Manually trigger the pipeline Lambda
aws lambda invoke \
  --function-name goldforecast-forecast-cron \
  --region us-east-1 /tmp/response.json

cat /tmp/response.json
# Expected: {"statusCode":200,"body":"{\"status\":\"success\",...}"}

# Check CloudWatch logs
aws logs tail /aws/lambda/goldforecast-forecast-cron --since 10m --region us-east-1
```

#### Get Your Live URLs Any Time

```powershell
aws cloudformation describe-stacks --stack-name goldforecast-stack `
  --query "Stacks[0].Outputs" --output table --region us-east-1
```

#### Cost

Everything runs within the AWS free tier — estimated cost: **$0/month**.

| Service | Monthly Usage | Free Tier |
|---------|---------------|-----------|
| Lambda (forecast) | 30 invocations × ~60s × 512 MB | 400,000 GB-s |
| Lambda (history API) | ~3,000 requests | 400,000 GB-s |
| API Gateway | ~3,000 requests | 1M/month |
| EventBridge Scheduler | 30 invocations | 14M/month |
| S3 | ~100 KB storage | 5 GB (12 mo) |
| CloudWatch Logs | ~1 MB/month | 5 GB |

---

### Local Development

For local testing without AWS:

```bash
npx tsx gold_forecast_agent.ts
```

Uses the local `data/` directory for persistence instead of Upstash Redis.

---

### Future: AI Michel Expansion

This V1 agent is structured to evolve into the full AI Michel 3-agent neurotropic system:
- Agent #1 "Sensor Stream" — data collection (this agent)
- Agent #2 "Stream of Consciousness" — analysis + ChromaDB + Ollama
- Agent #3 "Stream of Action" — prediction generation

Additional agents for other assets (stocks, silver, etc.) will follow the same AWS architecture pattern, with a final summarizer agent aggregating all findings.

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
│   ├── forecast.ts              # Exports runPipeline() — full 10-action production pipeline
│   ├── adaptive.ts              # Stage 3 self-learning module (10/5/0 ranking, weights)
│   └── history.ts               # Exports getHistoryData() — read-only JSON for dashboard
├── lambda/
│   ├── forecast-handler.ts      # AWS Lambda entry: invokes runPipeline() from EventBridge
│   └── history-handler.ts       # AWS Lambda entry: invokes getHistoryData() from API Gateway
├── public/
│   └── index.html               # Live dashboard (chart, table, per-day analysis) — hosted on S3
├── template.yaml                # AWS SAM — Lambda, EventBridge, S3, API Gateway, IAM
├── esbuild.config.mjs           # Bundles lambda/ handlers to dist/ for Lambda deployment
├── package.json                 # Dependencies and npm scripts (build, deploy, test)
├── package-lock.json            # Locked dependency versions
├── tsconfig.json                # TypeScript strict mode, ES2022, ESNext modules
├── .env                         # API keys (NOT committed — see .env.example)
├── .env.example                 # Template for environment setup
├── .gitignore                   # Excludes .env, node_modules, data/, dist/
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
| Node.js 20 | Runtime with native `fetch()` — no external HTTP library |
| `npx tsx` | Direct TypeScript execution for local development |
| esbuild | Bundles TypeScript to ESM for AWS Lambda deployment |
| AWS Lambda | Serverless compute — runs the forecast pipeline and history API |
| AWS EventBridge Scheduler | DST-aware daily cron at 10:00 AM Toronto time |
| AWS S3 | Static website hosting for the dashboard |
| AWS SAM | Infrastructure-as-Code (`template.yaml`) for all AWS resources |
| AWS SSM Parameter Store | Encrypted secret storage (resolved at deploy time) |
| Alpha Vantage NEWS_SENTIMENT | Structured gold news feed for Action 1 (replaces web scraping) |
| Groq API | Cloud inference for Llama 3.3 70B |
| Llama 3.3 70B | LLM for news synthesis (25-word article from 20 sources) |
| Yahoo Finance HTTP API | Stock prices (NEM, GOLD, GLD), forex (AUDUSD=X), ETF (SLV), gold futures (GC=F) |
| kitco.com | Primary gold spot price source (USD per troy ounce) |
| Upstash Redis | Cloud persistence for CSV history, last-forecast blob, adaptive state, and accuracy audit log |
| Chart.js 4 | Actual vs Predicted line chart on dashboard (loaded via CDN) |
| CSV + JSON | Data formats for forecast history and pipeline state |

---

## Configuration

### Environment Variables

| Variable | Required | Where | Description |
|----------|----------|-------|-------------|
| `GROQ_API_KEY` | Yes | Local + AWS | API key for Groq cloud inference ([get one free](https://console.groq.com/)) |
| `ALPHA_VANTAGE_KEY` | Yes | Local + AWS | API key for Alpha Vantage NEWS_SENTIMENT ([get one free](https://www.alphavantage.co/)) |
| `UPSTASH_REDIS_REST_URL` | Yes | Local + AWS | Upstash Redis REST endpoint URL |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Local + AWS | Upstash Redis REST auth token |
| `CRON_SECRET` | Yes | AWS | Bearer token used to secure the forecast Lambda endpoint |

In AWS, all variables are stored as encrypted SSM Parameter Store entries under `/gold-forecast/*` and injected into Lambda at deploy time — they are never exposed in plaintext in the CloudFormation template.

### Configuration Files

| File | Purpose |
|------|---------|
| `.env` | Local environment variables (not committed) |
| `.env.example` | Template showing required variables |
| `template.yaml` | AWS SAM — defines all Lambda, EventBridge, S3, and IAM resources |
| `esbuild.config.mjs` | Bundles `lambda/forecast-handler.ts` and `lambda/history-handler.ts` to `dist/` |
| `tsconfig.json` | TypeScript: strict mode, ES2022 target, NodeNext modules, `noEmit` (run via tsx) |
| `package.json` | Type: module, dependencies, npm scripts (`build`, `deploy`, `test`) |

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
**Last Updated:** May 2026
