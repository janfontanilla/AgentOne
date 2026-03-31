/**
 * Vercel API Route — Returns forecast history data
 * Used by the dashboard to display the CSV table and latest forecast.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { list, getDownloadUrl } from "@vercel/blob";

async function readBlob(filename: string): Promise<string | null> {
  try {
    const { blobs } = await list({ prefix: filename });
    if (blobs.length === 0) return null;
    const downloadUrl = await getDownloadUrl(blobs[0].url);
    const resp = await fetch(downloadUrl);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const csv = await readBlob("gold_forecast_history.csv");
    const forecastJson = await readBlob("last_forecast.json");

    const rows: Array<{
      date: string;
      actual_gold_price: string;
      forecast: string;
      deviation: string;
      article?: string;
      c1?: number;
      c2?: number;
      c3?: number;
    }> = [];

    // Parse last_forecast.json for today's analysis
    let todayAnalysis: { article: string; c1: number; c2: number; c3: number } | null = null;
    if (forecastJson) {
      try {
        const forecast = JSON.parse(forecastJson);
        if (forecast.article && forecast.c1 !== undefined) {
          todayAnalysis = { article: forecast.article, c1: forecast.c1, c2: forecast.c2, c3: forecast.c3 };
        }
      } catch { /* ignore parse errors */ }
    }

    if (csv) {
      const lines = csv.trim().split("\n");
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(",");
        if (parts.length < 4) continue;
        const date = parts[0] || "";
        // Only add analysis to today's row
        const isTodayRow = date === new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        rows.push({
          date,
          actual_gold_price: parts[1] || "",
          forecast: parts[2] || "",
          deviation: parts[3] || "",
          ...(isTodayRow && todayAnalysis ? { article: todayAnalysis.article, c1: todayAnalysis.c1, c2: todayAnalysis.c2, c3: todayAnalysis.c3 } : {}),
        });
      }
    }

    let lastForecast = null;
    if (forecastJson) {
      try {
        lastForecast = JSON.parse(forecastJson);
      } catch {
        lastForecast = null;
      }
    }

    res.status(200).json({
      rows: rows.reverse(),
      lastForecast,
      totalDays: rows.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}
