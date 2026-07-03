export interface ArrBase {
  url: string;
  apiKey: string;
}

type Dict = Record<string, unknown>;

export function buildMovieAddPayload(
  lookupMovie: Dict,
  qualityProfileId: number,
  rootFolderPath: string
): Dict {
  // Spread lookup FIRST, then our enrichment so our values win.
  return {
    ...lookupMovie,
    qualityProfileId,
    rootFolderPath,
    monitored: true,
    minimumAvailability: 'released',
    addOptions: { searchForMovie: false },
  };
}

export function buildSeriesAddPayload(
  lookupSeries: Dict,
  qualityProfileId: number,
  rootFolderPath: string,
  season: number | null,
  languageProfileId?: number
): Dict {
  const seasons = Array.isArray(lookupSeries.seasons)
    ? (lookupSeries.seasons as Array<Dict>)
    : [];
  const hasMatch = season !== null && seasons.some((s) => s.seasonNumber === season);
  const mappedSeasons = seasons.map((s) => ({
    ...s,
    monitored: hasMatch ? s.seasonNumber === season : true, // no match/null -> all monitored
  }));
  const payload: Dict = {
    ...lookupSeries,
    qualityProfileId,
    rootFolderPath,
    monitored: true,
    addOptions: { searchForMissingEpisodes: false },
    seasons: mappedSeasons,
  };
  if (languageProfileId !== undefined) payload.languageProfileId = languageProfileId;
  return payload;
}

// ---- integration helpers (call the arr; exercised in the live test) ----

async function arrGet(base: ArrBase, path: string): Promise<unknown> {
  const r = await fetch(`${base.url}/api/v3${path}`, {
    headers: { 'X-Api-Key': base.apiKey },
  });
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
  return r.json();
}

async function fetchDefaults(base: ArrBase): Promise<{ qualityProfileId: number; rootFolderPath: string }> {
  const [profiles, folders] = await Promise.all([
    arrGet(base, '/qualityprofile'),
    arrGet(base, '/rootfolder'),
  ]);
  const qualityProfileId = Array.isArray(profiles) ? profiles[0]?.id : undefined;
  const rootFolderPath = Array.isArray(folders) ? folders[0]?.path : undefined;
  if (!qualityProfileId) throw new Error('No quality profile configured in the app');
  if (!rootFolderPath) throw new Error('No root folder configured in the app');
  return { qualityProfileId, rootFolderPath };
}

function looksAlreadyAdded(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 409) return false;
  const text = JSON.stringify(body ?? '').toLowerCase();
  return text.includes('already') || text.includes('exist');
}

export async function ensureMovie(base: ArrBase, imdbId: string): Promise<{ added: boolean }> {
  const lookup = await arrGet(base, `/movie/lookup?term=imdb:${encodeURIComponent(imdbId)}`);
  const movie = Array.isArray(lookup) ? (lookup[0] as Dict | undefined) : undefined;
  if (!movie) throw new Error(`No movie found for ${imdbId}`);
  const { qualityProfileId, rootFolderPath } = await fetchDefaults(base);
  const res = await fetch(`${base.url}/api/v3/movie`, {
    method: 'POST',
    headers: { 'X-Api-Key': base.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMovieAddPayload(movie, qualityProfileId, rootFolderPath)),
  });
  if (res.ok) return { added: true };
  const body = await res.json().catch(() => null);
  if (looksAlreadyAdded(res.status, body)) return { added: false };
  throw new Error(`Add movie failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
}

export async function ensureSeries(
  base: ArrBase,
  tvdbId: number,
  season: number | null
): Promise<{ added: boolean }> {
  const lookup = await arrGet(base, `/series/lookup?term=tvdb:${tvdbId}`);
  const series = Array.isArray(lookup) ? (lookup[0] as Dict | undefined) : undefined;
  if (!series) throw new Error(`No series found for tvdb ${tvdbId}`);
  const { qualityProfileId, rootFolderPath } = await fetchDefaults(base);
  // languageProfileId is required on Sonarr v3, removed on v4: include only if the endpoint exists.
  let languageProfileId: number | undefined;
  try {
    const langs = await arrGet(base, '/languageprofile');
    if (Array.isArray(langs) && langs[0]?.id) languageProfileId = langs[0].id;
  } catch {
    /* v4: /languageprofile 404s — omit the field */
  }
  const res = await fetch(`${base.url}/api/v3/series`, {
    method: 'POST',
    headers: { 'X-Api-Key': base.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSeriesAddPayload(series, qualityProfileId, rootFolderPath, season, languageProfileId)),
  });
  if (res.ok) return { added: true };
  const body = await res.json().catch(() => null);
  if (looksAlreadyAdded(res.status, body)) return { added: false };
  throw new Error(`Add series failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
}
