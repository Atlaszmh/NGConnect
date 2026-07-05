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
