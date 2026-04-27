# Adaptive Weighting Self-Learning Mechanism — Implementation Plan

**Status:** Ready to implement
**Target:** [agentone/api/forecast.ts](agentone/api/forecast.ts) (deployed Vercel pipeline only)
**Author:** Planning session, 2026-04-26
**Spec source:** "Prompt for Upgrading AI Agent: Adaptive Weighting via Historical Accuracy" (supervisor)

---

## 1. Goal

Replace the current equal-weight 6-indicator forecast formula with an adaptive weighting scheme. Each indicator earns daily bonus points (10/5/0) based on prediction accuracy ranked within its group (3 direct, 3 reversal). A rolling 10-day cumulative bonus (0–100) reweights tomorrow's forecast as `weight_i = 100 + cumulative_bonus_i`.

**Core principle:** more accurate indicators get more influence.

---

## 2. Architecture (verified against codebase)

### Two entry points, one library
- [agentone/gold_forecast_agent.ts](agentone/gold_forecast_agent.ts) — library + local-dev runner (3-coefficient pipeline). **NOT touched by this plan.**
- [agentone/api/forecast.ts](agentone/api/forecast.ts) — deployed Vercel cron agent (6-indicator pipeline). **This is what we upgrade.**

### Indicator mapping (confirmed at [forecast.ts:303](agentone/api/forecast.ts#L303))

| Spec name | Code variable | Source | Group |
|-----------|---------------|--------|-------|
| D1 | `c1` | avg(NEM%, GOLD%) | Direct (gold ↑ when ↑) |
| D2 | `c2` | AUDUSD=X % | Direct |
| D3 | `c3` | SLV % | Direct |
| R1 | `r1 = -i1` | avg(SPY,DIA,QQQ,IWM) % negated | Reversal (gold ↓ when ↑) |
| R2 | `r2 = -i2` | DX-Y.NYB % negated | Reversal |
| R3 | `r3 = -i3` | TLT % negated | Reversal |

Reversal predictions are stored **already-converted (negated)** in adaptive state. Single source of truth, no sign-drift bugs.

