/**
 * Storage layer — S3-backed object I/O for the gold forecast pipeline.
 *
 * Replaces the previous Upstash Redis storage. All state is held as small
 * objects (< 100 KB each) in a single S3 bucket. Access pattern is GET/PUT
 * of whole objects only — no partial updates, no atomic ops, no TTL.
 *
 * In production, the bucket name is injected via STATE_BUCKET_NAME (set by
 * SAM at deploy time). In local dev, if STATE_BUCKET_NAME is unset, the
 * module falls back to the local `data/` directory so `npx tsx
 * gold_forecast_agent.ts` keeps working without AWS credentials.
 *
 * The exported `s3StorageClient` matches the RedisLike interface used by
 * api/adaptive.ts so the adaptive module didn't need any changes.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { S3Client, GetObjectCommand, PutObjectCommand, NoSuchKey } from "@aws-sdk/client-s3";

const BUCKET_NAME = process.env.STATE_BUCKET_NAME;
const LOCAL_DATA_DIR = path.resolve(process.cwd(), "data");

// Lazy: only instantiate the SDK client when we actually need it.
let _s3: S3Client | null = null;
function getS3(): S3Client {
  if (!_s3) _s3 = new S3Client({});
  return _s3;
}

async function streamToString(stream: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function readObject(key: string): Promise<string | null> {
  if (!BUCKET_NAME) return readLocal(key);
  try {
    const out = await getS3().send(
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })
    );
    if (!out.Body) return null;
    return await streamToString(out.Body as any);
  } catch (e: any) {
    if (e instanceof NoSuchKey || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw e;
  }
}

export async function writeObject(key: string, value: string): Promise<void> {
  if (!BUCKET_NAME) return writeLocal(key, value);
  await getS3().send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: value,
      ContentType: key.endsWith(".csv") ? "text/csv" : "application/json",
    })
  );
}

// ─── RedisLike adapter for api/adaptive.ts ──────────────────────────────────
//
// adaptive.ts takes a `RedisLike` ({ get(key), set(key, value) }). We expose
// an object with the same shape backed by S3, so the adaptive module needs
// zero changes.

export const s3StorageClient = {
  async get(key: string): Promise<unknown> {
    return await readObject(key);
  },
  async set(key: string, value: string): Promise<unknown> {
    await writeObject(key, value);
    return "OK";
  },
};

// ─── Local-dev fallback (no STATE_BUCKET_NAME set) ──────────────────────────

async function readLocal(key: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(LOCAL_DATA_DIR, key), "utf-8");
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function writeLocal(key: string, value: string): Promise<void> {
  await fs.mkdir(LOCAL_DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_DATA_DIR, key), value, "utf-8");
}
