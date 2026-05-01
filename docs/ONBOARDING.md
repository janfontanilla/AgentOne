# Team Onboarding — Gold Forecast Daily AI Agent

**Welcome to the team.** This document gets you from zero to shipping code on the project. Read it in order, end to end. After that, the supervisor's PDF spec in `docs/Gold_Forecast_Spec_v1.pdf` is the source of truth for *what* the agent does, and the source code is the source of truth for *how* it does it.

- **Live dashboard:** https://agentone-theta.vercel.app (post-migration: a new AWS-fronted URL — see §6)
- **GitHub repo:** https://github.com/janfontanilla/AgentOne
- **Slack/email contact during handoff:** Jan Fontanilla — janfontanilla12@gmail.com

---

## 1. What this project is

**One sentence:** A fully automated AI agent that runs every morning at 10:00 AM Toronto time, scrapes gold-related news, calculates six market signals, predicts tomorrow's gold price, and tracks its own accuracy on a public dashboard.

**Who it's for:** AI SYNT (supervisor: **Olga Grass**, technical lead: **Dr. Alex**). It's the V1 prototype for the larger AI Michel project — a 3-agent neurotropic architecture for predictive financial modeling. We are not building AI Michel yet; the standalone agent is a stepping stone.

**Read these supervisor materials before touching code (in `agentone/docs/`):**

| File | Why |
|---|---|
| `Gold_Forecast_Spec_v1.pdf` | The authoritative spec. Every line of the pipeline traces back to this. Treat it as gospel even where it has discrepancies (see §8). |
| `Prompt_for_Upgrading_AI_Agent_v3.docx` | The adaptive-weighting upgrade prompt. Stage 3 of the project implements this literally. |
| `AI_Michel_Project_v1.pdf` | Future context. Where this agent eventually evolves into a 3-agent system. Not building yet. |
| `Server_Hosting_Meeting_Notes.docx` | April 27 meeting notes about hosting and the AWS migration. |
| `Screenshot_2026-03-24_160742.png` | Project structure reference from an early planning session. |

---

## 2. Architecture (post-AWS migration)

```
                 +------------------+
                 |   EventBridge    |  cron rule: 0 14 * * ? *
                 |  (14:00 UTC)     |  (= 10:00 AM Toronto)
                 +--------+---------+
                          | invokes
                          v
+--------------+   +--------+---------+   +-------------------+
| Yahoo Finance| <-+    Lambda        +-> | Upstash Redis     |
| kitco.com    |   | api/forecast.ts  |   | (state: 6 keys)   |
| Groq Llama   |   | 10-action        |   |                   |
+--------------+   |  pipeline +      |   +-------------------+
                   |  adaptive layer  |
                   +--------+---------+
                            ^
                            | reads via API Gateway
                            |
+-----------------+   +-----+----------+   +-------------------+
| CloudFront      | --> | API Gateway  +-> | Lambda            |
| (cached SPA)    |     |  GET /api/   |   | api/history.ts    |
|                 |     |  history     |   | (read-only)       |
+--------+--------+     +--------------+   +-------------------+
         |
         v
+-----------------+
| S3              |
| public/         |
| index.html      |
+-----------------+
```

**Component-by-component:**

- **EventBridge** fires the daily forecast cron at 14:00 UTC. (UTC stays constant; Toronto local time absorbs DST automatically.)
- **Lambda — forecast handler** (`api/forecast.ts`, 490 lines) runs the full pipeline in one invocation. Timeout: 300s. Hits external APIs (Yahoo Finance, kitco, Groq) and writes results to Redis.
- **Lambda — history handler** (`api/history.ts`, 129 lines) is a read-only data API. The dashboard calls it on page load; it returns the rows table, the last forecast, and the adaptive weighting state.
- **API Gateway** routes `GET /api/history` to the history Lambda. The forecast Lambda is invoked by EventBridge directly, not via API Gateway.
- **Upstash Redis** holds all state. Six keys (see §11 appendix). We chose Upstash over ElastiCache to stay serverless and avoid VPC complexity for V1 — easy to swap later if needed.
- **S3 + CloudFront** serve the dashboard. `public/index.html` is a single static file (885 lines, no build step). Updated when we deploy.
- **Groq, Yahoo Finance, kitco.com** are stateless external dependencies. Groq needs an API key; the others don't.

**Why Lambda not ECS:** the workload is one cron run per day plus a few dashboard reads — perfectly serverless. ECS only makes sense once we layer in AI Michel's long-running multi-agent loops.

