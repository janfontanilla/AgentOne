# Planning, Architecture, and Decisions

Single source of truth for **why the agent is shaped the way it is**. Read [README.md](README.md) for *what it does* and [docs/ONBOARDING.md](docs/ONBOARDING.md) for *how to start working on it*. This file is for context that doesn't fit in either: the decision log, the PDF discrepancies, the stage roadmap, and the design rationale behind the adaptive-weighting layer.

---

## 1. Stage Roadmap

The project is delivered in stages. Each stage corresponds to a supervisor-issued spec or a deployment milestone.

| Stage | Scope | Status | Driver |
|---|---|---|---|
| 1. Three-coefficient pipeline | NEM+GOLD avg, AUDUSD, SLV → average → forecast % | Complete (2026-03-28) | `docs/Gold_Forecast_Spec_v1.pdf` |
| 2. Six-indicator pipeline | Add inverse signals: US Equities (avg), DXY, TLT (negated) | Complete (2026-04) | Internal expansion |
| 3. Adaptive weighting | Self-learning 10/5/0 bonus + rolling 10-day cumulative weights | Complete (2026-04→2026-05) | `docs/Prompt_for_Upgrading_AI_Agent_v3.docx` |
| 4. AWS migration + ops | EventBridge + Lambda + S3/CloudFront + (Upstash or DynamoDB) | **In progress** | `docs/Server_Hosting_Meeting_Notes.docx` |
| 5. AI Michel | 3-agent neurotropic architecture (Sensor → Consciousness → Action) | Future | `docs/AI_Michel_Project_v1.pdf` |

Stage labels were removed from the live dashboard for a cleaner public face, but the internal taxonomy above survives in code paths and docs.

---

## 2. Decision Log

Append-only. Newest first.

| Date | Decision | Why | Alternatives considered |
|---|---|---|---|
| 2026-05-01 | Switch actual-gold reference to **GLD** (was GC=F) for adaptive scoring | Spec §5 names GLD explicitly; close-to-close consistent with other Yahoo indicators | Keep GC=F (consistency but unnamed in spec), use kitco spot (24/7, dimensionally inconsistent) |
| 2026-05-01 | **Strict 10/5/0** ranking; ties resolved by sort stability | Spec §3.3 calls bonuses "an integer between 0 and 100"; fractional ties violated that | Fractional split (mathematically fair but extra-spec) |
| 2026-05-01 | **Drop** zero-information-day skip | Spec only requires skipping when actual price is missing; the broader skip was extra-spec | Tighter epsilon (still extra-spec), keep as-is |
| 2026-04-26 | Adaptive layer in **separate module** `api/adaptive.ts` | Isolates self-learning logic from the legacy pipeline; testable independently | Inline in `forecast.ts` (couples concerns) |
| 2026-04-26 | Persist adaptive state in **Upstash Redis** | Same store the rest of the pipeline already uses | DynamoDB (extra service for V1), Vercel KV (vendor lock-in) |
| 2026-04 | **Six** indicators (added inverse SPY/DIA/QQQ/IWM, DXY, TLT) | Improves signal quality; reversal indicators capture macro drag on gold | Stay with 3 (loses DXY signal), add commodities (more correlated) |
| 2026-03-28 | **Drop Base44**, go standalone TypeScript | Free plan too limited for continued dev | Stay on Base44 (blocked), Python rewrite (loses TS toolchain) |
| 2026-03-28 | **npx tsx** for execution | Runs TS directly, no build step | tsc + node (extra step), Deno (different runtime) |
| 2026-03-28 | **Single-file agent** (`gold_forecast_agent.ts`) | All 7 actions + helpers in one file for V1 simplicity | Multi-file module structure (overkill at this stage) |
| 2026-03-28 | **Yahoo Finance HTTP API** | Free, no API key, covers all symbols | Alpha Vantage (rate-limited), yfinance Python (wrong runtime) |
| 2026-03-28 | **Groq + Llama 3.3 70B** for news synthesis | PDF spec names Llama 3.3 70B; Groq has free tier | OpenAI (paid), local Ollama (heavy infra) |
| 2026-03-28 | **HTML stripping** for readability | Lightweight, no external deps | readability-lxml (Python only), Puppeteer (heavy) |
| 2026-03-28 | **Multi-source URL collection** | Google alone gets blocked by CAPTCHA | Single source (unreliable) |
| 2026-03-24 | **CSV** for forecast history (not SQLite) | PDF spec requires CSV, simpler for V1 | SQLite (overkill), Base44 DB (later abandoned) |
| 2026-03-24 | **last_forecast.json** for cross-day handoff | PDF requires storing today's forecast for next day | Extra CSV column (messier), SQLite (overkill) |

---

## 3. Stage 3 — Adaptive Weighting (design notes)

Implementation lives in [api/adaptive.ts](api/adaptive.ts) and is invoked from [api/forecast.ts](api/forecast.ts) before the indicator-fetching block. Source spec: `docs/Prompt_for_Upgrading_AI_Agent_v3.docx`.

### Indicator mapping

| Spec name | Code key | Source | Group | Sign convention |
|---|---|---|---|---|
| D1 | `c1` | avg(NEM%, GOLD%) | Direct | Stored as raw % |
| D2 | `c2` | AUDUSD=X % | Direct | Stored as raw % |
| D3 | `c3` | SLV % | Direct | Stored as raw % |
| R1 | `r1 = -i1` | avg(SPY,DIA,QQQ,IWM) % | Reversal | Stored **already-negated** |
| R2 | `r2 = -i2` | DX-Y.NYB % | Reversal | Stored **already-negated** |
| R3 | `r3 = -i3` | TLT % | Reversal | Stored **already-negated** |

