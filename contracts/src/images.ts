import type { ImageKind } from './analysis.js';
import type { InputRole } from './inputs.js';

/** What a design reference is: a drawing of the product, or a photo of it. */
export type DesignKind = Extract<ImageKind, 'sketch' | 'photo'>;

/**
 * Which uploaded image plays which part, from the analyser's decision. Pure, so generation and
 * the critic pick the same images on every replay.
 */
export interface ImagePlan<T> {
  /** Sketches and photos of the product, in upload order: the design references. */
  design: T[];
  /** What each design reference is, in the same order. */
  designKinds: DesignKind[];
  /** The material sample: the first image read as one. */
  material?: T;
  /** Further material images: sent after the design references, as references only. */
  extraMaterials: T[];
  /** What the critic compares with: the first sketch, else the first photo. */
  criticReference?: { file: T; kind: 'sketch' | 'photo' };
}

/**
 * `kinds` is the analyser's decision per input, in input order (`ProductSpec.imageKinds`). A run
 * analysed before the analyser classified images has none: its roles decide, `swatch` being the
 * material sample and every other input a sketch.
 */
export function planImages<T extends { role?: InputRole }>(
  inputs: readonly T[],
  kinds?: readonly ImageKind[],
): ImagePlan<T> {
  const kindOf = (file: T, i: number): ImageKind =>
    kinds ? (kinds[i] ?? 'ignored') : file.role === 'swatch' ? 'material' : 'sketch';
  const read = inputs.map((file, i) => ({ file, kind: kindOf(file, i) }));
  const of = (kind: ImageKind) => read.filter((r) => r.kind === kind).map((r) => r.file);

  const materials = of('material');
  const sketch = of('sketch')[0];
  const photo = of('photo')[0];
  const design = read.filter(
    (r): r is { file: T; kind: DesignKind } => r.kind === 'sketch' || r.kind === 'photo',
  );
  return {
    design: design.map((r) => r.file),
    designKinds: design.map((r) => r.kind),
    ...(materials[0] ? { material: materials[0] } : {}),
    extraMaterials: materials.slice(1),
    ...(sketch
      ? { criticReference: { file: sketch, kind: 'sketch' as const } }
      : photo
        ? { criticReference: { file: photo, kind: 'photo' as const } }
        : {}),
  };
}
