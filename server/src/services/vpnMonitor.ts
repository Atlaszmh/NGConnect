import { createServiceLogger } from './logger';
import { config } from '../config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

const log = createServiceLogger('vpn-monitor');

export interface VpnState {
  connected: boolean;
  ip: string;
  country?: string;
  lastCheck: string;
  lastChange?: string;
  downloadsPaused: boolean;
}

interface KillSwitchConfig {
  enabled: boolean;
  autoResume: boolean;
  pollIntervalMs: number;
  gracePeriodMs: number;
}

let currentState: VpnState = {
  connected: false,
  ip: 'Unknown',
  lastCheck: new Date().toISOString(),
  downloadsPaused: false,
};

let killSwitchConfig: KillSwitchConfig = {
  enabled: true,
  autoResume: true,
  pollIntervalMs: 15000,
  gracePeriodMs: 5000,
};

let pollInterval: ReturnType<typeof setInterval> | null = null;
let disconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let consecutiveConnectedPolls = 0;
const REQUIRED_CONNECTED_POLLS = 3; // Must see "Connected" 3 times in a row (~45s) before resuming
const listeners: Array<(state: VpnState, event: string) => void> = [];

// ProtonVPN log file path on Windows
// When running as LocalSystem service, os.homedir() returns the system profile
// dir, not the actual user's home. Use PROTON_LOG_PATH or USERPROFILE env var
// as fallback to find the real user's ProtonVPN logs.
const protonLogPath = process.env.PROTON_LOG_PATH || path.join(
  process.env.REAL_USER_HOME || os.homedir(),
  'AppData',
  'Local',
  'Proton',
  'Proton VPN',
  'Logs',
  'client-logs.txt'
);

export function getVpnState(): VpnState {
  return { ...currentState };
}

export function getKillSwitchConfig(): KillSwitchConfig {
  return { ...killSwitchConfig };
}

export function updateKillSwitchConfig(update: Partial<KillSwitchConfig>) {
  killSwitchConfig = { ...killSwitchConfig, ...update };
  log.info('Kill switch config updated', killSwitchConfig);

  // Restart polling with new interval
  if (pollInterval) {
    stopVpnMonitor();
    startVpnMonitor();
  }
}

export function onVpnEvent(listener: (state: VpnState, event: string) => void) {
  listeners.push(listener);
}

function emit(event: string) {
  listeners.forEach((fn) => fn(currentState, event));
}

/**
 * Check if ProtonVPN TUN adapter is up via PowerShell/Get-NetAdapter.
 * This is the most reliable detection method — doesn't depend on log files.
 */
async function checkNetAdapter(): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      'Get-NetAdapter -Name "ProtonVPN*" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status',
    ], { timeout: 5000 });
    const status = stdout.trim();
    if (!status) return null; // adapter not found
    return status === 'Up';
  } catch {
    return null; // PowerShell failed or timed out
  }
}

/**
 * Parse VPN connection status from log content.
 * Exported for testing.
 */
export function parseVpnStatus(content: string): boolean | null {
  const matches = content.match(
    /Status updated to (Connected|Disconnected|Connecting)\./g
  );
  if (!matches || matches.length === 0) return null;
  const lastMatch = matches[matches.length - 1];
  return lastMatch === 'Status updated to Connected.';
}

/**
 * Read the tail of a file (up to maxBytes from the end).
 */
function readTail(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath);
  const readSize = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
  fs.closeSync(fd);
  return buffer.toString('utf-8');
}

/**
 * Check ProtonVPN connection status by reading its log file.
 * Handles log rotation: if the current file has no status lines,
 * falls back to client-logs.1.txt (the rotated previous log).
 * Returns null only if no log files exist at all.
 */
function checkProtonLog(): boolean | null {
  try {
    if (!fs.existsSync(protonLogPath)) {
      return null;
    }

    const MAX_READ = 524288; // 512KB
    const content = readTail(protonLogPath, MAX_READ);
    let result = parseVpnStatus(content);

    // If no status lines found, check the rotated log file (.1.txt)
    // ProtonVPN rotates logs and the "Connected" line may only exist
    // in the previous file after rotation
    if (result === null) {
      const rotatedPath = protonLogPath.replace(/\.txt$/, '.1.txt');
      if (fs.existsSync(rotatedPath)) {
        log.debug('No status lines in current log, checking rotated log');
        const rotatedContent = readTail(rotatedPath, MAX_READ);
        result = parseVpnStatus(rotatedContent);
      }
    }

    if (result === null) {
      log.warn('ProtonVPN log exists but no status lines found — assuming disconnected');
      return false;
    }

    if (!result) {
      const lastStatus = content.match(/Status updated to (\w+)\./g)?.pop();
      const state = lastStatus?.match(/Status updated to (\w+)\./)?.[1] || 'unknown';
      log.debug(`ProtonVPN log last status: ${state} — treating as disconnected`);
    }
    return result;
  } catch {
    log.warn('Failed to read ProtonVPN log — assuming disconnected');
    return false;
  }
}

