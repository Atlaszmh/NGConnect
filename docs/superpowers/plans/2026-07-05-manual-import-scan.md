# Manual Import Scan Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One button on the Downloads page that makes Sonarr and Radarr scan SAB's completed folder and auto-import manually-downloaded media (renamed + moved to library, so Plex picks it up).

**Architecture:** A server-side service (`importScan.ts`) reads SAB's `complete_dir` via its API, fires Sonarr `DownloadedEpisodesScan` and Radarr `DownloadedMoviesScan` commands sequentially with `importMode: 'Move'`, and exposes start + poll endpoints under `/api/system/import-scan`. The Downloads page gets a button that starts a scan and polls until both commands are terminal, then refreshes the import-history list.

**Tech Stack:** Express 5 + TypeScript (server), vitest (tests), React 19 + axios wrapper (`client/src/services/api.ts`), lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-07-04-manual-import-scan-design.md`

**Branch:** `feature/import-scan`

**Conventions that matter here:**
- Server tests only cover **pure functions**; HTTP-calling code stays thin and untested (see `cancelDownload.test.ts` — it tests `findQueueMatch` only). Follow that split: pure parse/validate/map logic is exported and tested; `fetch` orchestration is not unit-tested.
- Run server tests with `npm test` from `server/` (vitest).
- Route handlers live in `server/src/routes/system.ts` and delegate to services (see the `cancel-download` handler there for the error-shape pattern: `502 { error: message }`).
- Arr requests use `X-Api-Key` header + `AbortSignal.timeout(10000)`; SAB requests build a `URL` with `apikey` + `output=json` query params (see `cancelDownload.ts`).

---

## Chunk 1: Server — importScan service + routes

### Task 1: Pure logic in `importScan.ts` (TDD)

**Files:**
- Create: `server/src/services/importScan.ts`
- Create: `server/src/services/importScan.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/importScan.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractCompleteDir, commandStatus, isTerminal } from './importScan';

describe('extractCompleteDir', () => {
  it('returns the absolute complete_dir from a SAB get_config response', () => {
    const sab = { config: { misc: { complete_dir: 'R:\\Torrents\\complete' } } };
    expect(extractCompleteDir(sab)).toBe('R:\\Torrents\\complete');
  });

  it('throws when complete_dir is missing', () => {
    expect(() => extractCompleteDir({ config: { misc: {} } })).toThrow(/complete_dir/);
  });

  it('throws when complete_dir is empty', () => {
    const sab = { config: { misc: { complete_dir: '' } } };
    expect(() => extractCompleteDir(sab)).toThrow(/complete_dir/);
  });

  it('throws when complete_dir is relative (SAB can store paths relative to its base folder)', () => {
    const sab = { config: { misc: { complete_dir: 'Downloads\\complete' } } };
    expect(() => extractCompleteDir(sab)).toThrow(/absolute/);
  });

  it('throws on a malformed response (no config object)', () => {
    expect(() => extractCompleteDir({})).toThrow(/complete_dir/);
    expect(() => extractCompleteDir(null)).toThrow(/complete_dir/);
    expect(() => extractCompleteDir('nonsense')).toThrow(/complete_dir/);
  });
});

describe('commandStatus', () => {
  it('extracts the status string from an arr command response', () => {
    expect(commandStatus({ id: 42, status: 'started' })).toBe('started');
  });

  it('returns "unknown" when status is missing or not a string', () => {
    expect(commandStatus({ id: 42 })).toBe('unknown');
    expect(commandStatus({ status: 7 })).toBe('unknown');
    expect(commandStatus(null)).toBe('unknown');
  });
});

