import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { config } from './config';
import { logger } from './services/logger';
import { requestLogger, errorHandler, notFoundHandler } from './middleware/errorHandler';
import { sonarrRouter } from './routes/sonarr';
import { radarrRouter } from './routes/radarr';
import { sabnzbdRouter } from './routes/sabnzbd';
import { systemRouter } from './routes/system';
import { nzbgeekRouter } from './routes/nzbgeek';
import { startVpnMonitor, onVpnEvent } from './services/vpnMonitor';
import { startHealthMonitor } from './services/healthMonitor';
import { addNotification } from './services/notifications';
import { notificationsRouter } from './routes/notifications';
import { authRouter, requireAuth } from './middleware/auth';

const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
  hsts: false,
}));
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());
app.use(requestLogger);

// Auth routes (public)
app.use('/api/auth', authRouter);

// Protected API routes
app.use('/api/sonarr', requireAuth, sonarrRouter);
app.use('/api/radarr', requireAuth, radarrRouter);
app.use('/api/sabnzbd', requireAuth, sabnzbdRouter);
app.use('/api/nzbgeek', requireAuth, nzbgeekRouter);
app.use('/api/system', requireAuth, systemRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);

// Serve static client build in production
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('/*path', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Error handling (must be after routes)
app.use(notFoundHandler);
app.use(errorHandler);

// Catch unhandled rejections and exceptions
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

app.listen(config.port, config.host, () => {
  logger.info(`NGConnect server running at http://${config.host}:${config.port}`);
  startVpnMonitor();
  startHealthMonitor();

  // Wire VPN events to notifications
  onVpnEvent((_state, event) => {
    if (event === 'vpn_disconnected') {
      addNotification('error', 'VPN Disconnected', 'ProtonVPN connection dropped');
    } else if (event === 'vpn_connected') {
      addNotification('success', 'VPN Connected', 'ProtonVPN connection restored');
    } else if (event === 'downloads_paused') {
      addNotification('warning', 'Downloads Paused', 'SABnzbd paused due to VPN disconnect');
    } else if (event === 'downloads_resumed') {
      addNotification('success', 'Downloads Resumed', 'SABnzbd resumed after VPN reconnect');
    }
  });
});
