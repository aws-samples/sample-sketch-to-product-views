/**
 * Per-revision authorization, as pure predicates over the stored revision.
 *
 * Pure and in `@sketch-to-product-views/contracts` so they can be tested without the API or the store. They
 * read only the `owner` field.
 *
 * Two predicates, deliberately separate, because reading your own run and resolving its
 * approval gate are not the same permission even though today they resolve the same way.
 *
 * A revision records the `sub` that submitted it (`owner`), and the owner is also the leading
 * part of every key the revision is stored under (`USER#{owner}#…`, `user/{owner}/…`), which
 * IAM enforces for the API (infra/modules/api). These predicates are the in-code half of that
 * boundary: they still run, so a key built the wrong way is refused here as well.
 */

/**
 * The only part of a revision the policy reads. Declared structurally so both
 * `PipelineState` and any in-memory record satisfy it without a cast.
 */
export interface OwnedRevision {
  owner: string;
}

/** An empty owner matches nobody, not even an empty subject. */
function ownsRevision(state: OwnedRevision, sub: string): boolean {
  return state.owner !== '' && state.owner === sub;
}

/** Read: the owner only. */
export function mayReadRevision(state: OwnedRevision, sub: string): boolean {
  return ownsRevision(state, sub);
}

/**
 * Review: **current policy is owner-reviews-own-run**.
 *
 * This is the human-approval gate, so the owner is not obviously the right reviewer — a
 * separate reviewer population is a real requirement and not one this codebase can express
 * yet, since the only identity signal available is `sub`. Rather than invent a role or
 * group system here, the policy is confined to this one function: when reviewer identity
 * does arrive (a group claim, a per-product reviewer list), this body is the only thing
 * that changes.
 */
export function mayReviewRevision(state: OwnedRevision, sub: string): boolean {
  return mayReadRevision(state, sub);
}
