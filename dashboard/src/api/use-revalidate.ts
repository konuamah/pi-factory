import { useEffect, useRef, useState } from 'preact/hooks';
import { subscribeEvents } from './client';

/**
 * Fetches immediately, then re-fetches when an SSE event for the relevant scope arrives.
 * refreshKey: stable per scope (e.g. 'status', runId, or a tab id).
 */
export function useRevalidate<T>(
  refreshKey: string,
  fetcher: () => Promise<T>,
  {
    initial = undefined as T | undefined,
    onEvent = () => true,
  }: {
    initial?: T;
    onEvent?: (type: string, data: Record<string, unknown>) => boolean;
  } = {},
): { data: T | undefined; error: boolean; reload: () => void } {
  const [data, setData] = useState<T | undefined>(initial);
  const [error, setError] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(refreshKey);
  keyRef.current = refreshKey;

  const load = () => {
    fetcherRef.current()
      .then((value) => {
        setData(value);
        setError(false);
      })
      .catch(() => setError(true));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    const unsub = subscribeEvents((type, data) => {
      if (onEvent(type, data)) {
        load();
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  return { data, error, reload: load };
}

/** True when an SSE event touches a specific run. */
export function runEvent(type: string, data: Record<string, unknown>, runId: string): boolean {
  if (data.runId === runId) {
    return true;
  }
  // run.completed / run.started on the status list
  return /^run\./.test(type);
}