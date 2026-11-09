import type { Toast } from '../lib/useRunNotifications';

/** In-page notices, bottom right, newest last. */
export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.milestone}`}>
          <div>
            <strong>{t.title}</strong>
            <p>{t.body}</p>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            aria-label="Dismiss"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
