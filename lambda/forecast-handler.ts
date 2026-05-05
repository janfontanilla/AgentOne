/**
 * AWS Lambda handler for the daily forecast cron.
 *
 * Invoked by EventBridge Scheduler at 10 AM Toronto time (DST-aware).
 *
 * Loads Groq + Alpha Vantage + Cron secrets from SSM into process.env at
 * cold start. State storage is S3 (bucket name comes from STATE_BUCKET_NAME,
 * set by SAM); the S3 client uses the Lambda's IAM role automatically.
 */

import type { ScheduledEvent } from "aws-lambda";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });
let initialized = false;

async function initialize(): Promise<void> {
  if (initialized) return;

  const result = await ssm.send(new GetParametersCommand({
    Names: [
      "/gold-forecast/groq-api-key",
      "/gold-forecast/alpha-vantage-key",
      "/gold-forecast/cron-secret",
    ],
    WithDecryption: true,
  }));

  for (const p of result.Parameters ?? []) {
    if (!p.Name || !p.Value) continue;
    if (p.Name === "/gold-forecast/groq-api-key") process.env.GROQ_API_KEY = p.Value;
    else if (p.Name === "/gold-forecast/alpha-vantage-key") process.env.ALPHA_VANTAGE_KEY = p.Value;
    else if (p.Name === "/gold-forecast/cron-secret") process.env.CRON_SECRET = p.Value;
  }

  initialized = true;
}

export const handler = async (event: ScheduledEvent) => {
  console.log("EventBridge trigger received at", event.time);

  await initialize();

  // Dynamic import — runs AFTER process.env is populated. ESM caches the
  // module, so subsequent invocations on the same Lambda container reuse
  // this import (no re-fetch).
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
