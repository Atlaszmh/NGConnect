import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  clearNotifications,
} from '../services/notifications';

export const notificationsRouter = Router();

notificationsRouter.get('/', (req: Request, res: Response) => {
  const unreadOnly = req.query.unread === 'true';
  res.json({
    notifications: getNotifications(unreadOnly),
    unreadCount: getUnreadCount(),
  });
});

notificationsRouter.get('/count', (_req: Request, res: Response) => {
  res.json({ unreadCount: getUnreadCount() });
});

notificationsRouter.post('/:id/read', (req: Request, res: Response) => {
  const id = req.params.id as string;
  markAsRead(id);
  res.json({ ok: true });
});

notificationsRouter.post('/read-all', (_req: Request, res: Response) => {
  markAllAsRead();
  res.json({ ok: true });
});

notificationsRouter.delete('/', (_req: Request, res: Response) => {
  clearNotifications();
  res.json({ ok: true });
});
