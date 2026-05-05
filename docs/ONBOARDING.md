# Team Onboarding — Gold Forecast Daily AI Agent

**Welcome to the team.** Read this document end to end before touching any code. After that, the supervisor's PDF spec in `docs/Gold_Forecast_Spec_v1.pdf` is the source of truth for *what* the agent does, and the source code is the source of truth for *how* it does it.

- **GitHub repo:** https://github.com/janfontanilla/AgentOne
- **Contact during handoff:** Jan Fontanilla — janfontanilla12@gmail.com

---

## 1. What this project is

**One sentence:** A fully automated AI agent that runs every morning at 10:00 AM Toronto time, fetches gold-related news, calculates six market signals, predicts tomorrow's gold price, and tracks its own accuracy on a public dashboard.

**Who it's for:** AI SYNT (supervisor: **Olga Grass**, technical lead: **Dr. Alex**). It's the V1 prototype for the larger AI Michel project — a 3-agent neurotropic architecture for predictive financial modeling. We are not building AI Michel yet; this agent is the stepping stone.

**Read these supervisor materials before touching code (in `agentone/docs/`):**

| File | Why |
|---|---|
| `Gold_Forecast_Spec_v1.pdf` | The authoritative spec. Every line of the pipeline traces back to this. Treat it as law — even where it has discrepancies (see §8). |
| `Prompt_for_Upgrading_AI_Agent_v3.docx` | The adaptive-weighting upgrade spec. Stage 3 implements this literally. |
| `AI_Michel_Project_v1.pdf` | Future context — where this agent eventually evolves into a 3-agent system. Not building yet. |
| `Server_Hosting_Meeting_Notes.docx` | Meeting notes about hosting and the AWS migration. |

---

## 2. Architecture (AWS — current production)

```
                 +----------------------+
                 |  EventBridge         |  cron: 10:00 AM Toronto (DST-aware)
                 |  Scheduler           |  TimeZone: America/Toronto
                 +----------+-----------+
                            | invokes
                            v
+---------------+   +-------+----------+   +-------------------+
| Alpha Vantage | <-+  Lambda          +-> | Upstash Redis     |
| Yahoo Finance |   |  forecast-cron   |   | (state: 6 keys)   |
| kitco.com     |   |  runPipeline()   |   |                   |
| Groq Llama    |   |  10-action       |   +-------------------+
+---------------+   |  pipeline +      |
                    |  adaptive layer  |
                    +-------+----------+
                            ^
                            | HTTP via API Gateway
                            |
               +------------+----------+
               |  API Gateway HTTP v2  |
               |  GET /api/history     |
               +------------+----------+
                            |
                    +-------+----------+
                    |  Lambda          |
                    |  history-api     |
                    |  getHistoryData()|
                    +------------------+

               +---------------------------+
               |  S3 (static website)      |
               |  public/index.html        |
               |  Dashboard — no build     |
               +---------------------------+
```

**Component breakdown:**

- **EventBridge Scheduler** fires the forecast Lambda at 10:00 AM Toronto time. Uses `TimeZone: America/Toronto` so DST is handled automatically — no UTC offset math needed.
- **Lambda `goldforecast-forecast-cron`** (`lambda/forecast-handler.ts`) calls `runPipeline()` from `api/forecast.ts`. Timeout: 270s, memory: 512 MB. Hits Alpha Vantage, Yahoo Finance, kitco, and Groq, then writes results to Upstash Redis.
- **Lambda `goldforecast-history-api`** (`lambda/history-handler.ts`) calls `getHistoryData()` from `api/history.ts`. Read-only. Serves the dashboard via API Gateway.
- **API Gateway HTTP v2** routes `GET /api/history` to the history Lambda with CORS enabled.
- **S3** hosts `public/index.html` as a static website — no build step, no CloudFront needed.
- **Upstash Redis** holds all pipeline state (6 keys — see §11B). Chosen over DynamoDB to stay serverless and avoid VPC complexity for V1.
- **SSM Parameter Store** holds all secrets, resolved at deploy time. Zero runtime cost.
- **Alpha Vantage NEWS_SENTIMENT API** replaced the original web scraping approach for Action 1. See §3 and §8.

