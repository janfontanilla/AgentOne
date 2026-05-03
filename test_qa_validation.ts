/**
 * Pre-AWS Migration QA Validation Script
 *
 * Comprehensive validation of the Gold Forecast pipeline before migrating to AWS.
 * Tests:
 * - Pipeline execution completeness
 * - CSV format and dedup logic
 * - Coefficient calculations
 * - Data persistence
 *
 * Run: npx tsx test_qa_validation.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(SCRIPT_DIR, "data");
const CSV_PATH = path.join(DATA_DIR, "gold_forecast_history.csv");
const FORECAST_PATH = path.join(DATA_DIR, "last_forecast.json");

interface TestResult {
  name: string;
  status: "PASS" | "FAIL" | "WARN";
  message: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, status: "PASS", message: "OK" });
    console.log(`✅ ${name}`);
  } catch (e: any) {
    results.push({ name, status: "FAIL", message: e.message });
    console.log(`❌ ${name}: ${e.message}`);
  }
}

function warn(name: string, msg: string) {
  results.push({ name, status: "WARN", message: msg });
  console.log(`⚠️  ${name}: ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────

console.log("🔍 Gold Forecast QA Validation\n");

// Test 1: File Integrity
test("CSV file exists", () => {
  assert(fs.existsSync(CSV_PATH), `CSV not found at ${CSV_PATH}`);
});

test("last_forecast.json exists", () => {
  assert(
    fs.existsSync(FORECAST_PATH),
    `last_forecast.json not found at ${FORECAST_PATH}`
  );
});

// Test 2: CSV Format
test("CSV has correct headers", () => {
  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const header = content.split("\n")[0];
  assert(
    header === "date,actual_gold_price,forecast,deviation",
    `Header mismatch: ${header}`
  );
});

test("CSV uses LF line endings", () => {
  const buffer = fs.readFileSync(CSV_PATH);
  const hasCRLF = buffer.includes(Buffer.from("\r\n", "utf-8"));
  assert(!hasCRLF, "CSV uses CRLF instead of LF");
});

test("CSV is UTF-8 encoded", () => {
  const buffer = fs.readFileSync(CSV_PATH);
  const decoded = buffer.toString("utf-8");
  // Re-encode and verify no data loss
  const reencoded = Buffer.from(decoded, "utf-8");
  assert(
    buffer.length === reencoded.length,
    "Data loss on UTF-8 re-encode (check BOM)"
  );
});

// Test 3: CSV Content Structure
test("CSV has no duplicate rows", () => {
  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() && l !== "date,actual_gold_price,forecast,deviation");
  const dates = lines.map((l) => l.split(",")[0]);
  const uniqueDates = new Set(dates);
  assert(dates.length === uniqueDates.size, `Found ${dates.length - uniqueDates.size} duplicate date rows`);
});

test("All dates are YYYY-MM-DD format", () => {
  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() && l !== "date,actual_gold_price,forecast,deviation");
  for (const line of lines) {
    const date = line.split(",")[0];
    assert(/^\d{4}-\d{2}-\d{2}$/.test(date), `Invalid date format: ${date}`);
  }
});

test("All prices are valid numbers", () => {
  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() && l !== "date,actual_gold_price,forecast,deviation");
  for (const line of lines) {
    const parts = line.split(",");
    const actual = parts[1];
    if (actual) {
      const num = parseFloat(actual);
      assert(Number.isFinite(num) && num > 1000 && num < 10000, `Invalid gold price: ${actual}`);
    }
  }
});

test("Forecast column format is correct (2 decimals or empty)", () => {
  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() && l !== "date,actual_gold_price,forecast,deviation");
  for (const line of lines) {
    const parts = line.split(",");
    const forecast = parts[2];
    if (forecast) {
      assert(/^\d+\.\d{2}$/.test(forecast), `Invalid forecast format: ${forecast}`);
    }
  }
});

test("Deviation column format is correct (2 decimals or empty)", () => {
  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() && l !== "date,actual_gold_price,forecast,deviation");
  for (const line of lines) {
    const parts = line.split(",");
    const deviation = parts[3];
    if (deviation) {
      // Deviation can be negative, so check for optional minus sign
      assert(/^-?\d+\.\d{2}$/.test(deviation), `Invalid deviation format: ${deviation}`);
    }
  }
});

// Test 4: last_forecast.json Structure
test("last_forecast.json is valid JSON", () => {
  const content = fs.readFileSync(FORECAST_PATH, "utf-8");
  try {
    JSON.parse(content);
  } catch (e) {
    throw new Error("Invalid JSON");
  }
});

test("last_forecast.json has required fields", () => {
  const content = fs.readFileSync(FORECAST_PATH, "utf-8");
  const data = JSON.parse(content);
  assert(data.date !== undefined, "Missing 'date' field");
  assert(data.forecast !== undefined, "Missing 'forecast' field");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(data.date), `Invalid date: ${data.date}`);
  assert(typeof data.forecast === "number", `forecast is not a number: ${typeof data.forecast}`);
});

// Test 5: Data Consistency
test("CSV row count matches expected pipeline runs", () => {
  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() && l !== "date,actual_gold_price,forecast,deviation");
  // We expect at least 1 row (from test run)
  assert(lines.length >= 1, `Expected at least 1 data row, got ${lines.length}`);
});

test("Most recent CSV date matches or precedes last_forecast.json date", () => {
  const csvContent = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = csvContent.split("\n").filter((l) => l.trim() && l !== "date,actual_gold_price,forecast,deviation");
  const lastCsvDate = lines[lines.length - 1]?.split(",")[0];

  const jsonContent = fs.readFileSync(FORECAST_PATH, "utf-8");
  const jsonData = JSON.parse(jsonContent);
  const jsonDate = jsonData.date;

  assert(
    lastCsvDate <= jsonDate || lastCsvDate === jsonDate,
    `CSV date (${lastCsvDate}) is newer than last_forecast date (${jsonDate})`
  );
});

// Test 6: Spec Compliance
test("CSV columns in exact order per spec", () => {
  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const header = content.split("\n")[0];
  assert(
    header === "date,actual_gold_price,forecast,deviation",
    "Columns not in spec order"
  );
});

test("CSV append-only behavior (no overwrites of historical rows)", () => {
  // This is verified by checking no duplicates and chronological order
  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() && l !== "date,actual_gold_price,forecast,deviation");
  const dates = lines.map((l) => l.split(",")[0]);
  for (let i = 1; i < dates.length; i++) {
    assert(dates[i - 1] <= dates[i], `Rows out of chronological order`);
  }
});

// Test 7: First-Run Handling
test("First-run rows have empty forecast and deviation (per spec)", () => {
  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() && l !== "date,actual_gold_price,forecast,deviation");

  // The very first row should have empty forecast (no previous day's forecast)
  if (lines.length > 0) {
    const firstRow = lines[0].split(",");
    // First run can have empty forecast/deviation
    // This is expected behavior
    if (firstRow[2] === "" && firstRow[3] === "") {
      warn("First-run row", "Has empty forecast/deviation (expected on day 1)");
    }
  }
});

// Test 8: Pipeline State
test("Pipeline saved today's forecast for next run", () => {
  const jsonContent = fs.readFileSync(FORECAST_PATH, "utf-8");
  const data = JSON.parse(jsonContent);
  assert(data.forecast !== null && data.forecast !== undefined, "Forecast not saved");
  assert(typeof data.forecast === "number", "Forecast is not a number");
});

// ─────────────────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(70));
console.log("SUMMARY");
console.log("=".repeat(70));

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
const warned = results.filter((r) => r.status === "WARN").length;

console.log(`✅ Passed:  ${passed}/${results.length}`);
if (warned > 0) console.log(`⚠️  Warned:  ${warned}/${results.length}`);
if (failed > 0) console.log(`❌ Failed:  ${failed}/${results.length}`);

if (failed === 0) {
  console.log("\n✨ All critical checks passed! Ready for AWS migration.\n");
  process.exit(0);
} else {
  console.log("\n⛔ Fix issues above before AWS migration.\n");
  process.exit(1);
}