describe('isTerminal', () => {
  it('treats completed/failed/aborted/cancelled as terminal', () => {
    for (const s of ['completed', 'failed', 'aborted', 'cancelled']) {
      expect(isTerminal(s)).toBe(true);
    }
  });

  it('treats queued/started as non-terminal', () => {
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('started')).toBe(false);
  });

  it('treats unknown as terminal so the client never polls forever on garbage', () => {
    expect(isTerminal('unknown')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `server/`): `npx vitest run src/services/importScan.test.ts`
Expected: FAIL — `Cannot find module './importScan'` (or export errors).

- [ ] **Step 3: Write the pure functions**

Create `server/src/services/importScan.ts`:

```typescript
import path from 'path';
import { config } from '../config';

// SAB's get_config response nests settings under config.misc. complete_dir can
// be relative (to SAB's base folder) depending on how SAB was set up; the arrs
// need an absolute path, so reject relative ones rather than guessing the base.
// path.win32 explicitly: SAB runs on Windows, and this keeps the tests
// deterministic if they ever run on another platform.
export function extractCompleteDir(sabConfig: unknown): string {
  const dir = (sabConfig as { config?: { misc?: { complete_dir?: unknown } } })
    ?.config?.misc?.complete_dir;
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error('SAB config has no complete_dir');
  }
  if (!path.win32.isAbsolute(dir)) {
    throw new Error(`SAB complete_dir is not absolute: ${dir}`);
  }
  return dir;
}

export function commandStatus(commandJson: unknown): string {
  const status = (commandJson as { status?: unknown })?.status;
  return typeof status === 'string' ? status : 'unknown';
}

// Terminal = the client should stop polling. 'unknown' is terminal on purpose:
// a garbage response must not leave the client polling forever.
export function isTerminal(status: string): boolean {
  return status !== 'queued' && status !== 'started';
}
```

(The `config` import is unused until Task 2 — include it now so Step 3 of Task 2 only appends code. If the linter complains during this task, it's fine; Task 2 resolves it.)

- [ ] **Step 4: Run tests to verify they pass**

Run (from `server/`): `npx vitest run src/services/importScan.test.ts`
Expected: PASS (all 3 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/importScan.ts server/src/services/importScan.test.ts
git commit -m "feat(server): pure helpers for import scan (complete_dir extraction, command status)"
```

### Task 2: Orchestration functions in `importScan.ts`

Thin `fetch` orchestration — **no unit tests**, per codebase convention. Correctness is covered by the pure functions plus live verification (Task 5).

**Files:**
- Modify: `server/src/services/importScan.ts` (append)

- [ ] **Step 1: Append orchestration code**

Append to `server/src/services/importScan.ts`:

```typescript
import type { ArrBase } from './arrAdd'; // add to the imports at the top of the file

async function fetchSabCompleteDir(): Promise<string> {
  const url = new URL(`${config.sabnzbd.url}/api`);
  url.searchParams.set('mode', 'get_config');
  url.searchParams.set('section', 'misc');
  url.searchParams.set('apikey', config.sabnzbd.apiKey);
  url.searchParams.set('output', 'json');
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`SAB get_config failed: HTTP ${res.status}`);
  return extractCompleteDir(await res.json());
}

async function postArrCommand(
  base: ArrBase,
  arrName: string,
  commandName: string,
  completeDir: string,
): Promise<number> {
  const res = await fetch(`${base.url}/api/v3/command`, {
    method: 'POST',
    headers: { 'X-Api-Key': base.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: commandName, path: completeDir, importMode: 'Move' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${arrName} rejected ${commandName}: HTTP ${res.status}`);
  const data = (await res.json()) as { id?: unknown };
  if (typeof data.id !== 'number') throw new Error(`${arrName} returned no command id`);
  return data.id;
}

// Start a scan of SAB's completed folder in both arrs. Commands are fired
// sequentially (Sonarr first) to avoid both arrs Move-scanning the same tree
// at the same instant. If Radarr fails after Sonarr accepted, the Sonarr scan
// proceeds anyway (harmless — scans are idempotent) but we still throw so the
// user sees the error.
export async function startImportScan(): Promise<{
  sonarrCommandId: number;
  radarrCommandId: number;
}> {
  const completeDir = await fetchSabCompleteDir();
  const sonarrCommandId = await postArrCommand(
    config.sonarr, 'Sonarr', 'DownloadedEpisodesScan', completeDir,
  );
  const radarrCommandId = await postArrCommand(
    config.radarr, 'Radarr', 'DownloadedMoviesScan', completeDir,
  );
  return { sonarrCommandId, radarrCommandId };
}

async function fetchCommandStatus(base: ArrBase, id: number): Promise<string> {
  const res = await fetch(`${base.url}/api/v3/command/${id}`, {
    headers: { 'X-Api-Key': base.apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`command ${id} lookup failed: HTTP ${res.status}`);
  return commandStatus(await res.json());
}

export async function getImportScanStatus(
  sonarrId: number,
  radarrId: number,
): Promise<{ sonarr: { status: string }; radarr: { status: string } }> {
  const [sonarr, radarr] = await Promise.all([
    fetchCommandStatus(config.sonarr, sonarrId),
    fetchCommandStatus(config.radarr, radarrId),
  ]);
  return { sonarr: { status: sonarr }, radarr: { status: radarr } };
}
```

- [ ] **Step 2: Verify it compiles and existing tests still pass**

Run (from `server/`): `npx tsc --noEmit` then `npm test`
Expected: no type errors; all suites PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/importScan.ts
git commit -m "feat(server): import-scan orchestration (SAB complete_dir -> arr DownloadedScan commands)"
```

### Task 3: Routes in `system.ts`

**Files:**
- Modify: `server/src/routes/system.ts`

- [ ] **Step 1: Add the two routes**

In `server/src/routes/system.ts`, add to the imports block:

```typescript
import { startImportScan, getImportScanStatus } from '../services/importScan';
```

Then add these handlers directly after the `/cancel-download` handler (end of file):

```typescript
// Manual import scan: make Sonarr+Radarr scan SAB's completed folder and
// auto-import anything recognizable (for downloads sent to SAB manually).
systemRouter.post('/import-scan', async (_req: Request, res: Response) => {
  try {
    res.json(await startImportScan());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import scan failed';
    console.error('import-scan error:', message);
    res.status(502).json({ error: message });
  }
});

systemRouter.get('/import-scan/:sonarrId/:radarrId', async (req: Request, res: Response) => {
  const sonarrId = Number(req.params.sonarrId);
  const radarrId = Number(req.params.radarrId);
  if (!Number.isInteger(sonarrId) || !Number.isInteger(radarrId)) {
    res.status(400).json({ error: 'command ids must be integers' });
    return;
  }
  try {
    res.json(await getImportScanStatus(sonarrId, radarrId));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Status check failed';
    console.error('import-scan status error:', message);
    res.status(502).json({ error: message });
  }
});
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run (from `server/`): `npx tsc --noEmit` then `npm test`
Expected: no type errors; all suites PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/system.ts
git commit -m "feat(server): POST/GET /system/import-scan endpoints"
```

## Chunk 2: Client — scan button on Downloads page

### Task 4: Scan button + polling in `DownloadsPage.tsx`

No component test — the client has no test harness (no vitest/RTL in `client/package.json`); verification is live (Task 5).

**Files:**
- Modify: `client/src/pages/DownloadsPage.tsx`

- [ ] **Step 1: Add imports and scan state**

In `client/src/pages/DownloadsPage.tsx`:

1. Add `FolderSearch` to the lucide-react import list (line 2).
2. Inside `DownloadsPage()`, next to the existing `useState` calls, add:

```typescript
const [scanState, setScanState] = useState<
  { phase: 'idle' } | { phase: 'scanning' } | { phase: 'done'; message: string } | { phase: 'error'; message: string }
>({ phase: 'idle' });
```

3. Add the scan handler after `toggleSort`:

```typescript
// Ask Sonarr+Radarr to scan SAB's completed folder and import what they
// recognize, then poll until both commands finish (or ~2 min cap).
const runImportScan = async () => {
  setScanState({ phase: 'scanning' });
  try {
    const start = await api.post('/system/import-scan');
    const { sonarrCommandId, radarrCommandId } = start.data;
    const isTerminal = (s: string) => s !== 'queued' && s !== 'started';
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await api.get(`/system/import-scan/${sonarrCommandId}/${radarrCommandId}`);
      if (isTerminal(res.data?.sonarr?.status) && isTerminal(res.data?.radarr?.status)) {
        setScanState({ phase: 'done', message: 'Import scan complete — see History' });
        fetchHistory();
        return;
      }
    }
    // Poll cap hit: the scans keep running server-side; history catches up later.
    setScanState({
      phase: 'done',
      message: 'Scan still running in Sonarr/Radarr — history will update when it finishes',
    });
    fetchHistory();
  } catch (err) {
    const message =
      (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      'Import scan failed';
    setScanState({ phase: 'error', message });
  }
};
```

- [ ] **Step 2: Add the button and status note to the header**

In the `header-actions` div (before the refresh button), add:

```tsx
<button onClick={runImportScan} disabled={scanState.phase === 'scanning'}>
  <FolderSearch size={16} className={scanState.phase === 'scanning' ? 'spinning' : undefined} />
  {scanState.phase === 'scanning' ? 'Scanning…' : 'Scan download folder'}
</button>
```

(`spinning` is an existing utility class in `client/src/index.css` (~line 349, with `@keyframes spin`), already used by DashboardPage/SettingsPage — do not add new CSS.)

Directly under the `page-header` div (between it and the stats bar), add the status note:

```tsx
{scanState.phase === 'done' && <p className="placeholder">{scanState.message}</p>}
{scanState.phase === 'error' && (
  <p className="placeholder">
    <span className="badge badge-danger">
      <AlertCircle size={12} /> {scanState.message}
    </span>
  </p>
)}
```

(`AlertCircle`, `placeholder`, `badge badge-danger` are already used on this page — no new CSS needed.)

- [ ] **Step 3: Verify the client builds**

Run (from `client/`): `npx tsc -b && npx vite build`
Expected: build succeeds, no type errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/DownloadsPage.tsx
git commit -m "feat(client): scan-download-folder button on Downloads page"
```

## Chunk 3: Verification

### Task 5: Live verification (server PC only)

Sonarr/Radarr/SAB are localhost-only on the server PC (dev machine has no live services). If executing on the dev machine, stop after Step 1 and report that live verification is pending on the server PC.

**Files:** none (verification only)

- [ ] **Step 1: Full build + test sweep**

Run (from repo root): `npm run build` and (from `server/`) `npm test`
Expected: build succeeds, all tests PASS.

- [ ] **Step 2 (server PC): API smoke test**

The server PC self-updates from origin/main hourly — before smoke-testing, either wait for auto-deploy of the merged change or trigger it (`POST /api/system/update/check`) / restart the NGConnect service, so you're not testing stale code.

```powershell
Invoke-RestMethod -Method Post http://localhost:3001/api/system/import-scan
```

Expected: `{ sonarrCommandId: <n>, radarrCommandId: <n> }`. Then:

```powershell
Invoke-RestMethod http://localhost:3001/api/system/import-scan/<sonarrId>/<radarrId>
```

Expected: `{ sonarr: { status: ... }, radarr: { status: ... } }` reaching `completed`.

- [ ] **Step 3 (server PC): End-to-end check**

Send an NZB to SAB manually (no category), wait for completion, click "Scan download folder" on the Downloads page. Expected: file is renamed/moved into the TV/Movie root folder, appears in the page's History list as Imported, and shows up in Plex after the arr's Plex Connect refresh.