**What's stateless vs stateful:** the Lambda code itself is stateless — every invocation starts fresh and pulls all state from Redis. This means deploys are zero-downtime and a cold start is fine.

---

## 3. The pipeline — 10 actions + Stage 3 adaptive weighting

The agent runs **10 actions** sequentially per day. Each action is wrapped in its own try/catch, so one failure doesn't halt the rest. All 10 live in `api/forecast.ts:180-454` (the `runVercelPipeline()` function — yes, the function name still says Vercel; we'll rename during the migration cleanup).

**Sequence:**

| # | Action | Inputs | Output |
|---|---|---|---|
| **Pre-pipeline** | Load yesterday's forecast + adaptive state, fetch today's gold price up front | Redis | Used by adaptive scoring |
| **Adaptive scoring** | Score yesterday's predictions vs today's actual change → award daily bonuses (10/5/0) | yesterday blob, today's gold price, GC=F change | Updates `adaptive_state.json` |
| 1 | News + Groq synthesis | Multi-source URL scrape (max 20) | One-sentence article (Llama 3.3 70B) |
| 2 | NEM + GOLD stock 24h % change | Yahoo Finance | **C1** = avg(NEM, GOLD) |
| 3 | AUD/USD forex | Yahoo Finance | **C2** |
| 4 | SLV silver ETF | Yahoo Finance | **C3** |
| 5 | US Equities (SPY, DIA, QQQ, IWM avg) | Yahoo Finance | **I1** (inverse — contributes −I1) |
| 6 | US Dollar Index (DX-Y.NYB) | Yahoo Finance | **I2** (inverse) |
| 7 | Bond yields via TLT | Yahoo Finance | **I3** (inverse) |
| 8 | Adaptive-weighted forecast | C1–C3, I1–I3, cumulative bonuses | Today's forecast % |
| 9 | Build history CSV row + save tomorrow's dollar forecast | actual gold price, yesterday forecast | Row in `gold_forecast_history.csv`, updated `last_forecast.json` |
| 10 | Deviation log (audit) | actual price, yesterday forecast | Logged to CloudWatch |

**Why 10 actions when the supervisor's PDF only specifies 7?** The original 7 are still all there (1: news, 2-4: C1/C2/C3, 5: display+save, 6: build row, 7: deviation). Stage 2 added 3 inversely-correlated indicators (US equities, DXY, TLT) as Actions 5–7 in the new numbering, which pushed the original "display/save/build/deviation" to Actions 8–10. Functional behavior is a strict superset of the PDF.

### Stage 3 adaptive weighting (`api/adaptive.ts`, 393 lines)

The supervisor's adaptive-weighting upgrade ([`docs/Prompt_for_Upgrading_AI_Agent_v3.docx`](Prompt_for_Upgrading_AI_Agent_v3.docx)) makes the agent self-learning.

**Mechanic** (read `Prompt_for_Upgrading_AI_Agent_v3.docx` for the full spec):

