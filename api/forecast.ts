/**
 * Vercel Serverless Function — Gold Forecast Pipeline
 *
 * Triggered daily by Vercel Cron at 10:00 AM Toronto time (14:00 UTC / 15:00 UTC DST).
 * Runs the full 7-action pipeline with Upstash Redis for persistence.
 */

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

const CSV_COLUMNS = "date,actual_gold_price,forecast,deviation";

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

let csvCache: string | null = null;

async function loadCsv(): Promise<string> {
  if (csvCache !== null) return csvCache;
  const content = await readKey("gold_forecast_history.csv");
  csvCache = content ?? CSV_COLUMNS + "\n";
  return csvCache;
}

async function appendCsvRow(
  date: string,
  actual: number | null,
  forecast: number | null,
  deviation: number | null
): Promise<void> {
  const existing = await loadCsv();
  const row = [
    date,
    actual !== null ? actual.toFixed(2) : "",
    forecast !== null ? forecast.toFixed(2) : "",
    deviation !== null ? deviation.toFixed(2) : "",
  ].join(",");
  // Prevent duplicate rows for the same date — update existing row instead
  const lines = existing.trimEnd().split("\n");
  const idx = lines.findIndex((l, i) => i > 0 && l.startsWith(date + ","));
  if (idx >= 0) {
    lines[idx] = row;
  } else {
    lines.push(row);
  }
  const updated = lines.join("\n") + "\n";
  await writeKey("gold_forecast_history.csv", updated);
  csvCache = updated;
}

async function saveTodayForecast(
  date: string,
  forecast: number,
  extra?: { article?: string; c1?: number; c2?: number; c3?: number }
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
  c1: number,
  c2: number,
  c3: number
): Promise<void> {
  try {
    const raw = await readKey("analysis_history.json");
    const history: Array<{ date: string; article: string; c1: number; c2: number; c3: number }> =
      raw ? JSON.parse(raw) : [];
    const idx = history.findIndex((e) => e.date === date);
    const entry = {
      date,
      article,
      c1: parseFloat(c1.toFixed(2)),
      c2: parseFloat(c2.toFixed(2)),
      c3: parseFloat(c3.toFixed(2)),
    };
    if (idx >= 0) {
      history[idx] = entry;
    } else {
      history.push(entry);
    }
    await writeKey("analysis_history.json", JSON.stringify(history));
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
  csvCache = null; // Reset in-memory cache for fresh pipeline run
  const today = torontoDateStr();
  log(`=== Gold Forecast Daily — ${today} ===`);

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

  // Action 2: NEM + GOLD (Coefficient 1)
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

  // Action 3: AUD/USD (Coefficient 2)
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

  // Action 4: SLV (Coefficient 3)
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

  // Load yesterday's forecast BEFORE Action 5 overwrites the key
  let yesterdayForecast: number | null = null;
  try {
    yesterdayForecast = await loadYesterdayForecast();
  } catch (e: any) {
    log(`WARNING: Failed to load yesterday forecast: ${e.message}`);
  }

  // Action 5: Display Forecast
  const todayForecast = (coeff1 + coeff2 + coeff3) / 3;
  log(`Action 5: Result of Action #1: ${articleText}\nForecast coefficient (average of C1, C2, C3): ${todayForecast.toFixed(2)}`);
  log(`Action 5: C1=${coeff1.toFixed(2)}%, C2=${coeff2.toFixed(2)}%, C3=${coeff3.toFixed(2)}%`);

  await saveTodayForecast(today, todayForecast, {
    article: articleText,
    c1: parseFloat(coeff1.toFixed(2)),
    c2: parseFloat(coeff2.toFixed(2)),
    c3: parseFloat(coeff3.toFixed(2)),
  });
  log(`Action 5: today_forecast=${todayForecast.toFixed(2)} saved`);

  // Save analysis entry for daily history
  await saveAnalysisEntry(today, articleText, coeff1, coeff2, coeff3);

  // Action 6: Build Table Row
  let actualGoldPrice: number | null = null;

  try {
    log("Action 6: Fetching actual gold price from kitco.com...");
    actualGoldPrice = await fetchKitcoGoldPrice();
    log(`Action 6: Actual gold price: $${actualGoldPrice.toFixed(2)}`);
    if (yesterdayForecast !== null) {
      log(`Action 6: Yesterday's forecast: ${yesterdayForecast}`);
    } else {
      log("Action 6: No yesterday forecast found (first run).");
    }

    // Calculate deviation inline if yesterday's forecast exists
    let deviation: number | null = null;
    if (yesterdayForecast !== null) {
      deviation = actualGoldPrice - yesterdayForecast;
    }

    await appendCsvRow(today, actualGoldPrice, yesterdayForecast, deviation);
    log("Action 6: Row appended to CSV");

    const dollarForecast = actualGoldPrice * (1 + todayForecast / 100);
    await saveTodayForecast(today, dollarForecast, {
      article: articleText,
      c1: parseFloat(coeff1.toFixed(2)),
      c2: parseFloat(coeff2.toFixed(2)),
      c3: parseFloat(coeff3.toFixed(2)),
    });
    log(`Action 6: Dollar forecast for tomorrow: $${dollarForecast.toFixed(2)}`);
  } catch (e: any) {
    log(`Action 6 ERROR: ${e.message}. Skipping table update.`);
  }

  // Action 7: Deviation (log result, update if needed)
  try {
    if (actualGoldPrice !== null && yesterdayForecast !== null) {
      const deviation = actualGoldPrice - yesterdayForecast;
      log(`Action 7: Deviation = $${actualGoldPrice.toFixed(2)} - ${yesterdayForecast.toFixed(2)} = ${deviation.toFixed(2)}`);
    } else if (actualGoldPrice === null) {
      log("Action 7: Skipped — actual gold price unavailable.");
    } else {
      log("Action 7: Skipped — no yesterday forecast (first run or gap).");
    }
  } catch (e: any) {
    log(`Action 7 ERROR: ${e.message}`);
  }

  log("=== Pipeline complete ===");
}

// ─── Vercel Handler ─────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Verify cron secret (Vercel sends this header for cron invocations)
  const authHeader = req.headers["authorization"];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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
