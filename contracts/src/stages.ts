/**
 * The pipeline stages, in execution order.
 *
 * This list is the single source of truth for stage identity. The backend emits
 * events keyed by `id`; the UI renders the rail from this same array. Adding a
 * stage means editing this file only.
 */
export const STAGES = [
  { id: 'upload', num: '01', label: 'Upload product', group: 'intake' },
  { id: 'submit', num: '02', label: 'Submit package', group: 'intake' },
  { id: 'validate', num: '03', label: 'Validate package', group: 'intake' },
  { id: 'analyse', num: '04', label: 'Analyse images', group: 'intake' },
  { id: 'complete_spec', num: '05', label: 'Complete specification', group: 'intake' },
  { id: 'generate_2d', num: '06', label: 'Generate 2D image', group: 'two_d' },
  { id: 'evaluate_2d', num: '07', label: 'Evaluate 2D image', group: 'two_d' },
  { id: 'human_review', num: '08', label: 'Human review', group: 'review' },
  { id: 'deliver', num: '09', label: 'Deliver approved views', group: 'review' },
] as const;

export type StageId = (typeof STAGES)[number]['id'];
export type StageGroup = (typeof STAGES)[number]['group'];

export const STAGE_IDS = STAGES.map((s) => s.id) as readonly StageId[];

export const STAGE_GROUPS: { id: StageGroup; label: string }[] = [
  { id: 'intake', label: 'Product intake' },
  { id: 'two_d', label: '2D generation & evaluation' },
  { id: 'review', label: 'Review & delivery' },
];

export function stageMeta(id: StageId) {
  const found = STAGES.find((s) => s.id === id);
  if (!found) throw new Error(`unknown stage: ${id}`);
  return found;
}
