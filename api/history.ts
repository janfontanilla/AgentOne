/**
 * Vercel API Route — read-only JSON endpoint that powers the dashboard.
 *
 * GET /api/history → {
 *   rows:        per-day records merged from gold_forecast_history.csv
 *                and analysis_history.json (article + 3 direct + 3
 *                inverse indicator readings), newest first;
 *   lastForecast: the most recent last_forecast.json blob;
 *   totalDays:    rows.length;
 *   adaptive:    cumulative bonuses, current weights, and history depth
 *                (null when no adaptive history has been collected yet,
 *                so the client can fall back to the equal-weight signal).
 * }
 *
 * Side-effect free: all reads are from Upstash Redis. No state is
 * written here; the daily cron in api/forecast.ts is the only writer.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  loadAdaptiveState,
  computeCumulativeBonuses,
  type IndicatorMap,
} from "./adaptive.js";

const redis = Redis.fromEnv();

const ALL_KEYS: (keyof IndicatorMap)[] = ["d1", "d2", "d3", "r1", "r2", "r3"];

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

export interface HistoryRow {
  date: string;
  actual_gold_price: string;
  forecast: string;
  deviation: string;
  article?: string;
  c1?: number; c2?: number; c3?: number;
  i1?: number; i2?: number; i3?: number;
}

export interface HistoryResponse {
  rows: HistoryRow[];
  lastForecast: any;
  totalDays: number;
  adaptive: {
    cumBonuses: IndicatorMap;
    weights: IndicatorMap;
    historyDays: number;
  } | null;
}

// ─── Pure data-fetch (shared by Vercel handler + AWS Lambda) ────────────────
//
// Exported so AWS Lambda's history-handler.ts can call this directly and
// return JSON without needing to mock a Vercel request/response.

export async function getHistoryData(): Promise<HistoryResponse> {
  const csv = await readKey("gold_forecast_history.csv");
  const forecastJson = await readKey("last_forecast.json");
  const analysisJson = await readKey("analysis_history.json");

  const rows: HistoryRow[] = [];

  // Parse analysis history into a lookup by date
  let analysisMap: Record<string, {
    article: string;
    c1: number; c2: number; c3: number;
    i1?: number; i2?: number; i3?: number;
  }> = {};
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
        ...(analysis ? {
          article: analysis.article,
          c1: analysis.c1,
          c2: analysis.c2,
          c3: analysis.c3,
          i1: analysis.i1,
          i2: analysis.i2,
          i3: analysis.i3,
        } : {}),
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

  // Adaptive weighting state — surfaced so the dashboard can render the
  // weighted net signal and a per-indicator weights panel. Omitted (null)
  // when history is empty so the client falls back to the equal-weight signal.
  let adaptive: {
    cumBonuses: IndicatorMap;
    weights: IndicatorMap;
    historyDays: number;
  } | null = null;
  try {
    const state = await loadAdaptiveState(redis as any);
    if (state.history.length > 0) {
      const cumBonuses = computeCumulativeBonuses(state);
      const weights: IndicatorMap = { d1: 0, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 };
      for (const k of ALL_KEYS) weights[k] = 100 + cumBonuses[k];
      adaptive = { cumBonuses, weights, historyDays: state.history.length };
    }
  } catch {
    // adaptive state is optional — leave null on any failure
  }

  return {
    rows: rows.reverse(),
    lastForecast,
    totalDays: rows.length,
    adaptive,
  };
}

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const data = await getHistoryData();
    res.status(200).json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}