### Persistence
Upstash Redis (matches existing pattern at [forecast.ts:29](agentone/api/forecast.ts#L29)). New keys:
- `adaptive_state.json` — rolling 10-day bonus history
- `gold_forecast_accuracy.csv` — per-day audit log (unbounded growth, monitored)

---

## 3. Files Changed

### New files

**`agentone/api/adaptive.ts`** (~200 lines) — All adaptive logic isolated here.

Exports:
- `loadAdaptiveState(redis): Promise<AdaptiveState>`
- `saveAdaptiveState(redis, state): Promise<void>`
- `loadYesterdayBlob(redis): Promise<YesterdayBlob | null>`
- `updateDailyBonuses(redis, today, todayActualPrice, yesterdayBlob): Promise<void>`
- `computeCumulativeBonuses(state): IndicatorMap`
- `computeAdaptiveForecast(preds, cumBonuses): number`
- `rankAndAssignBonuses(group, errors): Record<IndicatorKey, number>` (tie-aware)
- `isZeroInformationDay(actualChangePct, preds): boolean`
- `appendAccuracyCsvRow(redis, entry, cumBonuses): Promise<void>`

**`agentone/test_adaptive.ts`** — Unit tests (see §8).

### Edited files

**`agentone/api/forecast.ts`** — 5 surgical edits:

1. Import adaptive module functions
2. Reorder: move kitco fetch from Action 9 to before Action 1
3. Insert wrapped adaptive block (try/catch) after kitco fetch, before Action 1
4. Replace Action 8 forecast formula at [forecast.ts:303](agentone/api/forecast.ts#L303) with weighted version
5. Extend `saveTodayForecast` extras to include `actual_gold_price`

**`agentone/README.md`** — New "Self-Learning Adaptive Weighting" section.

**`CHANGELOG.md`**, **`PROGRESS.md`**, **`PLANNING.md`** — Decision log entries.

### Untouched (verified safe)
- [agentone/gold_forecast_agent.ts](agentone/gold_forecast_agent.ts) — local-dev pipeline unchanged
- [agentone/api/history.ts](agentone/api/history.ts) — read-only API unaffected
- [agentone/public/index.html](agentone/public/index.html) — dashboard reads existing fields; minor inconsistency flagged in §11

---

## 4. Data Schemas

### `adaptive_state.json` (Redis key)

```typescript
type IndicatorKey = "d1" | "d2" | "d3" | "r1" | "r2" | "r3";
type IndicatorMap = Record<IndicatorKey, number>;

interface AdaptiveEntry {
  date: string;             // YYYY-MM-DD (Toronto), the day predictions were MADE
  actualChangePct: number;  // measured the next day
  preds: IndicatorMap;      // r1/r2/r3 already negated
  errors: IndicatorMap;     // |pred - actual|
  bonuses: IndicatorMap;    // 10 / 5 / 0 (or fractional on ties)
}

interface AdaptiveState {
  history: AdaptiveEntry[]; // chronological, max 10 entries (FIFO)
}
```

### Extended `last_forecast.json` (existing Redis key)

Add one field: `actual_gold_price: number`. Backward compatible — old blobs without this field trigger graceful skip on first post-deploy run.

### `gold_forecast_accuracy.csv` (Redis key, CSV-formatted string)

Columns:
```
date,actual_change_pct,
pred_d1,pred_d2,pred_d3,pred_r1,pred_r2,pred_r3,
err_d1,err_d2,err_d3,err_r1,err_r2,err_r3,
bonus_d1,bonus_d2,bonus_d3,bonus_r1,bonus_r2,bonus_r3,
cum_d1,cum_d2,cum_d3,cum_r1,cum_r2,cum_r3
```

Idempotency: same find-by-date-and-merge pattern as [forecast.ts:67](agentone/api/forecast.ts#L67).

---

## 5. Core Math

### Daily bonus assignment (§3.2 of spec)

```
For each group (direct, reversal):
  errors[k] = |preds[k] - actualChangePct|
  sorted = stable-sort group by error ascending
  Assign points [10, 5, 0] to positions [0, 1, 2]
  On ties: distribute average of tied positions (see §6 fix 3)
```

### Cumulative bonus (§3.3)

```
cumulativeBonus[k] = sum of bonuses[k] across all entries in state.history
                   ∈ [0, 100]  (max 10 entries × 10 points)
```

### Adaptive forecast (§3.4)

```
weight[k] = 100 + cumulativeBonus[k]    ∀ k ∈ {d1,d2,d3,r1,r2,r3}
totalWeight = Σ weight[k]
forecast = Σ (preds[k] × weight[k]) / totalWeight
```

**Empty-history equivalence:** all bonuses = 0 → all weights = 100 → `forecast = (d1+d2+d3+r1+r2+r3) × 100 / 600 = (d1+d2+d3+r1+r2+r3) / 6`. Numerically equivalent (within float epsilon) to the existing equal-weight formula. Day 1 produces the same forecast as today's code.

---

## 6. Concrete Bug Fixes (from adversarial review)

### Fix 1 — Strict numeric guards in `updateDailyBonuses`

```typescript
async function updateDailyBonuses(redis, today, todayActualPrice, yesterdayBlob) {
  if (!yesterdayBlob) {
    log("Adaptive: no yesterday data — skipping bonus update");
    return;
  }
  const yesterdayActual = yesterdayBlob.actual_gold_price;
  if (typeof yesterdayActual !== "number" || !isFinite(yesterdayActual) || yesterdayActual <= 0) {
    log(`Adaptive: yesterday actual_gold_price missing/invalid (${yesterdayActual}) — skipping`);
    return;
  }
  if (typeof todayActualPrice !== "number" || !isFinite(todayActualPrice) || todayActualPrice <= 0) {
    log(`Adaptive: today actual_gold_price invalid — skipping`);
    return;
  }
  for (const k of ["c1","c2","c3","i1","i2","i3"] as const) {
    if (typeof yesterdayBlob[k] !== "number" || !isFinite(yesterdayBlob[k])) {
      log(`Adaptive: yesterday ${k} missing/invalid — skipping`);
      return;
    }
  }
  // ...safe to proceed
}
```

**Prevents:** NaN propagation when first post-deploy run reads old blob without `actual_gold_price`.

### Fix 2 — Same-day guard + idempotency check

```typescript
async function loadYesterdayBlob() {
  const raw = await readKey("last_forecast.json");
  if (!raw) return null;
  const data = JSON.parse(raw);
  if (data.date === torontoDateStr()) {
    log("Adaptive: last_forecast.json is from today (same-day rerun) — no yesterday data");
    return null;
  }
  return data;
}

// Inside updateDailyBonuses, before push:
if (state.history.some(e => e.date === yesterdayBlob.date)) {
  log(`Adaptive: bonuses for ${yesterdayBlob.date} already recorded — skipping duplicate`);
  return;
}
```

**Prevents:** Cron retry within 60s corrupting state by scoring today's predictions against themselves.

### Fix 3 — Zero-information day detection + tie-aware bonuses

```typescript
function isZeroInformationDay(actualChangePct: number, preds: IndicatorMap): boolean {
  const EPSILON = 0.01;  // 0.01% — smaller than meaningful market movement
  if (Math.abs(actualChangePct) > EPSILON) return false;
  return (Object.values(preds) as number[]).every(p => Math.abs(p) < EPSILON);
}

function rankAndAssignBonuses(group: IndicatorKey[], errors: IndicatorMap) {
  const sorted = [...group].sort((a, b) => errors[a] - errors[b]);
  const points = [10, 5, 0];
  const bonuses: Record<string, number> = {};
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && errors[sorted[j]] === errors[sorted[i]]) j++;
    const tiedPoints = points.slice(i, j);
    const avg = tiedPoints.reduce((a,b) => a+b, 0) / tiedPoints.length;
    for (let k = i; k < j; k++) bonuses[sorted[k]] = avg;
    i = j;
  }
  return bonuses;
}
```

**Prevents:**
- Weekend bias from deterministic alphabetical tie-breaking (~520 spurious points/year toward d1/r1)
- Real-data ties producing arbitrary winners

### Fix 3.5 — Per-day summary log matching spec §3.5 format

After computing bonuses inside `updateDailyBonuses`, emit the structured summary the spec requires:

```typescript
function emitDailySummary(date: string, actualChangePct: number, preds: IndicatorMap, errors: IndicatorMap, bonuses: IndicatorMap, cumBonuses: IndicatorMap) {
  const fmt = (k: IndicatorKey, label: string) =>
    `${label} (error ${errors[k].toFixed(2)}%, bonus +${bonuses[k]})`;

  const directRanked = (["d1","d2","d3"] as const).sort((a,b) => errors[a] - errors[b]);
  const reversalRanked = (["r1","r2","r3"] as const).sort((a,b) => errors[a] - errors[b]);

  const labels: Record<IndicatorKey, string> = {
    d1: "Mining(C1)", d2: "AUDUSD(C2)", d3: "Silver(C3)",
    r1: "Equities(R1)", r2: "DXY(R2)", r3: "TLT(R3)",
  };

  log(`Adaptive: Date: ${date}`);
  log(`Adaptive: Actual gold change: ${actualChangePct >= 0 ? "+" : ""}${actualChangePct.toFixed(2)}%`);
  log(`Adaptive: Direct group: Winner=${fmt(directRanked[0], labels[directRanked[0]])}, Middle=${fmt(directRanked[1], labels[directRanked[1]])}, Loser=${fmt(directRanked[2], labels[directRanked[2]])}`);
  log(`Adaptive: Reversal group: Winner=${fmt(reversalRanked[0], labels[reversalRanked[0]])}, Middle=${fmt(reversalRanked[1], labels[reversalRanked[1]])}, Loser=${fmt(reversalRanked[2], labels[reversalRanked[2]])}`);
  log(`Adaptive: Cumulative bonuses after today: D1=${cumBonuses.d1}% D2=${cumBonuses.d2}% D3=${cumBonuses.d3}%; R1=${cumBonuses.r1}% R2=${cumBonuses.r2}% R3=${cumBonuses.r3}%`);
}
```

**Matches spec §3.5 example output exactly.**

### Fix 4 — Top-level try/catch in pipeline call site

```typescript
// In runVercelPipeline(), after kitco fetch:
let cumBonuses: IndicatorMap = { d1: 0, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 };
try {
  log("Adaptive: updating daily bonuses from yesterday's predictions...");
  const yesterdayBlob = await loadYesterdayBlob(redis);
  await updateDailyBonuses(redis, today, actualGoldPrice, yesterdayBlob);
  const state = await loadAdaptiveState(redis);
  cumBonuses = computeCumulativeBonuses(state);
  log(`Adaptive: cum bonuses → D1=${cumBonuses.d1} D2=${cumBonuses.d2} D3=${cumBonuses.d3} | R1=${cumBonuses.r1} R2=${cumBonuses.r2} R3=${cumBonuses.r3}`);
} catch (e: any) {
  log(`Adaptive ERROR: ${e.message}. Falling back to equal weights.`);
  // cumBonuses stays at zeros → weights all 100 → equivalent to old formula
}
```

**Prevents:** Adaptive subsystem failure halting the entire forecast pipeline. Matches per-action try/catch convention from [.claude/rules/error-handling.md](.claude/rules/error-handling.md).

---

## 7. Pipeline Sequencing (after upgrade)

```
1. Load yesterdayBlob (full last_forecast.json including actual_gold_price)
2. Fetch today's actual gold price (kitco → Yahoo fallback)  [MOVED UP from Action 9]
3. Adaptive block (try/catch):
   a. updateDailyBonuses(today, actualGoldPrice, yesterdayBlob)
   b. cumBonuses = computeCumulativeBonuses(state)
   c. appendAccuracyCsvRow if bonuses were updated
4. Action 1: news article (Groq Llama 3.3 70B)
5. Actions 2–4: c1, c2, c3 (mining stocks, AUD/USD, SLV)
6. Actions 5–7: i1, i2, i3 (equities, DXY, TLT)
7. Action 8 (modified): adaptive forecast = computeAdaptiveForecast(preds, cumBonuses)
8. Action 9: append CSV row, save last_forecast.json (now with actual_gold_price)
9. Action 10: deviation log
```

Only structural change: kitco fetch moves from Action 9 to before Action 1. Required because the adaptive block needs today's actual price to compute yesterday's actualChangePct. Action 9 reuses the already-fetched value (no double fetch).

---

## 8. Test Plan

### `agentone/test_adaptive.ts` — new test file

| # | Test | Purpose |
|---|------|---------|
| 1 | `rankAndAssignBonuses` assigns 10/5/0 by error rank | Spec §3.2 correctness |
| 2 | Three-way tie distributes 5/5/5 | Fix 3 verification |
| 3 | Two-way top tie distributes 7.5/7.5/0 | Fix 3 edge case |
| 4 | `computeCumulativeBonuses` sums history correctly | Spec §3.3 |
| 5 | Empty history → forecast equals equal-weight formula (within 1e-10) | Day 1 rollout safety |
| 6 | One indicator at bonus=100, others=0 → ~28.6% influence | Sanity check on weights |
| 7 | `updateDailyBonuses` skips when `yesterdayBlob = null` | Fix 1 |
| 8 | Skips when `actual_gold_price` is undefined/null/0/NaN | Fix 1 |
| 9 | Skips when any indicator field is missing | Fix 1 |
| 10 | Skips when blob.date === today (same-day rerun) | Fix 2 |
| 11 | Idempotent: calling twice with same yesterdayBlob doesn't double-append | Fix 2 |
| 12 | `isZeroInformationDay` returns true on flat day | Fix 3 |
| 13 | `isZeroInformationDay` returns false on real movement | Fix 3 |
| 14 | Adaptive block try/catch swallows errors, returns zero-bonuses | Fix 4 |
| 15 | 15-day simulation: adaptive avg error ≤ equal-weight avg error | Spec §6 |
| 16 | Summary log contains "Date:", "Actual gold change:", "Direct group: Winner=", "Reversal group: Winner=", "Cumulative bonuses after today:" | Spec §3.5 format compliance |

### Test infrastructure

Use existing `npx tsx --test` pattern from [agentone/test_gold_forecast.ts](agentone/test_gold_forecast.ts). Mock Redis with an in-memory map. No live API calls in tests.

---

## 9. Rollout Plan

### Phase A — Code (Day 0)
1. Implement `adaptive.ts` with all 9 exports
2. Implement `test_adaptive.ts` with 15 tests
3. Edit `forecast.ts` (5 surgical changes)
4. Run `npm test` — all tests must pass
5. Manual local dry-run with mocked Redis

### Phase B — Deploy (Day 1)
1. Push to main → Vercel auto-deploys
2. First cron run at 14:00 UTC: bonus update **skips** (old blob lacks `actual_gold_price`), forecast uses equal weights (history empty), `last_forecast.json` written with all new fields including `actual_gold_price`
3. Verify logs show: `Adaptive: yesterday actual_gold_price missing/invalid — skipping`
4. Verify forecast value matches what old code would have produced

### Phase C — Accumulation (Days 2–10)
Each day: bonus update runs, history grows by 1 entry, cumulative bonuses ramp up. Forecast diverges slightly from equal-weight as weights shift. Compare adaptive vs equal-weight in logs each day.

### Phase D — Steady state (Day 11+)
Rolling window stable at 10 entries. Daily cycle: append new entry, drop oldest.

### Rollback procedure
1. Revert [forecast.ts](agentone/api/forecast.ts) Action 8 to old `/6` formula
2. Adaptive Redis keys (`adaptive_state.json`, `gold_forecast_accuracy.csv`) become harmless leftovers — delete via Upstash console if desired
3. No data loss in `gold_forecast_history.csv`, `analysis_history.json`, or `last_forecast.json` core fields

---

## 10. Edge Case Matrix

| Scenario | Expected Behavior | Fix |
|----------|-------------------|-----|
| First-ever deploy, no `last_forecast.json` | Skip bonus, equal-weight forecast | Fix 1 |
| Old blob lacks `actual_gold_price` | Skip bonus, log reason | Fix 1 |
| Cron retry within 60s | Idempotent — no double append | Fix 2 |
| Same-day manual re-run | `loadYesterdayBlob` returns null | Fix 2 |
| Saturday cron (markets closed, all preds ≈ 0) | `isZeroInformationDay` → skip | Fix 3 |
| Three-way tied errors on real data | Each indicator gets 5 points | Fix 3 |
| Two-way top tie | Top two get 7.5 each, third gets 0 | Fix 3 |
| Kitco + Yahoo both fail today | Pipeline halts at `actualGoldPrice = null`, adaptive skipped, Action 9 skipped (existing behavior) | — |
| Redis read fails for `adaptive_state.json` | Empty state returned, fallback to equal weights | Fix 4 |
| Redis write fails | Error caught, logged, pipeline continues | Fix 4 |
| Day 11+ | History trims to last 10 via `slice(-10)` before save | — |
| Yesterday's `actual_gold_price = 0` | Rejected by guard (must be > 0) | Fix 1 |

---

## 11. Known Limitations & Deferred Items

### Acknowledged limitations (will document in code comments)

1. **Kitco-vs-Yahoo time-window mismatch.** Indicators are 24h % changes from Yahoo's market sessions; `actualChangePct` is kitco spot-to-spot. Different time windows introduce mild ranking distortion on near-tied predictions. Pragmatic for V1; flag for supervisor review.

2. **DST ambiguity.** Cron is fixed at 14:00 UTC. Toronto is 10:00 EDT in summer but 9:00 EST in winter. Pre-existing issue; not in scope.

3. **Float epsilon equivalence.** Day-1 forecast equals old formula to ~14 decimal places, not bit-for-bit. Saved values are rounded to 2 decimals via `.toFixed(2)`, so observable result is identical.

4. **TypeScript vs spec §7 "Python preferred."** Codebase is TypeScript (decision logged 2026-03-28 in [PLANNING.md](PLANNING.md) decision log). Supervisor accepted TS in prior phases; this upgrade follows the same convention. All spec functional requirements are met regardless of language.

### Deferred to follow-up PR

1. **Dashboard fix.** [public/index.html:449-450](agentone/public/index.html#L449-L450) computes its own equal-weight net signal client-side. After Day 11 it will diverge from the saved adaptive forecast. Fix in follow-up: replace client-side formula with a server-provided value, or add cumulative-bonus visualization. (User confirmed: dashboard fix happens after core logic ships.)

2. **Pre-existing failing tests.** [test_gold_forecast.ts:506-519](agentone/test_gold_forecast.ts#L506-L519) asserts `@vercel/blob` which was replaced by Upstash Redis. Pre-existing failure unrelated to this plan.

### Not implemented (out of scope per supervisor)

- Standalone agent ([gold_forecast_agent.ts](agentone/gold_forecast_agent.ts)) is unchanged — it's the V1 reference and only has 3 indicators. Adaptive weighting requires the 6-indicator design.

---

## 12. Open Questions for Supervisor

| # | Question | Blocking? |
|---|----------|-----------|
| Q1 | Confirm tie-breaking via average-bonus distribution (vs. spec silence) | No, defensible default |
| Q2 | Confirm zero-information-day skip vs. always-record | No, defensive default |
| Q3 | Should `actualChangePct` use kitco spot-to-spot or Yahoo `GC=F` close-to-close for apples-to-apples with indicator basis? | No, kitco matches existing pattern |
| Q4 | Dashboard update timing (now vs. follow-up) | Resolved: follow-up |

None of these block initial implementation. Document the chosen defaults in code; revisit if supervisor pushes back.

---

## 13. Implementation Checklist

- [ ] Read this plan in full before starting
- [ ] Create [agentone/api/adaptive.ts](agentone/api/adaptive.ts) with 9 exports
- [ ] Create [agentone/test_adaptive.ts](agentone/test_adaptive.ts) with 15 tests
- [ ] Edit [agentone/api/forecast.ts](agentone/api/forecast.ts):
  - [ ] Import adaptive functions
  - [ ] Move kitco fetch to top of `runVercelPipeline`
  - [ ] Insert wrapped adaptive block
  - [ ] Replace Action 8 formula
  - [ ] Extend `saveTodayForecast` with `actual_gold_price`
- [ ] Run `cd agentone && npm test` — all tests pass
- [ ] Update [agentone/README.md](agentone/README.md) with self-learning section
- [ ] Update [CHANGELOG.md](CHANGELOG.md) with new version entry
- [ ] Update [PLANNING.md](PLANNING.md) decision log
- [ ] Update [PROGRESS.md](PROGRESS.md) phase status
- [ ] Commit with message describing self-learning upgrade
- [ ] Deploy and verify Day 1 logs match expected skip-then-equal-weight behavior
- [ ] Schedule follow-up agent in 14 days to verify Day-11+ behavior and propose dashboard fix

---

## 14. References

- Spec document: "Prompt for Upgrading AI Agent: Adaptive Weighting via Historical Accuracy"
- Codebase entry point: [agentone/api/forecast.ts](agentone/api/forecast.ts)
- Existing forecast formula: [forecast.ts:303](agentone/api/forecast.ts#L303)
- Existing CSV idempotency pattern: [forecast.ts:67-86](agentone/api/forecast.ts#L67-L86)
- Existing same-day guard: [forecast.ts:152-166](agentone/api/forecast.ts#L152-L166)
- Project conventions: [CONVENTIONS.md](CONVENTIONS.md)
- Error handling rules: [.claude/rules/error-handling.md](.claude/rules/error-handling.md)
- CSV format rules: [.claude/rules/csv-format.md](.claude/rules/csv-format.md)
- Knowledge graph: [graphify-out/GRAPH_REPORT.md](graphify-out/GRAPH_REPORT.md)
