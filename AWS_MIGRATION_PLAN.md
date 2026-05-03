# AWS Migration Plan v2 — Gold Forecast Agent (Optimized)

**Migration:** Vercel + Upstash → AWS Lambda + EventBridge + S3/CloudFront
**Storage:** Upstash Redis (kept, no schema changes)
**Cost:** <$1/month (all within AWS free tier)
**Timeline:** 4-5 hours to go live

---

## Executive Summary

This is **v2** of the AWS migration plan. v1 had 5 critical bugs that would cause deployment failures. This version fixes all of them:

| Bug Fixed | Impact |
|-----------|--------|
| **#1 Timezone math** | Use EventBridge Scheduler (not Rules) with `TimeZone: America/Toronto` — handles DST automatically |
| **#2 ESM module conflict** | esbuild config uses `.mjs` with ESM imports |
| **#3 CloudFormation Parameter Default** | Removed intrinsic functions from Default values |
| **#4 Fragile mock req/res handlers** | Refactor `api/forecast.ts` to export `runPipeline()` — clean ~20 line handlers |
| **#5 Invalid CachePolicyId** | Use correct AWS-managed policy IDs |

Plus improvements:
- ✅ Hard cutover (no dual-run race conditions on Upstash)
- ✅ Deployment-time SSM resolution (zero runtime cost)
- ✅ Both PowerShell and Bash commands
- ✅ Test EventBridge with `rate(5 minutes)` (no 24-hour waits)
- ✅ Corrected cost estimates

