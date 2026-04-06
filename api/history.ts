/**
 * Vercel API Route — Returns forecast history data
 * Used by the dashboard to display the CSV table and latest forecast.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

async function readKey(key: string): Promise<string | null> {
  try {
    const value = await redis.get(key);
    if (value === null || value === undefined) return null;
    // Upstash auto-deserializes JSON — ensure we always return a string
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return null;
  }
}

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const csv = await readKey("gold_forecast_history.csv");
    const forecastJson = await readKey("last_forecast.json");
    const analysisJson = await readKey("analysis_history.json");

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

    // Parse analysis history into a lookup by date
    let analysisMap: Record<string, { article: string; c1: number; c2: number; c3: number }> = {};
    if (analysisJson) {
      try {
        const entries = JSON.parse(analysisJson);
        for (const e of entries) {
          if (e.date) analysisMap[e.date] = e;
        }
      } catch { /* ignore parse errors */ }
    }

    if (csv) {
      const lines = csv.trim().split("\n");
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(",");
        if (parts.length < 4) continue;
        const date = parts[0] || "";
        const analysis = analysisMap[date];
        rows.push({
          date,
          actual_gold_price: parts[1] || "",
          forecast: parts[2] || "",
          deviation: parts[3] || "",
          ...(analysis ? { article: analysis.article, c1: analysis.c1, c2: analysis.c2, c3: analysis.c3 } : {}),
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
