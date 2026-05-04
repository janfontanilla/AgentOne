/**
 * AWS Lambda handler for the daily forecast cron.
 *
 * Invoked by EventBridge Scheduler at 10 AM Toronto time (DST-aware).
 * Calls runPipeline() from api/forecast.ts directly — no req/res wrapping.
 *
 * Secrets are loaded from SSM Parameter Store at Lambda init (cached per
 * container). CloudFormation does not support {{resolve:ssm-secure}} for
 * Lambda env vars, so we fetch them at runtime and inject into process.env.
 */

import type { ScheduledEvent } from "aws-lambda";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { runPipeline } from "../api/forecast.js";
import { logs } from "../gold_forecast_agent.js";

const ssm = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });
let secretsLoaded = false;

async function loadSecrets(): Promise<void> {
  if (secretsLoaded) return;

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

  secretsLoaded = true;
}

export const handler = async (event: ScheduledEvent) => {
  console.log("EventBridge trigger received at", event.time);

  await loadSecrets();
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
