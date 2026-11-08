import type { PipelineState } from '@sketch-to-product-views/contracts';

/** The moments a run needs its watcher. */
export type Milestone = 'awaiting_review' | 'approved' | 'failed';

/** What notification decisions read from one poll. */
export type RunSnapshot = Pick<PipelineState, 'revisionId' | 'status'>;

const MILESTONES: ReadonlySet<string> = new Set<Milestone>([
  'awaiting_review',
  'approved',
  'failed',
]);

/**
 * The milestone a run reached between two polls, or `null`. Only a change of status seen while
 * watching counts: the first poll of a run (a page load, a reload, another run) never does, so a
 * finished run does not notify again, and an unchanged poll never does either.
 */
export function milestone(previous: RunSnapshot | null, next: RunSnapshot): Milestone | null {
  if (!previous || previous.revisionId !== next.revisionId) return null;
  if (previous.status === next.status || !MILESTONES.has(next.status)) return null;
  return next.status as Milestone;
}

export interface Notice {
  milestone: Milestone;
  /** Short: the toast heading, the notification title and the tab title prefix. */
  title: string;
  body: string;
}

export function noticeFor(state: PipelineState, reached: Milestone): Notice {
  const product = state.productId;
  switch (reached) {
    case 'awaiting_review':
      return {
        milestone: reached,
        title: 'Ready for review',
        body: `${product}: the views are ready for your review.`,
      };
    case 'approved':
      return {
        milestone: reached,
        title: 'Approved',
        body: `${product}: the views are delivered.`,
      };
    case 'failed':
      return {
        milestone: reached,
        title: 'Run failed',
        body: `${product}: ${state.failureReason ?? 'the run stopped.'}`,
      };
  }
}

/** "● Ready for review — Sketch to product views". */
export function titleWith(notice: Notice | null, base: string): string {
  return notice ? `● ${notice.title} — ${base}` : base;
}

// ── Browser notifications, where the context has them ───────────────────────

/** `unsupported` where there is no `Notification` (some mobile browsers, embedded views). */
export type Permission = NotificationPermission | 'unsupported';

export function notificationPermission(): Permission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Asks once, from a user gesture; resolves to the answer. Never throws. */
export async function askToNotify(): Promise<Permission> {
  const current = notificationPermission();
  if (current !== 'default') return current;
  try {
    return await Notification.requestPermission();
  } catch {
    // Old engines take a callback and return nothing; ask what was decided.
    return notificationPermission();
  }
}

/** Shows `notice` as a system notification when allowed; a click brings the tab back. */
export function showNotification(notice: Notice, tag: string): void {
  if (notificationPermission() !== 'granted') return;
  try {
    const shown = new Notification(notice.title, { body: notice.body, tag });
    shown.onclick = () => {
      window.focus();
      shown.close();
    };
  } catch {
    // Some contexts (Android Chrome) only allow notifications from a service worker.
  }
}

/** The watcher is looking at this tab. */
export function tabInView(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}
