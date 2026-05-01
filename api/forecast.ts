/**
 * Vercel Serverless Function — Gold Forecast Pipeline
 *
 * Triggered daily by Vercel Cron at 10:00 AM Toronto time (14:00 UTC).
 * Runs the full 10-action pipeline with Upstash Redis for persistence.
 *
 * Forecast is the adaptive-weighted average of six indicators (3 direct +
 * 3 reversal), where each weight is `100 + cumulative_bonus_i` over the
 * rolling 10-day accuracy window. See PLANNING.md §3 for the design and
 * the upgrade spec at agentone/docs/Prompt_for_Upgrading_AI_Agent_v3.docx
 * for the source requirements.
 */

import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  log,
  logs,
  torontoNow,
  torontoDateStr,
  toPercent,
  fetchYahooQuote,
  fetchKitcoGoldPrice,
  action1_newsArticle,
} from "../gold_forecast_agent.js";
import {
  loadAdaptiveState,
  loadYesterdayBlob,
  updateDailyBonuses,
  computeCumulativeBonuses,
  computeAdaptiveForecast,
  type IndicatorMap,
  type YesterdayBlob,
} from "./adaptive.js";

const CSV_COLUMNS = "date,actual_gold_price,forecast,deviation";
const MAX_ANALYSIS_HISTORY = 365;

// ─── Upstash Redis Storage ─────────────────────────────────────────────────

const redis = Redis.fromEnv();