---

## 3. The pipeline — 10 actions + Stage 3 adaptive weighting

The agent runs **10 actions** sequentially each day. Each action is wrapped in its own try/catch so one failure doesn't halt the rest. All 10 live in `api/forecast.ts` inside `runPipeline()`.

| # | Action | Inputs | Output |
|---|---|---|---|
| **Pre-pipeline** | Load yesterday's forecast + adaptive state, fetch today's gold price | Redis, kitco/Yahoo | Used by adaptive scoring |
| **Adaptive scoring** | Score yesterday's predictions vs today's actual change → award daily bonuses (10/5/0) | Yesterday's blob, today's GLD change | Updates `adaptive_state.json` |
| 1 | News synthesis via Alpha Vantage + Groq | Alpha Vantage NEWS_SENTIMENT API (20 articles) | One-sentence article (Llama 3.3 70B, ≤25 words) |
| 2 | NEM + GOLD stock 24h % change | Yahoo Finance | **C1** = avg(NEM%, GOLD%) |
| 3 | AUD/USD forex 24h % change | Yahoo Finance | **C2** |
| 4 | SLV silver ETF 24h % change | Yahoo Finance | **C3** |
| 5 | US Equities avg (SPY, DIA, QQQ, IWM) | Yahoo Finance | **I1** (inverse — contributes −I1) |
| 6 | US Dollar Index (DX-Y.NYB) | Yahoo Finance | **I2** (inverse) |
| 7 | Bond yields via TLT | Yahoo Finance | **I3** (inverse) |
| 8 | Adaptive-weighted forecast | C1–C3, I1–I3, cumulative bonuses | Today's forecast % |
| 9 | Build history CSV row + save tomorrow's dollar forecast | Actual gold price, yesterday's forecast | Row in `gold_forecast_history.csv`, updated `last_forecast.json` |
| 10 | Deviation log | Actual price, yesterday's forecast | Logged to CloudWatch |

**Why 10 actions when the PDF specifies 7?** The original 7 are all present (1: news, 2–4: C1/C2/C3, 5: display+save, 6: build row, 7: deviation). Stage 2 added 3 inverse indicators (Actions 5–7 in the new numbering), pushing original actions 5–7 to 8–10.

### Action 1 — Why Alpha Vantage replaced web scraping

The original spec called for scraping up to 20 URLs (Google → DuckDuckGo → known gold sites → Yahoo Finance RSS). In practice:
- Google: blocked by CAPTCHA on every run
- DuckDuckGo: rate-limited, intermittently returned 0 results
- Known news sites: ~7 of 10 returned 403/404/401
- Result: only ~3 of 20 pages succeeded — Groq was synthesizing nearly empty input

**Fix:** replaced all scraping with **Alpha Vantage NEWS_SENTIMENT API** (`topics=gold&sort=LATEST&limit=20`). Same Groq synthesis step, same ≤25-word output — just reliable structured input instead of broken scraping. Free tier: 25 requests/day, well within the 1/day cadence.

### Stage 3 adaptive weighting (`api/adaptive.ts`)

The agent self-learns which indicators have been most accurate and weights tomorrow's forecast accordingly.

**Mechanic:**
1. Six indicators — three **direct** (D1=Mining, D2=AUD/USD, D3=Silver) and three **reversal** (R1=Equities, R2=DXY, R3=TLT, stored already-negated).
2. Each day after the actual gold change is known: within each group of three, **closest prediction = +10, middle = +5, farthest = +0**. Ties resolved by sort stability (keeps bonuses as integers per spec §3.3).
3. Rolling **10-day FIFO** window of bonuses. Cumulative bonus per indicator: 0–100.
4. Tomorrow's forecast: `Σ(weight_i · pred_i) / Σ(weight_i)` where `weight_i = 100 + cumulative_bonus_i`.

