import { useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import {
  CANDIDATE_VIEWS,
  SPEC_FIELDS,
  stageMeta,
  type PipelineState,
  type SpecFieldKey,
  type StageId,
  type StageRun,
} from '@sketch-to-product-views/contracts';
import '@xyflow/react/dist/style.css';
import {
  layoutFlow,
  NODE_W,
  PROMPT_ID,
  selectionAfterClick,
  type CanvasNodeId,
} from '../lib/flow-layout';
import { latestViews, viewOf, VIEW_LABELS } from '../lib/views';
import { inputLabels } from '../lib/inputs';
import { StageNode, nodeHeight, type StageNodeData, type StageNodeType } from './StageNode';
import { BandNode, type BandNodeType } from './BandNode';
import { PromptNode, type PromptNodeType } from './PromptNode';
import { RetryEdge } from './RetryEdge';
import { CameraFollow } from './CameraFollow';
import { FitOnResize } from './FitOnResize';
import { focusStage } from '../lib/run-focus';
import { FIT_PADDING, MAX_ZOOM } from '../lib/camera';
import { generationProgress } from '../lib/progress';

/**
 * The pipeline as a node graph, each stage's output on its card.
 *
 * A lens, not an editor: positions are recomputed on every poll, so nodes are not draggable.
 */

const NODE_TYPES: NodeTypes = { stage: StageNode, band: BandNode, prompt: PromptNode };
const EDGE_TYPES: EdgeTypes = { retry: RetryEdge };

/** Where the work is now; edges into these animate. */
const ACTIVE = new Set<StageRun['status']>(['running', 'awaiting_review']);

/** The spec fields worth a chip on the card. The rest are in the inspector. */
const SPEC_CHIPS: SpecFieldKey[] = [
  'productType',
  'colorDescription',
  'materialDescription',
  'dimensions',
];

/** What stage `id` shows, derived from the polled document. */
function dataFor(
  id: StageId,
  state: PipelineState,
  run: StageRun,
  frozenAt?: string,
): StageNodeData {
  const meta = stageMeta(id);
  const current = latestViews(state.candidates);
  const base: StageNodeData = {
    num: meta.num,
    label: meta.label,
    status: run.status,
    attempt: run.attempt > 1 ? `attempt ${run.attempt}` : undefined,
    stubbed: run.stubbed,
    retrySource: id === 'evaluate_2d',
  };

  // Each upload under what the analyser read it as, once it has.
  const thumbs = () => {
    const labels = inputLabels(state);
    const captions = inputLabels(state, { short: true });
    return state.inputs.map((input, i) => ({
      url: input.url,
      caption: captions[i],
      title: labels[i],
    }));
  };

  switch (id) {
    case 'upload':
      return { ...base, thumbs: thumbs() };
    case 'analyse':
      if (!state.analysis) return base;
      return {
        ...base,
        ...(state.analysis.images ? { thumbs: thumbs() } : {}),
        chips: state.analysis.views.map((view) => ({ text: `${view} view`, observed: true })),
        note:
          state.analysis.views.length > 0
            ? `${state.analysis.parts?.length ?? 0} part(s), ${state.analysis.details.length} detail(s) to keep`
            : 'no view identified',
      };
    case 'complete_spec': {
      const spec = state.spec;
      if (!spec) return base;
      const fields = SPEC_CHIPS.flatMap((key) => (spec[key] ? [spec[key]] : []));
      const all = SPEC_FIELDS.flatMap((key) => (spec[key] ? [spec[key]] : []));
      const observed = all.filter((f) => f.provenance === 'observed').length;
      return {
        ...base,
        chips: fields.map((f) => ({ text: f.value, observed: f.provenance === 'observed' })),
        note:
          `${all.length - observed} supplied · ${observed} observed` +
          (state.warning ? ` · ${state.warning}` : ''),
      };
    }
    case 'generate_2d': {
      const latest = current.at(-1);
      const generation = generationProgress(state);
      return {
        ...base,
        // The stage reads as the last view to move; a view still generating means running.
        status: generation?.active ? 'running' : run.status,
        // The tiles say the attempt.
        attempt: generation ? undefined : base.attempt,
        ...(generation
          ? { generation, frozenAt }
          : { thumbs: current.map((c) => ({ url: c.url, caption: VIEW_LABELS[viewOf(c)] })) }),
        model: latest?.model,
        note: latest?.model ? undefined : (latest?.modelId ?? state.modelId),
      };
    }
    case 'evaluate_2d': {
      const verdicts = current.flatMap((c) =>
        c.evaluation ? [{ view: viewOf(c), verdict: c.evaluation.verdict }] : [],
      );
      if (verdicts.length === 0) return base;
      const outcome = state.criticOutcome;
      return {
        ...base,
        verdicts,
        model: current.find((c) => c.evaluation?.model)?.evaluation?.model,
        note:
          outcome && 'approved' in outcome
            ? outcome.approved
              ? `approved at attempt ${outcome.attempt}`
              : `best of ${outcome.attempts} sent to review`
            : undefined,
      };
    }
    case 'human_review': {
      const rounds = state.regenerations?.length ?? 0;
      return {
        ...base,
        note:
          state.status === 'awaiting_review'
            ? 'waiting on you'
            : rounds > 0
              ? `${rounds} regeneration${rounds === 1 ? '' : 's'}`
              : undefined,
      };
    }
    case 'deliver': {
      if (state.status !== 'approved') return base;
      const urls = state.deliveryUrls;
      const downloads = urls
        ? CANDIDATE_VIEWS.flatMap((view) => {
            const url = urls[view];
            return url ? [{ view, url }] : [];
          })
        : state.deliveryUrl
          ? [{ view: 'front' as const, url: state.deliveryUrl }]
          : [];
      return { ...base, downloads };
    }
    default:
      return base;
  }
}

/** Card data decides card heights, heights decide the layout: data first, cached. */
function buildFlow(
  state: PipelineState,
  selected: CanvasNodeId,
  frozenAt?: string,
): { nodes: Node[]; edges: Edge[] } {
  const data = new Map<StageId, StageNodeData>();
  const heightFor = (id: StageId) => {
    let entry = data.get(id);
    if (!entry) {
      entry = dataFor(id, state, state.stages[id] ?? { status: 'pending', attempt: 0 }, frozenAt);
      data.set(id, entry);
    }
    return nodeHeight(entry);
  };

  const layout = layoutFlow(heightFor);

  const bandNodes: BandNodeType[] = layout.bands.map((band) => ({
    id: `band:${band.id}`,
    type: 'band',
    position: { x: band.x, y: band.y },
    data: { label: band.label },
    width: band.width,
    height: band.height,
    selectable: false,
    draggable: false,
    zIndex: 0,
  }));

  const stageNodes: StageNodeType[] = layout.nodes.map((node) => ({
    id: node.id,
    type: 'stage',
    position: { x: node.x, y: node.y },
    selected: selected === node.id,
    data: data.get(node.id)!,
    // Sized up front, so the first paint routes edges correctly.
    width: NODE_W,
    height: node.height,
    zIndex: 1,
  }));

  const prompted = state.candidates.filter((c) => c.prompt);
  const promptNode: PromptNodeType = {
    id: PROMPT_ID,
    type: 'prompt',
    position: { x: layout.prompt.x, y: layout.prompt.y },
    selected: selected === PROMPT_ID,
    data: {
      text: prompted[prompted.length - 1]?.prompt,
      attempts: new Set(prompted.map((c) => c.attempt)).size,
    },
    width: layout.prompt.width,
    height: layout.prompt.height,
    zIndex: 1,
  };

  // The critic scores attempt 2 only after a retry; a regeneration is not scored.
  const retryTaken = state.events.some(
    (e) => e.stage === 'evaluate_2d' && e.status === 'running' && (e.attempt ?? 1) > 1,
  );

  const edges: Edge[] = layout.edges.map((edge) => {
    // The prompt has no status; work is "there" while generation runs.
    const targetStage = edge.target === PROMPT_ID ? 'generate_2d' : edge.target;
    const targetStatus = state.stages[targetStage]?.status ?? 'pending';
    const taken = edge.kind === 'retry' && retryTaken;
    return {
      id: edge.id,
      type: edge.kind === 'retry' ? 'retry' : undefined,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      className: `edge edge--${edge.kind}${taken ? ' edge--taken' : ''}`,
      animated: edge.kind === 'retry' ? taken : ACTIVE.has(targetStatus),
      label: edge.kind === 'retry' ? 'retry' : undefined,
      data: { taken },
      selectable: false,
      focusable: false,
    };
  });

  return { nodes: [...bandNodes, ...stageNodes, promptNode] as Node[], edges };
}

function selectionCaption(selected: CanvasNodeId): string {
  if (!selected) return 'Click a stage for its events.';
  if (selected === PROMPT_ID) return 'Prompt — every version to the right';
  const meta = stageMeta(selected);
  return `${meta.num} ${meta.label} — events to the right`;
}

export function StageCanvas({
  state,
  selected,
  onSelect,
  frozenAt,
}: {
  state: PipelineState;
  selected: CanvasNodeId;
  onSelect: (node: CanvasNodeId) => void;
  /** Set while replaying: the replayed event's time. */
  frozenAt?: string;
}) {
  const [follow, setFollow] = useState(true);
  const focus = focusStage(state);

  const { nodes, edges } = useMemo(
    () => buildFlow(state, selected, frozenAt),
    [state, selected, frozenAt],
  );

  return (
    <div className="canvas">
      <div className="canvas-tools">
        <p className="muted">{selectionCaption(selected)}</p>
        <button
          type="button"
          className={`toggle-btn${follow ? ' toggle-btn--on' : ''}`}
          onClick={() => setFollow((on) => !on)}
          aria-pressed={follow}
        >
          Follow the work
        </button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        // No `fitView`: FitOnResize frames the graph once the pane has a size.
        minZoom={0.25}
        maxZoom={MAX_ZOOM}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        onNodeClick={(_, node) => onSelect(selectionAfterClick(node.id, selected))}
        onPaneClick={() => onSelect(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
        <Controls
          showInteractive={false}
          position="bottom-left"
          fitViewOptions={{ padding: FIT_PADDING }}
        />
        <CameraFollow target={focus} enabled={follow} />
        <FitOnResize focus={follow ? focus : null} />
      </ReactFlow>
    </div>
  );
}
