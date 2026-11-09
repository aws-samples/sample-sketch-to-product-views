/**
 * The whole backend surface the SPA uses. Responses are typed by `@sketch-to-product-views/contracts`, so a
 * contract change breaks compilation on both sides.
 */

import type {
  PipelineState,
  PresignRequest,
  PresignResponse,
  ReviewDecision,
  SubmitRequest,
} from '@sketch-to-product-views/contracts';
import { sanitizeText } from '@sketch-to-product-views/contracts';
import type { DeploymentDefaults, ModelParam } from './settings.js';

import { clearSession, idToken } from './auth.js';

/** Empty when deployed: same-origin `/api/*` through CloudFront. Local dev: the site's origin. */
const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The JWT authorizer's audience is the app client id, which only the id token carries. */
async function authHeader(): Promise<Record<string, string>> {
  const token = await idToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Fired when the API rejects our credentials; the app returns to the sign-in card. */
export const SIGNED_OUT_EVENT = 'product-views:signed-out';

/** Shared by every request path, polling included. */
async function failure(res: Response): Promise<ApiError> {
  if (res.status === 401) {
    clearSession();
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    return new ApiError('Your session expired. Sign in again to continue.', 401);
  }
  const detail = (await res.json().catch(() => null)) as { error?: string } | null;
  return new ApiError(detail?.error ?? `${res.status} ${res.statusText}`, res.status);
}

/** An empty body or a non-JSON error page becomes an `ApiError` with a status. */
async function parseBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('The API returned a response this app could not read.', res.status);
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(await authHeader()),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw await failure(res);
  return parseBody<T>(res);
}

/** One entry of `GET /api/models`: the fields the model picker reads. */
export interface ModelSummary {
  id: string;
  name: string;
  category: string;
  description?: string;
  costPerCall?: number;
  isDefault?: boolean;
  params?: ModelParam[];
}

export function listModels(): Promise<{
  models: ModelSummary[];
  defaultModelId: string;
  deployment?: DeploymentDefaults;
}> {
  return apiFetch('/api/models');
}

/** `notes`: the design team's comments on a first generation. */
export type StartRequest = SubmitRequest & { notes?: string };

export function submitRevision(body: StartRequest): Promise<{ revisionId: string }> {
  return apiFetch('/api/revisions', { method: 'POST', body: JSON.stringify(body) });
}

export function submitReview(revisionId: string, decision: ReviewDecision): Promise<void> {
  return apiFetch(`/api/revisions/${encodeURIComponent(revisionId)}/review`, {
    method: 'POST',
    body: JSON.stringify(decision),
  });
}

/** Conditional GET: `null` on 304, so idle polling costs one small request and no re-render. */
export async function getPipeline(
  revisionId: string,
  etag?: string,
  signal?: AbortSignal,
): Promise<{ state: PipelineState; etag: string | null } | null> {
  const res = await fetch(`${BASE}/api/revisions/${encodeURIComponent(revisionId)}`, {
    headers: { ...(await authHeader()), ...(etag ? { 'if-none-match': etag } : {}) },
    signal,
  });
  if (res.status === 304) return null;
  if (!res.ok) throw await failure(res);
  return { state: await parseBody<PipelineState>(res), etag: res.headers.get('etag') };
}

/** Three legs: presign, PUT the bytes straight to S3, confirm (server-side magic-byte check). */
export async function uploadFile(
  file: File,
  productId: string,
): Promise<{ filename: string; url: string; key: string }> {
  // The name as the API keeps it: hidden characters out (`sanitizeText`).
  const filename = sanitizeText(file.name) || 'upload';
  const presign = await apiFetch<PresignResponse>('/api/uploads/presign', {
    method: 'POST',
    body: JSON.stringify({
      productId,
      filename,
      contentType: file.type,
      sizeBytes: file.size,
    } satisfies PresignRequest),
  });

  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': presign.contentType },
    body: file,
  });
  if (!put.ok) throw new ApiError(`Upload failed (${put.status}).`, put.status);

  await apiFetch('/api/uploads/confirm', {
    method: 'POST',
    body: JSON.stringify({ key: presign.key }),
  });

  return { filename, url: presign.cdnUrl, key: presign.key };
}
