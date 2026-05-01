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
const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_URLS = 20;

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
  const row = [
    date,
    actual !== null ? actual.toFixed(2) : "",
    forecast !== null ? forecast.toFixed(2) : "",
    deviation !== null ? deviation.toFixed(2) : "",
  ].join(",");
  fs.appendFileSync(CSV_PATH, row + "\n", "utf-8");
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

// ─── Action 1: Web Search + Page Scraping + Groq Llama 3.3 70B ──────────────
//
// PDF spec §1: scrape up to 20 gold-related news pages, then have an LLM
// summarize them in ≤25 words. Implemented in three steps:
//   1. searchForGoldUrls() — collect up to 20 URLs from Google + DuckDuckGo
//      + a curated list of always-reachable gold news sites + Yahoo RSS.
//   2. extractPageText() — strip each page to readable text (no headless
//      browser; we just regex out scripts, styles, and tags).
//   3. action1_newsArticle() — concatenate the texts and ask Groq's
//      Llama 3.3 70B for a short outlook. Static-text fallback if no key.

/** Collect up to 20 gold-related URLs from multiple sources. */
async function searchForGoldUrls(): Promise<string[]> {
  const urls: string[] = [];
  const seen = new Set<string>();
  const addUrl = (u: string) => {
    if (!seen.has(u) && urls.length < MAX_URLS) {
      seen.add(u);
      urls.push(u);
    }
  };

  // Source 1: Google search
  try {
    const resp = await fetch(
      `https://www.google.com/search?q=gold+price+tomorrow&num=20&hl=en`,
      { headers: { "User-Agent": SEARCH_UA } }
    );
    if (resp.ok) {
      const html = await resp.text();
      const matches = [...html.matchAll(/href="\/url\?q=(https?:\/\/[^&"]+)/g)];
      for (const m of matches) {
        const url = decodeURIComponent(m[1]);
        if (!url.includes("google.com") && !url.includes("youtube.com")) addUrl(url);
      }
    }
    log(`Action 1: Google returned ${urls.length} URLs`);
  } catch (e: any) {
    log(`Action 1: Google search failed: ${e.message}`);
  }

  // Source 2: DuckDuckGo JSON API (doesn't require CAPTCHA)
  if (urls.length < MAX_URLS) {
    try {
      const resp = await fetch(
        `https://api.duckduckgo.com/?q=gold+price+tomorrow&format=json&no_redirect=1&no_html=1`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      // DDG sometimes returns 200 with an empty body; resp.json() then throws
      // a generic "Unexpected end of JSON input". Read text first so we can
      // log the real condition.
      const text = await resp.text();
      if (!text.trim()) {
        log("Action 1: DuckDuckGo API returned empty body — skipping");
        throw new Error("empty body");
      }
      const data = JSON.parse(text);
      for (const t of (data.RelatedTopics ?? [])) {
        if (t.FirstURL) addUrl(t.FirstURL);
        // Subtopics
        for (const sub of (t.Topics ?? [])) {
          if (sub.FirstURL) addUrl(sub.FirstURL);
        }
      }
      log(`Action 1: DuckDuckGo API added URLs, total now ${urls.length}`);
    } catch (e: any) {
      log(`Action 1: DuckDuckGo API failed: ${e.message}`);
    }
  }

  // Source 3: Known gold news/forecast sites (reliable, always reachable)
  const knownUrls = [
    "https://www.kitco.com/news/gold/",
    "https://www.investing.com/commodities/gold",
    "https://www.reuters.com/markets/commodities/gold/",
    "https://www.bloomberg.com/markets/commodities",
    "https://www.marketwatch.com/investing/future/gold",
    "https://www.cnbc.com/quotes/GC=F",
    "https://finance.yahoo.com/quote/GC%3DF/",
    "https://www.fxstreet.com/commodities/gold",
    "https://goldprice.org/",
    "https://www.bullionvault.com/gold-news",
  ];
  for (const u of knownUrls) addUrl(u);
  log(`Action 1: After known sites, total URLs: ${urls.length}`);

  // Source 4: Yahoo Finance gold RSS headlines for more URLs
  try {
    const rssResp = await fetch(
      "https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC%3DF&region=US&lang=en-US",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const rssText = await rssResp.text();
    const linkMatches = [...rssText.matchAll(/<link>(https?:\/\/[^<]+)<\/link>/g)];
    for (const m of linkMatches) {
      if (!m[1].includes("yahoo.com/rss")) addUrl(m[1]);
    }
    log(`Action 1: After RSS, total URLs: ${urls.length}`);
  } catch (e: any) {
    log(`Action 1: Yahoo RSS failed: ${e.message}`);
  }

  return urls.slice(0, MAX_URLS);
}

async function extractPageText(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": SEARCH_UA },
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.slice(0, 1500);
}

/** PDF Action 1: produce a short gold-outlook article from scraped news.
 *
 *  Returns either the LLM's synthesis (when `GROQ_API_KEY` is set) or a
 *  static neutral-tone placeholder. Never throws — failures are logged
 *  and the placeholder is returned so the rest of the pipeline keeps
 *  running. The article is for human display only; the numeric forecast
 *  is computed from market indicators, not from this text. */
export async function action1_newsArticle(): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY ?? "";

  // Step 1: Search Google for top 20 result URLs (PDF spec)
  const urls = await searchForGoldUrls();
  log(`Action 1: Found ${urls.length} URLs to scrape`);

  // Step 2: Fetch each page and extract text (readability extraction per PDF)
  const extractedTexts: string[] = [];
  let successCount = 0;
  for (const url of urls) {
    try {
      const text = await extractPageText(url);
      if (text.length > 100) {
        extractedTexts.push(text);
        successCount++;
      }
    } catch (e: any) {
      /* skip failed pages — expected for blocked/timeout URLs */
      log(`Action 1: Page fetch failed for ${url}: ${e.message}`);
    }
  }
  log(`Action 1: Extracted text from ${successCount}/${urls.length} pages`);

  // Step 3: Synthesize via Groq Llama 3.3 70B
  const combinedText = extractedTexts
    .slice(0, 20)
    .join("\n---\n")
    .slice(0, 8000);

  if (groqKey) {
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
                  'You are a concise gold market analyst. Based on the provided extracted web page texts, write a SHORT article about the gold price outlook. Include: 1) A summary sentence of MAX 25 words answering "What will happen to gold price in the near future?". 2) One optional sentence summarizing the consensus. Keep the entire response under 100 words.',
              },
              {
                role: "user",
                content: `Here are extracted texts from ${successCount} web pages about gold price forecast:\n\n${combinedText}\n\nWrite the short article now.`,
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
  } else {
    return `Gold markets show mixed signals. Analysts expect consolidation near recent levels with bias driven by macroeconomic and geopolitical factors.`;
  }
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
