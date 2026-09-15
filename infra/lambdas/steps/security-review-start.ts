/**
 * Security Review START — creates code review + pentest, starts both jobs.
 * Returns IDs for the check step to poll.
 */
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
  const signed = await signer.sign({
    method: "POST", protocol: "https:", hostname, path,
    headers: { host: hostname, "content-type": "application/json" },
    body: bodyStr,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "POST", headers: signed.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        console.log(`API ${operation} ${res.statusCode}: ${text.slice(0, 500)}`);
        try { resolve(JSON.parse(text)); }
        catch { res.statusCode && res.statusCode >= 400 ? reject(new Error(`API ${res.statusCode}: ${text.slice(0, 500)}`)) : resolve(text); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── ZIP builder ────────────────────────────────────────────────────
function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[i] = c; }
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

async function collectFiles(commitId: string, folderPath: string): Promise<Array<{ path: string; blobId: string }>> {
  const files: Array<{ path: string; blobId: string }> = [];
  const resp = await cc.send(new GetFolderCommand({ repositoryName: REPO_NAME, commitSpecifier: commitId, folderPath }));
  for (const f of resp.files ?? []) { if (f.absolutePath && f.blobId) files.push({ path: f.absolutePath, blobId: f.blobId }); }
  for (const sub of resp.subFolders ?? []) { if (sub.absolutePath) files.push(...(await collectFiles(commitId, sub.absolutePath))); }
  return files;
}

async function zipFromCommit(commitId: string): Promise<Buffer> {
  const files = await collectFiles(commitId, "/");
  const entries: Array<{ name: Buffer; crc: number; compressed: Buffer; size: number }> = [];
  for (const file of files) {
    if (file.path.includes("node_modules/") || file.path.includes("dist/") || file.path.includes(".git/")) continue;
    const blob = await cc.send(new GetBlobCommand({ repositoryName: REPO_NAME, blobId: file.blobId }));
    if (blob.content) {
      const data = Buffer.from(blob.content);
      const compressed = await deflate(data);
      const p = file.path.startsWith("/") ? file.path.slice(1) : file.path;
      entries.push({ name: Buffer.from(p, "utf-8"), crc: crc32(data), compressed, size: data.length });
    }
  }
  const localParts: Buffer[] = []; const centralParts: Buffer[] = []; let offset = 0;
  for (const { name, crc, compressed, size } of entries) {
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    localParts.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    name.copy(central, 46); centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cd, eocd]);
}

// ─── Handler ────────────────────────────────────────────────────────
export const handler = async (
  event: { runId: string; implementResult: { fixBranch: string; fixCommitId?: string; ok: boolean } },
  _context: Context,
) => {
  const { runId, implementResult } = event;

  if (!implementResult.ok || !implementResult.fixCommitId) {
    await appendEvent(runId, "SECURITY_REVIEW", "Skipped — no fix commit");
    return { securityStarted: false, codeReviewId: "", codeReviewJobId: "", pentestId: "", pentestJobId: "", pollCount: 0, phase: "DONE" };
  }

  await appendEvent(runId, "SECURITY_REVIEW", "🔒 Starting AWS Security Agent review (code review + pentest)");

  // 1. Zip source
  await appendEvent(runId, "SECURITY_REVIEW", "Packaging source code from fix branch");
  const zipBuf = await zipFromCommit(implementResult.fixCommitId);
  const s3Key = `security-review/${runId}/source.zip`;
  await s3.send(new PutObjectCommand({ Bucket: CONTEXT_BUCKET, Key: s3Key, Body: zipBuf, ContentType: "application/zip" }));
  await appendEvent(runId, "SECURITY_REVIEW", "Source uploaded to S3");

  const s3Location = `s3://${CONTEXT_BUCKET}/${s3Key}`;
  const safeTitle = `ADLC-${runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}`;

  // 2. Create + start CODE REVIEW
  let codeReviewId = "";
  let codeReviewJobId = "";
  try {
    const crResp = (await apiCall("CreateCodeReview", {
      title: `${safeTitle}-CodeReview`,
      agentSpaceId: AGENT_SPACE_ID,
      assets: { sourceCode: [{ s3Location }] },
      serviceRole: SERVICE_ROLE_ARN,
      codeRemediationStrategy: "AUTOMATIC",
    })) as { codeReviewId: string };
    console.log("CreateCodeReview response:", JSON.stringify(crResp));
    codeReviewId = crResp.codeReviewId;
    await appendEvent(runId, "SECURITY_REVIEW", `📋 Code review created: ${codeReviewId}`);

    const crJobResp = (await apiCall("StartCodeReviewJob", {
      codeReviewId,
      agentSpaceId: AGENT_SPACE_ID,
    })) as { codeReviewJobId: string };
    console.log("StartCodeReviewJob response:", JSON.stringify(crJobResp));
    codeReviewJobId = crJobResp.codeReviewJobId;
    await appendEvent(runId, "SECURITY_REVIEW", `📋 Code review job started: ${codeReviewJobId}`);
  } catch (err) {
    await appendEvent(runId, "SECURITY_REVIEW", `⚠️ Code review failed to start: ${String(err).slice(0, 300)}`);
  }

  // 3. Create + start PENTEST
  let pentestId = "";
  let pentestJobId = "";
  try {
    const ptResp = (await apiCall("CreatePentest", {
      title: `${safeTitle}-Pentest`,
      agentSpaceId: AGENT_SPACE_ID,
      assets: {
        endpoints: [{ uri: APP_ENDPOINT }],
        sourceCode: [{ s3Location }],
      },
      serviceRole: SERVICE_ROLE_ARN,
      codeRemediationStrategy: "AUTOMATIC",
    })) as { pentestId: string };
    pentestId = ptResp.pentestId;
    await appendEvent(runId, "SECURITY_REVIEW", `🔍 Pentest created: ${pentestId}`);

    const ptJobResp = (await apiCall("StartPentestJob", {
      pentestId,
      agentSpaceId: AGENT_SPACE_ID,
    })) as { pentestJobId: string };
    pentestJobId = ptJobResp.pentestJobId;
    await appendEvent(runId, "SECURITY_REVIEW", `🔍 Pentest job started: ${pentestJobId}`);
  } catch (err) {
    await appendEvent(runId, "SECURITY_REVIEW", `⚠️ Pentest failed to start: ${String(err).slice(0, 300)}`);
  }

  await updateRun(runId, {
    securityReview: {
      reviewed: false,
      phase: "CODE_REVIEW",
      codeReviewId,
      codeReviewJobId,
      pentestId,
      pentestJobId,
      status: "IN_PROGRESS",
    },
  });

  return {
    securityStarted: true,
    codeReviewId,
    codeReviewJobId,
    pentestId,
    pentestJobId,
    pollCount: 0,
    phase: "CODE_REVIEW", // Check polls code review first, then pentest
  };
};