---

## 4. Repository structure

```
agentone/
├── api/
│   ├── forecast.ts          # Exports runPipeline() — 10-action production pipeline
│   ├── history.ts           # Exports getHistoryData() — read-only, powers dashboard
│   └── adaptive.ts          # Stage 3 self-learning module
├── lambda/
│   ├── forecast-handler.ts  # AWS Lambda entry: calls runPipeline() from EventBridge
│   └── history-handler.ts   # AWS Lambda entry: calls getHistoryData() from API Gateway
├── gold_forecast_agent.ts   # Shared helpers: Yahoo, kitco, Groq, Alpha Vantage, CSV, time
├── public/
│   └── index.html           # Static dashboard (chart, table, per-day analysis) — hosted on S3
├── template.yaml            # AWS SAM — defines all Lambda, EventBridge, S3, API Gateway, IAM
├── esbuild.config.mjs       # Bundles lambda/ handlers to dist/ for Lambda deployment
├── test_gold_forecast.ts    # Pipeline unit + structural tests
├── test_adaptive.ts         # Adaptive-module unit tests
├── docs/                    # Supervisor materials + this file
├── data/                    # Local-dev only: CSV + JSON state mirrors
├── package.json             # npm scripts: build, deploy, test
└── tsconfig.json            # TypeScript strict mode, ES2022, NodeNext modules
```

**Three canonical docs:**

| File | Purpose |
|---|---|
| `README.md` | Public-facing overview, AWS deployment steps, pipeline summary |
| `docs/ONBOARDING.md` | This file — day-one read for new team members |
| `PLANNING.md` | Architecture decision log, stage roadmap, PDF discrepancies |

---

## 5. Local development

**Prerequisites:**
- Node.js 20+
- `.env` file in `agentone/` (copy `.env.example` and fill in real values — Jan or Olga has the credentials)

**.env keys you need:**
```
GROQ_API_KEY=...                  # console.groq.com (free tier)
ALPHA_VANTAGE_KEY=...             # alphavantage.co (free tier, 25 req/day)
UPSTASH_REDIS_REST_URL=...        # console.upstash.com
UPSTASH_REDIS_REST_TOKEN=...      # same
CRON_SECRET=...                   # any random string for cron auth
```

**Core commands:**
```bash
npm install                        # install dependencies
npx tsx gold_forecast_agent.ts     # run full pipeline once (writes to Upstash if creds set)
npm test                           # fast unit tests (~600ms)
npm run test:long                  # full integration tests including real API calls (~11s)
npm run typecheck                  # TypeScript strict check only
npm run build                      # bundle lambda/ to dist/ via esbuild
```

**Reading live state:**
```bash
# Hit the live history API
curl https://<your-api-gateway-url>/api/history | jq .

# Read a Redis key directly via Upstash REST
curl -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  $UPSTASH_REDIS_REST_URL/get/last_forecast.json
```

---

## 6. AWS deployment — step by step

All infrastructure is defined in `template.yaml` and deployed with AWS SAM. Secrets live in SSM Parameter Store and are injected into Lambda at deploy time.

### Prerequisites

```bash
aws --version        # AWS CLI v2+
sam --version        # SAM CLI 1.x+
aws sts get-caller-identity   # confirms you are authenticated
```

### Step 1 — Store secrets in SSM (one-time setup)

```powershell
$REGION = "us-east-1"

aws ssm put-parameter --name "/gold-forecast/upstash-url"       --value "YOUR_URL"   --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/upstash-token"     --value "YOUR_TOKEN" --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/groq-api-key"      --value "YOUR_KEY"   --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/alpha-vantage-key" --value "YOUR_KEY"   --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/cron-secret"       --value "YOUR_SECRET" --type SecureString --region $REGION --overwrite
```

