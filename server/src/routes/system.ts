import { Router } from 'express';
import type { Request, Response } from 'express';
import os from 'os';
import { config } from '../config';
import {
  getVpnState,
  getKillSwitchConfig,
  updateKillSwitchConfig,
} from '../services/vpnMonitor';
import { getServiceHealth } from '../services/healthMonitor';

export const systemRouter = Router();

// Health check endpoint
systemRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Check connectivity to all services
systemRouter.get('/status', async (_req: Request, res: Response) => {
  const services: Record<string, { status: string; url: string }> = {};

  // Check Sonarr
  try {
    const resp = await fetch(`${config.sonarr.url}/api/v3/system/status`, {
      headers: { 'X-Api-Key': config.sonarr.apiKey },
    });
    services.sonarr = {
      status: resp.ok ? 'online' : 'error',
      url: config.sonarr.url,
    };
  } catch {
    services.sonarr = { status: 'offline', url: config.sonarr.url };
  }

  // Check Radarr
  try {
    const resp = await fetch(`${config.radarr.url}/api/v3/system/status`, {
      headers: { 'X-Api-Key': config.radarr.apiKey },
    });
    services.radarr = {
      status: resp.ok ? 'online' : 'error',
      url: config.radarr.url,
    };
  } catch {
    services.radarr = { status: 'offline', url: config.radarr.url };
  }

  // Check SABnzbd
  try {
    const url = new URL(`${config.sabnzbd.url}/api`);
    url.searchParams.set('mode', 'version');
    url.searchParams.set('apikey', config.sabnzbd.apiKey);
    url.searchParams.set('output', 'json');
    const resp = await fetch(url.toString());
    services.sabnzbd = {
      status: resp.ok ? 'online' : 'error',
      url: config.sabnzbd.url,
    };
  } catch {
    services.sabnzbd = { status: 'offline', url: config.sabnzbd.url };
  }

  res.json({ services });
});

// VPN status from the monitor
systemRouter.get('/vpn', (_req: Request, res: Response) => {
  const state = getVpnState();
  res.json(state);
});

// Kill switch config
systemRouter.get('/vpn/killswitch', (_req: Request, res: Response) => {
  res.json(getKillSwitchConfig());
});

systemRouter.put('/vpn/killswitch', (req: Request, res: Response) => {
  updateKillSwitchConfig(req.body);
  res.json(getKillSwitchConfig());
});

// System info for the settings/about page
systemRouter.get('/info', (_req: Request, res: Response) => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: os.uptime(),
    cpu: cpus.length > 0 ? `${cpus[0].model} (${cpus.length} cores)` : 'Unknown',
    memory: {
      total: `${(totalMem / (1024 * 1024 * 1024)).toFixed(1)} GB`,
      free: `${(freeMem / (1024 * 1024 * 1024)).toFixed(1)} GB`,
      usedPercent: ((1 - freeMem / totalMem) * 100).toFixed(1),
    },
  });
});

// Detailed health status from the health monitor
systemRouter.get('/health/services', (_req: Request, res: Response) => {
  res.json(getServiceHealth());
});
