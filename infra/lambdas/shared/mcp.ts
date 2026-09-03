/**
 * Shared validation for the per-user MCP configuration that Kiro CLI loads
 * inside the AgentCore container (written to .kiro/settings/mcp.json in the
 * agent's workspace). The schema follows the Kiro MCP configuration format:
 * https://awslabs.github.io/mcp/servers/aws-documentation-mcp-server
 */

export const MCP_CONFIG_KEY = "MCP_CONFIG";
export const MCP_MAX_CONFIG_BYTES = 32 * 1024;
export const MCP_MAX_SERVERS = 5;

const SERVER_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const ALLOWED_SERVER_KEYS = new Set([
  "command",
  "args",
  "env",
  "disabled",
  "autoApprove",
  "timeout",
  "type",
]);

export interface McpValidation {
  error?: string;
  serverCount: number;
  enabledCount: number;
  serverNames: string[];
}

function invalid(error: string): McpValidation {
  return { error, serverCount: 0, enabledCount: 0, serverNames: [] };
}

function isStringArray(value: unknown, maxItems: number, maxLength: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length <= maxLength)
  );
}

/** Validate an MCP configuration JSON document. Empty string means "no config". */
export function validateMcpConfig(configJson: string): McpValidation {
  if (!configJson.trim()) return { serverCount: 0, enabledCount: 0, serverNames: [] };
  if (Buffer.byteLength(configJson, "utf8") > MCP_MAX_CONFIG_BYTES) {
    return invalid(`configuration exceeds ${MCP_MAX_CONFIG_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return invalid("configuration is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("configuration must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  const extraRootKeys = Object.keys(root).filter((key) => key !== "mcpServers");
  if (extraRootKeys.length > 0) {
    return invalid(`unsupported top-level key: ${extraRootKeys[0]} (only mcpServers is allowed)`);
  }
  const servers = root.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return invalid("mcpServers must be an object mapping server names to definitions");
  }
  const entries = Object.entries(servers as Record<string, unknown>);
  if (entries.length === 0) {
    return invalid("mcpServers must define at least one server (or save an empty config to disable MCP)");
  }
  if (entries.length > MCP_MAX_SERVERS) {
    return invalid(`at most ${MCP_MAX_SERVERS} MCP servers are supported`);
  }
  let enabledCount = 0;
  const serverNames: string[] = [];
  for (const [name, definition] of entries) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      return invalid(`invalid server name: ${name.slice(0, 60)}`);
    }
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      return invalid(`server ${name} must be an object`);
    }
    const server = definition as Record<string, unknown>;
    const unknownKey = Object.keys(server).find((key) => !ALLOWED_SERVER_KEYS.has(key));
    if (unknownKey) {
      return invalid(`server ${name} has an unsupported key: ${unknownKey}`);
    }
    if (typeof server.command !== "string" || !server.command.trim() || server.command.length > 200) {
      return invalid(`server ${name} needs a non-empty command (max 200 chars)`);
    }
    if (server.args !== undefined && !isStringArray(server.args, 50, 500)) {
      return invalid(`server ${name}: args must be an array of strings`);
    }
    if (server.env !== undefined) {
      if (!server.env || typeof server.env !== "object" || Array.isArray(server.env)) {
        return invalid(`server ${name}: env must be an object of string values`);
      }
      const envEntries = Object.entries(server.env as Record<string, unknown>);
      if (envEntries.length > 20) return invalid(`server ${name}: at most 20 env entries`);
      for (const [key, value] of envEntries) {
        if (!ENV_KEY_PATTERN.test(key) || typeof value !== "string" || value.length > 500) {
          return invalid(`server ${name}: invalid env entry ${key.slice(0, 60)}`);
        }
      }
    }
    if (server.disabled !== undefined && typeof server.disabled !== "boolean") {
      return invalid(`server ${name}: disabled must be a boolean`);
    }
    if (server.autoApprove !== undefined && !isStringArray(server.autoApprove, 50, 200)) {
      return invalid(`server ${name}: autoApprove must be an array of strings`);
    }
    if (
      server.timeout !== undefined &&
      (typeof server.timeout !== "number" || !Number.isFinite(server.timeout) ||
        server.timeout < 1 || server.timeout > 3600)
    ) {
      return invalid(`server ${name}: timeout must be a number of seconds between 1 and 3600`);
    }
    if (server.type !== undefined && server.type !== "stdio") {
      return invalid(`server ${name}: only type "stdio" is supported`);
    }
    if (server.disabled !== true) enabledCount += 1;
    serverNames.push(name);
  }
  return { serverCount: entries.length, enabledCount, serverNames };
}