### Step 2 — Build Lambda bundles

```bash
npm run build
# Outputs: dist/forecast-handler.js, dist/history-handler.js
```

### Step 3 — Deploy with SAM

```bash
sam validate --template template.yaml
sam deploy \
  --stack-name goldforecast-stack \
  --region us-east-1 \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-confirm-changeset \
  --resolve-s3
```

SAM will print your live URLs in the Outputs table:
- `HistoryApiUrl` — the `/api/history` endpoint
- `DashboardBucketName` — S3 bucket for the static dashboard

### Step 4 — Upload dashboard to S3

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name goldforecast-stack \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardBucketName'].OutputValue" \
  --output text --region us-east-1)

aws s3 sync ./public s3://$BUCKET --delete --region us-east-1
```

### Step 5 — Verify

```bash
# Manually invoke the forecast Lambda
aws lambda invoke \
  --function-name goldforecast-forecast-cron \
  --region us-east-1 /tmp/response.json
cat /tmp/response.json
# Expected: {"statusCode":200,"body":"{\"status\":\"success\",...}"}

# Tail CloudWatch logs
aws logs tail /aws/lambda/goldforecast-forecast-cron --since 10m --region us-east-1

# Get all live URLs
aws cloudformation describe-stacks --stack-name goldforecast-stack \
  --query "Stacks[0].Outputs" --output table --region us-east-1
```

### Rollback

- **Code:** revert the merge commit on `main`, push, redeploy via SAM.
- **Instant Lambda rollback:** in the AWS Console, swap the Lambda alias to the previous version.
- **Static asset rollback:** restore the previous `index.html` version from S3 versioning.
- **State rollback:** Redis state is shared across deploys — do not roll back without talking to Jan or Olga first.

---

## 7. How to refactor the agent for a new asset

The gold forecast agent is the **template**. Additional agents will be built for other assets (stocks, silver, etc.) following the same pattern, each deployed independently to AWS. A final summarizer agent will aggregate all agents' findings.

### Pattern overview

Each new agent:
1. Copies the same pipeline structure (`runPipeline()` → Lambda handler → EventBridge cron)
2. Swaps in asset-specific data sources for its coefficients
3. Gets its own SAM stack, Lambda functions, EventBridge schedule, and SSM secrets
4. Writes its output to its own Upstash Redis keys (or a dedicated instance)

### Step-by-step: creating a new asset agent

#### 1. Identify your coefficients

Decide which market signals predict your asset. For gold we use:
- C1: related mining stocks (NEM, GOLD)
- C2: correlated forex pair (AUD/USD)
- C3: related commodity ETF (SLV)
- Inverse signals: US equities, DXY, TLT

For a **silver agent** example:
- C1: silver mining stocks (PAAS, AG)
- C2: AUD/USD (same correlation)
- C3: GLD (gold as a related commodity)
- Inverses: same

#### 2. Create the pipeline file

Copy `api/forecast.ts` → `api/forecast_silver.ts`. Then:
- Update the ticker symbols for your asset's coefficients
- Update the actual price fetch (kitco equivalent for your asset, or Yahoo Finance)
- Update the Redis key names (prefix with your asset, e.g. `silver_last_forecast.json`)
- Update the `runPipeline()` export name if needed (e.g. `runSilverPipeline()`)

#### 3. Create the Lambda handler

Copy `lambda/forecast-handler.ts` → `lambda/silver-forecast-handler.ts`. Change the import to point to your new pipeline file:

```typescript
import { runSilverPipeline } from "../api/forecast_silver.js";

