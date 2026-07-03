export interface NzbResult {
  guid: string;
  title: string;
  link: string;
  category: string;        // best-effort raw text (may be ''); client maps categoryId -> label
  categoryId: number | null; // primary numeric Newznab category code (most specific), for routing
  sizeBytes: number;       // 0 if unknown
  pubDate: string;         // original date string; '' if unknown
  grabs: number | null;    // null if absent
  imdbId: string | null;   // 'tt#######' (movies), else null
  tvdbId: number | null;   // TV series id, else null
  season: number | null;   // grabbed season number (from 'S01'), else null
  episode: number | null;  // grabbed episode number (from 'E00'), else null (0 for season packs)
}

function stripApiKey(u: string): string {
  if (!u) return u;
  try {
    const url = new URL(u);
    url.searchParams.delete('apikey');
    return url.toString();
  } catch {
    return u.replace(/([?&])apikey=[^&]*/gi, (_, sep) => (sep === '?' ? '?' : '')).replace(/[?&]$/, '');
  }
}

function asString(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o['#text'] === 'string') return o['#text'];
  }
  return '';
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

export function formatImdbId(raw: string | undefined): string | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return null;
  return 'tt' + String(n).padStart(7, '0');
}

// Parse 'S01' / 'E00' / '1' -> the integer (0 is valid, e.g. E00 season pack).
function parseSxxExx(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isNaN(n) ? null : n;
}

interface Attrs {
  first: Map<string, string>; // first value seen per attr name
  categories: number[];       // all numeric category codes
}

function readAttrs(item: Record<string, unknown>): Attrs {
  const first = new Map<string, string>();
  const categories: number[] = [];
  let attr = item.attr as unknown;
  if (attr && !Array.isArray(attr)) attr = [attr];
  if (Array.isArray(attr)) {
    for (const el of attr) {
      if (!el || typeof el !== 'object') continue;
      const rec = el as Record<string, unknown>;
      // Real NZBGeek shape: { "@attributes": { name, value } }. Flat fallback as insurance.
      const a = (rec['@attributes'] as Record<string, unknown> | undefined) ?? rec;
      const name = typeof a.name === 'string' ? a.name : undefined;
      if (!name) continue;
      const value = a.value;
      const valStr = typeof value === 'string' ? value : value == null ? '' : String(value);
      if (!first.has(name)) first.set(name, valStr);
      if (name === 'category') {
        const n = toInt(valStr);
        if (n !== null) categories.push(n);
      }
    }
  }
  return { first, categories };
}

function sizeOf(item: Record<string, unknown>, attrs: Attrs): number {
  const enc = item.enclosure as Record<string, unknown> | undefined;
  const encAttrs = (enc?.['@attributes'] as Record<string, unknown> | undefined) ?? enc;
  const fromEnc = toInt(encAttrs?.length);
  if (fromEnc !== null && fromEnc > 0) return fromEnc;
  const fromAttr = toInt(attrs.first.get('size'));
  if (fromAttr !== null && fromAttr > 0) return fromAttr;
  const fromItem = toInt(item.size);
  return fromItem !== null && fromItem > 0 ? fromItem : 0;
}

export function parseNewznabResults(raw: unknown): NzbResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  const channel = r.channel as Record<string, unknown> | undefined;
  let items = channel?.item ?? r.item;
  if (items && !Array.isArray(items)) items = [items];
  if (!Array.isArray(items)) return [];

  const results: NzbResult[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const attrs = readAttrs(item);

    const link = stripApiKey(asString(item.link));
    const guid = asString(item.guid) || link;
    if (!guid && !link) continue;

    results.push({
      guid,
      title: asString(item.title),
      link,
      category: asString(item.category),
      categoryId: attrs.categories.length
        ? attrs.categories.reduce((m, n) => (n > m ? n : m), -Infinity)
        : null,
      sizeBytes: sizeOf(item, attrs),
      pubDate: attrs.first.get('usenetdate') ?? asString(item.pubDate),
      grabs: toInt(attrs.first.get('grabs')),
      imdbId: formatImdbId(attrs.first.get('imdb')),
      tvdbId: toInt(attrs.first.get('tvdbid')),
      season: parseSxxExx(attrs.first.get('season')),
      episode: parseSxxExx(attrs.first.get('episode')),
    });
  }
  return results;
}
