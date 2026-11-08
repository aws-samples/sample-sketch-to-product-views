import type { ModelEntry } from '../registry/index.js';

/**
 * The dispatch seam, forked from CreativeFlow's `dispatch/types.ts`. Image generation depends
 * on this shape, not on a provider, so it can be unit-tested with a fake generator.
 */

export interface GenerationRequest {
  /**
   * Canonical inputs. `sketch` is the first image sent, raw bytes (the sketch, or the front
   * render when a view is made from it alone); the adapter handles encoding.
   */
  prompt: string;
  sketch: Uint8Array;

  /**
   * Further images sent after the first, in order: the material sample, then the front render
   * the other views are made from. Only models that take several input images accept them.
   */
  references?: Uint8Array[];

  /** Registry param overrides, keyed by the param's `key`. */
  params?: Record<string, string | number | boolean | undefined>;

  /** Model override; omitted means the category default. */
  modelId?: string;
}

export interface GenerationResult {
  image: Uint8Array;
  contentType: string;

  /**
   * Seed the provider actually used, recorded so a candidate is reproducible. Absent when
   * the provider has no seed (OpenAI image models).
   */
  seed?: number;

  model: Pick<ModelEntry, 'id' | 'bedrockModelId' | 'region'>;

  /** Wall-clock duration of the provider call, in ms. */
  durationMs: number;
}

/**
 * The port image generation talks to. One method, so a fake is three lines.
 */
export interface ImageGenerator {
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

/**
 * Raised when the provider refused to produce an image for a reason that is the input's
 * fault, not a transient failure. Distinguished from a generic error because a retry
 * would only cost money and fail identically.
 */
export class ContentRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`generation refused by the provider: ${reason}`);
    this.name = 'ContentRefusedError';
  }
}
