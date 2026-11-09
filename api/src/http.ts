import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { z } from 'zod';

/**
 * Response helpers. Every handler returns through these so the SPA sees one error shape
 * (`{error}`) whatever went wrong — which is what `web/src/lib/api.ts` already parses.
 */

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyResultV2;

export function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): ApiResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export const fail = (statusCode: number, error: string): ApiResult => json(statusCode, { error });

/**
 * Zod's bare "Required" is useless at a contract boundary, so name the field that failed.
 * The SPA surfaces this string to the user.
 */
export function badRequest(error: z.ZodError): ApiResult {
  const issue = error.issues[0];
  const path = issue.path.join('.');
  return fail(400, path ? `${path}: ${issue.message}` : issue.message);
}

export function parseBody(event: ApiEvent): unknown {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Body is not valid JSON.');
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Caller {
  sub: string;
  /** Display name, recorded on a review decision. A claim, never a client assertion. */
  name: string;
}

/**
 * Identity comes from the JWT the API Gateway authorizer already validated. If the
 * authorizer is attached and this is absent, something is misconfigured — so it throws
 * rather than falling back to an anonymous caller.
 */
export function caller(event: ApiEvent): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
  if (!sub) throw new HttpError(401, 'Unauthenticated.');
  const name = typeof claims.name === 'string' && claims.name ? claims.name : sub;
  return { sub, name };
}
