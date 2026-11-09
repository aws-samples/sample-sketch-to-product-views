import { useEffect, useState } from 'react';
import { ZOOM_EVENT, type ZoomDetail } from './ZoomImage';
import { safeImageUrl } from '../lib/image-url';

/** The full-size view of the clicked image. Mounted once; Escape or any click closes it. */
export function Lightbox() {
  const [shown, setShown] = useState<ZoomDetail | null>(null);

  useEffect(() => {
    const onZoom = (event: Event) => setShown((event as CustomEvent<ZoomDetail>).detail);
    window.addEventListener(ZOOM_EVENT, onZoom);
    return () => window.removeEventListener(ZOOM_EVENT, onZoom);
  }, []);

  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShown(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown]);

  const src = shown ? safeImageUrl(shown.src) : undefined;
  if (!shown || !src) return null;

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={shown.alt}
      onClick={() => setShown(null)}
    >
      <img src={src} alt={shown.alt} />
      <p className="lightbox__caption">
        {shown.alt}
        <span className="muted"> — click anywhere or press Escape to close</span>
      </p>
    </div>
  );
}
