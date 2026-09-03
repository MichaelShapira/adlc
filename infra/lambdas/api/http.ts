import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

export function response(
  statusCode: number,
  body: unknown
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Identity of the authenticated caller, from the Cognito JWT claims. */
export function callerIdentity(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): { sub: string; email: string; groups: string[] } {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const rawGroups = claims["cognito:groups"];
  let groups: string[] = [];
  if (Array.isArray(rawGroups)) {
    groups = rawGroups.map(String);
  } else if (typeof rawGroups === "string" && rawGroups) {
    try {
      const parsed: unknown = JSON.parse(rawGroups);
      groups = Array.isArray(parsed)
        ? parsed.map(String)
        : rawGroups.split(",").map((group) => group.trim());
    } catch {
      groups = rawGroups
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((group) => group.trim().replace(/^['\"]|['\"]$/g, ""));
    }
  }
  return {
    sub: String(claims.sub ?? "unknown"),
    email: String(claims.email ?? claims["cognito:username"] ?? "unknown"),
    groups: groups.filter(Boolean),
  };
}
