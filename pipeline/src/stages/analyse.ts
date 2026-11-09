import type { ModelUse, SketchAnalysis } from '@sketch-to-product-views/contracts';
import { analyseImages } from '@sketch-to-product-views/shared/analyse';
import { getArtifact, sniffImageType } from '@sketch-to-product-views/shared/store';
import type { PipelineInput } from '../input.js';

/**
 * Analyses the images, with the product metadata beside them.
 *
 * Every input is read and sent in upload order, with its file name: the analyser decides what
 * each one is (sketch, photo, material sample, unrelated). The product details go as given:
 * nothing here reads them by key, which is what lets the business export them in any shape.
 *
 * The analysis is the only source of the specification, so there is no degraded mode. A
 * transient failure is retried by the durable step; anything else fails the stage and the run.
 */
export interface AnalyseStageResult {
  analysis: SketchAnalysis;
  model: ModelUse;
  promptVersion: string;
  latencyMs: number;
  imageKeys: string[];
}

export async function analyse(input: PipelineInput, modelId?: string): Promise<AnalyseStageResult> {
  const files = input.inputs;
  const images = await Promise.all(
    files.map(async (file) => {
      // Package validation has already proved every input exists and is a supported image.
      if (!file.key) throw new Error(`${file.filename} has no storage key`);
      const bytes = await getArtifact(file.key);
      return {
        bytes,
        contentType: sniffImageType(bytes) ?? 'image/png',
        filename: file.filename,
        // An older client's material-sample tag: a hint for the analyser, not a decision.
        ...(file.role === 'swatch' ? { uploadedAsMaterial: true } : {}),
      };
    }),
  );

  const result = await analyseImages({
    images,
    metadata: input.productMetadata,
    modelId,
  });
  return { ...result, imageKeys: files.map((f) => f.key!) };
}
