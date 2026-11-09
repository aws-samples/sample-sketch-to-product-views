import { IMAGE_KIND_LABELS, type PipelineState } from '@sketch-to-product-views/contracts';

/** Captions for the narrow stage-card thumbnails; the full label goes in the tooltip. */
const SHORT_LABELS: Record<string, string> = {
  'Material sample': 'Material',
  'Not used': 'Unused',
};

/**
 * What each uploaded image is, as the analyser decided, for its thumbnail. Before the analysis,
 * or on a run analysed before images were classified, its number (or an older client's tag).
 * `short` gives the stage-card captions.
 */
export function inputLabels(
  state: Pick<PipelineState, 'inputs' | 'analysis'>,
  { short = false } = {},
): string[] {
  const read = state.analysis?.images;
  return state.inputs.map((input, i) => {
    const kind = read?.[i]?.kind;
    const label = kind
      ? IMAGE_KIND_LABELS[kind]
      : input.role === 'swatch'
        ? 'Material sample'
        : `Image ${i + 1}`;
    return short ? (SHORT_LABELS[label] ?? label) : label;
  });
}

/** The analyser's few words on each image, for a tooltip; undefined before it ran. */
export function inputDescriptions(state: Pick<PipelineState, 'inputs' | 'analysis'>) {
  return state.inputs.map((input, i) => {
    const description = state.analysis?.images?.[i]?.description;
    return description ? `${input.filename}: ${description}` : input.filename;
  });
}
