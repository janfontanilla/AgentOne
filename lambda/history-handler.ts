/**
 * AWS Lambda handler for the read-only history endpoint.
 *
 * Invoked by API Gateway HTTP API v2 on GET /api/history.
 * State is read from S3 via the Lambda's IAM role — no Upstash credentials needed.
 * STATE_BUCKET_NAME is injected by SAM at deploy time.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";

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
