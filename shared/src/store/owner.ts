/**
 * The owner id (the Cognito `sub`) that prefixes every key a user can reach:
 * `USER#{owner}#…` in DynamoDB and `user/{owner}/…` in S3. The same value is passed to STS as
 * the `sub` session tag that IAM matches against those prefixes.
 *
 * Cognito says not to validate the *format* of `sub` strictly
 * (https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html),
 * so this checks the characters, not a UUID shape. It allows the characters a session tag value
 * accepts (letters, digits and `_ . : = + @ -`,
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/id_tags.html#id_tags_rules_creating), less
 * the space and `/`, which would let a value escape its S3 prefix. `#` is the DynamoDB key
 * delimiter and is not a tag character either. Anything else throws: a key is never built from
 * an id that could reach another user's prefix.
 */
const OWNER_ID = /^[A-Za-z0-9_.:=+@-]{1,128}$/;

export function isOwnerId(value: unknown): value is string {
  return typeof value === 'string' && OWNER_ID.test(value);
}

export function assertOwnerId(value: unknown): string {
  if (!isOwnerId(value)) throw new Error('invalid owner id');
  return value;
}
