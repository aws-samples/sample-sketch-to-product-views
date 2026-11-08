import { STAGES, STAGE_GROUPS, type StageGroup, type StageId } from '@sketch-to-product-views/contracts';

/**
 * Where each stage sits on the canvas, and what connects to what.
 *
 * Stages and their order come from the contract; only the card heights depend on a run, because
 * a card grows to hold its output. One column per stage group, read left to right.
 */

export const NODE_W = 220;
/** Header plus status row. Cards grow from here; see `nodeHeight`. */
export const NODE_H = 64;
const GAP_X = 104;
const GAP_Y = 32;
const PAD = 24;

/** The prompt is an artifact, not a stage: it sits in the widened intake → 2D gap. */
export const PROMPT_W = 184;
export const PROMPT_H = 132;
const PROMPT_GAP = 56;

/** Phase band inset around its column, and its label strip. */
const BAND_X = 16;
const BAND_LABEL = 30;
const BAND_BOTTOM = 16;

export interface FlowNode {
  id: StageId;
  x: number;
  y: number;
  height: number;
}

export interface FlowPrompt {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The labelled rectangle behind a group's column. */
export interface FlowBand {
  id: StageGroup;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The prompt node's id. Not a `StageId`: it is not a stage. */
export const PROMPT_ID = 'prompt';

/** Anything a click can select, or `null`. */
export type CanvasNodeId = StageId | typeof PROMPT_ID | null;

const SELECTABLE = new Set<string>([...STAGES.map((s) => s.id), PROMPT_ID]);

/**
 * What a click on a canvas node selects: a stage or the prompt toggles; anything else (a band
 * behind a column) clears the selection like a click on the empty canvas.
 */
export function selectionAfterClick(nodeId: string, selected: CanvasNodeId): CanvasNodeId {
  if (!SELECTABLE.has(nodeId)) return null;
  return nodeId === selected ? null : (nodeId as CanvasNodeId);
}

export type FlowEdgeEnd = StageId | typeof PROMPT_ID;

export interface FlowEdge {
  id: string;
  source: FlowEdgeEnd;
  target: FlowEdgeEnd;
  /** `sequence`: the happy path. `retry`: the critic sending failed views back to the prompt. */
  kind: 'sequence' | 'retry';
  sourceHandle: string;
  targetHandle: string;
}

export interface FlowLayout {
  nodes: FlowNode[];
  bands: FlowBand[];
  prompt: FlowPrompt;
  edges: FlowEdge[];
}

type StageColumn = (typeof STAGES)[number][];

/** Only the first gap is widened, to hold the prompt. */
const columnX = (col: number): number =>
  PAD + col * (NODE_W + GAP_X) + (col > 0 ? PROMPT_W + PROMPT_GAP * 2 - GAP_X : 0);

function stagesByColumn(): StageColumn[] {
  return STAGE_GROUPS.map((group) => STAGES.filter((s) => s.group === group.id));
}

function placeNodes(
  columns: StageColumn[],
  columnHeights: number[],
  fullHeight: number,
  heightFor: (id: StageId) => number,
): FlowNode[] {
  const contentTop = PAD + BAND_LABEL;
  const nodes: FlowNode[] = [];
  columns.forEach((column, col) => {
    // Centred, so the chain stays roughly horizontal across short and tall columns.
    let y = contentTop + (fullHeight - columnHeights[col]) / 2;
    for (const stage of column) {
      const height = heightFor(stage.id);
      nodes.push({ id: stage.id, x: columnX(col), y, height });
      y += height + GAP_Y;
    }
  });
  return nodes;
}

/** Centred on the complete_spec → generate_2d hop it sits on. */
function placePrompt(nodes: FlowNode[]): FlowPrompt {
  const midOf = (id: StageId) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new Error(`flow-layout: no node for stage ${id}`);
    return node.y + node.height / 2;
  };
  return {
    x: columnX(0) + NODE_W + PROMPT_GAP,
    y: (midOf('complete_spec') + midOf('generate_2d')) / 2 - PROMPT_H / 2,
    width: PROMPT_W,
    height: PROMPT_H,
  };
}

/** Bands share one top and bottom, so they read as phases of one pipeline. */
function placeBands(fullHeight: number): FlowBand[] {
  return STAGE_GROUPS.map((group, col) => ({
    id: group.id,
    label: group.label,
    x: columnX(col) - BAND_X,
    y: PAD,
    width: NODE_W + BAND_X * 2,
    height: BAND_LABEL + fullHeight + BAND_BOTTOM,
  }));
}

/** Consecutive stages in contract order: down within a column, right between columns. */
function sequenceEdges(): FlowEdge[] {
  const group = new Map(STAGES.map((s) => [s.id, s.group]));
  const edges: FlowEdge[] = [];
  for (let i = 0; i < STAGES.length - 1; i += 1) {
    const source = STAGES[i].id;
    const target = STAGES[i + 1].id;
    const vertical = group.get(source) === group.get(target);
    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      kind: 'sequence',
      sourceHandle: vertical ? 'out-bottom' : 'out-right',
      targetHandle: vertical ? 'in-top' : 'in-left',
    });
  }
  return edges;
}

/** complete_spec → prompt → generate_2d: the spec becomes the prompt the image model gets. */
function splicePromptInto(edges: FlowEdge[]): void {
  const direct = edges.findIndex((e) => e.id === 'complete_spec->generate_2d');
  // Fail loudly on a contract reorder rather than splice the wrong hop.
  if (direct === -1) throw new Error('flow-layout: complete_spec no longer precedes generate_2d');
  edges.splice(
    direct,
    1,
    {
      id: 'complete_spec->prompt',
      source: 'complete_spec',
      target: PROMPT_ID,
      kind: 'sequence',
      sourceHandle: 'out-right',
      targetHandle: 'in-left',
    },
    {
      id: 'prompt->generate_2d',
      source: PROMPT_ID,
      target: 'generate_2d',
      kind: 'sequence',
      sourceHandle: 'out-right',
      targetHandle: 'in-left',
    },
  );
}

/** @param heightFor height of a stage's card, which varies with what it has produced. */
export function layoutFlow(heightFor: (id: StageId) => number): FlowLayout {
  const columns = stagesByColumn();
  const columnHeights = columns.map(
    (column) =>
      column.reduce((sum, stage) => sum + heightFor(stage.id), 0) + (column.length - 1) * GAP_Y,
  );
  const fullHeight = Math.max(...columnHeights);

  const nodes = placeNodes(columns, columnHeights, fullHeight, heightFor);
  const edges = sequenceEdges();
  splicePromptInto(edges);

  // The retry lands on the prompt: the critic's issues are added to it before regenerating.
  edges.push({
    id: 'retry',
    source: 'evaluate_2d',
    target: PROMPT_ID,
    kind: 'retry',
    sourceHandle: 'retry-out',
    targetHandle: 'retry-in',
  });

  return { nodes, bands: placeBands(fullHeight), prompt: placePrompt(nodes), edges };
}
