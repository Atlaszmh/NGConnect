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
