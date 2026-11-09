import { allModels, deployedModel } from '@sketch-to-product-views/shared/registry';
import { json, type ApiResult } from '../http.js';

/**
 * Read-only route: the model registry, so a reviewer sees which model produced a candidate.
 */

/**
 * Served straight from the compiled-in registry rather than DynamoDB.
 *
 * The registry is code — every entry is validated at build time and a legacy model cannot
 * get past the schema. Copying it into a table would add a write path that could hold a
 * model this code has never seen.
 */
export function models(): ApiResult {
  return json(
    200,
    {
      models: allModels().map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        description: m.description,
        region: m.region,
        residency: m.residency,
        tags: m.tags,
        params: m.params,
        acceptsInputs: m.acceptsInputs,
        requiredInputs: m.requiredInputs,
        costPerCall: m.costPerCall,
        isDefault: m.isDefault ?? false,
        promptGuide: m.promptGuide,
      })),
      // The deployment's choice, so the SPA preselects what a run with no model would get.
      defaultModelId: deployedModel('image-control', process.env.IMAGE_MODEL).id,
      // What a run that sets nothing gets, for the start form's defaults.
      deployment: {
        ...(process.env.IMAGE_SIZE ? { size: process.env.IMAGE_SIZE } : {}),
        ...(process.env.IMAGE_QUALITY ? { quality: process.env.IMAGE_QUALITY } : {}),
        attemptBudget: attemptBudgetFromEnv(),
      },
    },
    // The registry only changes with a deploy, so let the browser hold it briefly.
    { 'cache-control': 'public, max-age=300' },
  );
}

/** Same rule as the pipeline's `positiveIntFromEnv`: anything but a positive integer is 2. */
export function attemptBudgetFromEnv(): number {
  const parsed = Number(process.env.ATTEMPT_BUDGET);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
}
