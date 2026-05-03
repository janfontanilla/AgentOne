/**
 * Gold Forecast Daily AI Agent — local-dev pipeline + shared library.
 *
 * This file plays two roles:
 *
 * 1. **Local-dev runner.** When executed directly (`npx tsx
 *    gold_forecast_agent.ts`), it runs the original 7-action pipeline
 *    from the Gold_Forecast_Spec_v1.pdf and persists state to local
 *    files under `data/`. Useful for offline iteration and the
 *    `npm test` integration suite — never invoked in production.
 *
 * 2. **Shared library.** It exports the building blocks the production
 *    pipeline (`api/forecast.ts`) and the read-only history endpoint
 *    (`api/history.ts`) reuse: HTTP fetchers (`fetchYahooQuote`,
 *    `fetchKitcoGoldPrice`), the Groq news-synthesis action
 *    (`action1_newsArticle`), the log buffer, the percent helper, and
 *    the Toronto-time formatters. The production pipeline is a
 *    superset (10 actions, Upstash storage, adaptive weighting) that
 *    builds on these primitives.
 *
 * Run locally:  npx tsx agentone/gold_forecast_agent.ts
 * Production:   triggered by Vercel cron via api/forecast.ts handler.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Config ──────────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ─── API Config ──────────────────────────────────────────────────────────────

const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ─── Load .env file ──────────────────────────────────────────────────────────

(function loadEnv(): void {
  // Look for .env in agentone/ first, then project root
  const candidates = [
    path.resolve(SCRIPT_DIR, ".env"),
    path.resolve(SCRIPT_DIR, "..", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const val = trimmed.slice(eqIndex + 1).trim();
      process.env[key] = val; // .env file always takes precedence
    }
    break;
  }
})();
// Data stored inside agentone/data/
const DATA_DIR = path.resolve(SCRIPT_DIR, "data");
const CSV_PATH = path.join(DATA_DIR, "gold_forecast_history.csv");
const FORECAST_PATH = path.join(DATA_DIR, "last_forecast.json");
const CSV_COLUMNS = "date,actual_gold_price,forecast,deviation";

// ─── Logging ─────────────────────────────────────────────────────────────────

export const logs: string[] = [];
export function log(msg: string): void {
  const ts = torontoNow();
  const line = `${ts} ${msg}`;
  logs.push(line);
  console.log(line);
}

// ─── Toronto time helpers ────────────────────────────────────────────────────

export function torontoNow(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function torontoDateStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Percent change from `prev` to `current`. Returns 0 when `prev` is 0/falsy
 *  to keep failed indicators from poisoning downstream averages. */
export function toPercent(current: number, prev: number): number {
  if (!prev || prev === 0) return 0;
  return ((current - prev) / prev) * 100;
}

/** Fetch the last two valid daily closes for a Yahoo symbol.
 *
 *  Returns `{ current, prev }` so callers can compute close-to-close
 *  percent change without re-hitting the API. The 5-day range
 *  guarantees ≥2 data points across weekends, holidays, and pre-market
 *  hours (PDF spec §"24-hour fallback"). Throws on Yahoo's 200-with-error
 *  responses for delisted symbols rather than silently returning zeros. */
export async function fetchYahooQuote(
  symbol: string
): Promise<{ current: number; prev: number }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok)
    throw new Error(`Yahoo Finance failed for ${symbol}: ${resp.status}`);
  const data = await resp.json();
  // Yahoo returns 200 with an `error` field for delisted/typo'd symbols.
  // Surface that explicitly so a real symbol problem isn't reported as
  // "Not enough data" (which sounds transient).
  const yahooErr = data?.chart?.error;
  if (yahooErr) {
    throw new Error(
      `Yahoo Finance rejected ${symbol}: ${yahooErr.code ?? "unknown"} ${yahooErr.description ?? ""}`.trim()
    );
  }
  const closes: number[] =
    data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  const valid = closes.filter((v: number) => v != null && !isNaN(v));
  if (valid.length < 2) throw new Error(`Not enough data for ${symbol}`);
  return { current: valid[valid.length - 1], prev: valid[valid.length - 2] };
}

// ─── CSV Storage ─────────────────────────────────────────────────────────────

function ensureCsv(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CSV_PATH))
    fs.writeFileSync(CSV_PATH, CSV_COLUMNS + "\n", "utf-8");
}

