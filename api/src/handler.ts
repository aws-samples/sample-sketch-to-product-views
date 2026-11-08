import { describeError, errorSummary } from '@sketch-to-product-views/shared/errors';
import { GUARDRAIL_OFF_WARNING, guardrailFromEnv } from '@sketch-to-product-views/shared/guardrail';
import { HttpError, fail, type ApiEvent, type ApiResult } from './http.js';
import { fromCloudFront, originSecrets } from './origin.js';
import { models } from './routes/models.js';
import { review, status, submit } from './routes/revisions.js';
import { confirm, presign } from './routes/uploads.js';

/**
 * The one API Lambda. Thin by design: presign, submit, read, review. No stage runs here —
 * that is the durable function's job.
 *
 * Dispatch is on `routeKey`, which API Gateway sets to the route that matched. The routes
 * are enumerated in `infra/modules/api` with no `$default`, so an unknown key here means
 * Terraform and this table have drifted, and saying so is more useful than a 404.
 */

// Cold start: a GUARDRAIL_ID without a version fails here, and an unset one is logged once.
if (!guardrailFromEnv()) console.warn({ message: GUARDRAIL_OFF_WARNING });

type Route = (event: ApiEvent) => ApiResult | Promise<ApiResult>;

/**
 * Exported so `test/routes.test.ts` can compare it against the enumerated route list in
 * `infra/modules/api/main.tf`. There is no `$default` route, so a key missing from either
 * side is a 404 in production.
 */
export const ROUTES: Record<string, Route> = {
  'GET /api/models': models,
  'POST /api/uploads/presign': presign,
  'POST /api/uploads/confirm': confirm,
  'POST /api/revisions': submit,
  'GET /api/revisions/{id}': status,
  'POST /api/revisions/{id}/review': review,
};

export async function handler(event: ApiEvent): Promise<ApiResult> {
  const requestId = event.requestContext?.requestId;

  // Before any route: a caller holding a valid JWT must still come through CloudFront and WAF.
  if (!fromCloudFront(event.headers, originSecrets())) {
    logLine('warn', {
      message: 'request not from CloudFront',
      routeKey: event.routeKey,
      requestId,
    });
    return fail(403, 'Forbidden.');
  }

  // `hasOwn`, not a bare index: `routeKey` is attacker-adjacent input and an inherited
  // property name such as "constructor" would otherwise resolve to something callable.
  const route = Object.hasOwn(ROUTES, event.routeKey) ? ROUTES[event.routeKey] : undefined;
  if (!route) return fail(404, `No route for ${event.routeKey}.`);

  try {
    return await route(event);
  } catch (error) {
    if (error instanceof HttpError) {
      logLine('warn', {
        message: 'client error',
        routeKey: event.routeKey,
        requestId,
        statusCode: error.statusCode,
        error: error.message,
      });
      return fail(error.statusCode, error.message);
    }

    logLine('error', {
      message: 'unhandled error',
      routeKey: event.routeKey,
      requestId,
      reason: errorSummary(error),
      error: describeError(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Deliberately opaque. The request id is the handle for correlating with the log line
    // above; the error text may name a bucket, a table or a model.
    return fail(500, `Internal error. Request id ${requestId ?? 'unknown'}.`);
  }
}

/**
 * One JSON line per event, because the function's log format is JSON and a stack spread
 * over 30 lines cannot be queried. Every line carries the request id the 500 body quotes.
 *
 * The object, not a string of it: with the JSON log format Lambda nests a single object argument
 * in `message` and takes the level from the method called
 * (https://docs.aws.amazon.com/lambda/latest/dg/nodejs-logging.html).
 */
function logLine(level: 'warn' | 'error', fields: Record<string, unknown>): void {
  if (level === 'error') console.error(fields);
  else console.warn(fields);
}
