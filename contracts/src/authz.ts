/**
 * Per-revision authorization, as pure predicates over the stored revision.
 *
 * Pure and in `@sketch-to-product-views/contracts` so they can be tested without the API or the store. They
 * read only the `owner` field.
 *
 * Two predicates, deliberately separate, because reading your own run and resolving its
 * approval gate are not the same permission even though today they resolve the same way.
 *
 * A revision records the `sub` that submitted it (`owner`). Revisions written before that
 * field existed have none: those are **legacy** and are treated as readable by any
 * authenticated caller, because retro-fitting an owner is impossible and 403-ing them would
 * break runs that are still in flight. Every revision created from now on has an owner, so
 * this exception ages out on its own.
 */

/**
 * The only part of a revision the policy reads. Declared structurally so both
 * `PipelineState` and any in-memory record satisfy it without a cast.
 */
export interface OwnedRevision {
  owner?: string | undefined;
}

function ownsRevision(state: OwnedRevision, sub: string): boolean {
  return state.owner === sub;
}

/** Read: the owner, plus any authenticated caller for a legacy ownerless revision. */
export function mayReadRevision(state: OwnedRevision, sub: string): boolean {
  return state.owner === undefined || ownsRevision(state, sub);
}

/**
 * Review: **current policy is owner-reviews-own-run** (plus the legacy exception above).
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