export const handler = async (event: ScheduledEvent) => {
  const result = await runSilverPipeline();
  return { statusCode: 200, body: JSON.stringify(result) };
};
```

#### 4. Add to esbuild config

In `esbuild.config.mjs`, add your new handler as an additional entry point:

```javascript
await esbuild.build({
  ...commonOptions,
  entryPoints: ["./lambda/silver-forecast-handler.ts"],
  outfile: "./dist/silver-forecast-handler.js",
});
```

#### 5. Add to SAM template

In `template.yaml`, add a new Lambda function and EventBridge schedule following the same pattern as the gold agent. Use a different `FunctionName` and schedule name:

```yaml
SilverForecastFunction:
  Type: AWS::Serverless::Function
  Properties:
    FunctionName: silverforecast-forecast-cron
    CodeUri: dist/
    Handler: silver-forecast-handler.handler
    Timeout: 270
    MemorySize: 512
    Environment:
      Variables:
        UPSTASH_REDIS_REST_URL: '{{resolve:ssm-secure:/silver-forecast/upstash-url:1}}'
        # ... other secrets
```

#### 6. Add SSM secrets for the new agent

```powershell
aws ssm put-parameter --name "/silver-forecast/upstash-url" --value "..." --type SecureString --region us-east-1
# repeat for all secrets
```

#### 7. Build and deploy

```bash
npm run build
sam deploy --stack-name silverforecast-stack --region us-east-1 --capabilities CAPABILITY_NAMED_IAM --resolve-s3
```

#### 8. Verify

Same verification steps as the gold agent — manually invoke the Lambda, check CloudWatch logs, confirm a row appears in the asset's history key in Redis.

### The summarizer agent

Once all individual asset agents are running, a final **summarizer agent** will:
- Read the `last_forecast.json` key from each asset agent's Redis store
- Aggregate the forecasts into a unified report
- Optionally use Groq to synthesize a natural-language summary

The summarizer runs after all asset agents have completed (or on a slightly later schedule). It follows the same Lambda + EventBridge pattern — no new infrastructure pattern needed.

---

## 8. PDF discrepancies / known issues

Olga's instruction: **follow the PDF literally; flag discrepancies but don't unilaterally fix them.**

### % vs $ dimensional mismatch (the big one)

The PDF says `deviation = actual_gold_price − forecast`. But `actual` is dollars (~$3,300) and `forecast` is a percentage (+0.45%). Subtracting them is dimensionally inconsistent.

Our implementation: we compute a **dollar forecast** as `actual × (1 + percent_forecast/100)` and store it in `last_forecast.json`. Deviation is then `actual − dollar_forecast`, which is dimensionally consistent. The raw percentage is also saved for display. This is documented in `PLANNING.md` under "PDF Discrepancies." Do not change this without raising it with Olga.

### Action 6 / Action 7 overlap

The PDF has Action 6 building a CSV row and Action 7 also computing deviation. We split them across Actions 9 and 10 in the extended pipeline. Functionally equivalent.

### Stock ticker typo

The PDF says "Newmont (NEW)" on page 1 and "Newmont Corp (NEM)" on page 2. We use **NEM** (correct). Do not change this.

### Action 1 — original scraping approach

The original spec called for web scraping (Google + DuckDuckGo + news sites). This was replaced with Alpha Vantage NEWS_SENTIMENT API due to consistent failures (CAPTCHA, rate limits, 403s). The Groq synthesis step and ≤25-word output format are unchanged.

---

## 9. People & cadence

| Role | Who | Contact |
|---|---|---|
| Supervisor | **Olga Grass** (AI SYNT) | `aisyntinc@gmail.com` |
| Technical lead | **Dr. Alex** | Via Olga |
| Original author | **Jan Fontanilla** | `janfontanilla12@gmail.com` |

**Daily artefact:** the 10:00 AM Toronto cron run. Within ~60s a new row appears in the dashboard. If a day passes without a new row, check CloudWatch logs for the `goldforecast-forecast-cron` Lambda.

**Spec questions:** email Olga, copy Dr. Alex. Do not make spec-level changes without Olga's sign-off.

---

## 10. Quick-reference appendix

### A. All environment variables

| Name | Where (prod) | Notes |
|---|---|---|
| `GROQ_API_KEY` | SSM `/gold-forecast/groq-api-key` | console.groq.com, free tier |
| `ALPHA_VANTAGE_KEY` | SSM `/gold-forecast/alpha-vantage-key` | alphavantage.co, free tier (25 req/day) |
| `UPSTASH_REDIS_REST_URL` | SSM `/gold-forecast/upstash-url` | Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | SSM `/gold-forecast/upstash-token` | Upstash console |
| `CRON_SECRET` | SSM `/gold-forecast/cron-secret` | Bearer token for cron auth |

### B. All Redis keys (gold agent)

| Key | Schema | Written by | Read by |
|---|---|---|---|
| `gold_forecast_history.csv` | CSV: `date,actual_gold_price,forecast,deviation` | `appendCsvRow()` | `api/history.ts` (dashboard) |
| `last_forecast.json` | `{date, forecast, c1..i3, article, actual_gold_price}` | `saveTodayForecast()` | Next day's pipeline run |
| `analysis_history.json` | Array of daily analyses, capped at 365 | `saveAnalysisEntry()` | `api/history.ts` (dashboard expand rows) |
| `adaptive_state.json` | `{history: AdaptiveEntry[]}` — 10-entry FIFO | `saveAdaptiveState()` | `loadAdaptiveState()`, `api/history.ts` |
| `gold_forecast_accuracy.csv` | Audit CSV per spec §3.5 (24 columns) | `appendAccuracyCsvRow()` | Manual review |
| `gold_forecast_accuracy_legacy.csv` | Archive if CSV header drifts | Auto-archived | Never (archival only) |

### C. Useful commands

```bash
# Run pipeline locally
npx tsx gold_forecast_agent.ts

