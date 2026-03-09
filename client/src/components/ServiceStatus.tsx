interface ServiceStatusProps {
  name: string;
  status: 'online' | 'offline' | 'error' | 'checking';
  url?: string;
}

export default function ServiceStatus({ name, status }: ServiceStatusProps) {
  const statusColors: Record<string, string> = {
    online: 'var(--color-success)',
    offline: 'var(--color-danger)',
    error: 'var(--color-warning)',
    checking: 'var(--color-muted)',
  };

  return (
    <div className="service-status">
      <span
        className="status-dot"
        style={{ backgroundColor: statusColors[status] || statusColors.checking }}
      />
      <span className="service-name">{name}</span>
      <span className="service-state">{status}</span>
    </div>
  );
}
