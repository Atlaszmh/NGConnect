import { createServiceLogger } from './logger';
import { config } from '../config';
import { addNotification } from './notifications';

const log = createServiceLogger('health');

export interface ServiceHealth {
  name: string;
  status: 'online' | 'offline' | 'error';
  lastSeen?: string;
  lastCheck: string;
  responseTimeMs?: number;
  version?: string;
}

let serviceStates: Record<string, ServiceHealth> = {};
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function getServiceHealth(): Record<string, ServiceHealth> {
  return { ...serviceStates };
}

async function checkService(
  name: string,
  checkFn: () => Promise<{ ok: boolean; version?: string }>
): Promise<ServiceHealth> {
  const start = Date.now();
  const previous = serviceStates[name];

  try {
    const result = await checkFn();
    const health: ServiceHealth = {
      name,
      status: result.ok ? 'online' : 'error',
      lastCheck: new Date().toISOString(),
      lastSeen: result.ok ? new Date().toISOString() : previous?.lastSeen,
      responseTimeMs: Date.now() - start,
      version: result.version,
    };

    // Detect state changes
    if (previous && previous.status !== 'offline' && health.status === 'offline') {
      log.warn(`${name} went offline`);
      addNotification('error', `${name} is offline`, `Could not connect to ${name}`);
    } else if (previous?.status === 'offline' && health.status === 'online') {
      log.info(`${name} is back online`);
      addNotification('success', `${name} is back online`, `Connection restored`);
    }

    return health;
  } catch {
    const health: ServiceHealth = {
      name,
      status: 'offline',
      lastCheck: new Date().toISOString(),
      lastSeen: previous?.lastSeen,
      responseTimeMs: Date.now() - start,
    };

    if (previous && previous.status !== 'offline') {
      log.warn(`${name} went offline`);
      addNotification('error', `${name} is offline`, `Could not connect to ${name}`);
    }

    return health;
  }
}

async function pollHealth() {
  const sonarr = await checkService('sonarr', async () => {
    const resp = await fetch(`${config.sonarr.url}/api/v3/system/status`, {
      headers: { 'X-Api-Key': config.sonarr.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    const data = (await resp.json()) as { version?: string };
    return { ok: resp.ok, version: data?.version };
  });

  const radarr = await checkService('radarr', async () => {
    const resp = await fetch(`${config.radarr.url}/api/v3/system/status`, {
      headers: { 'X-Api-Key': config.radarr.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    const data = (await resp.json()) as { version?: string };
    return { ok: resp.ok, version: data?.version };
  });

  const sabnzbd = await checkService('sabnzbd', async () => {
    const url = new URL(`${config.sabnzbd.url}/api`);
    url.searchParams.set('mode', 'version');
    url.searchParams.set('apikey', config.sabnzbd.apiKey);
    url.searchParams.set('output', 'json');
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    const data = (await resp.json()) as { version?: string };
    return { ok: resp.ok, version: data?.version };
  });

  serviceStates = {
    sonarr,
    radarr,
    sabnzbd,
  };
}

export function startHealthMonitor(intervalMs: number = 60000) {
  if (pollInterval) return;
  log.info('Health monitor started', { intervalMs });
  pollHealth();
  pollInterval = setInterval(pollHealth, intervalMs);
}

export function stopHealthMonitor() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