async function checkVpnStatus(): Promise<boolean> {
  // Primary: check Windows network adapter (most reliable)
  // Falls back to ProtonVPN log parsing if adapter check unavailable
  let adapterStatus = await checkNetAdapter();
  const protonStatus = adapterStatus !== null ? adapterStatus : checkProtonLog();

  if (adapterStatus !== null) {
    log.debug(`VPN adapter status: ${adapterStatus ? 'Up' : 'Down'}`);
  }

  // Fetch public IP for display purposes
  let ip = currentState.ip;
  let country = currentState.country;
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as { ip: string };
    ip = data.ip;

    // Geo lookup
    try {
      const geoRes = await fetch(`https://ipapi.co/${ip}/json/`, {
        signal: AbortSignal.timeout(5000),
      });
      const geoData = (await geoRes.json()) as Record<string, string>;
      country = geoData.country_name;
    } catch {
      // Geo is optional
    }
  } catch {
    // IP lookup failed — keep previous IP
  }

  const isConnected = protonStatus === true;

  const previousIp = currentState.ip;
  const wasConnected = currentState.connected;

  currentState = {
    connected: isConnected,
    ip,
    country,
    lastCheck: new Date().toISOString(),
    lastChange:
      wasConnected !== isConnected || previousIp !== ip
        ? new Date().toISOString()
        : currentState.lastChange,
    downloadsPaused: currentState.downloadsPaused,
  };

  return isConnected;
}

async function pauseSabnzbd() {
  try {
    const url = new URL(`${config.sabnzbd.url}/api`);
    url.searchParams.set('apikey', config.sabnzbd.apiKey);
    url.searchParams.set('mode', 'pause');
    url.searchParams.set('output', 'json');
    await fetch(url.toString());
    currentState.downloadsPaused = true;
    log.warn('SABnzbd PAUSED due to VPN disconnect');
    emit('downloads_paused');
  } catch (err) {
    log.error('Failed to pause SABnzbd', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function resumeSabnzbd() {
  try {
    const url = new URL(`${config.sabnzbd.url}/api`);
    url.searchParams.set('apikey', config.sabnzbd.apiKey);
    url.searchParams.set('mode', 'resume');
    url.searchParams.set('output', 'json');
    await fetch(url.toString());
    currentState.downloadsPaused = false;
    log.info('SABnzbd RESUMED after VPN reconnect');
    emit('downloads_resumed');
  } catch (err) {
    log.error('Failed to resume SABnzbd', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function poll() {
  const wasConnected = currentState.connected;
  const isConnected = await checkVpnStatus();

  if (!isConnected) {
    // Reset consecutive connected counter on ANY non-connected poll
    consecutiveConnectedPolls = 0;

    if (killSwitchConfig.enabled && !currentState.downloadsPaused) {
      // VPN is not connected and downloads are running — pause immediately
      log.warn('VPN not connected — pausing downloads', { ip: currentState.ip, wasConnected });
      emit('vpn_disconnected');
      await pauseSabnzbd();
    }
  } else {
    // VPN reports connected — but don't trust it immediately
    consecutiveConnectedPolls++;
    log.info(`VPN connected poll ${consecutiveConnectedPolls}/${REQUIRED_CONNECTED_POLLS}`, { ip: currentState.ip });

    if (consecutiveConnectedPolls >= REQUIRED_CONNECTED_POLLS) {
      // Confirmed stable connection
      if (!wasConnected || (currentState.downloadsPaused && killSwitchConfig.enabled)) {
        log.info('VPN connection confirmed stable — resuming downloads', { ip: currentState.ip });
        emit('vpn_connected');

        if (disconnectTimeout) {
          clearTimeout(disconnectTimeout);
          disconnectTimeout = null;
        }

        if (killSwitchConfig.autoResume && currentState.downloadsPaused) {
          await resumeSabnzbd();
        }
      }
    } else {
      // Not yet confirmed — keep downloads paused, don't mark as connected
      log.info(`VPN connected but waiting for confirmation (${consecutiveConnectedPolls}/${REQUIRED_CONNECTED_POLLS})`);
      // Override: keep state as disconnected until confirmed
      currentState.connected = false;
    }
  }
}

export function startVpnMonitor() {
  if (pollInterval) return;

  // Log whether we found the ProtonVPN log file
  const logExists = fs.existsSync(protonLogPath);
  log.info('VPN monitor started', {
    interval: killSwitchConfig.pollIntervalMs,
    killSwitch: killSwitchConfig.enabled,
    protonLogDetected: logExists,
    protonLogPath: logExists ? protonLogPath : undefined,
  });

  // Initial check
  poll();
  pollInterval = setInterval(poll, killSwitchConfig.pollIntervalMs);
}

export function stopVpnMonitor() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (disconnectTimeout) {
    clearTimeout(disconnectTimeout);
    disconnectTimeout = null;
  }
  log.info('VPN monitor stopped');
}