function appendCsvRow(
  date: string,
  actual: number | null,
  forecast: number | null,
  deviation: number | null
): void {
  ensureCsv();
  const content = fs.readFileSync(CSV_PATH, "utf-8").trimEnd();
  const lines = content.split("\n");
  const idx = lines.findIndex((l, i) => i > 0 && l.trim().startsWith(date + ","));

  if (idx >= 0) {
    // Row exists — merge fields (only overwrite if new value is non-null)
    const parts = lines[idx].split(",");
    const mergedActual   = actual   !== null ? actual.toFixed(2)   : (parts[1] || "");
    const mergedForecast = forecast !== null ? forecast.toFixed(2) : (parts[2] || "");
    let   mergedDev      = deviation !== null ? deviation.toFixed(2) : (parts[3] || "");
    // If prior run wrote actual without forecast (first-run) and later run has forecast,
    // recompute deviation so row isn't stuck with "" deviation.
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
  fs.writeFileSync(CSV_PATH, updated, "utf-8");
}

function updateLastRowDeviation(deviation: number): void {
  ensureCsv();
  const content = fs.readFileSync(CSV_PATH, "utf-8").trimEnd();
  const lines = content.split("\n");
  if (lines.length < 2) return;
  const lastLine = lines[lines.length - 1];
  const parts = lastLine.split(",");
  parts[3] = deviation.toFixed(2);
  lines[lines.length - 1] = parts.join(",");
  fs.writeFileSync(CSV_PATH, lines.join("\n") + "\n", "utf-8");
}

// ─── Last Forecast JSON ──────────────────────────────────────────────────────

function saveTodayForecast(date: string, forecast: number): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    FORECAST_PATH,
    JSON.stringify({ date, forecast: parseFloat(forecast.toFixed(2)) }, null, 2),
    "utf-8"
  );
}

function loadYesterdayForecast(): number | null {
  try {
    if (!fs.existsSync(FORECAST_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(FORECAST_PATH, "utf-8"));
    // Only use forecast if it's from a previous day (not today's run)
    const today = torontoDateStr();
    if (data.date === today) return null; // This is today's forecast, not yesterday's
    if (data.forecast !== undefined && data.forecast !== null) {
      return parseFloat(data.forecast);
    }
  } catch (e: any) {
    log(`WARNING: Failed to load yesterday forecast: ${e.message}`);
  }
  return null;
}

// ─── Gold Price from kitco.com (with Yahoo fallback) ─────────────────────────

/** Fetch today's spot gold price in USD per troy ounce.
 *
 *  Primary source is kitco.com (PDF spec §6 names it explicitly). Falls
 *  back to Yahoo's GC=F gold futures last close if kitco fails or returns
 *  an out-of-range price. Validates the result is between $1,000 and
 *  $10,000 to catch HTML-extraction false positives. */
export async function fetchKitcoGoldPrice(): Promise<number> {
  // Primary: kitco.com (per PDF spec)
  try {
    const kitcoResp = await fetch("https://www.kitco.com/gold-price-today-usa/", {
      headers: { "User-Agent": SEARCH_UA },
    });
    if (kitcoResp.ok) {
      const html = await kitcoResp.text();
      const priceMatch =
        html.match(/gold\s*(?:spot|bid)\s*price[^$]*?\$\s*([\d,]+\.\d{2})/i) ??
        html.match(/"price":\s*([\d,]+\.\d{2})/i) ??
        html.match(/\$\s*([\d,]+\.\d{2})\s*(?:USD)?/);
      if (priceMatch) {
        const price = parseFloat(priceMatch[1].replace(/,/g, ""));
        if (price > 1000 && price < 10000) return price;
      }
    }
  } catch (e: any) {
    log(`Action 6: Kitco fetch failed, trying Yahoo fallback: ${e.message}`);
  }

  // Fallback: Yahoo Finance GC=F futures
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=5d`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) throw new Error(`Gold price fetch failed: ${resp.status}`);
  const data = await resp.json();
  const closes: number[] =
    data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  const valid = closes.filter((v: number) => v != null && !isNaN(v));
  if (!valid.length) throw new Error("No gold price data");
  return valid[valid.length - 1];
}

// ─── Action 1: Gold News via Alpha Vantage NEWS_SENTIMENT API ──────────────────
//
// PDF spec §1 requires scraping up to 20 gold news articles for LLM synthesis.
// Direct web scraping fails (sites block non-browser requests). Solution: use
// Alpha Vantage NEWS_SENTIMENT API as the reliable scraping service.
// Returns structured articles (title + summary), avoiding HTML parsing failures.
// Fallback: static text if API unavailable. Never throws.

/** Scrape up to 20 gold news articles via Alpha Vantage NEWS_SENTIMENT API. */
async function fetchAlphaVantageNews(): Promise<string> {
  const avKey = process.env.ALPHA_VANTAGE_KEY;
  if (!avKey) return "";

  try {
    const resp = await fetch(
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=GLD,GOLD&topics=financial_markets&sort=LATEST&limit=20&apikey=${encodeURIComponent(avKey)}`
    );
    if (!resp.ok) {
      log(`Action 1: Alpha Vantage API returned ${resp.status}`);
      return "";
    }

    const data = await resp.json() as any;
    if (data?.["Error Message"] || data?.note) {
      log(`Action 1: Alpha Vantage API error: ${data["Error Message"] || data.note}`);
      return "";
    }

    const feed = data?.feed ?? [];
    if (!Array.isArray(feed) || feed.length === 0) {
      log("Action 1: Alpha Vantage returned no articles");
      return "";
    }

    // Extract up to 20 article summaries (PDF spec: "up to 20 news articles")
    const summaries = feed
      .slice(0, 20)
      .map((item: any) => {
        const title = item.title || "";
        const summary = item.summary || "";
        return `${title}. ${summary}`.trim();
      })
      .filter((s: string) => s.length > 0);

    log(`Action 1: Alpha Vantage scraping: ${summaries.length} articles fetched`);
    return summaries.join("\n---\n");
  } catch (e: any) {
    log(`Action 1: Alpha Vantage scraping failed: ${e.message}`);
    return "";
  }
}