async function readKey(key: string): Promise<string | null> {
  try {
    const value = await redis.get(key);
    if (value === null || value === undefined) return null;
    // Upstash auto-deserializes JSON — ensure we always return a string
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch (e: any) {
    log(`Redis read failed for ${key}: ${e.message}`);
    return null;
  }
}

async function writeKey(key: string, value: string): Promise<void> {
  try {
    await redis.set(key, value);
  } catch (e: any) {
    log(`Redis write failed for ${key}: ${e.message}`);
    throw e;
  }
}

// ─── Storage Functions (Redis-backed) ──────────────────────────────────────

async function loadCsv(): Promise<string> {
  const content = await readKey("gold_forecast_history.csv");
  return content ?? CSV_COLUMNS + "\n";
}

async function appendCsvRow(
  date: string,
  actual: number | null,
  forecast: number | null,
  deviation: number | null
): Promise<void> {
  const existing = await loadCsv();
  const lines = existing.trimEnd().split("\n");
  const idx = lines.findIndex((l, i) => i > 0 && l.trim().startsWith(date + ","));

  if (idx >= 0) {
    // Row exists — only overwrite a field if the new value is non-null.
    // This prevents same-day reruns from erasing a forecast/deviation that
    // was correctly calculated on the first run of the day.
    const parts = lines[idx].split(",");
    const mergedActual   = actual   !== null ? actual.toFixed(2)   : (parts[1] || "");
    const mergedForecast = forecast !== null ? forecast.toFixed(2) : (parts[2] || "");
    let   mergedDev      = deviation !== null ? deviation.toFixed(2) : (parts[3] || "");
    // If a prior run wrote actual without a forecast (first-run path) and a
    // later same-day run now has a forecast, recompute deviation from the
    // merged values so the row isn't permanently stuck with "" deviation.
    if (!mergedDev && mergedActual && mergedForecast) {
      const a = parseFloat(mergedActual);
      const f = parseFloat(mergedForecast);
      if (Number.isFinite(a) && Number.isFinite(f)) {
        mergedDev = (a - f).toFixed(2);
      }
    }
    lines[idx] = [date, mergedActual, mergedForecast, mergedDev].join(",");
  } else {
    const row = [
      date,
      actual   !== null ? actual.toFixed(2)   : "",
      forecast !== null ? forecast.toFixed(2) : "",
      deviation !== null ? deviation.toFixed(2) : "",
    ].join(",");
    lines.push(row);
  }

  const updated = lines.join("\n") + "\n";
  await writeKey("gold_forecast_history.csv", updated);
  log(`CSV row saved for ${date}`);
}

async function saveTodayForecast(
  date: string,
  forecast: number,
  extra?: {
    article?: string;
    c1?: number; c2?: number; c3?: number;
    i1?: number; i2?: number; i3?: number;
    actual_gold_price?: number;
  }
): Promise<void> {
  await writeKey(
    "last_forecast.json",
    JSON.stringify({
      date,
      forecast: parseFloat(forecast.toFixed(2)),
      ...(extra ?? {}),
    })
  );
}

async function saveAnalysisEntry(
  date: string,
  article: string,
  c1: number, c2: number, c3: number,
  i1: number, i2: number, i3: number
): Promise<void> {
  try {
    const raw = await readKey("analysis_history.json");
    const history: Array<{
      date: string; article: string;
      c1: number; c2: number; c3: number;
      i1: number; i2: number; i3: number;
    }> = raw ? JSON.parse(raw) : [];
    const idx = history.findIndex((e) => e.date === date);
    const entry = {
      date,
      article,
      c1: parseFloat(c1.toFixed(2)),
      c2: parseFloat(c2.toFixed(2)),
      c3: parseFloat(c3.toFixed(2)),
      i1: parseFloat(i1.toFixed(2)),
      i2: parseFloat(i2.toFixed(2)),
      i3: parseFloat(i3.toFixed(2)),
    };
    if (idx >= 0) {
      history[idx] = entry;
    } else {
      history.push(entry);
    }
    // Cap history to prevent unbounded growth
    const trimmed = history.length > MAX_ANALYSIS_HISTORY
      ? history.slice(-MAX_ANALYSIS_HISTORY)
      : history;
    await writeKey("analysis_history.json", JSON.stringify(trimmed));
    log(`Analysis entry saved for ${date}`);
  } catch (e: any) {
    log(`WARNING: Failed to save analysis entry: ${e.message}`);
  }
}

async function loadYesterdayForecast(): Promise<number | null> {
  try {
    const raw = await readKey("last_forecast.json");
    if (!raw) return null;
    const data = JSON.parse(raw);
    const today = torontoDateStr();
    if (data.date === today) return null;
    if (data.forecast !== undefined && data.forecast !== null) {
      return parseFloat(data.forecast);
    }
  } catch (e: any) {
    log(`WARNING: Failed to load yesterday forecast: ${e.message}`);
  }
  return null;
}

// ─── Pipeline (Vercel version) ──────────────────────────────────────────────

async function runVercelPipeline(): Promise<void> {
  // Pipeline ordering implements upgrade spec §3.1's allowed alternative:
  // "the main 10:00 AM run can first load the previous day's actual data
  // and update bonuses, then generate the new prediction." So today's
  // adaptive weights include yesterday's freshly-scored bonuses, matching
  // §3.3's `cumulative_bonus = sum(daily_bonus[t-9 ... t])` semantics.
  const today = torontoDateStr();
  log(`=== Gold Forecast Daily — ${today} ===`);

  // Load yesterday's forecast FIRST — before anything overwrites it
  let yesterdayForecast: number | null = null;
  try {
    yesterdayForecast = await loadYesterdayForecast();
    if (yesterdayForecast !== null) {
      log(`Loaded yesterday's forecast: $${yesterdayForecast.toFixed(2)}`);
    } else {
      log("No yesterday forecast found (first run or same-day re-run).");
    }
  } catch (e: any) {
    log(`WARNING: Failed to load yesterday forecast: ${e.message}`);
  }

  // Load full yesterday blob for adaptive scoring (separate from yesterdayForecast
  // to keep same-day-rerun semantics). Also fetched up front because the
  // adaptive block needs today's actual price.
  let yesterdayBlob: YesterdayBlob | null = null;
  try {
    yesterdayBlob = await loadYesterdayBlob(redis);
  } catch (e: any) {
    log(`WARNING: Failed to load yesterday blob: ${e.message}`);
  }

  // Fetch today's actual gold price up front so the adaptive block can score
  // yesterday's predictions. Action 9 reuses this value (no double fetch).
  let actualGoldPrice: number | null = null;
  try {
    log("Fetching actual gold price from kitco.com...");
    actualGoldPrice = await fetchKitcoGoldPrice();
    log(`Actual gold price: $${actualGoldPrice.toFixed(2)}`);
  } catch (e: any) {
    log(`WARNING: Failed to fetch actual gold price: ${e.message}`);
  }

  // Adaptive weighting: score yesterday's predictions, compute cumulative bonuses
  // for today's forecast. Wrapped so any failure here falls back to equal weights
  // and never halts the rest of the pipeline.
  let cumBonuses: IndicatorMap = { d1: 0, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 };
  try {
    if (actualGoldPrice !== null) {
      log("Adaptive: updating daily bonuses from yesterday's predictions...");
      // Spec §5: "use a reliable API (e.g., Kitco, GoldAPI, or Yahoo Finance
      // for GLD ETF). Ensure consistency: use the same price reference."
      // GLD is named in the spec and is close-to-close like the other Yahoo
      // indicators, so it satisfies both the source list and the consistency
      // requirement. Falls back to spot-to-spot from kitco if Yahoo fails.
      let actualChangePctOverride: number | undefined;
      try {
        const gld = await fetchYahooQuote("GLD");
        actualChangePctOverride = toPercent(gld.current, gld.prev);
        log(
          `Adaptive: GLD close-to-close: ${gld.prev.toFixed(2)} → ${gld.current.toFixed(2)} (${actualChangePctOverride.toFixed(2)}%)`
        );
      } catch (e: any) {
        log(
          `Adaptive: GLD fetch failed (${e.message}) — falling back to kitco spot-to-spot`
        );
      }
      await updateDailyBonuses(
        redis,
        actualGoldPrice,
        yesterdayBlob,
        actualChangePctOverride
      );
    } else {
      log("Adaptive: skipping bonus update (no actual gold price).");
    }
    const state = await loadAdaptiveState(redis);
    cumBonuses = computeCumulativeBonuses(state);
    log(
      `Adaptive: cum bonuses → D1=${cumBonuses.d1} D2=${cumBonuses.d2} D3=${cumBonuses.d3} | R1=${cumBonuses.r1} R2=${cumBonuses.r2} R3=${cumBonuses.r3}`
    );
  } catch (e: any) {
    log(`Adaptive ERROR: ${e.message}. Falling back to equal weights.`);
  }

  // Action 1: News Article
  let articleText = "";
  try {
    log("Action 1: Fetching gold price news and synthesizing article...");
    articleText = await action1_newsArticle();
    log(`Article: ${articleText}`);
  } catch (e: any) {
    log(`Action 1 ERROR: ${e.message}`);
    articleText = "Gold price outlook analysis could not be generated today.";
  }

  // Action 2: NEM + GOLD (Coefficient 1 — direct)
  let coeff1 = 0;
  try {
    log("Action 2: Fetching NEM and GOLD stock prices...");
    let nemPct = 0;
    try {
      const nem = await fetchYahooQuote("NEM");
      nemPct = toPercent(nem.current, nem.prev);
      log(`NEM: ${nem.prev.toFixed(2)} → ${nem.current.toFixed(2)} (${nemPct.toFixed(2)}%)`);
    } catch (e: any) {
      log(`Action 2 WARNING: NEM fetch failed, using 0: ${e.message}`);
    }
    let goldPct = 0;
    try {
      const gold = await fetchYahooQuote("GOLD");
      goldPct = toPercent(gold.current, gold.prev);
      log(`GOLD: ${gold.prev.toFixed(2)} → ${gold.current.toFixed(2)} (${goldPct.toFixed(2)}%)`);
    } catch (e: any) {
      log(`Action 2 WARNING: GOLD fetch failed, using 0: ${e.message}`);
    }
    coeff1 = (nemPct + goldPct) / 2;
    log(`Coefficient 1 (avg NEM+GOLD): ${coeff1.toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 2 ERROR: ${e.message}. Using coeff1=0`);
  }

  // Action 3: AUD/USD (Coefficient 2 — direct)
  let coeff2 = 0;
  try {
    log("Action 3: Fetching AUD/USD exchange rate...");
    const audusd = await fetchYahooQuote("AUDUSD=X");
    coeff2 = toPercent(audusd.current, audusd.prev);
    log(`AUD/USD: ${audusd.prev.toFixed(5)} → ${audusd.current.toFixed(5)} (${coeff2.toFixed(2)}%)`);
    log(`Coefficient 2 (AUD/USD): ${coeff2.toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 3 ERROR: ${e.message}. Using coeff2=0`);
  }

  // Action 4: SLV (Coefficient 3 — direct)
  let coeff3 = 0;
  try {
    log("Action 4: Fetching SLV (iShares Silver Trust) price...");
    const slv = await fetchYahooQuote("SLV");
    coeff3 = toPercent(slv.current, slv.prev);
    log(`SLV: ${slv.prev.toFixed(2)} → ${slv.current.toFixed(2)} (${coeff3.toFixed(2)}%)`);
    log(`Coefficient 3 (SLV): ${coeff3.toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 4 ERROR: ${e.message}. Using coeff3=0`);
  }

  // Action 5: US Equity Index (Index 1 — inverse)
  // Average of S&P 500 (SPY), Dow Jones (DIA), NASDAQ-100 (QQQ), Russell 2000 (IWM)
  // Rising equities are inversely correlated with gold — contribution is negated
  let inv1 = 0;
  try {
    log("Action 5: Fetching US Equity Index (SPY, DIA, QQQ, IWM)...");
    const equitySymbols = ["SPY", "DIA", "QQQ", "IWM"];
    const equityPcts: number[] = [];
    for (const sym of equitySymbols) {
      try {
        const q = await fetchYahooQuote(sym);
        const pct = toPercent(q.current, q.prev);
        equityPcts.push(pct);
        log(`${sym}: ${q.prev.toFixed(2)} → ${q.current.toFixed(2)} (${pct.toFixed(2)}%)`);
      } catch (e: any) {
        log(`Action 5 WARNING: ${sym} fetch failed, excluding from avg: ${e.message}`);
      }
    }
    if (equityPcts.length > 0) {
      inv1 = equityPcts.reduce((a, b) => a + b, 0) / equityPcts.length;
    }
    log(`Index 1 raw (US Equities avg): ${inv1.toFixed(2)}% → forecast contribution: ${(-inv1).toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 5 ERROR: ${e.message}. Using inv1=0`);
  }

  // Action 6: U.S. Dollar Index (Index 2 — inverse)
  // A stronger dollar pushes gold down — contribution is negated
  let inv2 = 0;
  try {
    log("Action 6: Fetching U.S. Dollar Index (DX-Y.NYB)...");
    const dxy = await fetchYahooQuote("DX-Y.NYB");
    inv2 = toPercent(dxy.current, dxy.prev);
    log(`DXY: ${dxy.prev.toFixed(3)} → ${dxy.current.toFixed(3)} (${inv2.toFixed(2)}%)`);
    log(`Index 2 raw (DXY): ${inv2.toFixed(2)}% → forecast contribution: ${(-inv2).toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 6 ERROR: ${e.message}. Using inv2=0`);
  }

  // Action 7: Bond Yields via TLT (Index 3 — inverse)
  // Rising TLT (bond prices up = yields down) is positively correlated with gold
  // But we store raw TLT % and negate it as the inverse index contribution
  let inv3 = 0;
  try {
    log("Action 7: Fetching Bond Yields via TLT (iShares 20+ Year Treasury)...");
    const tlt = await fetchYahooQuote("TLT");
    inv3 = toPercent(tlt.current, tlt.prev);
    log(`TLT: ${tlt.prev.toFixed(2)} → ${tlt.current.toFixed(2)} (${inv3.toFixed(2)}%)`);
    log(`Index 3 raw (TLT): ${inv3.toFixed(2)}% → forecast contribution: ${(-inv3).toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 7 ERROR: ${e.message}. Using inv3=0`);
  }

  // Action 8: Display Forecast
  // Formula: weighted average of all 6 indicators using adaptive weights.
  // weight_i = 100 + cumulative_bonus_i. With empty history (all bonuses 0),
  // this is mathematically equivalent to the prior equal-weight /6 formula.
  const adaptivePreds: IndicatorMap = {
    d1: coeff1, d2: coeff2, d3: coeff3,
    r1: -inv1, r2: -inv2, r3: -inv3,
  };
  const todayForecast = computeAdaptiveForecast(adaptivePreds, cumBonuses);
  log(`Action 8: Result of Action #1: ${articleText}`);
  log(`Action 8: Direct  → C1=${coeff1.toFixed(2)}%, C2=${coeff2.toFixed(2)}%, C3=${coeff3.toFixed(2)}%`);
  log(`Action 8: Inverse → I1=${inv1.toFixed(2)}% (contrib ${(-inv1).toFixed(2)}%), I2=${inv2.toFixed(2)}% (contrib ${(-inv2).toFixed(2)}%), I3=${inv3.toFixed(2)}% (contrib ${(-inv3).toFixed(2)}%)`);
  log(`Action 8: Weights → D1=${100+cumBonuses.d1} D2=${100+cumBonuses.d2} D3=${100+cumBonuses.d3} | R1=${100+cumBonuses.r1} R2=${100+cumBonuses.r2} R3=${100+cumBonuses.r3}`);
  log(`Action 8: Forecast coefficient (adaptive weighted avg): ${todayForecast.toFixed(2)}%`);

  // Save analysis entry for daily history
  await saveAnalysisEntry(today, articleText, coeff1, coeff2, coeff3, inv1, inv2, inv3);

  // Action 9: Build Table Row (reuses actualGoldPrice fetched up front)
  try {
    if (actualGoldPrice === null) {
      throw new Error("actual gold price unavailable from earlier fetch");
    }
    if (yesterdayForecast !== null) {
      log(`Action 9: Yesterday's forecast: $${yesterdayForecast.toFixed(2)}`);
    } else {
      log("Action 9: No yesterday forecast (first run).");
    }

    let deviation: number | null = null;
    if (yesterdayForecast !== null) {
      deviation = actualGoldPrice - yesterdayForecast;
    }

    await appendCsvRow(today, actualGoldPrice, yesterdayForecast, deviation);

    // Convert today's % forecast to a dollar forecast for tomorrow
    const dollarForecast = actualGoldPrice * (1 + todayForecast / 100);
    await saveTodayForecast(today, dollarForecast, {
      article: articleText,
      c1: parseFloat(coeff1.toFixed(2)),
      c2: parseFloat(coeff2.toFixed(2)),
      c3: parseFloat(coeff3.toFixed(2)),
      i1: parseFloat(inv1.toFixed(2)),
      i2: parseFloat(inv2.toFixed(2)),
      i3: parseFloat(inv3.toFixed(2)),
      actual_gold_price: parseFloat(actualGoldPrice.toFixed(2)),
    });
    log(`Action 9: Dollar forecast for tomorrow: $${dollarForecast.toFixed(2)}`);
  } catch (e: any) {
    log(`Action 9 ERROR: ${e.message}. Skipping table update.`);
    // Without a confirmed actual gold price we cannot convert today's percent
    // forecast to a dollar amount. Saving the raw percent here would dimensionally
    // poison tomorrow's deviation calc (the next run would treat 0.45 as $0.45).
    // Better to skip the save: tomorrow's run will see no yesterday forecast and
    // take the first-run path, keeping the CSV clean.
    if (actualGoldPrice !== null) {
      const dollarForecast = actualGoldPrice * (1 + todayForecast / 100);
      await saveTodayForecast(today, dollarForecast, {
        article: articleText,
        c1: parseFloat(coeff1.toFixed(2)),
        c2: parseFloat(coeff2.toFixed(2)),
        c3: parseFloat(coeff3.toFixed(2)),
        i1: parseFloat(inv1.toFixed(2)),
        i2: parseFloat(inv2.toFixed(2)),
        i3: parseFloat(inv3.toFixed(2)),
        actual_gold_price: parseFloat(actualGoldPrice.toFixed(2)),
      });
      log(`Action 9: CSV write failed but actual price was available; saved $${dollarForecast.toFixed(2)} dollar forecast.`);
    } else {
      log(`Action 9: No actual gold price — skipping last_forecast.json write to avoid dimensional poisoning.`);
    }
  }

  // Action 10: Deviation (log result)
  try {
    if (actualGoldPrice !== null && yesterdayForecast !== null) {
      const deviation = actualGoldPrice - yesterdayForecast;
      log(`Action 10: Deviation = $${actualGoldPrice.toFixed(2)} - $${yesterdayForecast.toFixed(2)} = ${deviation.toFixed(2)}`);
    } else if (actualGoldPrice === null) {
      log("Action 10: Skipped — actual gold price unavailable.");
    } else {
      log("Action 10: Skipped — no yesterday forecast (first run or gap).");
    }
  } catch (e: any) {
    log(`Action 10 ERROR: ${e.message}`);
  }

  log("=== Pipeline complete ===");
}

// ─── Vercel Handler ─────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Verify cron secret. Default-deny: if CRON_SECRET is unset in this
  // environment we refuse the request rather than allowing public traffic
  // to drive the (Groq-billed, state-mutating) pipeline.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({ error: "Server misconfigured: CRON_SECRET not set" });
    return;
  }
  const authHeader = req.headers["authorization"] ?? "";
  const expected = `Bearer ${cronSecret}`;
  // Constant-time compare to avoid leaking secret length via response timing.
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && timingSafeEqual(a, b);
  if (!valid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  logs.length = 0; // Clear logs from previous runs

  try {
    await runVercelPipeline();
    res.status(200).json({
      status: "success",
      timestamp: torontoNow(),
      logs: logs,
    });
  } catch (e: any) {
    res.status(500).json({
      status: "error",
      error: e.message,
      logs: logs,
    });
  }
}

export const config = {
  maxDuration: 300,
};