1. Three direct indicators (D1=Mining, D2=AUD/USD, D3=Silver) and three reversal indicators (R1=Equities, R2=DXY, R3=TLT, all stored already-negated for one source of truth).
2. After each day's actual gold change is known, each indicator is scored: absolute error vs the actual change. Within each group of three, **closest = +10, middle = +5, farthest = +0**. Ties split the points (e.g. two-way tie for winner = both get 7.5).
3. We keep a rolling window of the last **10 days** of bonuses. Cumulative bonus per indicator ranges 0–100.
4. Tomorrow's forecast is `Σ(weight_i · pred_i) / Σ(weight_i)` where `weight_i = 100 + cumulative_bonus_i`. Indicators that have been most accurate carry more weight.
5. Edge cases handled in code: zero-information days (actual change < 0.01% AND all preds < 0.01%) are skipped to avoid noise; same-day reruns are idempotent (won't double-count); cold start treats all weights equally.

**Where adaptive plumbs into the pipeline:**

- `api/forecast.ts:218-257` — pre-pipeline scoring of yesterday's predictions
- `api/forecast.ts:377-386` — Action 8 calls `computeAdaptiveForecast` with current cum bonuses
- `api/adaptive.ts:99-133` — state I/O (load/save `adaptive_state.json`)
- `api/adaptive.ts:136-153` — `rankAndAssignBonuses` (the 10/5/0 + tie split)
- `api/adaptive.ts:170-183` — `computeAdaptiveForecast` (the weighted-average formula)
- `api/adaptive.ts:229-341` — `updateDailyBonuses` (the daily cron-side scoring)

The dashboard surfaces all of this — see §7.

### Shared agent code (`gold_forecast_agent.ts`, 551 lines)

Yahoo Finance fetcher, kitco scraper, Groq client, multi-source URL collector, HTML stripper, Toronto-time helpers, log helpers. Imported by both Lambda handlers. No direct external HTTP from the handler files — everything goes through here.

---

## 4. Repository tour

```
agentone/
├── api/
│   ├── forecast.ts        # Lambda: daily cron pipeline (10 actions)
│   ├── history.ts         # Lambda: GET /api/history (dashboard data)
│   └── adaptive.ts        # Stage 3 self-learning module (no handler)
├── gold_forecast_agent.ts # Shared agent helpers (Yahoo, kitco, Groq, CSV, time)
├── public/
│   └── index.html         # Single-page dashboard, no build step
├── test_gold_forecast.ts  # Pipeline unit + structural tests
├── test_adaptive.ts       # Adaptive-module unit tests (run as part of `npm test`)
├── docs/                  # Supervisor materials + this file
├── data/                  # Local-dev only: CSV + last_forecast.json mirror
├── package.json           # npm scripts and deps
├── tsconfig.json          # strict mode, ESNext modules
├── vercel.json            # Vercel cron + maxDuration (legacy; will go after AWS)
└── *.md                   # Project docs (read second after this file)
```

**Project docs (top-level `.md` files), what each one is for:**

| File | What |
|---|---|
| `README.md` | Public-facing project description. Quick start, dashboard URL, pipeline overview. |
| `docs/ONBOARDING.md` | This file. Day-one read for a new team member. |
| `PLANNING.md` | Architecture decisions log, Stage roadmap, PDF discrepancies, AWS migration state. |

The project deliberately keeps to these three docs. Anything else (per-session notes, scratch TODOs, granular review notes) lives in git history, GitHub Issues, or PR descriptions — not in the repo's doc tree.

**Files you should not check in:**
- `.env` (secrets)
- `node_modules/`
- `data/` (local CSV mirrors)
- `.claude/` (per-machine permissions)
- `docs/` is gitignored to keep PDFs out of the repo — supervisor materials live in this directory locally / on shared drive

---

## 5. Local development

**Prerequisites:**
- Node.js 18+ (`fetch` is built in; we don't use external HTTP libraries)
- An `.env` file in `agentone/` (copy `.env.example` and fill in the real values — Olga has the credentials)

**.env keys you need** (see `.env.example`):
```
GROQ_API_KEY=...                    # from console.groq.com (free tier)
UPSTASH_REDIS_REST_URL=...          # from console.upstash.com
UPSTASH_REDIS_REST_TOKEN=...        # same
CRON_SECRET=...                     # any random string for cron auth
```

**Three commands** that cover 95% of local work:

```bash
# Install deps
npm install

# Run the full pipeline once (writes to local data/ AND to Upstash if creds are set)
npx tsx gold_forecast_agent.ts

# Run tests (113 fast tests, ~600ms — typecheck + unit + adaptive)
npm test

# Run the long integration test suite (123 total, ~11s — hits real APIs)
npm run test:long

# Just the typecheck (catches ESM resolution bugs that bundler-mode masks)
npm run typecheck
```

**Reading state without running the pipeline:**
- Local: open `agentone/data/gold_forecast_history.csv` and `agentone/data/last_forecast.json`
- Live: `curl https://agentone-theta.vercel.app/api/history | jq .` (post-migration: same path on the AWS-fronted URL)
- Direct Redis: Upstash REST API — `curl -H "Authorization: Bearer $TOKEN" https://<your-instance>.upstash.io/get/last_forecast.json`

**Editor tips:**
- TypeScript strict mode is on. The project compiles via `tsx` at runtime (no separate build step).
- The dashboard JS is inline in `public/index.html`. Edit and refresh the browser; no bundling.

---

## 6. AWS deployment workflow

> **Status note for the team:** As of Sunday, the project is freshly migrated. If you hit anything in this section that doesn't match reality, page Jan or Olga — the migration likely just finished and a step needs updating.

### Shipping a code change end to end

1. **Branch off `main`**: `git checkout -b feature/your-thing`
2. **Make your change**, write/update tests
3. **Run tests locally**: `npm test` must be green
4. **Push and open a PR** to `main`
5. **CI runs** `npm test` automatically (GitHub Actions; see `.github/workflows/` if it exists, else flag with Jan — adding CI is on the post-migration TODO list)
6. **Merge** the PR
7. **Auto-deploy** kicks off via GitHub Actions → AWS:
   - Forecast Lambda gets the new code (zero downtime — alias swap)
   - History Lambda gets the new code
   - `public/index.html` syncs to S3, CloudFront cache invalidated for that key
8. **Smoke test**:
   - Hit `https://<aws-domain>/api/history` and verify the response shape
   - Open the dashboard and hard-refresh (Ctrl+F5)
   - Check CloudWatch logs for the most recent forecast Lambda invocation
9. **For changes to the daily cron path**, you can manually invoke the forecast Lambda once via the AWS Console (Test event) instead of waiting for 10 AM Toronto

### AWS access and credentials

- **AWS Console access:** Olga distributes IAM users. Each teammate gets read access by default; write access on request.
- **No AWS credentials in the repo.** Ever. We use IAM roles for the Lambda runtime and GitHub Actions OIDC for CI.
- **Local dev does not need AWS credentials** — the pipeline talks to Upstash directly via REST. Only the live deploy talks to AWS.

### Environment variables (where they live)

| Variable | Storage | Read by |
|---|---|---|
| `GROQ_API_KEY` | AWS Secrets Manager | Forecast Lambda |
| `UPSTASH_REDIS_REST_URL` | AWS Secrets Manager | Both Lambdas |
| `UPSTASH_REDIS_REST_TOKEN` | AWS Secrets Manager | Both Lambdas |
| `CRON_SECRET` | Lambda env var | Forecast Lambda (auth check at `api/forecast.ts:464`) |

### Rollback

- **Code rollback:** revert the merge commit on `main`, push. CI redeploys the previous version. ≤2 min end to end.
- **Lambda alias swap:** for an instant rollback without a code revert, swap the production alias to the previous version in the AWS Console.
- **Static asset rollback:** S3 versions every object — restore the previous `index.html` version and invalidate CloudFront.
- **State rollback:** **be careful.** Redis state is shared across all deploys. Don't roll back the data unless you know what you're doing — talk to Jan or Olga first.

### Where the daily cron logs live

CloudWatch Logs → log group `/aws/lambda/agentone-forecast` (or whatever the migration named it). Each daily invocation gets its own log stream, named with the date. The forecast handler writes a `=== Pipeline complete ===` line at the end on success.

---

## 7. Reading the live dashboard

**URL:** https://agentone-theta.vercel.app (post-migration: TBD AWS-fronted URL)

The dashboard auto-refreshes every 60 seconds. Hard-refresh (Ctrl+F5 / Cmd+Shift+R) if you've just deployed and don't see your change.

**Top three cards:**
1. **Today's Gold Price** — kitco spot price at 10 AM Toronto today
2. **Our Prediction for Tomorrow** — yesterday's forecast applied to today's price as `actual × (1 + forecast/100)`. Up/down arrow shows direction vs current.
3. **How Close Were We?** — `actual − predicted` from the most recent fully-scored day. Green if under $50, red otherwise.

**News Analysis & Market Signals box:**
- Llama 3.3 70B's one-sentence article from this morning's run
- Net signal as a single number (% expected change)
- When adaptive weights exist (after day 1), this section becomes **two side-by-side cards**: "Adaptive (Stage 3)" vs "Equal weight (Stage 2)" with a "shifted by ±X% vs flat average" line. This is the spec §6 acceptance test view.
- Per-indicator pills showing each signal's raw value and its contribution

**Adaptive Weighting panel** (Stage 3):
- "Warming up" badge in yellow until 10 days of history; "Mature" in green at day 10+
- Six indicator rows (only render once we have at least 1 day of data — empty state shows just the explainer)
- Each row: indicator name, current cumulative bonus, weight (100 + bonus), share of total weight pool, colored bar
- Direct-group bars are green (Mining / AUD/USD / Silver), reversal-group bars are blue (Equities / DXY / TLT)

**Actual vs Predicted chart:** historical price (gold line) + our forecast (blue dashed). Closer = better.

**Prediction History table:**
- One row per day. Today's row is highlighted with a yellow left border.
- Click a row to expand the per-indicator breakdown for that day.
- The Net Signal column uses adaptive weights when available, equal weight when not.

---

## 8. PDF discrepancies / open questions

These are inherited from the supervisor's PDF spec. Olga's instruction is **follow the PDF literally; flag discrepancies but don't unilaterally "fix" them.**

### % vs $ dimensional mismatch (the big one)

The PDF says `deviation = actual_gold_price − forecast`. But `actual` is dollars (e.g. $4,700) and `forecast` is a percentage (e.g. +0.45%). Subtracting them is dimensionally inconsistent.

Our compromise (`api/forecast.ts:402-410`):
- **Deviation** is computed against yesterday's *dollar* forecast, which we compute as `actual × (1 + percent_forecast/100)` and store in `last_forecast.json`. So the math works out and the dashboard shows reasonable dollar deviations.
- We also save the percent forecast for next-day's display.

This is documented in `PLANNING.md` under "PDF Discrepancies Found." Before changing any forecast/deviation logic, raise it with Olga.

### Action 6 / Action 7 overlap

The PDF has Action 6 building a CSV row and Action 7 also computing deviation. We split them: Action 9 (build row) and Action 10 (log deviation as audit). Functionally equivalent, but if you read the PDF and the code side by side this is the gap.

### Stock ticker typo

The PDF says "Newmont (NEW)" on page 1 and "Newmont Corp (NEM)" on page 2. The correct ticker is **NEM**. Don't get confused.

### Other inherited issues

Low-priority cleanup items worth knowing about:
- A few `try/catch` blocks log a warning but swallow the actual error type.
- `torontoNow()` returns system local time, not strictly Toronto — only affects log timestamps, not forecasts.
- The pipeline's function name still says `runVercelPipeline()` — rename during the AWS cleanup pass.

---

## 9. Stage 4 / future work

**Stage 4 (current — AWS migration + ops):** the migration is the immediate work. Once it's done and stable for ~10 days, we'll have the first full "mature" adaptive weighting window and can do the §6 acceptance test (compare adaptive vs equal-weight error rates).

**Stage 5 (future — AI Michel):** see `docs/AI_Michel_Project_v1.pdf`. Three agents in a neurotropic architecture (Sensor → Consciousness → Action) using LangChain + CrewAI + ChromaDB + Ollama. Most likely deployed on ECS Fargate (long-running) rather than Lambda. We are **not** building this now; the agent is structured so it can evolve into Sensor in V2 without rewriting.

**Today's "TODO once X" list** (open items as of this writing):
- [ ] Rotate the Upstash REST token (it appeared in cached `.claude/settings.local.json` previously — treated as compromised)
- [ ] Add CI workflow (GitHub Actions running `npm test` on PR) if not done as part of the AWS migration
- [ ] Decide ElastiCache vs Upstash long-term (Upstash is fine for now)
- [ ] Write Terraform / CDK templates if the migration was done by hand-clicking
- [ ] First §6 acceptance test result: 10 days after the first adaptive-eligible run, compare the adaptive forecast's mean abs error vs equal-weight on the same data. Should be lower; if not, surface it to Olga.
- [ ] Rename `runVercelPipeline()` → `runDailyPipeline()` and remove `vercel.json` once AWS is stable

---

## 10. People & cadence

| Role | Who | What they do |
|---|---|---|
| Supervisor | **Olga Grass** (AI SYNT, `aisyntinc@gmail.com`) | Approves spec changes; sole authority on PDF interpretation |
| Technical lead | **Dr. Alex** | Architecture review; future direction |
| Original author | **Jan Fontanilla** (`janfontanilla12@gmail.com`) | Available for handoff questions |
| New team | Qasem, Dilwod, Yatharth | Stage 4 ownership |

**Daily artefact:** the 10:00 AM Toronto cron run. Within ~60s a new row appears in the dashboard. If a day passes without a new row, check CloudWatch.

**Weekly cadence (suggested):**
- Skim `gold_forecast_history.csv` rows for the week — sanity check deviations
- Check the adaptive weighting panel — flag any indicator stuck at 0 cumulative bonus for 10+ consecutive days (means it's never the closest predictor; possibly miscalibrated or genuinely uninformative)
- Sync with Olga on direction; raise any PDF-discrepancy questions

**Communications:**
- Code questions and infra issues: GitHub PRs / Issues, plus Slack/email
- Spec questions: email Olga, copy Dr. Alex
- Don't make spec-level changes without Olga's sign-off

---

## 11. Quick-reference appendix

### A. All environment variables

| Name | Storage | Read by | Notes |
|---|---|---|---|
| `GROQ_API_KEY` | AWS Secrets Manager (prod), `.env` (local) | `gold_forecast_agent.ts:316` | Free tier at console.groq.com |
| `UPSTASH_REDIS_REST_URL` | Secrets Manager | `Redis.fromEnv()` in `api/forecast.ts:38`, `api/history.ts:16` | |
| `UPSTASH_REDIS_REST_TOKEN` | Secrets Manager | Same | |
| `CRON_SECRET` | Lambda env var | `api/forecast.ts:464` | Bearer-token auth on the cron endpoint |
| `RUN_LONG_TESTS` | Local-only | `test_gold_forecast.ts:699` | Set to `1` to enable the long integration test |

### B. All Redis keys

| Key | Schema | Written by | Read by |
|---|---|---|---|
| `gold_forecast_history.csv` | CSV: `date,actual_gold_price,forecast,deviation` | `appendCsvRow()` `forecast.ts:68` | `api/history.ts:36` (dashboard) |
| `last_forecast.json` | `{date, forecast, c1..i3, article, actual_gold_price}` | `saveTodayForecast()` `forecast.ts:102` | Next day's run; `loadYesterdayBlob()` `adaptive.ts:118` |
| `analysis_history.json` | Array of daily analyses (date, article, c1..i3) — capped at 365 | `saveAnalysisEntry()` `forecast.ts:122` | `api/history.ts:38` (dashboard expand rows) |
| `adaptive_state.json` | `{history: AdaptiveEntry[]}` — bounded at 10 | `saveAdaptiveState()` `adaptive.ts:111` | `loadAdaptiveState()` `adaptive.ts:98`, `api/history.ts:108` |
| `gold_forecast_accuracy.csv` | Audit CSV per spec §3.5 (24 columns) | `appendAccuracyCsvRow()` `adaptive.ts:345` | Manual review |
| `gold_forecast_accuracy_legacy.csv` | Archive when the CSV header drifts | Same | Never (archival only) |

### C. Useful commands

```bash
# Run the full pipeline locally
npx tsx gold_forecast_agent.ts

# Run tests
npm test                                # 113 fast (typecheck + unit + adaptive)
npm run test:long                       # 123 with integration tests
npm run typecheck                       # just the strict TS pass

# Hit the live history endpoint
curl https://agentone-theta.vercel.app/api/history | jq .

# Manually invoke the live forecast (don't do this casually — it writes state)
curl -X POST https://agentone-theta.vercel.app/api/forecast \
  -H "Authorization: Bearer $CRON_SECRET"

# Read a single Redis key directly via Upstash REST
curl -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  $UPSTASH_REDIS_REST_URL/get/last_forecast.json

# Tail CloudWatch logs for the forecast Lambda (post-migration)
aws logs tail /aws/lambda/agentone-forecast --follow
```

### D. Glossary

| Term | Meaning |
|---|---|
| **C1, C2, C3** | The three "direct" coefficients: rising = gold up. C1 = avg(NEM, GOLD), C2 = AUD/USD, C3 = SLV. |
| **I1, I2, I3** | The three "inverse" indices (raw values). I1 = US Equities, I2 = DXY, I3 = TLT. Stored as raw %, contributed to forecast as `−Ix`. |
| **D1, D2, D3 / R1, R2, R3** | Adaptive-module names for the same six indicators. R-keys store the negated form (already `-Ix`) so there's one source of truth in the math. |
| **bonus** | Daily 10/5/0 points awarded by accuracy rank within each group of three. Ties split. |
| **cumulative bonus** | Sum of the last 10 days' bonuses for one indicator. Range 0–100. |
| **weight** | `100 + cumulative_bonus`. Range 100–200. Drives the adaptive forecast formula. |
| **share** | One indicator's `weight / total_weight`, expressed as a percent. The fraction of tomorrow's forecast that this indicator drives. |
| **maturity** | "Warming up" if `historyDays < 10`; "Mature" at 10. Surfaced in the dashboard. |
| **zero-information day** | When `|actual change| < 0.01%` AND all preds are < 0.01%. We skip bonus updates on such days to avoid noise. |
| **Toronto time** | The agent's canonical timezone. `America/Toronto` via `Intl.DateTimeFormat`. Handles DST automatically. |

---

**Welcome again. Ship something on day one — even a typo fix in this doc — to validate the deploy pipeline end to end.**
