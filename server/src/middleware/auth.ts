import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { createServiceLogger } from '../services/logger';

const log = createServiceLogger('auth');

const JWT_SECRET = process.env.JWT_SECRET || 'ngconnect-default-secret-change-me';
const TOKEN_EXPIRY = '24h';

export const authRouter = Router();

// Login endpoint
authRouter.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!config.auth?.username || !config.auth?.passwordHash) {
    // Auth not configured — allow access
    log.warn('Auth not configured, granting access');
    const token = jwt.sign({ user: 'admin' }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    res.json({ token, message: 'Auth not configured — set credentials in config' });
    return;
  }

  if (username !== config.auth.username) {
    log.warn('Login failed: invalid username', { username });
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, config.auth.passwordHash);
  if (!valid) {
    log.warn('Login failed: invalid password', { username });
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  log.info('Login successful', { username });
  res.json({ token });
});

// Hash a password (utility endpoint for initial setup)
authRouter.post('/hash', async (req: Request, res: Response) => {
  const { password } = req.body;
  if (!password) {
    res.status(400).json({ error: 'Password required' });
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  res.json({ hash });
});

// Auth check endpoint
authRouter.get('/check', (req: Request, res: Response) => {
  const authEnabled = !!(config.auth?.username && config.auth?.passwordHash);
  res.json({ authEnabled });
});

// JWT verification middleware
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Skip auth if not configured
  if (!config.auth?.username || !config.auth?.passwordHash) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = header.substring(7);
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