Reversal predictions are negated **once** before storage so there's a single source of truth and no sign-drift bugs downstream.

### Persistence (Upstash Redis keys)

| Key | Contents |
|---|---|
| `last_forecast.json` | Yesterday's blob: date, dollar forecast, six indicator readings, actual gold price |
| `adaptive_state.json` | Rolling 10-day FIFO history of `{date, actualChangePct, preds, errors, bonuses}` |
| `gold_forecast_accuracy.csv` | Per-day audit log; columns match spec §3.5 literally |
| `gold_forecast_accuracy_legacy.csv` | Auto-archived copy if the live header drifts from the spec |
| `gold_forecast_history.csv` | The user-visible CSV: `date, actual_gold_price, forecast, deviation` |
| `analysis_history.json` | Per-day article + raw indicator readings, capped at 365 days |

### Pipeline ordering (spec §3.1)

The 10 AM Toronto cron runs in this order:

1. Load `last_forecast.json` (yesterday's blob).
2. Fetch today's actual gold price (kitco, Yahoo fallback).
3. **Score yesterday's predictions** against today's actual change → update `adaptive_state.json` and append a row to `gold_forecast_accuracy.csv`.
4. Fetch today's six indicators (Actions 1–7).
5. Compute today's forecast as the **adaptively-weighted** average using the freshly-updated bonuses (Action 8).
6. Write the daily CSV row and save tomorrow's blob (Actions 9–10).

This implements spec §3.1's allowed alternative: "the main 10:00 AM run can first load the previous day's actual data and update bonuses, then generate the new prediction." The adaptive weights for today therefore include yesterday's freshly-scored bonuses.

### Self-learning math (spec §4)

```
error_i        = |pred_i − actual_change_pct|
rank_i         = sort ascending by error within {direct} and {reversal} separately
bonus_i        = 10 if rank==1, 5 if rank==2, 0 if rank==3
cum_bonus_i    = sum(daily_bonus_i over last 10 entries)   # FIFO trimmed
weight_i       = 100 + cum_bonus_i
forecast       = Σ(weight_i × pred_i) / Σ(weight_i)
```

Ties are broken by sort stability (preserves input array order), which keeps cumulative bonuses as integers in the spec's stated 0–100 range.

---

## 4. PDF Spec Discrepancies (flagged, not silently fixed)

Per supervisor's instruction, follow the PDF literally and surface mismatches rather than working around them.

### From `Gold_Forecast_Spec_v1.pdf`

1. **Forecast % vs actual $ mismatch (major).** PDF says forecast = avg(C1, C2, C3) (a percentage like 0.45) and deviation = actual − forecast (a dollar minus a percentage). Likely intent: apply forecast as `yesterday_price * (1 + forecast/100)`. Our pipeline saves a dollar forecast for next-day comparison while still logging the raw percentage. Open with Olga.
2. **Action 6 / Action 7 overlap.** PDF has both actions handling deviation. We split the work: Action 9 builds the row, Action 10 logs the deviation as a separate audit step.
3. **Stock ticker typo.** Page 1 says "Newmont (NEW)"; page 2 says "Newmont Corp (NEM)". We use **NEM** (correct).

### From `Prompt_for_Upgrading_AI_Agent_v3.docx`

4. **Spec is silent on tie handling.** We resolve by stable sort and keep bonuses as integers. Defensible reading of §3.3.
5. **Spec says the actual-change reference can be "Kitco, GoldAPI, or Yahoo Finance for GLD ETF"** (§5). We use GLD because it's named in the spec and is close-to-close like the other Yahoo indicators.
6. **Spec only mentions skipping comparison on missing actual price** (§5). We comply — no broader zero-information-day skip.

---

## 5. AWS Migration (Stage 4) — open decisions

Tracked here as decisions are made. Source meeting notes: `docs/Server_Hosting_Meeting_Notes.docx`.

| Decision | Status | Notes |
|---|---|---|
| State store | **Open** | Keep Upstash Redis (less migration work) vs. move to DynamoDB (AWS-native). |
| IaC tool | **Open** | SAM (simple), CDK (TS-native), or Terraform (org-standard?). |
| Static dashboard host | Likely S3 + CloudFront | Existing `public/index.html` is build-step-free. |
| Cron | EventBridge schedule rule | `0 14 * * ? *` (= 10 AM Toronto). |
| Auth on `/api/forecast` | **Open** | EventBridge invokes Lambda directly (IAM) or shared secret in env. |
| Lambda handler shim | Not started | Wrap existing `api/forecast.ts` handler with `APIGatewayProxyHandlerV2`. |

---

## 6. Open Questions

- [ ] Forecast % vs actual $ — confirm intent with Olga before AWS cutover so the new deployment doesn't perpetuate a possible bug.
- [ ] AWS state store: Upstash Redis vs DynamoDB.
- [ ] AWS IaC tool choice.
- [x] Whether kitco.com requires a headless browser → simple HTTP works, with Yahoo fallback.
- [x] Rate limits on Google search for 20 URLs → mitigated with multi-source collection.
- [x] Whether Stage 3 spec was implemented faithfully → audit complete 2026-05-01, six minor deviations identified, five tightened, one (zero-info skip) removed.
