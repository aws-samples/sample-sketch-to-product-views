import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The browser reaches the API only through CloudFront, which adds this header with a secret
 * value (an origin custom header); a request straight to the `execute-api` URL lacks it.
 * https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html
 */
export const ORIGIN_HEADER = 'x-origin-verify';

/**
 * `ORIGIN_VERIFY_SECRETS`: comma-separated accepted values, two during a rotation
 * (infra/README.md). Unset or empty rejects every request: fail closed.
 */
export function originSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ORIGIN_VERIFY_SECRETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Hashed first so the compare is constant-time whatever the lengths. */
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** True when the header carries one of the accepted secrets. */
export function fromCloudFront(
  headers: Record<string, string | undefined> | undefined,
  secrets: string[],
): boolean {
  const presented = headers?.[ORIGIN_HEADER];
  if (!presented) return false;
  const given = digest(presented);
  // Every secret is compared, so the timing does not say which one matched.
  let match = false;
  for (const secret of secrets) match = timingSafeEqual(given, digest(secret)) || match;
  return match;
}
