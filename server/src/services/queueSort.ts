import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { createServiceLogger } from './logger';

const log = createServiceLogger('queue-sort');

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

export interface QueueMove {
  nzo_id: string;
  position: number;
}

// Minimal sequence of "move item to position i" ops that transforms current into
// desired. Each op maps 1:1 to a SAB `mode=switch&value=<nzo_id>&value2=<position>`
// call. Returns [] when current === desired (so the loop makes zero SAB calls).
export function planMoves(currentIds: string[], desiredIds: string[]): QueueMove[] {
  const work = [...currentIds];
  const moves: QueueMove[] = [];
  for (let i = 0; i < desiredIds.length; i++) {
    const want = desiredIds[i];
    if (work[i] === want) continue;
    const j = work.indexOf(want, i);
    if (j === -1) continue; // defensive: desired id not present in current
    work.splice(j, 1);
    work.splice(i, 0, want);
    moves.push({ nzo_id: want, position: i });
  }
  return moves;
}

export interface QueueSortConfig {
  enabled: boolean;
  pollIntervalMs: number;
}

const DEFAULT_CONFIG: QueueSortConfig = { enabled: true, pollIntervalMs: 15000 };
const MIN_INTERVAL_MS = 5000;

// Sanitize an unknown object (parsed from disk OR a PUT body) into a valid config:
// enabled defaults true unless explicitly boolean false; pollIntervalMs defaults
// to 15000 and is floored + clamped to MIN_INTERVAL_MS; unknown keys are dropped.
export function normalizeConfig(raw: unknown): QueueSortConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_CONFIG.enabled;
  let pollIntervalMs = DEFAULT_CONFIG.pollIntervalMs;
  if (typeof obj.pollIntervalMs === 'number' && Number.isFinite(obj.pollIntervalMs)) {
    pollIntervalMs = Math.max(MIN_INTERVAL_MS, Math.floor(obj.pollIntervalMs));
  }
  return { enabled, pollIntervalMs };
}

// Persisted like logger's logs dir: __dirname-relative, created if missing.
const DATA_DIR = path.join(__dirname, '../../data');
const CONFIG_PATH = path.join(DATA_DIR, 'queue-sort.json');

let queueSortConfig: QueueSortConfig = DEFAULT_CONFIG;

function loadConfig(): QueueSortConfig {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  } catch {
    return normalizeConfig({}); // missing/corrupt → defaults (enabled ON)
  }
}

function saveConfig(cfg: QueueSortConfig): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (err) {
    log.warn('Failed to persist queue-sort config', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getQueueSortConfig(): QueueSortConfig {
  return { ...queueSortConfig };
}

export function updateQueueSortConfig(partial: unknown): QueueSortConfig {
  const patch = partial && typeof partial === 'object' ? (partial as Record<string, unknown>) : {};
  const merged = normalizeConfig({ ...queueSortConfig, ...patch });
  const intervalChanged = merged.pollIntervalMs !== queueSortConfig.pollIntervalMs;
  queueSortConfig = merged;
  saveConfig(queueSortConfig);
  if (pollInterval && intervalChanged) {
    stopQueueSorter();
    startQueueSorter();
  }
  return getQueueSortConfig();
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

async function sabQueue(): Promise<QueueSlot[]> {
  const url = new URL(`${config.sabnzbd.url}/api`);
  url.searchParams.set('apikey', config.sabnzbd.apiKey);
  url.searchParams.set('mode', 'queue');
  url.searchParams.set('output', 'json');
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  const data = (await resp.json()) as { queue?: { slots?: QueueSlot[] } };
  return data.queue?.slots ?? [];
}

async function sabSwitch(nzoId: string, position: number): Promise<void> {
  const url = new URL(`${config.sabnzbd.url}/api`);
  url.searchParams.set('apikey', config.sabnzbd.apiKey);
  url.searchParams.set('mode', 'switch');
  url.searchParams.set('value', nzoId);
  url.searchParams.set('value2', String(position));
  url.searchParams.set('output', 'json');
  await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
}

async function tick(): Promise<void> {
  if (!queueSortConfig.enabled) return;
  try {
    const slots = await sabQueue();
    if (slots.length < 2) return;
    const currentIds = slots.map((s) => s.nzo_id);
    const moves = planMoves(currentIds, episodeSortOrder(slots));
    if (moves.length === 0) return; // already sorted → no SAB calls
    for (const mv of moves) {
      await sabSwitch(mv.nzo_id, mv.position);
    }
    log.info(`Reordered queue into episode order (${moves.length} move(s))`);
  } catch (err) {
    log.warn('Queue sort tick failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startQueueSorter(): void {
  if (pollInterval) return;
  queueSortConfig = loadConfig(); // pick up persisted enabled/interval on boot
  log.info('Queue sorter started', {
    enabled: queueSortConfig.enabled,
    interval: queueSortConfig.pollIntervalMs,
  });
  tick();
  pollInterval = setInterval(tick, queueSortConfig.pollIntervalMs);
}

export function stopQueueSorter(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
