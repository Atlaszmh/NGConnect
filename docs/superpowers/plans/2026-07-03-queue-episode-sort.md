# Queue Episode-Order Sort Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-side background loop keeps the SABnzbd queue in per-show season→episode order (non-episode items hold their position), toggleable from the Downloads page and persisted across restarts.

**Architecture:** Four pure, unit-tested functions in a new `queueSort.ts` service (`parseEpisode`, `episodeSortOrder`, `planMoves`, `normalizeConfig`) hold all the logic; a thin `setInterval` loop (mirroring `vpnMonitor.ts`) fetches the SAB queue, computes the desired order, and applies it with the existing SAB `mode=switch` primitive. A persisted JSON config (`server/data/queue-sort.json`) drives an on/off toggle exposed via `GET`/`PUT /system/queue-sort` and rendered as a switch on the Downloads page.

**Tech Stack:** Express 5 + TypeScript (server, strict), React 19 + Vite + axios (client, strict + noUnusedLocals + verbatimModuleSyntax), vitest.

**Spec:** [docs/superpowers/specs/2026-07-03-queue-episode-sort-design.md](../specs/2026-07-03-queue-episode-sort-design.md)

**Branch:** `feature/queue-episode-sort` (already checked out). NOT merged to `main` until the end.

---

## File Structure

**New:**
- `server/src/services/queueSort.ts` — the four pure functions + persisted config (`getQueueSortConfig`/`updateQueueSortConfig` + `loadConfig`/`saveConfig`) + the background loop (`startQueueSorter`/`stopQueueSorter` + `tick` + SAB `sabQueue`/`sabSwitch` helpers). One clear responsibility: keeping the SAB queue in episode order.
- `server/src/services/queueSort.test.ts` — unit tests for the four pure functions.
- `server/data/queue-sort.json` — runtime-generated persisted config (gitignored; NOT committed; created by `saveConfig`).

**Modified:**
- `server/src/routes/system.ts` — add `GET`/`PUT /system/queue-sort` (mirrors the kill-switch endpoints at lines 110-118).
- `server/src/index.ts` — call `startQueueSorter()` in the `app.listen` callback (next to `startVpnMonitor()` at line 69).
- `client/src/pages/DownloadsPage.tsx` — "Keep in episode order" toggle (fetch/PUT `/system/queue-sort`); disable drag while enabled.
- `client/src/index.css` — a small `.sort-toggle` rule.
- `.gitignore` — add `server/data/`.

**Key existing patterns to mirror (read these first):**
- `server/src/services/vpnMonitor.ts` — the in-memory config + `get/update` accessors, `start/stop` + `setInterval` loop with `try/catch`, `createServiceLogger`, and the pure `parseVpnStatus`. The SAB pause/resume helpers there show how to call the SAB API server-side (`new URL(config.sabnzbd.url + '/api')`, set `apikey`/`mode`/`output=json`, `fetch`).
- `server/src/services/logger.ts:5` — `path.join(__dirname, '../../logs')` is the `__dirname`-relative writable-dir convention; the data dir mirrors it as `../../data`.
- `server/src/routes/system.ts:110-118` — the `GET`/`PUT /vpn/killswitch` shape to mirror.

