import { createServiceLogger } from './logger';

const log = createServiceLogger('notifications');

export interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
}

const MAX_NOTIFICATIONS = 100;
let notifications: Notification[] = [];
let nextId = 1;

export function addNotification(
  type: Notification['type'],
  title: string,
  message: string
) {
  const notification: Notification = {
    id: String(nextId++),
    type,
    title,
    message,
    timestamp: new Date().toISOString(),
    read: false,
  };

  notifications.unshift(notification);

  // Trim old notifications
  if (notifications.length > MAX_NOTIFICATIONS) {
    notifications = notifications.slice(0, MAX_NOTIFICATIONS);
  }

  log.info(`Notification: [${type}] ${title} - ${message}`);
  return notification;
}

export function getNotifications(unreadOnly: boolean = false): Notification[] {
  if (unreadOnly) {
    return notifications.filter((n) => !n.read);
  }
  return [...notifications];
}

export function getUnreadCount(): number {
  return notifications.filter((n) => !n.read).length;
}

export function markAsRead(id: string): boolean {
  const n = notifications.find((n) => n.id === id);
  if (n) {
    n.read = true;
    return true;
  }
  return false;
}

export function markAllAsRead(): void {
  notifications.forEach((n) => (n.read = true));
}

export function clearNotifications(): void {
  notifications = [];
}
