export const CONTEXT_MAX_ITEMS = 10;
export const CONTEXT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const CONTEXT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const CONTEXT_MAX_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024);
export const CONTEXT_MAX_PDFS = 5;
export const CONTEXT_URL_TTL_SECONDS = 5 * 60;
export const CONTEXT_QUOTA_KEY = "__QUOTA__";

export const CONTEXT_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type ContextUploadContentType = (typeof CONTEXT_CONTENT_TYPES)[number];
export type ContextContentType = ContextUploadContentType | "text/plain";
export type ContextKind = "note" | "file" | "image";

export interface ContextItemRecord {
  ownerSub: string;
  itemKey: string;
  itemId: string;
  status: "PENDING" | "READY" | "DELETING";
  kind: ContextKind;
  fileName: string;
  contentType: ContextContentType;
  sizeBytes: number;
  s3Key: string;
  digest?: string;
  checksumSha256?: string;
  createdAt: string;
  updatedAt: string;
  uploadExpiresAt?: number;
  purgeAfter?: number;
}

export function isUploadContentType(value: string): value is ContextUploadContentType {
  return (CONTEXT_CONTENT_TYPES as readonly string[]).includes(value);
}

export function contextKind(contentType: ContextContentType): ContextKind {
  if (contentType === "text/plain") return "note";
  return contentType.startsWith("image/") ? "image" : "file";
}

export function validateUploadSize(contentType: ContextUploadContentType, sizeBytes: number): string | undefined {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return "sizeBytes must be a positive integer";
  }
  if (sizeBytes >= CONTEXT_MAX_FILE_BYTES) {
    return `files must be smaller than ${CONTEXT_MAX_FILE_BYTES} bytes`;
  }
  if (contentType.startsWith("image/") && sizeBytes > CONTEXT_MAX_IMAGE_BYTES) {
    return `images must not exceed ${CONTEXT_MAX_IMAGE_BYTES} bytes`;
  }
  return undefined;
}

export function safeFileName(value: unknown, fallback: string): string {
  const input = typeof value === "string" ? value.normalize("NFC") : "";
  const leaf = input.split(/[\\/]/).pop() ?? "";
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[^\p{L}\p{N} ._()[\]-]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+|[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 120);
}

export function hasExpectedMagic(contentType: ContextUploadContentType, bytes: Uint8Array): boolean {
  if (contentType === "application/pdf") {
    return Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-";
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return png.every((value, index) => bytes[index] === value);
  }
  return (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  );
}