---

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │  EventBridge Scheduler              │
                    │  cron(0 10 * * ? *)                 │
                    │  TimeZone: America/Toronto          │
                    │  ✅ DST-aware (always 10 AM local)  │
                    └────────────┬────────────────────────┘
                                 │ invoke (IAM)
                                 ▼
                    ┌────────────────────────────────────┐
                    │  Lambda: forecast-cron             │
                    │  Runtime: nodejs20.x               │
                    │  Timeout: 270s / Memory: 512 MB    │
                    │  Handler: forecast-handler.handler │
                    │  Calls runPipeline() directly      │
                    └────────────┬───────────────────────┘
                                 │ HTTPS
                                 ▼
                    ┌────────────────────────────────────┐
                    │  Upstash Redis (kept)              │
                    │  5 keys, no schema changes         │
                    └────────────────────────────────────┘

                    ┌────────────────────────────────────┐
                    │  API Gateway HTTP API v2           │
                    │  GET /api/history                  │
                    └────────────┬───────────────────────┘
                                 ▼
                    ┌────────────────────────────────────┐
                    │  Lambda: history-api               │
                    │  Timeout: 30s / Memory: 256 MB     │
                    │  Calls getHistoryData() directly   │
                    └────────────┬───────────────────────┘
                                 │ HTTPS
                                 ▼
                    ┌────────────────────────────────────┐
                    │  Upstash Redis (read-only)         │
                    └────────────────────────────────────┘

                    ┌────────────────────────────────────┐
                    │  CloudFront (CDN, HTTPS)           │
                    │  /         → S3                    │
                    │  /api/*    → API Gateway           │
                    └────────────┬───────────────────────┘
                                 ▼
                    ┌────────────────────────────────────┐
                    │  S3 Bucket (public/index.html)     │
                    └────────────────────────────────────┘

Secrets: SSM Parameter Store (resolved at deploy time, zero runtime cost)
IaC:     SAM (template.yaml)
Build:   esbuild → dist/
```

---

## Phase 1: Refactor api/forecast.ts (~5 minutes)

**Goal:** Add a pure `runPipeline()` export so Lambda handler can call it directly without mock req/res objects.

**File:** `c:\Users\janfo\OneDrive\Desktop\HappyNutrition\agentone\api\forecast.ts`

**Required changes:**
1. Extract pipeline logic into a new `runPipeline()` function
2. Keep the existing Vercel `handler()` calling `runPipeline()` — non-breaking for Vercel
3. Lambda handler will import and call `runPipeline()` directly

**Code change pattern:**

```typescript
// === BEFORE (current) ===
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ... pipeline logic inline ...
  res.json({ status: "success" });
}

// === AFTER (refactored) ===

// New: Pure pipeline function (no Vercel deps)
export async function runPipeline(): Promise<{ status: string; logs: string[] }> {
  // ... move all pipeline logic here ...
  return { status: "success", logs: logs.slice() };
}

// Existing: Vercel handler now just wraps runPipeline()
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  try {
    const result = await runPipeline();
    res.status(200).json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}
```

**Same pattern for `api/history.ts`:**
```typescript
// New export
export async function getHistoryData(): Promise<HistoryResponse> {
  // ... existing read logic ...
  return { rows, lastForecast, totalDays, adaptive };
}

// Existing handler now just wraps it
export default async function handler(req, res) {
  try {
    const data = await getHistoryData();
    res.status(200).json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}
```

**Verification:**
```bash
npm run typecheck  # Should pass
npm test           # All 108 tests still pass
```

---

## Phase 2: Pre-flight Checks (~10 minutes)

### **STOP & CHECK 0: Verify your environment is ready**

**PowerShell:**
```powershell
aws --version                          # aws-cli/2.x or higher
sam --version                          # SAM CLI 1.x or higher
aws sts get-caller-identity            # Returns your AWS Account ID
node --version                         # v18+ (recommend v20)
npm run typecheck                      # No TypeScript errors
```

**Bash:**
```bash
aws --version                          # aws-cli/2.x or higher
sam --version                          # SAM CLI 1.x or higher
aws sts get-caller-identity            # Returns your AWS Account ID
node --version                         # v18+ (recommend v20)
npm run typecheck                      # No TypeScript errors
```

**If any fail:**
- AWS CLI: https://aws.amazon.com/cli/
- SAM CLI: `pip install aws-sam-cli`
- AWS auth: `aws configure` (need access key + secret)

---

## Phase 3: Create SSM Secrets (~5 minutes)

Store all secrets encrypted in AWS SSM Parameter Store. Resolved at deploy time = zero runtime cost.

**PowerShell:**
```powershell
$REGION = "us-east-1"

# Read current values from .env
$envFile = Get-Content "c:\Users\janfo\OneDrive\Desktop\HappyNutrition\agentone\.env" | Where-Object { $_ -match "=" }
$envHash = @{}
foreach ($line in $envFile) {
  if ($line -notmatch "^#") {
    $key, $value = $line -split "=", 2
    $envHash[$key.Trim()] = $value.Trim()
  }
}

# Generate a random CRON_SECRET if you don't have one
$cronSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})

# Create 5 SecureString parameters
aws ssm put-parameter --name "/gold-forecast/upstash-url" --value $envHash["UPSTASH_REDIS_REST_URL"] --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/upstash-token" --value $envHash["UPSTASH_REDIS_REST_TOKEN"] --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/groq-api-key" --value $envHash["GROQ_API_KEY"] --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/alpha-vantage-key" --value $envHash["ALPHA_VANTAGE_KEY"] --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/cron-secret" --value $cronSecret --type SecureString --region $REGION --overwrite

# Verify
aws ssm describe-parameters --region $REGION --query "Parameters[?starts_with(Name, '/gold-forecast/')].Name"
# Expected: 5 parameters listed
```

**Bash:**
```bash
REGION="us-east-1"
source c:/Users/janfo/OneDrive/Desktop/HappyNutrition/agentone/.env
CRON_SECRET=$(openssl rand -hex 32)

aws ssm put-parameter --name "/gold-forecast/upstash-url" --value "$UPSTASH_REDIS_REST_URL" --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/upstash-token" --value "$UPSTASH_REDIS_REST_TOKEN" --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/groq-api-key" --value "$GROQ_API_KEY" --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/alpha-vantage-key" --value "$ALPHA_VANTAGE_KEY" --type SecureString --region $REGION --overwrite
aws ssm put-parameter --name "/gold-forecast/cron-secret" --value "$CRON_SECRET" --type SecureString --region $REGION --overwrite

aws ssm describe-parameters --region $REGION --query "Parameters[?starts_with(Name, '/gold-forecast/')].Name"
```

**Cost:** $0 (deployment-time resolution = no runtime API calls)

---

## Phase 4: Create Lambda Handlers (~10 minutes)

Clean ~20 line handlers — no mock req/res objects, just direct function calls.

### File: `lambda/forecast-handler.ts`

```typescript
/**
 * AWS Lambda handler for daily forecast cron.
 * Invoked by EventBridge Scheduler at 10 AM Toronto time.
 * Calls runPipeline() directly — no Vercel handler wrapping.
 */

