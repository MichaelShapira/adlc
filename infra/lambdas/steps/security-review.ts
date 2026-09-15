/**
 * Security Review step — runs AWS Security Agent pentest
 * on the fix branch after validation passes.
 *
 * Uses raw HTTPS calls with SigV4 signing since the securityagent
 * SDK client may not be available, and AWS CLI isn't in Lambda.
 */
import { execSync } from "node:child_process";
import { createDeflateRaw } from "node:zlib";
import * as https from "node:https";
import type { Context } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  CodeCommitClient,
  GetFolderCommand,
  GetBlobCommand,
} from "@aws-sdk/client-codecommit";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { appendEvent, updateRun } from "../shared/db";

const AGENT_SPACE_ID = process.env.AGENT_SPACE_ID!;
const SERVICE_ROLE_ARN = process.env.SERVICE_ROLE_ARN!;
const CONTEXT_BUCKET = process.env.CONTEXT_BUCKET!;
const APP_ENDPOINT = process.env.APP_ENDPOINT!;
const REPO_NAME = process.env.REPO_NAME!;
const REGION = process.env.AWS_REGION ?? "us-east-1";

const s3 = new S3Client({});
const cc = new CodeCommitClient({});

const MAX_POLL_SECONDS = 600;
const POLL_INTERVAL_MS = 15_000;

interface SecurityReviewResult {
  reviewed: boolean;
  findingsCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findings: Array<{
    name: string;
    riskLevel: string;
    confidence: string;
    status: string;
    findingId: string;
  }>;
  pentestId: string;
  pentestJobId: string;
  passed: boolean;
}

// ─── SigV4 API helper ───────────────────────────────────────────────
const signer = new SignatureV4({
  credentials: defaultProvider(),
  region: REGION,
  service: "securityagent",
  sha256: Sha256,
});

async function apiCall(operation: string, body: Record<string, unknown>): Promise<unknown> {
  const hostname = `securityagent.${REGION}.api.aws`;
  const path = `/${operation}`;
  const bodyStr = JSON.stringify(body);

  const headers: Record<string, string> = {
    host: hostname,
    "content-type": "application/json",
  };

  const signed = await signer.sign({
    method: "POST",
    protocol: "https:",
    hostname,
    path,
    headers,
    body: bodyStr,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        headers: signed.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve(JSON.parse(text));
          } catch {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`API ${res.statusCode}: ${text.slice(0, 500)}`));
            } else {
              resolve(text);
            }
          }
        });
      },
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── ZIP builder (pure Node.js) ─────────────────────────────────────
function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function deflate(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const d = createDeflateRaw();
    const parts: Buffer[] = [];
    d.on("data", (chunk: Buffer) => parts.push(chunk));
    d.on("end", () => resolve(Buffer.concat(parts)));
    d.on("error", reject);
    d.end(buf);
  });
}

// ─── CodeCommit helpers ─────────────────────────────────────────────
async function collectFiles(
  commitId: string,
  folderPath: string,
): Promise<Array<{ path: string; blobId: string }>> {
  const files: Array<{ path: string; blobId: string }> = [];
  const resp = await cc.send(
    new GetFolderCommand({
      repositoryName: REPO_NAME,
      commitSpecifier: commitId,
      folderPath,
    }),
  );
  for (const f of resp.files ?? []) {
    if (f.absolutePath && f.blobId) {
      files.push({ path: f.absolutePath, blobId: f.blobId });
    }
  }
  for (const sub of resp.subFolders ?? []) {
    if (sub.absolutePath) {
      files.push(...(await collectFiles(commitId, sub.absolutePath)));
    }
  }
  return files;
}

async function zipFromCommit(commitId: string): Promise<Buffer> {
  const files = await collectFiles(commitId, "/");

  const entries: Array<{ name: Buffer; crc: number; compressed: Buffer; size: number }> = [];

  for (const file of files) {
    if (file.path.includes("node_modules/") || file.path.includes("dist/") || file.path.includes(".git/")) continue;
    const blob = await cc.send(
      new GetBlobCommand({ repositoryName: REPO_NAME, blobId: file.blobId }),
    );
    if (blob.content) {
      const data = Buffer.from(blob.content);
      const compressed = await deflate(data);
      const p = file.path.startsWith("/") ? file.path.slice(1) : file.path;
      entries.push({ name: Buffer.from(p, "utf-8"), crc: crc32(data), compressed, size: data.length });
    }
  }

  // Build zip
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const { name, crc, compressed, size } of entries) {
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length + compressed.length;
  }

  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cd, eocd]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Handler ────────────────────────────────────────────────────────
