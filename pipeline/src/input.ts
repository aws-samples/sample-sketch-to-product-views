import { pipelineInputSchema, sanitizeSubmitBody, type PipelineInput } from '@sketch-to-product-views/contracts';

/**
 * The payload `POST /api/revisions` invokes this function with. The schema lives in
 * `@sketch-to-product-views/contracts` so the API builds the payload against the same definition this function
 * parses it with.
 */
export { pipelineInputSchema, type PipelineInput };

/** Sanitised again (idempotent; the API already did), then parsed. */
export function parsePipelineInput(event: unknown): PipelineInput {
  return pipelineInputSchema.parse(sanitizeSubmitBody(event));
}