# Tests
npm test                  # fast unit tests
npm run test:long         # full integration suite
npm run typecheck         # strict TS check only

# Build + deploy
npm run build
sam deploy --stack-name goldforecast-stack --region us-east-1 --capabilities CAPABILITY_NAMED_IAM --resolve-s3

# Manually invoke forecast Lambda
aws lambda invoke --function-name goldforecast-forecast-cron --region us-east-1 /tmp/r.json

# Tail CloudWatch logs
aws logs tail /aws/lambda/goldforecast-forecast-cron --since 10m --region us-east-1

# Get live URLs from CloudFormation
aws cloudformation describe-stacks --stack-name goldforecast-stack \
  --query "Stacks[0].Outputs" --output table --region us-east-1

# Read a Redis key directly
curl -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  $UPSTASH_REDIS_REST_URL/get/last_forecast.json
```

### D. Glossary

| Term | Meaning |
|---|---|
| **C1, C2, C3** | Direct coefficients — rising means asset price up. C1 = avg(NEM, GOLD), C2 = AUD/USD, C3 = SLV |
| **I1, I2, I3** | Inverse indices (raw %). I1 = US Equities, I2 = DXY, I3 = TLT. Contributed as −Ix |
| **D1–D3 / R1–R3** | Adaptive-module names for the same six indicators. R-keys store the already-negated form |
| **bonus** | Daily 10/5/0 points by accuracy rank within each group of three |
| **cumulative bonus** | Sum of last 10 days' bonuses for one indicator. Range 0–100 |
| **weight** | `100 + cumulative_bonus`. Range 100–200. Drives the adaptive forecast formula |
| **Toronto time** | The agent's canonical timezone — `America/Toronto` via `Intl.DateTimeFormat`, DST-aware |
| **SAM stack** | The AWS CloudFormation stack deployed via SAM CLI (`goldforecast-stack`) |

---

**Welcome. The best first task is to manually invoke the forecast Lambda, confirm it succeeds in CloudWatch, and verify the history API returns a new row.**
