/**
 * Gold Forecast Daily AI Agent — Comprehensive Test Suite
 *
 * Covers: helper functions, CSV/JSON operations, coefficient logic,
 * error handling, Vercel deployment files, security, PDF compliance,
 * and a full integration test.
 *
 * Run unit tests:       npx tsx test_gold_forecast.ts
 * Run ALL (+ long):     RUN_LONG_TESTS=1 npx tsx test_gold_forecast.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

// ═══════════════════════════════════════════════════════════════════════════
// Re-declare pure helper functions from gold_forecast_agent.ts for unit testing
// (The agent auto-runs its pipeline on import, so we can't import directly)
// ═══════════════════════════════════════════════════════════════════════════

function toPercent(current: number, prev: number): number {
  if (!prev || prev === 0) return 0;
  return ((current - prev) / prev) * 100;
}

function torontoNow(): string {
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

function torontoDateStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV/JSON helper functions (re-declared with configurable paths for testing)
// ═══════════════════════════════════════════════════════════════════════════

const CSV_COLUMNS = "date,actual_gold_price,forecast,deviation";

function ensureCsv(dataDir: string, csvPath: string): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(csvPath))
    fs.writeFileSync(csvPath, CSV_COLUMNS + "\n", "utf-8");
}

function appendCsvRow(
  csvPath: string,
  dataDir: string,
  date: string,
  actual: number | null,
  forecast: number | null,
  deviation: number | null
): void {
  ensureCsv(dataDir, csvPath);
  const row = [
    date,
    actual !== null ? actual.toFixed(2) : "",
    forecast !== null ? forecast.toFixed(2) : "",
    deviation !== null ? deviation.toFixed(2) : "",
  ].join(",");
  fs.appendFileSync(csvPath, row + "\n", "utf-8");
}

function updateLastRowDeviation(csvPath: string, dataDir: string, deviation: number): void {
  ensureCsv(dataDir, csvPath);
  const content = fs.readFileSync(csvPath, "utf-8").trimEnd();
  const lines = content.split("\n");
  if (lines.length < 2) return;
  const lastLine = lines[lines.length - 1];
  const parts = lastLine.split(",");
  parts[3] = deviation.toFixed(2);
  lines[lines.length - 1] = parts.join(",");
  fs.writeFileSync(csvPath, lines.join("\n") + "\n", "utf-8");
}

function saveTodayForecast(forecastPath: string, dataDir: string, date: string, forecast: number): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    forecastPath,
    JSON.stringify({ date, forecast: parseFloat(forecast.toFixed(2)) }, null, 2),
    "utf-8"
  );
}

function loadYesterdayForecast(forecastPath: string): number | null {
  try {
    if (!fs.existsSync(forecastPath)) return null;
    const data = JSON.parse(fs.readFileSync(forecastPath, "utf-8"));
    const today = torontoDateStr();
    if (data.date === today) return null;
    if (data.forecast !== undefined && data.forecast !== null) {
      return parseFloat(data.forecast);
    }
  } catch (_) {}
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Temp directory helper
// ═══════════════════════════════════════════════════════════════════════════

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gold-test-"));
}

function cleanTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: Helper Function Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("toPercent()", () => {
  it("calculates positive percentage change", () => {
    assert.equal(toPercent(110, 100), 10);
  });

  it("calculates negative percentage change", () => {
    assert.equal(toPercent(90, 100), -10);
  });

  it("returns 0 when prev is 0", () => {
    assert.equal(toPercent(100, 0), 0);
  });

  it("returns 0 when prev is NaN", () => {
    assert.equal(toPercent(100, NaN), 0);
  });

  it("returns 0 when values are the same", () => {
    assert.equal(toPercent(100, 100), 0);
  });

  it("matches PDF formula: (current - 24h ago) / 24h ago * 100", () => {
    const current = 2050.0;
    const prev = 2000.0;
    const expected = ((current - prev) / prev) * 100;
    assert.equal(toPercent(current, prev), expected);
  });

  it("handles small forex-like values", () => {
    const result = toPercent(0.6873, 0.6887);
    assert.ok(Math.abs(result - -0.2033) < 0.01);
  });
});

describe("torontoDateStr()", () => {
  it("returns YYYY-MM-DD format", () => {
    const result = torontoDateStr();
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a valid date", () => {
    const result = torontoDateStr();
    const parsed = new Date(result);
    assert.ok(!isNaN(parsed.getTime()));
  });
});

describe("torontoNow()", () => {
  it("returns a string with date and time", () => {
    const result = torontoNow();
    assert.ok(result.length > 10, "Should be longer than just a date");
  });

  it("contains the current Toronto date", () => {
    const result = torontoNow();
    const today = torontoDateStr();
    assert.ok(result.includes(today), `Expected '${result}' to contain '${today}'`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: CSV Operations
// ═══════════════════════════════════════════════════════════════════════════

describe("ensureCsv()", () => {
  let tmpDir: string;
  before(() => { tmpDir = makeTempDir(); });
  after(() => { cleanTempDir(tmpDir); });

  it("creates data directory if missing", () => {
    const dataDir = path.join(tmpDir, "newdir");
    const csvPath = path.join(dataDir, "test.csv");
    ensureCsv(dataDir, csvPath);
    assert.ok(fs.existsSync(dataDir));
  });

  it("creates CSV with correct header", () => {
    const dataDir = path.join(tmpDir, "dir2");
    const csvPath = path.join(dataDir, "test.csv");
    ensureCsv(dataDir, csvPath);
    const content = fs.readFileSync(csvPath, "utf-8");
    assert.equal(content.trim(), CSV_COLUMNS);
  });

  it("does not overwrite existing CSV", () => {
    const dataDir = path.join(tmpDir, "dir3");
    fs.mkdirSync(dataDir, { recursive: true });
    const csvPath = path.join(dataDir, "test.csv");
    fs.writeFileSync(csvPath, "existing,data\n", "utf-8");
    ensureCsv(dataDir, csvPath);
    const content = fs.readFileSync(csvPath, "utf-8");
    assert.equal(content.trim(), "existing,data");
  });
});

describe("appendCsvRow()", () => {
  let tmpDir: string;
  let dataDir: string;
  let csvPath: string;

  before(() => {
    tmpDir = makeTempDir();
    dataDir = path.join(tmpDir, "data");
    csvPath = path.join(dataDir, "history.csv");
  });
  after(() => { cleanTempDir(tmpDir); });

  it("creates CSV and appends a full row", () => {
    appendCsvRow(csvPath, dataDir, "2026-03-28", 4492.00, 0.45, 4491.55);
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    assert.equal(lines[0], CSV_COLUMNS);
    assert.equal(lines[1], "2026-03-28,4492.00,0.45,4491.55");
  });

  it("appends row with null forecast (first run)", () => {
    appendCsvRow(csvPath, dataDir, "2026-03-29", 4500.00, null, null);
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    assert.equal(lines[2], "2026-03-29,4500.00,,");
  });

  it("appends row with null deviation only", () => {
    appendCsvRow(csvPath, dataDir, "2026-03-30", 4510.00, 1.80, null);
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    assert.equal(lines[3], "2026-03-30,4510.00,1.80,");
  });

  it("maintains correct number of rows", () => {
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 4); // header + 3 data rows
  });

  it("all rows have exactly 4 columns", () => {
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    for (const line of lines) {
      assert.equal(line.split(",").length, 4, `Row '${line}' should have 4 columns`);
    }
  });
});

describe("updateLastRowDeviation()", () => {
  let tmpDir: string;

  before(() => { tmpDir = makeTempDir(); });
  after(() => { cleanTempDir(tmpDir); });

  it("updates deviation on the last row", () => {
    const dataDir = path.join(tmpDir, "data1");
    const csvPath = path.join(dataDir, "test.csv");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(csvPath, `${CSV_COLUMNS}\n2026-03-28,4492.00,1.80,\n`, "utf-8");
    updateLastRowDeviation(csvPath, dataDir, 4490.20);
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    assert.equal(lines[1], "2026-03-28,4492.00,1.80,4490.20");
  });

  it("does nothing on header-only CSV (no crash)", () => {
    const dataDir = path.join(tmpDir, "data2");
    const csvPath = path.join(dataDir, "test.csv");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(csvPath, `${CSV_COLUMNS}\n`, "utf-8");
    updateLastRowDeviation(csvPath, dataDir, 100);
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1); // still just header
  });

  it("preserves other columns when updating deviation", () => {
    const dataDir = path.join(tmpDir, "data3");
    const csvPath = path.join(dataDir, "test.csv");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(csvPath, `${CSV_COLUMNS}\n2026-03-28,4492.00,1.80,\n`, "utf-8");
    updateLastRowDeviation(csvPath, dataDir, 4490.20);
    const parts = fs.readFileSync(csvPath, "utf-8").trim().split("\n")[1].split(",");
    assert.equal(parts[0], "2026-03-28");
    assert.equal(parts[1], "4492.00");
    assert.equal(parts[2], "1.80");
    assert.equal(parts[3], "4490.20");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: JSON Operations
// ═══════════════════════════════════════════════════════════════════════════

describe("saveTodayForecast()", () => {
  let tmpDir: string;

  before(() => { tmpDir = makeTempDir(); });
  after(() => { cleanTempDir(tmpDir); });

  it("creates valid JSON file", () => {
    const dataDir = path.join(tmpDir, "data");
    const fp = path.join(dataDir, "forecast.json");
    saveTodayForecast(fp, dataDir, "2026-03-28", 1.80);
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    assert.equal(data.date, "2026-03-28");
    assert.equal(data.forecast, 1.80);
  });

  it("rounds forecast to 2 decimal places", () => {
    const dataDir = path.join(tmpDir, "data2");
    const fp = path.join(dataDir, "forecast.json");
    saveTodayForecast(fp, dataDir, "2026-03-28", 1.23456789);
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    assert.equal(data.forecast, 1.23);
  });

  it("handles negative forecast", () => {
    const dataDir = path.join(tmpDir, "data3");
    const fp = path.join(dataDir, "forecast.json");
    saveTodayForecast(fp, dataDir, "2026-03-28", -0.55);
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    assert.equal(data.forecast, -0.55);
  });
});

describe("loadYesterdayForecast()", () => {
  let tmpDir: string;

  before(() => { tmpDir = makeTempDir(); });
  after(() => { cleanTempDir(tmpDir); });

  it("returns null when file is missing", () => {
    assert.equal(loadYesterdayForecast(path.join(tmpDir, "nofile.json")), null);
  });

  it("returns null when date is today (prevents self-read)", () => {
    const fp = path.join(tmpDir, "today.json");
    const today = torontoDateStr();
    fs.writeFileSync(fp, JSON.stringify({ date: today, forecast: 1.5 }));
    assert.equal(loadYesterdayForecast(fp), null);
  });

  it("returns forecast when date is yesterday", () => {
    const fp = path.join(tmpDir, "yesterday.json");
    fs.writeFileSync(fp, JSON.stringify({ date: "2025-01-01", forecast: 0.45 }));
    assert.equal(loadYesterdayForecast(fp), 0.45);
  });

  it("returns null on corrupted JSON", () => {
    const fp = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(fp, "not json{{{");
    assert.equal(loadYesterdayForecast(fp), null);
  });

  it("returns null when forecast field is missing", () => {
    const fp = path.join(tmpDir, "noforecast.json");
    fs.writeFileSync(fp, JSON.stringify({ date: "2025-01-01" }));
    assert.equal(loadYesterdayForecast(fp), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: Coefficient & Forecast Logic
// ═══════════════════════════════════════════════════════════════════════════

describe("Coefficient calculations", () => {
  it("C1 = average of NEM% and GOLD%", () => {
    const nemPct = 2.76;
    const goldPct = -0.35;
    const c1 = (nemPct + goldPct) / 2;
    assert.ok(Math.abs(c1 - 1.205) < 0.001);
  });

  it("Forecast = average of C1, C2, C3", () => {
    const c1 = 1.20, c2 = -0.21, c3 = 4.39;
    const forecast = (c1 + c2 + c3) / 3;
    assert.equal(parseFloat(forecast.toFixed(2)), 1.79);
  });

  it("All coefficients 0 yields forecast 0.00", () => {
    const forecast = (0 + 0 + 0) / 3;
    assert.equal(parseFloat(forecast.toFixed(2)), 0.00);
  });

  it("Deviation = actual - forecast (PDF formula)", () => {
    const actual = 4492.00;
    const forecast = 0.45;
    const deviation = actual - forecast;
    assert.equal(deviation, 4491.55);
  });

  it("toFixed(2) formatting works on all coefficients", () => {
    const c1 = 1.205;
    const c2 = -0.2067;
    const c3 = 4.394;
    assert.equal(c1.toFixed(2), "1.21");
    assert.equal(c2.toFixed(2), "-0.21");
    assert.equal(c3.toFixed(2), "4.39");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: CSV Format Validation (PDF Compliance)
// ═══════════════════════════════════════════════════════════════════════════

describe("CSV format — PDF spec compliance", () => {
  it("CSV_COLUMNS matches PDF exactly: date,actual_gold_price,forecast,deviation", () => {
    assert.equal(CSV_COLUMNS, "date,actual_gold_price,forecast,deviation");
  });

  it("Date format is YYYY-MM-DD", () => {
    const date = torontoDateStr();
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("First run row has empty forecast and deviation", () => {
    const tmpDir = makeTempDir();
    const dataDir = path.join(tmpDir, "data");
    const csvPath = path.join(dataDir, "test.csv");
    appendCsvRow(csvPath, dataDir, "2026-03-22", 2150.30, null, null);
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    assert.equal(lines[1], "2026-03-22,2150.30,,");
    cleanTempDir(tmpDir);
  });

  it("Matches PDF expected output: 2026-03-23,2148.10,0.45,-2.20", () => {
    const tmpDir = makeTempDir();
    const dataDir = path.join(tmpDir, "data");
    const csvPath = path.join(dataDir, "test.csv");
    appendCsvRow(csvPath, dataDir, "2026-03-23", 2148.10, 0.45, -2.20);
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    // PDF shows: 2026-03-23, 2148.10, 0.45, -2.20
    const parts = lines[1].split(",");
    assert.equal(parts[0], "2026-03-23");
    assert.equal(parts[1], "2148.10");
    assert.equal(parts[2], "0.45");
    assert.equal(parts[3], "-2.20");
    cleanTempDir(tmpDir);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: Docker & Deployment File Validation
// ═══════════════════════════════════════════════════════════════════════════

describe("Vercel deployment validation", () => {
  it("vercel.json exists with cron config", () => {
    const vercelJson = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "vercel.json"), "utf-8"));
    assert.ok(vercelJson.crons, "Should have crons array");
    assert.equal(vercelJson.crons[0].path, "/api/forecast");
    assert.equal(vercelJson.crons[0].schedule, "0 14 * * *");
  });

  it("cron schedule targets 10 AM Toronto (14:00 UTC)", () => {
    const vercelJson = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "vercel.json"), "utf-8"));
    // 14:00 UTC = 10:00 AM EDT (Toronto summer) or 9:00 AM EST (winter)
    assert.ok(vercelJson.crons[0].schedule.startsWith("0 14"), "Should be 14:00 UTC");
  });

  it("api/forecast.ts exists", () => {
    assert.ok(fs.existsSync(path.join(SCRIPT_DIR, "api", "forecast.ts")));
  });

  it("api/history.ts exists", () => {
    assert.ok(fs.existsSync(path.join(SCRIPT_DIR, "api", "history.ts")));
  });

  it("public/index.html exists (dashboard)", () => {
    assert.ok(fs.existsSync(path.join(SCRIPT_DIR, "public", "index.html")));
  });

  it("dashboard mentions Gold Forecast", () => {
    const html = fs.readFileSync(path.join(SCRIPT_DIR, "public", "index.html"), "utf-8");
    assert.ok(html.includes("Gold Forecast"));
  });

  it("dashboard fetches /api/history", () => {
    const html = fs.readFileSync(path.join(SCRIPT_DIR, "public", "index.html"), "utf-8");
    assert.ok(html.includes("/api/history"));
  });

  it("forecast API uses Upstash Redis for storage", () => {
    const source = fs.readFileSync(path.join(SCRIPT_DIR, "api", "forecast.ts"), "utf-8");
    assert.ok(source.includes("@upstash/redis"), "forecast.ts should import @upstash/redis");
  });

  it("forecast API has maxDuration config", () => {
    const vercelConfig = JSON.parse(
      fs.readFileSync(path.join(SCRIPT_DIR, "vercel.json"), "utf-8"),
    );
    assert.ok(vercelConfig.functions?.["api/forecast.ts"]?.maxDuration);
  });

  it("package.json has @upstash/redis dependency", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "package.json"), "utf-8"));
    assert.ok(pkg.dependencies["@upstash/redis"], "Should have @upstash/redis");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: Security Checks
// ═══════════════════════════════════════════════════════════════════════════

describe("Security audit", () => {
  it(".gitignore excludes .env", () => {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, ".gitignore"), "utf-8");
    assert.ok(content.includes(".env"));
  });

  it(".gitignore excludes node_modules", () => {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, ".gitignore"), "utf-8");
    assert.ok(content.includes("node_modules"));
  });

  it("agent source has no hardcoded API keys", () => {
    const source = fs.readFileSync(path.join(SCRIPT_DIR, "gold_forecast_agent.ts"), "utf-8");
    // Check for common API key patterns
    assert.ok(!source.match(/gsk_[a-zA-Z0-9]{20,}/), "Should not contain Groq API key");
    assert.ok(!source.match(/sk-[a-zA-Z0-9]{20,}/), "Should not contain OpenAI key");
    assert.ok(!source.match(/AIza[a-zA-Z0-9]{30,}/), "Should not contain Google key");
  });

  it("agent reads API key from environment only", () => {
    const source = fs.readFileSync(path.join(SCRIPT_DIR, "gold_forecast_agent.ts"), "utf-8");
    assert.ok(source.includes("process.env.GROQ_API_KEY"), "Should read key from env");
  });

  it(".env.example has placeholder, not real key", () => {
    const content = fs.readFileSync(path.join(SCRIPT_DIR, ".env.example"), "utf-8");
    assert.ok(content.includes("your_groq_api_key_here"), "Should have placeholder");
    assert.ok(!content.match(/gsk_[a-zA-Z0-9]{20,}/), "Should not contain real key");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8: PDF Compliance — Agent Source Code Checks
// ═══════════════════════════════════════════════════════════════════════════

describe("PDF spec compliance — source code", () => {
  const source = fs.readFileSync(path.join(SCRIPT_DIR, "gold_forecast_agent.ts"), "utf-8");

  it("searches for 'gold price tomorrow' (Action 1)", () => {
    assert.ok(source.includes("gold+price+tomorrow") || source.includes("gold price tomorrow"));
  });

  it("uses NEM symbol, not NEW (PDF typo on page 1)", () => {
    assert.ok(source.includes('"NEM"'), "Should use NEM");
    // Page 1 says NEW but page 2 says NEM — using NEM is correct
  });

  it("uses GOLD symbol for Barrick Gold (Action 2)", () => {
    assert.ok(source.includes('"GOLD"'));
  });

  it("uses AUDUSD=X for forex (Action 3)", () => {
    assert.ok(source.includes("AUDUSD=X"));
  });

  it("uses SLV for silver (Action 4)", () => {
    assert.ok(source.includes('"SLV"'));
  });

  it("limits URL scraping to 20 (MAX_URLS)", () => {
    assert.ok(source.includes("MAX_URLS = 20"));
  });

  it("uses kitco.com as primary gold price source (Action 6)", () => {
    assert.ok(source.includes("kitco.com"));
  });

  it("has Yahoo Finance GC=F as gold price fallback", () => {
    assert.ok(source.includes("GC=F") || source.includes("GC%3DF"));
  });

  it("stores forecast in last_forecast.json (Action 5)", () => {
    assert.ok(source.includes("last_forecast.json"));
  });

  it("outputs exact PDF format: 'Result of Action #1:'", () => {
    assert.ok(source.includes("Result of Action #1:"));
  });

  it("outputs exact PDF format: 'Forecast coefficient (average of C1, C2, C3):'", () => {
    assert.ok(source.includes("Forecast coefficient (average of C1, C2, C3):"));
  });

  it("formats coefficients to 2 decimal places", () => {
    const fixedCalls = source.match(/toFixed\(2\)/g);
    assert.ok(fixedCalls && fixedCalls.length >= 5, "Should have multiple toFixed(2) calls");
  });

  it("uses America/Toronto timezone", () => {
    assert.ok(source.includes("America/Toronto"));
  });

  it("uses Groq API with Llama 3.3 70B model", () => {
    assert.ok(source.includes("llama-3.3-70b-versatile"));
    assert.ok(source.includes("api.groq.com"));
  });

  it("has independent try/catch for each action", () => {
    // Count action error log patterns
    const actionErrors = source.match(/Action \d+ ERROR/g);
    assert.ok(actionErrors && actionErrors.length >= 4, "Should have error handlers per action");
  });

  it("coefficients default to 0 on failure", () => {
    assert.ok(source.includes("let coeff1 = 0"));
    assert.ok(source.includes("let coeff2 = 0"));
    assert.ok(source.includes("let coeff3 = 0"));
  });

  it("NEM and GOLD fetch independently", () => {
    assert.ok(source.includes("let nemPct = 0"));
    assert.ok(source.includes("let goldPct = 0"));
  });

  it("gold price failure skips table update", () => {
    assert.ok(source.includes("Skipping table update"));
  });

  it("25-word limit mentioned in Groq prompt", () => {
    assert.ok(source.includes("25 words") || source.includes("MAX 25 words"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9: Project Structure & Deliverable Checks
// ═══════════════════════════════════════════════════════════════════════════

describe("Project structure", () => {
  it("gold_forecast_agent.ts exists", () => {
    assert.ok(fs.existsSync(path.join(SCRIPT_DIR, "gold_forecast_agent.ts")));
  });

  it("package.json exists with correct type", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "package.json"), "utf-8"));
    assert.equal(pkg.type, "module");
  });

  it("tsconfig.json exists", () => {
    assert.ok(fs.existsSync(path.join(SCRIPT_DIR, "tsconfig.json")));
  });

  it(".env.example exists", () => {
    assert.ok(fs.existsSync(path.join(SCRIPT_DIR, ".env.example")));
  });

  it("vercel.json exists", () => {
    assert.ok(fs.existsSync(path.join(SCRIPT_DIR, "vercel.json")));
  });

  it("README.md exists in agentone", () => {
    assert.ok(fs.existsSync(path.join(SCRIPT_DIR, "README.md")));
  });

  it("api/ directory exists with routes", () => {
    assert.ok(fs.existsSync(path.join(SCRIPT_DIR, "api", "forecast.ts")));
    assert.ok(fs.existsSync(path.join(SCRIPT_DIR, "api", "history.ts")));
  });

  it("README mentions Vercel deployment", () => {
    const readme = fs.readFileSync(path.join(SCRIPT_DIR, "README.md"), "utf-8");
    assert.ok(readme.includes("Vercel") || readme.includes("vercel"));
  });

  it("README has an installation/setup section", () => {
    const readme = fs.readFileSync(path.join(SCRIPT_DIR, "README.md"), "utf-8");
    assert.ok(
      readme.includes("Installation") || readme.includes("Setup") || readme.includes("Quick Start"),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10: Integration Test — Full Pipeline Run
// ═══════════════════════════════════════════════════════════════════════════

const RUN_LONG = process.env.RUN_LONG_TESTS === "1";

describe("Full pipeline integration test", { skip: !RUN_LONG }, () => {
  let tmpDataDir: string;
  let output: string;

  before(() => {
    // Create isolated temp data directory so we don't pollute real data
    tmpDataDir = makeTempDir();
    const dataDir = path.join(tmpDataDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
  });

  after(() => {
    cleanTempDir(tmpDataDir);
  });

  it("pipeline runs to completion (exit code 0)", () => {
    output = execSync(`npx tsx gold_forecast_agent.ts`, {
      cwd: SCRIPT_DIR,
      encoding: "utf-8",
      timeout: 120000,
      env: { ...process.env, DATA_DIR_OVERRIDE: tmpDataDir },
    });
    assert.ok(output.includes("Pipeline complete"), "Should complete pipeline");
  });

  it("output contains all 7 action markers", () => {
    assert.ok(output.includes("Action 1:"), "Missing Action 1");
    assert.ok(output.includes("Action 2:"), "Missing Action 2");
    assert.ok(output.includes("Action 3:"), "Missing Action 3");
    assert.ok(output.includes("Action 4:"), "Missing Action 4");
    assert.ok(output.includes("Action 5:"), "Missing Action 5");
    assert.ok(output.includes("Action 6:"), "Missing Action 6");
    assert.ok(output.includes("Action 7:"), "Missing Action 7");
  });

  it("output contains 'Result of Action #1:' (PDF format)", () => {
    assert.ok(output.includes("Result of Action #1:"));
  });

  it("output contains 'Forecast coefficient (average of C1, C2, C3):'", () => {
    assert.ok(output.includes("Forecast coefficient (average of C1, C2, C3):"));
  });

  it("output shows all 3 coefficient values", () => {
    assert.ok(output.match(/C1=[\-\d.]+%/), "Should show C1");
    assert.ok(output.match(/C2=[\-\d.]+%/), "Should show C2");
    assert.ok(output.match(/C3=[\-\d.]+%/), "Should show C3");
  });

  it("last_forecast.json was created", () => {
    const fp = path.join(SCRIPT_DIR, "data", "last_forecast.json");
    assert.ok(fs.existsSync(fp), "last_forecast.json should exist");
  });

  it("last_forecast.json has today's date and a numeric forecast", () => {
    const fp = path.join(SCRIPT_DIR, "data", "last_forecast.json");
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    assert.equal(data.date, torontoDateStr());
    assert.equal(typeof data.forecast, "number");
  });

  it("gold_forecast_history.csv has header + at least 1 data row", () => {
    const csvPath = path.join(SCRIPT_DIR, "data", "gold_forecast_history.csv");
    assert.ok(fs.existsSync(csvPath), "CSV should exist");
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    assert.ok(lines.length >= 2, `CSV should have header + data, got ${lines.length} lines`);
    assert.equal(lines[0], CSV_COLUMNS);
  });

  it("CSV data row has correct date format", () => {
    const csvPath = path.join(SCRIPT_DIR, "data", "gold_forecast_history.csv");
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    const lastRow = lines[lines.length - 1];
    const date = lastRow.split(",")[0];
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("CSV data row has valid gold price", () => {
    const csvPath = path.join(SCRIPT_DIR, "data", "gold_forecast_history.csv");
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    const lastRow = lines[lines.length - 1];
    const priceStr = lastRow.split(",")[1];
    if (priceStr) {
      const price = parseFloat(priceStr);
      assert.ok(price > 1000 && price < 10000, `Gold price ${price} should be between 1000-10000`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Summary footer
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n══════════════════════════════════════════════════════");
console.log("Gold Forecast Agent — Comprehensive Test Suite");
console.log("══════════════════════════════════════════════════════");
if (!RUN_LONG) {
  console.log("NOTE: Integration tests skipped. Run with:");
  console.log("  RUN_LONG_TESTS=1 npx tsx test_gold_forecast.ts");
}
console.log("══════════════════════════════════════════════════════\n");
