export interface ParsedEpisode {
  show: string;   // normalized grouping key (lowercased, separators → spaces)
  season: number;
  episode: number;
}

// Show prefix, a separator, then SxxEyy. The `e` must follow the season digits
// immediately, so `S01.E01` (separator between blocks) and bare season packs
// (`S01`) do NOT match. First episode of a multi-episode file wins.
const EPISODE_RE = /^(.*?)[._ -]+s(\d{1,2})e(\d{1,3})/i;

export function parseEpisode(filename: string): ParsedEpisode | null {
  if (typeof filename !== 'string') return null;
  const m = filename.match(EPISODE_RE);
  if (!m) return null;
  const show = m[1].replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!show) return null; // no show identity → treat as non-episode
  return { show, season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };
}

export interface QueueSlot {
  nzo_id: string;
  filename: string;
}

// Desired nzo_id order: non-episodes stay at their absolute index; episodes are
// gathered per show (show order = ascending min current index) and ordered by
// season then episode, filling the remaining slots in ascending index order.
export function episodeSortOrder(slots: QueueSlot[]): string[] {
  const n = slots.length;
  const result: (string | null)[] = new Array(n).fill(null);
  const episodes: { nzo_id: string; index: number; show: string; season: number; episode: number }[] = [];

  slots.forEach((s, index) => {
    const parsed = parseEpisode(s.filename);
    if (parsed) {
      episodes.push({ nzo_id: s.nzo_id, index, ...parsed });
    } else {
      result[index] = s.nzo_id; // fixed point
    }
  });

  const freeSlots: number[] = [];
  for (let i = 0; i < n; i++) if (result[i] === null) freeSlots.push(i);

  const showMinIndex = new Map<string, number>();
  for (const ep of episodes) {
    const cur = showMinIndex.get(ep.show);
    if (cur === undefined || ep.index < cur) showMinIndex.set(ep.show, ep.index);
  }

  const sorted = [...episodes].sort((a, b) => {
    const ga = showMinIndex.get(a.show)!;
    const gb = showMinIndex.get(b.show)!;
    if (ga !== gb) return ga - gb;
    if (a.season !== b.season) return a.season - b.season;
    if (a.episode !== b.episode) return a.episode - b.episode;
    return a.index - b.index; // stable tie-break
  });

  sorted.forEach((ep, i) => { result[freeSlots[i]] = ep.nzo_id; });
  return result as string[];
}
