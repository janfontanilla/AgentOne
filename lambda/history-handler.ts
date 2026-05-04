/**
 * AWS Lambda handler for the read-only history endpoint.
 *
 * Invoked by API Gateway HTTP API v2 on GET /api/history.
 *
 * Critical: DYNAMIC IMPORT for ../api/history.js so secrets are loaded
 * into process.env BEFORE Redis.fromEnv() runs at module init.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });
let initialized = false;

async function initialize(): Promise<void> {
  if (initialized) return;

  const result = await ssm.send(new GetParametersCommand({
    Names: [
      "/gold-forecast/upstash-url",
      "/gold-forecast/upstash-token",
    ],
    WithDecryption: true,
  }));

  for (const p of result.Parameters ?? []) {
    if (!p.Name || !p.Value) continue;
    if (p.Name === "/gold-forecast/upstash-url") process.env.UPSTASH_REDIS_REST_URL = p.Value;
    else if (p.Name === "/gold-forecast/upstash-token") process.env.UPSTASH_REDIS_REST_TOKEN = p.Value;
  }

  initialized = true;
}

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  console.log("API request:", event.rawPath, event.requestContext.http.method);

  try {
    await initialize();
    const { getHistoryData } = await import("../api/history.js");
    const data = await getHistoryData();
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(data),
    };
  } catch (error: any) {
    console.error("History API error:", error.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
