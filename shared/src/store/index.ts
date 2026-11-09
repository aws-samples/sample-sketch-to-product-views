/**
 * Persistence only — DynamoDB revisions and S3 artifacts.
 *
 * Exposed as its own entry point (`@sketch-to-product-views/shared/store`) so the API can bundle the
 * store without dragging in `sharp`, which the qc tier needs and Lambda would then have
 * to ship as a native binary for no reason.
 */
export * from './revisions.js';
export * from './artifacts.js';
export * from './owner.js';
