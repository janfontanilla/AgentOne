/**
 * AWS Lambda handler for the daily forecast cron.
 *
 * Invoked by EventBridge Scheduler at 10 AM Toronto time (DST-aware).
 *
 * Critical: We use DYNAMIC IMPORT for ../api/forecast.js to ensure secrets
 * are loaded into process.env BEFORE Redis.fromEnv() runs at module init.
 * Static `import` would execute Redis.fromEnv() with empty env vars and
 * break the pipeline with "Failed to parse URL" errors.
 */

import type { ScheduledEvent } from "aws-lambda";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });
let initialized = false;

async function initialize(): Promise<void> {
  if (initialized) return;

  const result = await ssm.send(new GetParametersCommand({
    Names: [
      "/gold-forecast/upstash-url",
      "/gold-forecast/upstash-token",
      "/gold-forecast/groq-api-key",
      "/gold-forecast/alpha-vantage-key",
      "/gold-forecast/cron-secret",
    ],
    WithDecryption: true,
  }));

  for (const p of result.Parameters ?? []) {
    if (!p.Name || !p.Value) continue;
    if (p.Name === "/gold-forecast/upstash-url") process.env.UPSTASH_REDIS_REST_URL = p.Value;
    else if (p.Name === "/gold-forecast/upstash-token") process.env.UPSTASH_REDIS_REST_TOKEN = p.Value;
    else if (p.Name === "/gold-forecast/groq-api-key") process.env.GROQ_API_KEY = p.Value;
    else if (p.Name === "/gold-forecast/alpha-vantage-key") process.env.ALPHA_VANTAGE_KEY = p.Value;
    else if (p.Name === "/gold-forecast/cron-secret") process.env.CRON_SECRET = p.Value;
  }

  initialized = true;
}

export const handler = async (event: ScheduledEvent) => {
  console.log("EventBridge trigger received at", event.time);

  await initialize();

  // Dynamic import — runs AFTER process.env is populated, so Redis.fromEnv()
  // sees the proper credentials. ESM caches the module, so subsequent
  // invocations on the same Lambda container reuse this import (no re-fetch).
  const { runPipeline } = await import("../api/forecast.js");
  const { logs } = await import("../gold_forecast_agent.js");

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
    throw error;
  }
};
