import { config } from '../config';
import { createServiceLogger } from './logger';
import type { ArrBase } from './arrAdd';

const log = createServiceLogger('cancel-download');

export interface ArrQueueRecord {
  id: number;
  downloadId?: string;
}

export type ArrTarget = 'sonarr' | 'radarr';

// Which arr + queue-item id owns this SAB nzo_id. Sonarr is checked before Radarr
// (a given nzo_id belongs to at most one). Exact-string match on downloadId.
export function findQueueMatch(
  sonarr: ArrQueueRecord[],
  radarr: ArrQueueRecord[],
  nzoId: string,
): { arr: ArrTarget; id: number } | null {
  const inSonarr = sonarr.find((r) => r.downloadId === nzoId);
  if (inSonarr) return { arr: 'sonarr', id: inSonarr.id };
  const inRadarr = radarr.find((r) => r.downloadId === nzoId);
  if (inRadarr) return { arr: 'radarr', id: inRadarr.id };
  return null;
}

async function arrQueueRecords(base: ArrBase): Promise<ArrQueueRecord[]> {
  try {
    const res = await fetch(`${base.url}/api/v3/queue?page=1&pageSize=200`, {
      headers: { 'X-Api-Key': base.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { records?: ArrQueueRecord[] };
    return data.records ?? [];
  } catch {
    return []; // down or hung arr must not block cancel
  }
}

async function arrDeleteQueueItem(base: ArrBase, id: number): Promise<void> {
  const url = `${base.url}/api/v3/queue/${id}?removeFromClient=true&blocklist=true&skipRedownload=true`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'X-Api-Key': base.apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`arr queue delete failed: HTTP ${res.status}`);
}

async function sabDelete(nzoId: string): Promise<void> {
  const url = new URL(`${config.sabnzbd.url}/api`);
  url.searchParams.set('apikey', config.sabnzbd.apiKey);
  url.searchParams.set('mode', 'queue');
  url.searchParams.set('name', 'delete');
  url.searchParams.set('value', nzoId);
  url.searchParams.set('output', 'json');
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`SAB delete failed: HTTP ${res.status}`);
}

// Cancel a download: if the nzo_id is in an arr queue, delete it there with
// removeFromClient+blocklist+skipRedownload (removes from SAB AND marks the grab
// failed so a different release can be grabbed); otherwise fall back to a plain
// SAB delete. An arr-delete failure also falls back to SAB so cancel is never a
// silent no-op.
export async function cancelDownload(
  nzoId: string,
): Promise<{ via: ArrTarget | 'sab'; blocklisted: boolean }> {
  const [sonarrQueue, radarrQueue] = await Promise.all([
    arrQueueRecords(config.sonarr),
    arrQueueRecords(config.radarr),
  ]);
  const match = findQueueMatch(sonarrQueue, radarrQueue, nzoId);
  if (match) {
    const base = match.arr === 'sonarr' ? config.sonarr : config.radarr;
    try {
      await arrDeleteQueueItem(base, match.id);
      return { via: match.arr, blocklisted: true };
    } catch (err) {
      log.warn('arr queue delete failed; falling back to SAB delete', {
        arr: match.arr,
        id: match.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await sabDelete(nzoId); // no arr match, or arr delete failed
  return { via: 'sab', blocklisted: false };
}
