import type { ReactEventHandler } from 'react';
import { safeImageUrl } from '../lib/image-url';

/**
 * A thumbnail that opens full size when clicked. Opened by a window event rather than context,
 * because many thumbnails render inside React Flow nodes, outside any provider of this app.
 */
export const ZOOM_EVENT = 'product-views:zoom';

export type ZoomDetail = { src: string; alt: string };

export function openZoom(detail: ZoomDetail) {
  const src = safeImageUrl(detail.src);
  if (!src) return;
  window.dispatchEvent(new CustomEvent<ZoomDetail>(ZOOM_EVENT, { detail: { ...detail, src } }));
}

export function ZoomImage({
  src,
  alt,
  className,
  onError,
}: {
  src: string;
  alt: string;
  className?: string;
  onError?: ReactEventHandler<HTMLImageElement>;
}) {
  const open = () => openZoom({ src, alt });

  return (
    <img
      className={className ? `${className} zoomable` : 'zoomable'}
      src={src}
      alt={alt}
      role="button"
      tabIndex={0}
      title="Click to view full size"
      onError={onError}
      // Inside a stage node the click would also select the node.
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
    />
  );
}
