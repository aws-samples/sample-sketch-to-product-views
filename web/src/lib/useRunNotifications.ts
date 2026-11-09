import { useCallback, useEffect, useRef, useState } from 'react';
import type { PipelineState } from '@sketch-to-product-views/contracts';
import {
  milestone,
  noticeFor,
  showNotification,
  tabInView,
  titleWith,
  type Notice,
  type RunSnapshot,
} from './notify';

export interface Toast extends Notice {
  id: number;
}

const TOAST_MS = 10_000;

/**
 * Tells the watcher when the live run reaches review, approval or failure: a toast, a tab title
 * prefix until the tab is in view, and a system notification while it is not.
 */
export function useRunNotifications(state: PipelineState | null): {
  toasts: Toast[];
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const previous = useRef<RunSnapshot | null>(null);
  const baseTitle = useRef(document.title);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    if (!state) return;
    const reached = milestone(previous.current, state);
    previous.current = { revisionId: state.revisionId, status: state.status };
    if (!reached) return;

    const notice = noticeFor(state, reached);
    const id = nextId.current++;
    setToasts((list) => [...list, { ...notice, id }]);
    window.setTimeout(() => dismiss(id), TOAST_MS);
    if (!tabInView()) {
      document.title = titleWith(notice, baseTitle.current);
      showNotification(notice, state.revisionId);
    }
  }, [state, dismiss]);

  // The prefix goes once the tab is looked at.
  useEffect(() => {
    const clear = () => {
      if (tabInView()) document.title = baseTitle.current;
    };
    window.addEventListener('focus', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('focus', clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);

  return { toasts, dismiss };
}