/** PDF Action 1: produce a short gold-outlook article from news sentiment data.
 *
 *  Primary: fetches structured news via Alpha Vantage NEWS_SENTIMENT API,
 *  synthesizes via Groq Llama 3.3 70B. Fallback: static neutral-tone text
 *  if Alpha Vantage key absent or API fails, or if Groq key absent. Never
 *  throws — failures logged, pipeline continues. Article is for display
 *  only; numeric forecast comes from market indicators. */
export async function action1_newsArticle(): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY ?? "";

  // Step 1: Fetch structured news from Alpha Vantage (replaces web scraping)
  const newsText = await fetchAlphaVantageNews();
  log(
    `Action 1: Alpha Vantage returned ${newsText.length > 0 ? "structured news" : "no news"}`
  );

  // Step 2: Synthesize via Groq Llama 3.3 70B if we have both news and API key
  if (newsText && groqKey) {
    try {
      const aiResp = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [
              {
                role: "system",
                content:
                  'You are a concise gold market analyst. Based on the provided news articles, write a SHORT article about the gold price outlook. Include: 1) A summary sentence of MAX 25 words answering "What will happen to gold price in the near future?". 2) One optional sentence summarizing sentiment. Keep the entire response under 100 words.',
              },
              {
                role: "user",
                content: `Here are recent articles on gold and commodities:\n\n${newsText.slice(0, 8000)}\n\nWrite the short article now.`,
              },
            ],
            max_tokens: 150,
            temperature: 0.5,
          }),
        }
      );
      if (!aiResp.ok) {
        log(`Action 1: Groq API HTTP error: ${aiResp.status}`);
        return "Gold price outlook analysis unavailable.";
      }
      const aiData = await aiResp.json();
      if (aiData?.error) {
        log(`Action 1: Groq API error: ${JSON.stringify(aiData.error)}`);
        return "Gold price outlook analysis unavailable.";
      }
      return (
        aiData?.choices?.[0]?.message?.content?.trim() ??
        "Gold price outlook analysis unavailable."
      );
    } catch (e: any) {
      log(`Action 1: Groq API fetch failed: ${e.message}`);
      return "Gold price outlook analysis unavailable.";
    }
  }

  // Fallback: static text when news unavailable or no API keys
  return `Gold markets show mixed signals. Analysts expect consolidation near recent levels with bias driven by macroeconomic and geopolitical factors.`;
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

