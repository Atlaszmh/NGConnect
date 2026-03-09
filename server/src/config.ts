import path from 'path';
import fs from 'fs';

// When running as a Windows service, --env-file doesn't work because
// node-windows' wrapper.js uses child_process.fork() which doesn't
// pass Node CLI flags to the child process. Load .env manually as fallback.
if (!process.env.SONARR_API_KEY) {
  const envPath = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

interface ServiceConfig {
  url: string;
  apiKey: string;
}

interface AuthConfig {
  username: string;
  passwordHash: string;
}

interface Config {
  port: number;
  host: string;
  corsOrigin: string;
  sonarr: ServiceConfig;
  radarr: ServiceConfig;
  sabnzbd: ServiceConfig;
  nzbgeek: { apiKey: string; baseUrl: string };
  auth?: AuthConfig;
}

const defaultConfig: Config = {
  port: 3001,
  host: '0.0.0.0',
  corsOrigin: '*',
  sonarr: {
    url: process.env.SONARR_URL || 'http://localhost:8989',
    apiKey: process.env.SONARR_API_KEY || '',
  },
  radarr: {
    url: process.env.RADARR_URL || 'http://localhost:7878',
    apiKey: process.env.RADARR_API_KEY || '',
  },
  sabnzbd: {
    url: process.env.SABNZBD_URL || 'http://localhost:8080',
    apiKey: process.env.SABNZBD_API_KEY || '',
  },
  nzbgeek: {
    apiKey: process.env.NZBGEEK_API_KEY || '',
    baseUrl: process.env.NZBGEEK_URL || 'https://api.nzbgeek.info',
  },
  auth: process.env.AUTH_USERNAME
    ? {
        username: process.env.AUTH_USERNAME,
        passwordHash: process.env.AUTH_PASSWORD_HASH || '',
      }
    : undefined,
};

// Load config from file if it exists
const configPath = path.join(__dirname, '../../config.json');
let fileConfig: Partial<Config> = {};
if (fs.existsSync(configPath)) {
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    console.warn('Failed to parse config.json, using defaults');
  }
}

export const config: Config = { ...defaultConfig, ...fileConfig };
