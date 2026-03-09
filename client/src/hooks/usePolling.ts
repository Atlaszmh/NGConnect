import { useEffect, useRef, useState } from 'react';
import api from '../services/api';

export function usePolling<T>(
  url: string,
  intervalMs: number = 10000,
  initialData?: T
) {
  const [data, setData] = useState<T | undefined>(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        const res = await api.get(url);
        if (!cancelled) {
          setData(res.data);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Request failed');
          setLoading(false);
        }
      }
    };

    fetchData();
    intervalRef.current = setInterval(fetchData, intervalMs);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [url, intervalMs]);

  const refetch = async () => {
    try {
      const res = await api.get(url);
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  };

  return { data, loading, error, refetch };
}