export async function runPipeline(): Promise<void> {
  const today = torontoDateStr();
  log(`=== Gold Forecast Daily — ${today} ===`);

  // ── Action 1: News Article ───────────────────────────────────────────────
  let articleText = "";
  try {
    log("Action 1: Fetching gold price news and synthesizing article...");
    articleText = await action1_newsArticle();
    log(`Article: ${articleText}`);
  } catch (e: any) {
    log(`Action 1 ERROR: ${e.message}`);
    articleText = "Gold price outlook analysis could not be generated today.";
  }

  // ── Action 2: NEM + GOLD stocks (Coefficient 1) ─────────────────────────
  let coeff1 = 0;
  try {
    log("Action 2: Fetching NEM and GOLD stock prices...");

    let nemPct = 0;
    try {
      const nem = await fetchYahooQuote("NEM");
      nemPct = toPercent(nem.current, nem.prev);
      log(
        `NEM: ${nem.prev.toFixed(2)} → ${nem.current.toFixed(2)} (${nemPct.toFixed(2)}%)`
      );
    } catch (e: any) {
      log(`Action 2 WARNING: NEM fetch failed, using 0: ${e.message}`);
    }

    let goldPct = 0;
    try {
      const gold = await fetchYahooQuote("GOLD");
      goldPct = toPercent(gold.current, gold.prev);
      log(
        `GOLD: ${gold.prev.toFixed(2)} → ${gold.current.toFixed(2)} (${goldPct.toFixed(2)}%)`
      );
    } catch (e: any) {
      log(`Action 2 WARNING: GOLD fetch failed, using 0: ${e.message}`);
    }

    coeff1 = (nemPct + goldPct) / 2;
    log(`Coefficient 1 (avg NEM+GOLD): ${coeff1.toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 2 ERROR: ${e.message}. Using coeff1=0`);
  }

  // ── Action 3: AUD/USD (Coefficient 2) ───────────────────────────────────
  let coeff2 = 0;
  try {
    log("Action 3: Fetching AUD/USD exchange rate...");
    const audusd = await fetchYahooQuote("AUDUSD=X");
    coeff2 = toPercent(audusd.current, audusd.prev);
    log(
      `AUD/USD: ${audusd.prev.toFixed(5)} → ${audusd.current.toFixed(5)} (${coeff2.toFixed(2)}%)`
    );
    log(`Coefficient 2 (AUD/USD): ${coeff2.toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 3 ERROR: ${e.message}. Using coeff2=0`);
  }

  // ── Action 4: SLV (Coefficient 3) ───────────────────────────────────────
  let coeff3 = 0;
  try {
    log("Action 4: Fetching SLV (iShares Silver Trust) price...");
    const slv = await fetchYahooQuote("SLV");
    coeff3 = toPercent(slv.current, slv.prev);
    log(
      `SLV: ${slv.prev.toFixed(2)} → ${slv.current.toFixed(2)} (${coeff3.toFixed(2)}%)`
    );
    log(`Coefficient 3 (SLV): ${coeff3.toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 4 ERROR: ${e.message}. Using coeff3=0`);
  }

  // ── Action 5: Display Forecast Message ──────────────────────────────────
  const todayForecast = (coeff1 + coeff2 + coeff3) / 3;
  const forecastMsg = `Result of Action #1: ${articleText}\nForecast coefficient (average of C1, C2, C3): ${todayForecast.toFixed(2)}`;
  log("Action 5: " + forecastMsg);
  log(
    `Action 5: C1=${coeff1.toFixed(2)}%, C2=${coeff2.toFixed(2)}%, C3=${coeff3.toFixed(2)}%`
  );

  // Store today_forecast for next day's run (PDF spec)
  saveTodayForecast(today, todayForecast);
  log(
    `Action 5: today_forecast=${todayForecast.toFixed(2)} saved to ${FORECAST_PATH}`
  );

  // ── Action 6: Build Today's Table Row ───────────────────────────────────
  let actualGoldPrice: number | null = null;
  let yesterdayForecast: number | null = null;

  try {
    // 6.1 Get today's actual gold price from kitco.com (with Yahoo fallback)
    log("Action 6: Fetching actual gold price from kitco.com...");
    actualGoldPrice = await fetchKitcoGoldPrice();
    log(`Action 6: Actual gold price: $${actualGoldPrice.toFixed(2)}`);

    // 6.2 Retrieve yesterday's forecast
    yesterdayForecast = loadYesterdayForecast();
    if (yesterdayForecast !== null) {
      log(`Action 6: Yesterday's forecast: ${yesterdayForecast}`);
    } else {
      log("Action 6: No yesterday forecast found (first run).");
    }

    // 6.3 + 6.4 Create row and append to CSV (deviation left for Action 7)
    appendCsvRow(today, actualGoldPrice, yesterdayForecast, null);
    log(`Action 6: Row appended to ${CSV_PATH}`);

    // Convert today's % forecast to a dollar forecast for tomorrow's comparison
    // predicted_price = today_actual * (1 + avg_coefficient / 100)
    const dollarForecast = actualGoldPrice * (1 + todayForecast / 100);
    saveTodayForecast(today, dollarForecast);
    log(`Action 6: Dollar forecast for tomorrow: $${dollarForecast.toFixed(2)}`);
  } catch (e: any) {
    log(`Action 6 ERROR: ${e.message}. Skipping table update.`);
  }

  // ── Action 7: Update the Table with Deviation ──────────────────────────
  try {
    if (actualGoldPrice !== null && yesterdayForecast !== null) {
      // 7.1 Calculate deviation: Actual − Forecast
      const deviation = actualGoldPrice - yesterdayForecast;
      log(
        `Action 7: Deviation = $${actualGoldPrice.toFixed(2)} - ${yesterdayForecast.toFixed(2)} = ${deviation.toFixed(2)}`
      );

      // 7.2 Update the last CSV row with deviation
      updateLastRowDeviation(deviation);
      log(`Action 7: Deviation ${deviation.toFixed(2)} saved to CSV`);
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

// ─── Entry Point ─────────────────────────────────────────────────────────────
// Only auto-run when executed directly (not when imported by Vercel API route)

const isDirectRun = process.argv[1]?.replace(/\\/g, "/").includes("gold_forecast_agent");
if (isDirectRun) {
  runPipeline().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