import type { ScheduledEvent } from "aws-lambda";
import { runPipeline } from "../api/forecast.js";

export const handler = async (event: ScheduledEvent) => {
  console.log("EventBridge trigger:", event.time);

  try {
    const result = await runPipeline();
    console.log("Pipeline completed:", result.status);
    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (error: any) {
    console.error("Pipeline failed:", error.message, error.stack);
    throw error; // EventBridge will retry per its policy
  }
};
```

### File: `lambda/history-handler.ts`

```typescript
/**
 * AWS Lambda handler for /api/history endpoint.
 * Invoked by API Gateway HTTP API v2.
 * Returns JSON with CORS headers for dashboard.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getHistoryData } from "../api/history.js";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  console.log("API request:", event.rawPath);

  try {
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
```

**Install AWS Lambda types:**
```bash
npm install --save-dev @types/aws-lambda esbuild
```

---

## Phase 5: Create esbuild Config (~5 minutes)

**File:** `esbuild.config.mjs` (note `.mjs` extension for ESM)

```javascript
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

if (!fs.existsSync("./dist")) {
  fs.mkdirSync("./dist", { recursive: true });
}

const commonOptions = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["@aws-sdk/*"], // pre-installed in Lambda runtime
  sourcemap: true,
  minify: true,
  banner: {
    // Workaround for ESM `__dirname` not being defined in bundled output
    js: "import { fileURLToPath } from 'url'; import { dirname } from 'path'; const __filename = fileURLToPath(import.meta.url); const __dirname = dirname(__filename);",
  },
};

async function build() {
  try {
    await esbuild.build({
      ...commonOptions,
      entryPoints: ["./lambda/forecast-handler.ts"],
      outfile: "./dist/forecast-handler.js",
    });

    await esbuild.build({
      ...commonOptions,
      entryPoints: ["./lambda/history-handler.ts"],
      outfile: "./dist/history-handler.js",
    });

    const forecastSize = fs.statSync("./dist/forecast-handler.js").size;
    const historySize = fs.statSync("./dist/history-handler.js").size;

    console.log(`✓ forecast-handler.js: ${(forecastSize / 1024).toFixed(1)} KB`);
    console.log(`✓ history-handler.js: ${(historySize / 1024).toFixed(1)} KB`);
    console.log(`Total: ${((forecastSize + historySize) / 1024).toFixed(1)} KB`);
  } catch (e) {
    console.error("Build failed:", e);
    process.exit(1);
  }
}

build();
```

**Add to `package.json`:**
```json
{
  "scripts": {
    "build": "node esbuild.config.mjs",
    "deploy": "npm run build && sam deploy --stack-name goldforecast-stack --region us-east-1 --capabilities CAPABILITY_NAMED_IAM"
  }
}
```

**Test the build:**
```bash
npm run build
ls -lah dist/
# Expected: forecast-handler.js ~80-150 KB, history-handler.js ~50-80 KB
```

---

## Phase 6: SAM Template (~15 minutes)

**File:** `template.yaml`

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Description: Gold Forecast Agent - AWS Migration v2

Globals:
  Function:
    Runtime: nodejs20.x
    Architectures:
      - x86_64

Resources:

  # ─── Lambda: Forecast Cron ────────────────────────────────────────────
  ForecastCronFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: goldforecast-forecast-cron
      CodeUri: dist/
      Handler: forecast-handler.handler
      Timeout: 270
      MemorySize: 512
      Environment:
        Variables:
          UPSTASH_REDIS_REST_URL: '{{resolve:ssm-secure:/gold-forecast/upstash-url:1}}'
          UPSTASH_REDIS_REST_TOKEN: '{{resolve:ssm-secure:/gold-forecast/upstash-token:1}}'
          GROQ_API_KEY: '{{resolve:ssm-secure:/gold-forecast/groq-api-key:1}}'
          ALPHA_VANTAGE_KEY: '{{resolve:ssm-secure:/gold-forecast/alpha-vantage-key:1}}'
          CRON_SECRET: '{{resolve:ssm-secure:/gold-forecast/cron-secret:1}}'

  ForecastCronLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /aws/lambda/goldforecast-forecast-cron
      RetentionInDays: 30

  # ─── EventBridge Scheduler (NOT Rules) ────────────────────────────────
  # Why Scheduler vs Rules: Scheduler supports TimeZone parameter for proper DST
  ForecastSchedulerRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              Service: scheduler.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: invoke-forecast-lambda
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: lambda:InvokeFunction
                Resource: !GetAtt ForecastCronFunction.Arn

  ForecastSchedule:
    Type: AWS::Scheduler::Schedule
    Properties:
      Name: goldforecast-daily-cron
      Description: Daily forecast at 10 AM Toronto time (DST-aware)
      ScheduleExpression: "cron(0 10 * * ? *)"
      ScheduleExpressionTimezone: "America/Toronto"
      State: ENABLED
      FlexibleTimeWindow:
        Mode: "OFF"
      Target:
        Arn: !GetAtt ForecastCronFunction.Arn
        RoleArn: !GetAtt ForecastSchedulerRole.Arn

  # ─── Lambda: History API ──────────────────────────────────────────────
  HistoryApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: goldforecast-history-api
      CodeUri: dist/
      Handler: history-handler.handler
      Timeout: 30
      MemorySize: 256
      Environment:
        Variables:
          UPSTASH_REDIS_REST_URL: '{{resolve:ssm-secure:/gold-forecast/upstash-url:1}}'
          UPSTASH_REDIS_REST_TOKEN: '{{resolve:ssm-secure:/gold-forecast/upstash-token:1}}'
      Events:
        GetHistory:
          Type: HttpApi
          Properties:
            ApiId: !Ref HistoryApi
            Method: GET
            Path: /api/history

  HistoryApiLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /aws/lambda/goldforecast-history-api
      RetentionInDays: 30

  # ─── API Gateway HTTP API v2 ──────────────────────────────────────────
  HistoryApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      StageName: "$default"
      CorsConfiguration:
        AllowOrigins: ["*"]
        AllowMethods: ["GET", "OPTIONS"]
        AllowHeaders: ["Content-Type"]

  # ─── S3 Bucket for Static Site ────────────────────────────────────────
  DashboardBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "goldforecast-dashboard-${AWS::AccountId}"
      VersioningConfiguration:
        Status: Enabled
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true

  DashboardOAC:
    Type: AWS::CloudFront::OriginAccessControl
    Properties:
      OriginAccessControlConfig:
        Name: GoldForecastDashboardOAC
        OriginAccessControlOriginType: s3
        SigningBehavior: always
        SigningProtocol: sigv4

  DashboardBucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref DashboardBucket
      PolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: cloudfront.amazonaws.com
            Action: s3:GetObject
            Resource: !Sub "${DashboardBucket.Arn}/*"
            Condition:
              StringEquals:
                "AWS:SourceArn": !Sub "arn:aws:cloudfront::${AWS::AccountId}:distribution/${DashboardDistribution}"

  # ─── CloudFront (CORRECT CachePolicyIds) ──────────────────────────────
  DashboardDistribution:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        Enabled: true
        DefaultRootObject: index.html
        HttpVersion: http2
        PriceClass: PriceClass_100  # US/EU only — cheapest
        Origins:
          - Id: S3Origin
            DomainName: !GetAtt DashboardBucket.RegionalDomainName
            S3OriginConfig: {}
            OriginAccessControlId: !GetAtt DashboardOAC.Id
          - Id: ApiGatewayOrigin
            DomainName: !Sub "${HistoryApi}.execute-api.${AWS::Region}.amazonaws.com"
            CustomOriginConfig:
              HTTPSPort: 443
              OriginProtocolPolicy: https-only
              OriginSSLProtocols:
                - TLSv1.2
        DefaultCacheBehavior:
          TargetOriginId: S3Origin
          ViewerProtocolPolicy: redirect-to-https
          AllowedMethods: [GET, HEAD, OPTIONS]
          # CORRECT: CachingOptimized policy (was incorrect in v1)
          CachePolicyId: 658327ea-f89d-4fab-a63d-7e88639e58f6
          Compress: true
        CacheBehaviors:
          - PathPattern: "/api/*"
            TargetOriginId: ApiGatewayOrigin
            ViewerProtocolPolicy: https-only
            AllowedMethods: [GET, HEAD, OPTIONS]
            # CORRECT: CachingDisabled policy (no cache for live data)
            CachePolicyId: 4135ea3d-6df7-44a4-9bb4-1b042a830a37
            # CORRECT: AllViewer origin request policy
            OriginRequestPolicyId: 216adef6-5c7f-47e4-b989-5492eafa07d3
            Compress: true

Outputs:
  ForecastCronFunctionArn:
    Description: ARN of the forecast-cron Lambda
    Value: !GetAtt ForecastCronFunction.Arn

  HistoryApiUrl:
    Description: API Gateway URL for /api/history
    Value: !Sub "https://${HistoryApi}.execute-api.${AWS::Region}.amazonaws.com/api/history"

  CloudFrontUrl:
    Description: CloudFront distribution URL
    Value: !Sub "https://${DashboardDistribution.DomainName}"

  DashboardBucketName:
    Description: S3 bucket for static site
    Value: !Ref DashboardBucket
```

---

## Phase 7: Deploy (~10 minutes)

### **STOP & CHECK 1: Build artifacts exist**

```bash
ls -lah dist/
# Expected: forecast-handler.js, history-handler.js, source maps
```

### Deploy with SAM

**Both PowerShell and Bash:**
```bash
sam validate --template template.yaml
sam build --template template.yaml
sam deploy \
  --stack-name goldforecast-stack \
  --region us-east-1 \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-confirm-changeset \
  --resolve-s3
```

**Expected output:**
```
Successfully created/updated stack - goldforecast-stack
Outputs:
  ForecastCronFunctionArn: arn:aws:lambda:us-east-1:...:function:goldforecast-forecast-cron
  HistoryApiUrl: https://abc123.execute-api.us-east-1.amazonaws.com/api/history
  CloudFrontUrl: https://d111111abcdef8.cloudfront.net
  DashboardBucketName: goldforecast-dashboard-123456789012
```

**Save these outputs for the next step.**

---

## Phase 8: Upload Dashboard to S3 (~5 minutes)

```bash
# Get bucket name from CloudFormation output
BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name goldforecast-stack \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardBucketName'].OutputValue" \
  --output text \
  --region us-east-1)

# Update fetch URL in index.html (one line change)
# Find: fetch('/api/history')
# Replace with CloudFront URL or API Gateway URL

# Upload
aws s3 sync ./public s3://$BUCKET_NAME --delete --region us-east-1

# Test
CLOUDFRONT_URL=$(aws cloudformation describe-stacks \
  --stack-name goldforecast-stack \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontUrl'].OutputValue" \
  --output text \
  --region us-east-1)

curl -I $CLOUDFRONT_URL
# Expected: HTTP/2 200, X-Cache: hit/miss from cloudfront
```

---

## Phase 9: Tier-1 Tests (5 must pass before go-live)

### Test 1: EventBridge Triggers Lambda (~5 min, NOT 24 hours)

**Setup:** Create temporary test schedule firing every 5 minutes.

```bash
LAMBDA_ARN=$(aws cloudformation describe-stacks \
  --stack-name goldforecast-stack \
  --query "Stacks[0].Outputs[?OutputKey=='ForecastCronFunctionArn'].OutputValue" \
  --output text --region us-east-1)

ROLE_ARN=$(aws iam get-role --role-name goldforecast-stack-ForecastSchedulerRole-* \
  --query 'Role.Arn' --output text)

# Create test schedule (rate(5 minutes))
aws scheduler create-schedule \
  --name goldforecast-test-trigger \
  --schedule-expression "rate(5 minutes)" \
  --state ENABLED \
  --flexible-time-window '{"Mode":"OFF"}' \
  --target "{\"Arn\":\"$LAMBDA_ARN\",\"RoleArn\":\"$ROLE_ARN\"}" \
  --region us-east-1

# Wait 5-6 minutes, then check logs
aws logs tail /aws/lambda/goldforecast-forecast-cron --since 10m --region us-east-1

# Expected log lines:
# EventBridge trigger: 2026-XX-XXTHHmm:ssZ
# Pipeline completed: success

# CLEANUP — delete test schedule immediately
aws scheduler delete-schedule --name goldforecast-test-trigger --region us-east-1
```

### Test 2: Lambda Cold Start <30s, Total <270s

```bash
# Manually invoke and measure
time aws lambda invoke \
  --function-name goldforecast-forecast-cron \
  --invocation-type RequestResponse \
  --region us-east-1 \
  /tmp/response.json

cat /tmp/response.json
# Expected: {"statusCode":200,"body":"{\"status\":\"success\",...}"}
# Time: 30-60 seconds (cold) or 5-15 seconds (warm)
```

### Test 3: Data Persists to Upstash (Verify Across 2 Invocations)

```bash
# Invoke once
aws lambda invoke --function-name goldforecast-forecast-cron \
  --region us-east-1 /tmp/run1.json

# Read /api/history to see today's data
HISTORY_URL=$(aws cloudformation describe-stacks --stack-name goldforecast-stack \
  --query "Stacks[0].Outputs[?OutputKey=='HistoryApiUrl'].OutputValue" \
  --output text --region us-east-1)

curl $HISTORY_URL | python -m json.tool | head -50
# Expected: rows[] with today's date, lastForecast object, adaptive (if 1+ days)
```

### Test 4: API Gateway Returns Valid JSON

```bash
curl -i $HISTORY_URL
# Expected:
# HTTP/2 200
# content-type: application/json
# access-control-allow-origin: *
# {"rows":[...],"lastForecast":{...},"totalDays":N,"adaptive":...}
```

### Test 5: Idempotency (Same-Date Reruns Don't Duplicate)

```bash
# Invoke twice on same day
aws lambda invoke --function-name goldforecast-forecast-cron \
  --region us-east-1 /tmp/run1.json
sleep 5
aws lambda invoke --function-name goldforecast-forecast-cron \
  --region us-east-1 /tmp/run2.json

# Check history endpoint
curl $HISTORY_URL | python -c "import json,sys; d=json.load(sys.stdin); \
  today_rows=[r for r in d['rows'] if r['date']=='$(date +%Y-%m-%d)']; \
  print(f'Today rows: {len(today_rows)} (expected: 1)')"
# Expected: 1 row (not 2)
```

---

## Phase 10: Hard Cutover (NO Dual-Run)

### Why hard cutover (not dual-run)?
Both Vercel and AWS would write to same Upstash keys → race condition on `last_forecast.json`. **Last writer wins** can corrupt adaptive_state.json.

### Cutover Sequence

**Day 0 (Today):** Deploy AWS, schedule **DISABLED**
```bash
aws scheduler update-schedule --name goldforecast-daily-cron \
  --state DISABLED --region us-east-1
```

**Day 1:** Run all 5 Tier-1 tests with manual invokes. Confirm all green.

**Day 2:** Disable Vercel cron
```bash
# Edit vercel.json, remove the crons array
# Commit and deploy
git -C agentone add vercel.json
git -C agentone commit -m "Disable Vercel cron — migrating to AWS"
git -C agentone push
```

**Day 3:** Enable AWS schedule
```bash
aws scheduler update-schedule --name goldforecast-daily-cron \
  --state ENABLED --region us-east-1
```

**Day 4:** Verify next 10 AM Toronto run succeeded
```bash
aws logs tail /aws/lambda/goldforecast-forecast-cron --since 24h --region us-east-1
```

### Rollback Procedure (if AWS fails)

```bash
# 1. Disable AWS schedule
aws scheduler update-schedule --name goldforecast-daily-cron \
  --state DISABLED --region us-east-1

# 2. Re-enable Vercel cron
# Edit vercel.json — restore crons array
git -C agentone revert HEAD
git -C agentone push

# 3. Vercel resumes within 1 cron cycle
```

**Recovery time: <10 minutes**

---

## Phase 11: Monitoring & Cost (Ongoing)

### CloudWatch Dashboard

Key metrics to track:
- Lambda duration (should be <60s typical)
- Lambda errors (should be 0)
- Lambda invocations (should be exactly 1/day)
- Upstash latency (Lambda logs)

### Billing Alarm

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name GoldForecastBillingAlert \
  --alarm-description "Alert if AWS spend exceeds $1/month" \
  --metric-name EstimatedCharges \
  --namespace AWS/Billing \
  --statistic Maximum \
  --period 86400 \
  --threshold 1.0 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --region us-east-1
```

### Corrected Cost Breakdown

| Service | Monthly Usage | Free Tier | Actual Cost |
|---------|---------------|-----------|-------------|
| Lambda forecast-cron | 30 invocations × ~60s × 512 MB = 0.9 GB-seconds | 400,000 GB-s | $0 |
| Lambda history-api | ~3,000 invocations × ~1s × 256 MB = 750 GB-seconds | 400,000 GB-s | $0 |
| API Gateway | ~3,000 requests | 1M free | $0 |
| EventBridge Scheduler | 30 invocations | First 14M free | $0 |
| DynamoDB | 0 (using Upstash) | n/a | $0 |
| S3 storage | ~100 KB | 5 GB free (12 mo) | $0 |
| S3 GET requests | ~3,000/month | 20K free (12 mo) | $0 |
| CloudFront | ~3,000 requests, ~300 MB | 1 TB free | $0 |
| SSM Parameter Store | 0 runtime calls (deploy-time only) | n/a | $0 |
| CloudWatch Logs | ~1 MB/month | 5 GB free | $0 |
| **Total** | | | **$0/month** |

(Plus $0/month Upstash on free tier — well under 10K commands/day limit)

---

## Critical Files Created/Modified

### New Files (5)
| Path | Purpose | Size |
|------|---------|------|
| `agentone/lambda/forecast-handler.ts` | Lambda entry: calls runPipeline() | ~25 lines |
| `agentone/lambda/history-handler.ts` | Lambda entry: calls getHistoryData() | ~35 lines |
| `agentone/template.yaml` | SAM infrastructure | ~180 lines |
| `agentone/esbuild.config.mjs` | Build config (ESM) | ~50 lines |
| `agentone/AWS_MIGRATION_PLAN.md` | This document | n/a |

### Modified Files (3)
| Path | Change |
|------|--------|
| `agentone/api/forecast.ts` | Add `runPipeline()` export, refactor handler() to use it |
| `agentone/api/history.ts` | Add `getHistoryData()` export, refactor handler() |
| `agentone/package.json` | Add `build` and `deploy` scripts; add esbuild + @types/aws-lambda devDeps |
| `agentone/public/index.html` | Update fetch URL from `/api/history` to CloudFront URL |

### No Changes (Verified)
| Path | Reason |
|------|--------|
| `agentone/api/adaptive.ts` | Pure logic, no Vercel deps |
| `agentone/gold_forecast_agent.ts` | Shared library, already framework-agnostic |
| `agentone/.env` | Used only for SSM parameter setup |
| Tests | All 108 still pass — runPipeline() is a non-breaking addition |

---

## Summary: What Changed from v1

| Issue | v1 (Buggy) | v2 (Fixed) |
|-------|------------|------------|
| Timezone | `cron(0 14 * * ? *)` shifts 1 hr in winter | EventBridge Scheduler with `TimeZone: America/Toronto` |
| Build config | `esbuild.config.js` with `require()` (breaks ESM) | `esbuild.config.mjs` with `import` |
| CloudFormation Default | `Default: !Sub "..."` (invalid) | Hardcoded in Resources via `!Sub` |
| Lambda handlers | Mock req/res, ~200 lines glue | Direct `runPipeline()` call, ~25 lines |
| CachePolicyId | Typo (invalid UUID) | Correct AWS-managed policy IDs |
| Secrets | Mixed (deploy-time + runtime) | Deploy-time only (zero runtime cost) |
| Migration | Dual-run (race conditions) | Hard cutover (safe) |
| Test 1 | Wait 24 hours | `rate(5 minutes)` test schedule |
| Cost estimate | $0.45/month SSM (200x off) | $0/month (deploy-time resolution) |
| Commands | PowerShell only | Both PowerShell and Bash |

---

## Next Steps

1. **Phase 1-2:** Refactor api/forecast.ts and api/history.ts (15 min)
2. **Phase 3:** Create SSM secrets (5 min)
3. **Phase 4-6:** Create handlers, esbuild config, template.yaml (30 min)
4. **Phase 7:** Run `npm run deploy` (10 min)
5. **Phase 8:** Upload dashboard to S3 (5 min)
6. **Phase 9:** Run all 5 Tier-1 tests (~30 min total)
7. **Phase 10:** Execute hard cutover (4 days from start)

**Total: ~2 hours of active work over 4-day cutover window**