export const handler = async (
  event: {
    runId: string;
    implementResult: {
      fixBranch: string;
      fixCommitId?: string;
      ok: boolean;
    };
  },
  _context: Context,
): Promise<SecurityReviewResult> => {
  const { runId, implementResult } = event;

  if (!implementResult.ok || !implementResult.fixCommitId) {
    await appendEvent(runId, "SECURITY_REVIEW", "Skipped — no fix commit");
    return {
      reviewed: false, findingsCount: 0, criticalCount: 0, highCount: 0,
      mediumCount: 0, lowCount: 0, findings: [], pentestId: "", pentestJobId: "", passed: true,
    };
  }

  await appendEvent(runId, "SECURITY_REVIEW", "Starting AWS Security Agent review");

  // 1. Zip source from fix commit
  await appendEvent(runId, "SECURITY_REVIEW", "Packaging source code from fix branch");
  const zipBuf = await zipFromCommit(implementResult.fixCommitId);
  const s3Key = `security-review/${runId}/source.zip`;

  // 2. Upload to S3
  await s3.send(
    new PutObjectCommand({
      Bucket: CONTEXT_BUCKET,
      Key: s3Key,
      Body: zipBuf,
      ContentType: "application/zip",
    }),
  );
  await appendEvent(runId, "SECURITY_REVIEW", "Source uploaded to S3");

  // 3. Create pentest
  const safeTitle = `ADLC-Run-${runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}`;
  const createResp = (await apiCall("CreatePentest", {
    title: safeTitle,
    agentSpaceId: AGENT_SPACE_ID,
    assets: {
      endpoints: [{ uri: APP_ENDPOINT }],
      sourceCode: [{ s3Location: `s3://${CONTEXT_BUCKET}/${s3Key}` }],
    },
    serviceRole: SERVICE_ROLE_ARN,
    codeRemediationStrategy: "AUTOMATIC",
  })) as { pentestId: string };

  const pentestId = createResp.pentestId;
  await appendEvent(runId, "SECURITY_REVIEW", `Pentest created: ${pentestId}`);

  // 4. Start pentest job
  const startResp = (await apiCall("StartPentestJob", {
    pentestId,
    agentSpaceId: AGENT_SPACE_ID,
  })) as { pentestJobId: string; status: string };

  const pentestJobId = startResp.pentestJobId;
  await appendEvent(runId, "SECURITY_REVIEW", `Pentest job started: ${pentestJobId}`);

  // 5. Poll for completion
  const deadline = Date.now() + MAX_POLL_SECONDS * 1000;
  let jobStatus = "IN_PROGRESS";

  while (jobStatus === "IN_PROGRESS" && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const jobsResp = (await apiCall(
        "ListPentestJobsForPentest",
        { pentestId, agentSpaceId: AGENT_SPACE_ID },
      )) as { pentestJobSummaries: Array<{ pentestJobId: string; status: string }> };

      const job = jobsResp.pentestJobSummaries?.find((j) => j.pentestJobId === pentestJobId);
      jobStatus = job?.status ?? "UNKNOWN";
    } catch {
      // transient, keep polling
    }
  }

  await appendEvent(runId, "SECURITY_REVIEW", `Pentest job finished: ${jobStatus}`);

  // 6. Fetch findings
  let findings: SecurityReviewResult["findings"] = [];
  try {
    const findingsResp = (await apiCall(
      "ListFindings",
      { pentestJobId, agentSpaceId: AGENT_SPACE_ID },
    )) as {
      findingSummaries: Array<{
        name: string;
        riskLevel: string;
        confidence: string;
        status: string;
        findingId: string;
      }>;
    };
    findings = (findingsResp.findingSummaries ?? []).map((f) => ({
      name: f.name ?? "Unknown",
      riskLevel: f.riskLevel ?? "UNKNOWN",
      confidence: f.confidence ?? "UNKNOWN",
      status: f.status ?? "ACTIVE",
      findingId: f.findingId ?? "",
    }));
  } catch (err) {
    await appendEvent(runId, "SECURITY_REVIEW", `Warning: could not fetch findings: ${String(err).slice(0, 200)}`);
  }

  const criticalCount = findings.filter((f) => f.riskLevel === "CRITICAL").length;
  const highCount = findings.filter((f) => f.riskLevel === "HIGH").length;
  const mediumCount = findings.filter((f) => f.riskLevel === "MEDIUM").length;
  const lowCount = findings.filter((f) => f.riskLevel === "LOW").length;
  const passed = criticalCount === 0 && highCount === 0;

  const result: SecurityReviewResult = {
    reviewed: true,
    findingsCount: findings.length,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    findings: findings.slice(0, 20),
    pentestId,
    pentestJobId,
    passed,
  };

  await updateRun(runId, { securityReview: result });
  await appendEvent(
    runId,
    "SECURITY_REVIEW",
    passed
      ? `✅ Security review passed (${findings.length} findings, 0 critical/high)`
      : `⚠️ Security review flagged ${criticalCount} critical, ${highCount} high findings`,
  );

  return result;
};
