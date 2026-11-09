// Finds the pages to audit when nobody named them: a bounded, same-origin walk of the links from the base URL.
const ASSET = /\.(css|js|mjs|json|png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|woff2?|mp4|webm|mp3|txt|xml)$/i;

export const pathOf = (url: URL): string => `${url.pathname}${url.search}`;

export const discoverPages = async (baseUrl: string, max = 15): Promise<string[]> => {
  const base = new URL(baseUrl);
  const seen = new Set<string>([pathOf(base)]);
  const queue: { url: URL; depth: number }[] = [{ url: base, depth: 0 }];
  while (queue.length > 0 && seen.size < max) {
    const next = queue.shift();
    if (!next || next.depth >= 2) continue;
    let html: string;
    try {
      const response = await fetch(next.url, { redirect: 'follow' });
      if (!response.ok || !(response.headers.get('content-type') ?? '').includes('html')) continue;
      html = await response.text();
    } catch {
      continue;
    }
    for (const match of html.matchAll(/href\s*=\s*["']([^"'#]+)/gi)) {
      let link: URL;
      try {
        link = new URL(match[1] ?? '', next.url);
      } catch {
        continue;
      }
      if (link.origin !== base.origin || ASSET.test(link.pathname)) continue;
      const path = pathOf(link);
      if (seen.has(path) || seen.size >= max) continue;
      seen.add(path);
      queue.push({ url: link, depth: next.depth + 1 });
    }
  }
  return [...seen];
};
