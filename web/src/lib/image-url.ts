/**
 * Image URLs the UI may display: presigned `https:` URLs and `blob:` previews of staged files.
 * Anything else (a `javascript:` or `data:` URL from a tampered response) is refused.
 */
export function safeImageUrl(src: string): string | undefined {
  try {
    const { protocol } = new URL(src);
    return protocol === 'https:' || protocol === 'blob:' ? src : undefined;
  } catch {
    return undefined;
  }
}