**Note on the server test config:** `server/tsconfig.json` excludes `**/*.test.ts`, so the new test file is NOT compiled into `dist` (don't remove that exclude).

---

## Chunk 1: Server pure core (parseEpisode, episodeSortOrder, planMoves, normalizeConfig)

All four functions and their tests live in `server/src/services/queueSort.ts` and `server/src/services/queueSort.test.ts`. Each task is one TDD cycle and one commit. Run tests from the `server/` directory.

### Task 1: `parseEpisode` (pure)

**Files:**
- Create: `server/src/services/queueSort.ts`
- Create: `server/src/services/queueSort.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/queueSort.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseEpisode } from './queueSort';

describe('parseEpisode', () => {
  it('parses standard S01E05', () => {
    expect(parseEpisode('The.Mandalorian.S02E05.1080p.WEB.H264-GRP')).toEqual({
      show: 'the mandalorian', season: 2, episode: 5,
    });
  });
  it('is case-insensitive and handles space/underscore separators', () => {
    expect(parseEpisode('some show s1e5 720p')).toEqual({ show: 'some show', season: 1, episode: 5 });
    expect(parseEpisode('Some_Show_S01E09_x265')).toEqual({ show: 'some show', season: 1, episode: 9 });
  });
  it('uses the FIRST episode of a multi-episode file', () => {
    expect(parseEpisode('Show.Name.S01E01E02.1080p')).toMatchObject({ season: 1, episode: 1 });
    expect(parseEpisode('Show.Name.S01E01-E02.1080p')).toMatchObject({ season: 1, episode: 1 });
  });
  it('finds SxxEyy even when the show name contains digits', () => {
    expect(parseEpisode('The.100.S03E05.1080p')).toEqual({ show: 'the 100', season: 3, episode: 5 });
  });
  it('returns null for a season pack (no E)', () => {
    expect(parseEpisode('The.Show.S01.1080p.WEBRip')).toBeNull();
  });
  it('returns null for a separator between the S and E blocks (S01.E01)', () => {
    expect(parseEpisode('Show.Name.S01.E01.1080p')).toBeNull();
  });
  it('returns null for movies and date-based / unparseable names', () => {
    expect(parseEpisode('Some.Movie.2021.1080p.BluRay.x264')).toBeNull();
    expect(parseEpisode('Daily.Show.2024.01.15.1080p')).toBeNull();
    expect(parseEpisode('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/services/queueSort.test.ts`
Expected: FAIL — `parseEpisode` is not exported / file missing.

- [ ] **Step 3: Implement `parseEpisode` in `queueSort.ts`**

Create `server/src/services/queueSort.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/services/queueSort.test.ts`
Expected: PASS (all `parseEpisode` cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/queueSort.ts server/src/services/queueSort.test.ts
git commit -m "feat(server): parseEpisode — SxxEyy parser for queue sort"
```

---

### Task 2: `episodeSortOrder` (pure)

**Files:**
- Modify: `server/src/services/queueSort.ts`
- Modify: `server/src/services/queueSort.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `queueSort.test.ts` (add `episodeSortOrder` to the import from `./queueSort`):

```ts
import { episodeSortOrder } from './queueSort';

const slot = (nzo_id: string, filename: string) => ({ nzo_id, filename });

describe('episodeSortOrder', () => {
  it('groups by show and orders episodes, holding a non-episode at its index', () => {
    // Canonical spec fixture: movie fixed at index 2; ShowB (min idx 0) before ShowA (min idx 1).
    const order = episodeSortOrder([
      slot('b2', 'ShowB.S01E02.1080p'),
      slot('a1', 'ShowA.S01E01.1080p'),
      slot('mv', 'Some.Movie.2021.1080p'),
      slot('b1', 'ShowB.S01E01.1080p'),
      slot('a2', 'ShowA.S01E02.1080p'),
    ]);
    expect(order).toEqual(['b1', 'b2', 'mv', 'a1', 'a2']);
  });

  it('leaves one show split around a held movie (ordered but non-contiguous)', () => {
    const order = episodeSortOrder([
      slot('e3', 'ShowA.S01E03.1080p'),
      slot('mv', 'Some.Movie.2021.1080p'),
      slot('e1', 'ShowA.S01E01.1080p'),
      slot('e2', 'ShowA.S01E02.1080p'),
    ]);
    expect(order).toEqual(['e1', 'mv', 'e2', 'e3']);
  });

  it('orders across seasons within a show', () => {
    const order = episodeSortOrder([
      slot('s2e1', 'ShowA.S02E01.1080p'),
      slot('s1e2', 'ShowA.S01E02.1080p'),
      slot('s1e1', 'ShowA.S01E01.1080p'),
    ]);
    expect(order).toEqual(['s1e1', 's1e2', 's2e1']);
  });

  it('is a no-op (same order) when already sorted', () => {
    const slots = [
      slot('a1', 'ShowA.S01E01.1080p'),
      slot('a2', 'ShowA.S01E02.1080p'),
      slot('mv', 'Some.Movie.2021.1080p'),
    ];
    expect(episodeSortOrder(slots)).toEqual(['a1', 'a2', 'mv']);
  });

  it('returns the same ids for an all-non-episode queue', () => {
    const slots = [slot('m1', 'Movie.One.2020.1080p'), slot('m2', 'Movie.Two.2021.1080p')];
    expect(episodeSortOrder(slots)).toEqual(['m1', 'm2']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/services/queueSort.test.ts`
Expected: FAIL — `episodeSortOrder` not exported.

- [ ] **Step 3: Implement `episodeSortOrder`**

Append to `queueSort.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/services/queueSort.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/queueSort.ts server/src/services/queueSort.test.ts
git commit -m "feat(server): episodeSortOrder — group-by-show episode ordering"
```

---

### Task 3: `planMoves` (pure)

**Files:**
- Modify: `server/src/services/queueSort.ts`
- Modify: `server/src/services/queueSort.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `queueSort.test.ts` (add `planMoves` to the import):

```ts
import { planMoves } from './queueSort';

describe('planMoves', () => {
  it('returns [] when current already equals desired (no SAB calls)', () => {
    expect(planMoves(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('emits a single move when one item is out of place', () => {
    expect(planMoves(['a', 'b', 'c'], ['b', 'a', 'c'])).toEqual([{ nzo_id: 'b', position: 0 }]);
  });

  it('produces a move sequence that reproduces desired when replayed', () => {
    const current = ['a', 'b', 'c', 'd'];
    const desired = ['d', 'c', 'b', 'a'];
    const moves = planMoves(current, desired);
    // Replay each move (splice item to position) and confirm we land on desired.
    const work = [...current];
    for (const mv of moves) {
      const from = work.indexOf(mv.nzo_id);
      work.splice(from, 1);
      work.splice(mv.position, 0, mv.nzo_id);
    }
    expect(work).toEqual(desired);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/services/queueSort.test.ts`
Expected: FAIL — `planMoves` not exported.

- [ ] **Step 3: Implement `planMoves`**

Append to `queueSort.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/services/queueSort.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/queueSort.ts server/src/services/queueSort.test.ts
git commit -m "feat(server): planMoves — minimal switch ops to reach desired order"
```

---

### Task 4: `normalizeConfig` (pure)

**Files:**
- Modify: `server/src/services/queueSort.ts`
- Modify: `server/src/services/queueSort.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `queueSort.test.ts` (add `normalizeConfig` to the import):

```ts
import { normalizeConfig } from './queueSort';

describe('normalizeConfig', () => {
  it('defaults an empty/absent object to enabled + 15000ms', () => {
    expect(normalizeConfig({})).toEqual({ enabled: true, pollIntervalMs: 15000 });
    expect(normalizeConfig(null)).toEqual({ enabled: true, pollIntervalMs: 15000 });
    expect(normalizeConfig(undefined)).toEqual({ enabled: true, pollIntervalMs: 15000 });
  });
  it('honors an explicit enabled:false', () => {
    expect(normalizeConfig({ enabled: false }).enabled).toBe(false);
  });
  it('ignores a non-boolean enabled (defaults to true)', () => {
    expect(normalizeConfig({ enabled: 'yes' }).enabled).toBe(true);
  });
  it('clamps pollIntervalMs to the 5000ms floor and floors fractional values', () => {
    expect(normalizeConfig({ pollIntervalMs: 1000 }).pollIntervalMs).toBe(5000);
    expect(normalizeConfig({ pollIntervalMs: 20500.9 }).pollIntervalMs).toBe(20500);
  });
  it('falls back to default interval for a non-numeric value', () => {
    expect(normalizeConfig({ pollIntervalMs: 'fast' }).pollIntervalMs).toBe(15000);
  });
  it('drops unknown keys and round-trips a realistic config', () => {
    expect(normalizeConfig({ enabled: false, pollIntervalMs: 30000, foo: 1 }))
      .toEqual({ enabled: false, pollIntervalMs: 30000 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/services/queueSort.test.ts`
Expected: FAIL — `normalizeConfig` not exported.

- [ ] **Step 3: Implement `normalizeConfig`**

Append to `queueSort.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/services/queueSort.test.ts`
Expected: PASS (all four functions covered).

- [ ] **Step 5: Full suite + build**

Run: `cd server && npm test && npm run build`
Expected: all suites pass (existing 60 + the new queueSort tests); `tsc` exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/queueSort.ts server/src/services/queueSort.test.ts
git commit -m "feat(server): normalizeConfig — sanitize+clamp queue-sort config"
```

---

## Chunk 2: Server persistence, loop, route, wiring

Adds the thin I/O (config file persistence, the SAB fetch/switch helpers, the `setInterval` loop) and exposes + starts it. No new unit tests — the pure logic is already covered; the build is the typecheck gate and behavior is confirmed by the Chunk 4 live check.

### Task 5: Persisted config + background loop in `queueSort.ts`

**Files:**
- Modify: `server/src/services/queueSort.ts`

- [ ] **Step 1: Add imports at the TOP of `queueSort.ts`**

Add above the existing exports:

```ts
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { createServiceLogger } from './logger';

const log = createServiceLogger('queue-sort');
```

- [ ] **Step 2: Add persistence + accessors** (append to `queueSort.ts`, after `normalizeConfig`)

```ts
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
```

- [ ] **Step 3: Add the SAB helpers + loop** (append to `queueSort.ts`)

```ts
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
```

(Note: `updateQueueSortConfig` restarts the loop when the interval changes; `startQueueSorter` re-reads the file, which is the just-saved value — consistent. `tick` reorders even when SAB is paused, which is intended.)

- [ ] **Step 4: Build to typecheck**

Run: `cd server && npm run build`
Expected: `tsc` exit 0 (strict). `queueSortConfig` is referenced before its `let` only inside functions (hoisted, fine); confirm no "used before assigned" errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/queueSort.ts
git commit -m "feat(server): persisted queue-sort config + background reorder loop"
```

---

### Task 6: Route — `GET`/`PUT /system/queue-sort`

**Files:**
- Modify: `server/src/routes/system.ts`

- [ ] **Step 1: Add the import**

In `server/src/routes/system.ts`, add after the `vpnMonitor` import block (around line 9):

```ts
import { getQueueSortConfig, updateQueueSortConfig } from '../services/queueSort';
```

- [ ] **Step 2: Add the endpoints** (after the kill-switch `PUT`, around line 118)

```ts
// Queue episode-order sort config (persisted). PUT body is sanitized inside
// updateQueueSortConfig (normalizeConfig), so req.body can pass through directly.
systemRouter.get('/queue-sort', (_req: Request, res: Response) => {
  res.json(getQueueSortConfig());
});

systemRouter.put('/queue-sort', (req: Request, res: Response) => {
  res.json(updateQueueSortConfig(req.body));
});
```

- [ ] **Step 3: Build**

Run: `cd server && npm run build`
Expected: `tsc` exit 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/system.ts
git commit -m "feat(server): GET/PUT /system/queue-sort config endpoints"
```

---

### Task 7: Wire the loop into startup + gitignore the data dir

**Files:**
- Modify: `server/src/index.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Import + start the sorter**

In `server/src/index.ts`, add to the imports (near line 14):

```ts
import { startQueueSorter } from './services/queueSort';
```

Then inside the `app.listen(...)` callback, after `startHealthMonitor();` (line 70):

```ts
  startQueueSorter();
```

- [ ] **Step 2: Gitignore the runtime data dir**

Append to the root `.gitignore` (it already ignores `server/logs/`):

```
server/data/
```

- [ ] **Step 3: Build**

Run: `cd server && npm run build`
Expected: `tsc` exit 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts .gitignore
git commit -m "feat(server): start queue sorter on boot; gitignore server/data"
```

---

## Chunk 3: Client — episode-order toggle

### Task 8: "Keep in episode order" toggle on the Downloads page

**Files:**
- Modify: `client/src/pages/DownloadsPage.tsx`
- Modify: `client/src/index.css`

No client test harness — `npm run build` (tsc + vite) is the gate; live render is Task 9.

- [ ] **Step 1: Make `SortableQueueItem` accept a `disabled` prop**

In `DownloadsPage.tsx`, update the component signature and the `useSortable` call (around lines 83-97) so drag can be turned off when auto-sort is on:

```tsx
function SortableQueueItem({
  slot,
  onDelete,
  disabled,
}: {
  slot: QueueSlot;
  onDelete: (id: string) => void;
  disabled: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slot.nzo_id, disabled });
```

Then, in the returned JSX, only render the drag handle when not disabled. Replace the existing drag-handle `<button>` (around lines 109-116) with:

```tsx
          {!disabled && (
            <button
              className="btn-icon-sm drag-handle"
              {...attributes}
              {...listeners}
              title="Drag to reorder"
            >
              <GripVertical size={14} />
            </button>
          )}
```

- [ ] **Step 2: Add toggle state + fetch/update in `DownloadsPage`**

Add state alongside the others (after line 151, `const [tab, setTab] = ...`):

```tsx
  const [sortEnabled, setSortEnabled] = useState(true);
```

Add a fetch callback near `fetchHistory` (after line 175):

```tsx
  const fetchSortConfig = useCallback(async () => {
    try {
      const res = await api.get('/system/queue-sort');
      setSortEnabled(res.data?.enabled !== false);
    } catch {
      /* keep default ON */
    }
  }, []);

  const toggleSort = async () => {
    const next = !sortEnabled;
    setSortEnabled(next); // optimistic
    try {
      await api.put('/system/queue-sort', { enabled: next });
    } catch {
      setSortEnabled(!next); // revert on failure
    }
  };
```

Call `fetchSortConfig()` in the mount effect (update the effect at lines 177-182):

```tsx
  useEffect(() => {
    fetchQueue();
    fetchHistory();
    fetchSortConfig();
    const interval = setInterval(fetchQueue, 5000);
    return () => clearInterval(interval);
  }, [fetchQueue, fetchHistory, fetchSortConfig]);
```

- [ ] **Step 3: Render the toggle + pass `disabled` to items**

In the queue-tab branch (the `tab === 'queue' ?` block, around lines 288-312), add the toggle above the list and pass `disabled={sortEnabled}` to each item. Replace the block body with:

```tsx
        <div className="download-list">
          <label className="sort-toggle">
            <input type="checkbox" checked={sortEnabled} onChange={toggleSort} />
            Keep in episode order
          </label>
          {!queue?.slots?.length ? (
            <p className="placeholder">Download queue is empty</p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={queue.slots.map((s) => s.nzo_id)}
                strategy={verticalListSortingStrategy}
              >
                {queue.slots.map((slot) => (
                  <SortableQueueItem
                    key={slot.nzo_id}
                    slot={slot}
                    onDelete={deleteItem}
                    disabled={sortEnabled}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
```

- [ ] **Step 4: Add the CSS rule**

Append to `client/src/index.css`:

```css
.sort-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85em;
  color: var(--color-text-muted, #9aa);
  margin-bottom: 10px;
  cursor: pointer;
}
.sort-toggle input {
  cursor: pointer;
}
```

(If `--color-text-muted` isn't defined in this codebase, the fallback `#9aa` applies — verify against the existing `:root` variables and use whatever muted token the file already defines.)

- [ ] **Step 5: Build**

Run: `cd client && npm run build`
Expected: `tsc -b && vite build` — no type errors (strict + noUnusedLocals + verbatimModuleSyntax); `client/dist` produced.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/DownloadsPage.tsx client/src/index.css
git commit -m "feat(client): keep-in-episode-order toggle; disable drag when on"
```

---

## Chunk 4: Verification and rollout

### Task 9: Full verify, merge, USER-RUN live check

- [ ] **Step 1: Full local verification**

Run:
```bash
cd /c/Projects/NGConnect
(cd server && npm test && npm run build) && (cd client && npm run build)
git grep -nE "apikey=[A-Za-z0-9]{8,}" -- server/ client/ | grep -v "apikey=REDACTED" && echo "LEAK" || echo "no embedded keys - good"
```
Expected: server tests pass (60 existing + queueSort suite), both builds exit 0, "no embedded keys - good".

- [ ] **Step 2: Confirm no divergence, then merge and push**

`origin/main` moved under a feature branch earlier this project — check before merging:
```bash
git fetch origin
git log --oneline HEAD..origin/main   # expect EMPTY (no parallel commits)
git checkout main
git merge --ff-only origin/main
git merge --no-ff feature/queue-episode-sort -m "feat: keep SAB queue in episode order (server-side, toggleable, persisted)"
(cd server && npm test) && git push origin main
```
Expected: `HEAD..origin/main` empty; tests pass on the merged result; push succeeds. Server PC auto-deploys within the hour (or via "Check for Updates Now").

- [ ] **Step 3: USER-RUN — live check on the server PC** (SAB is localhost-only)

With the toggle **ON** (default): get a show's episodes into the SAB queue out of order (grab several single episodes, or drag them out of order), and confirm within ~15s SAB reorders them into `S01E01 → S01E02 → …` and downloads in that order. Confirm a **movie keeps its position** in the queue. Toggle **OFF** and confirm a manual drag now persists (isn't undone). Restart the service (or wait for an auto-deploy) and confirm the OFF choice **survived** (config persisted). Watch the server log (`server/logs/ngconnect-YYYY-MM-DD.log`) for the queue **never settling** — continuous "Reordered queue" lines every tick — which would indicate SAB's post-switch order disagrees with ours (e.g. priority tiers); if seen, we'll exclude non-default-priority items.

---

## Done criteria

- [ ] `parseEpisode`, `episodeSortOrder`, `planMoves`, `normalizeConfig` implemented and unit-tested; full server suite + `tsc` green.
- [ ] Background loop keeps the SAB queue in per-show episode order server-side; zero SAB calls when already sorted; non-episodes hold position.
- [ ] Toggle persists to `server/data/queue-sort.json` and survives restart; `GET`/`PUT /system/queue-sort` work.
- [ ] Downloads page shows the "Keep in episode order" toggle; drag disabled while on; client build clean.
- [ ] No committed API keys; `server/data/` gitignored.
- [ ] Live check on the server PC: episodes download in order, movie holds position, OFF survives restart, no oscillation.
