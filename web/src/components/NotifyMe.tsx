import { useState } from 'react';
import { askToNotify, notificationPermission, type Permission } from '../lib/notify';

/** Asks for system notifications on click; says so once they are on or blocked. */
export function NotifyMe() {
  const [permission, setPermission] = useState<Permission>(notificationPermission);
  if (permission === 'unsupported') return null;
  if (permission === 'granted') return <span className="muted notify-state">Notifications on</span>;
  if (permission === 'denied') {
    return (
      <span className="muted notify-state" title="Allow them in the browser's site settings.">
        Notifications blocked
      </span>
    );
  }
  return (
    <button
      type="button"
      className="btn btn--ghost"
      title="Get a system notification when the views are ready, approved or the run fails"
      onClick={() => void askToNotify().then(setPermission)}
    >
      Notify me
    </button>
  );
}
