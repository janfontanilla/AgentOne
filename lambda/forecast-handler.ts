/**
 * AWS Lambda handler for the daily forecast cron.
 *
 * Invoked by EventBridge Scheduler at 10 AM Toronto time (DST-aware).
 * Calls runPipeline() from api/forecast.ts directly — no req/res wrapping.
 *
 * Environment variables (resolved from SSM Parameter Store at deploy time):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   GROQ_API_KEY, ALPHA_VANTAGE_KEY, CRON_SECRET
 */

import type { ScheduledEvent } from "aws-lambda";
import { runPipeline } from "../api/forecast.js";
import { logs } from "../gold_forecast_agent.js";

export const handler = async (event: ScheduledEvent) => {
  console.log("EventBridge trigger received at", event.time);

  // Clear log buffer between invocations (Lambda reuses execution contexts)
  logs.length = 0;

  try {
    await runPipeline();
    console.log(`Pipeline completed successfully (${logs.length} log lines)`);
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", logs }),
    };
  } catch (error: any) {
    console.error("Pipeline failed:", error.message, error.stack);
    // Throw so EventBridge applies its retry policy (default: 2 retries)
    throw error;
  }
};
