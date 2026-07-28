const linkRegex = /<a[^>]+href=["']([^"']+)["']/gi;

export function normalizeUrl(raw: string, base?: string): string {
  const url = base ? new URL(raw, base) : new URL(raw);
  url.hash = '';
  return url.toString();
}

export function extractSameOriginLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  const base = new URL(baseUrl);
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html))) {
    try {
      const normalized = normalizeUrl(match[1], baseUrl);
      const candidate = new URL(normalized);
      if (candidate.origin === base.origin) {
        links.add(candidate.toString());
      }
    } catch {
      continue;
    }
  }

  return [...links];
}
