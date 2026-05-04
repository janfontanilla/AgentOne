/**
 * AWS Lambda handler for the read-only history endpoint.
 *
 * Invoked by API Gateway HTTP API v2 on GET /api/history.
 * Calls getHistoryData() from api/history.ts and returns JSON with
 * CORS headers for the CloudFront-hosted dashboard.
 *
 * Secrets are loaded from SSM Parameter Store at Lambda init (cached per
 * container). Only Upstash credentials are needed for read-only access.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { getHistoryData } from "../api/history.js";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ssm = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });
let secretsLoaded = false;

async function loadSecrets(): Promise<void> {
  if (secretsLoaded) return;

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

  secretsLoaded = true;
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  console.log("API request:", event.rawPath, event.requestContext.http.method);

  try {
    await loadSecrets();
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
