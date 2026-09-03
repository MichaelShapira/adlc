export function safeString(value: unknown, fallback = "Unavailable"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function shortId(value: unknown, length = 8): string {
  const text = optionalString(value);
  return text ? text.slice(0, length) : "Unavailable";
}

export function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function safeNonNegativeNumber(value: unknown): number | null {
  const number = safeNumber(value);
  return number !== null && number >= 0 ? number : null;
}

export function safeInteger(value: unknown): number | null {
  const number = safeNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

export function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function safeObjectArray<T extends object>(value: unknown): T[] {
  return safeArray<unknown>(value).filter(
    (item): item is T => typeof item === "object" && item !== null && !Array.isArray(item)
  );
}

export function safeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function safeFixed(
  value: unknown,
  digits: number,
  fallback = "Unavailable"
): string {
  const number = safeNumber(value);
  return number === null ? fallback : number.toFixed(digits);
}

export function safeLowerClass(value: unknown, fallback = "unknown"): string {
  const text = optionalString(value);
  return text
    ? text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40)
    : fallback;
}

export function displayStatus(value: unknown): string {
  const text = optionalString(value);
  return text ? text.replace(/_/g, " ") : "Unavailable";
}

export function safeLines(value: unknown): string[] {
  return typeof value === "string" ? value.split("\n") : [];
}

export function safePathParts(value: unknown): string[] {
  return typeof value === "string"
    ? value.split("/").filter((part) => part.length > 0)
    : [];
}

export function safeTime(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "Unavailable";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "Unavailable";
}
