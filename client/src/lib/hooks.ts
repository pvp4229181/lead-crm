import { useEffect, useRef, useState } from 'react';
import { getSocket } from './socket';

/**
 * Delays propagating `value` until the user stops changing it. Search boxes drive
 * react-query keys directly, so without this every keystroke fired its own request.
 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * Whether the realtime socket is currently delivering events.
 *
 * Socket.IO only runs under traditional hosting (see server/src/realtime.ts); on Vercel's
 * serverless functions it never connects. Screens use this to poll aggressively only when
 * they have no live feed, instead of doing both at once.
 */
export function useRealtimeConnected(): boolean {
  const [connected, setConnected] = useState(() => getSocket().connected);
  useEffect(() => {
    const socket = getSocket();
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    socket.on('connect', on);
    socket.on('disconnect', off);
    socket.io.on('reconnect', on);
    setConnected(socket.connected);
    return () => { socket.off('connect', on); socket.off('disconnect', off); socket.io.off('reconnect', on); };
  }, []);
  return connected;
}

/**
 * Poll interval for a live view: a slow safety net while the socket is pushing updates,
 * and the fast fallback interval when it is not.
 */
export function useLiveInterval(fallbackMs: number, backgroundMs = 60000): number | false {
  return useRealtimeConnected() ? backgroundMs : fallbackMs;
}

/** Subscribes to socket events for the lifetime of the component. */
export function useSocketEvents(handlers: Record<string, (payload: any) => void>) {
  const latest = useRef(handlers);
  latest.current = handlers;
  const names = Object.keys(handlers).sort().join(',');
  useEffect(() => {
    const socket = getSocket();
    const bound = names.split(',').filter(Boolean).map(name => {
      const handler = (payload: any) => latest.current[name]?.(payload);
      socket.on(name, handler);
      return [name, handler] as const;
    });
    return () => { for (const [name, handler] of bound) socket.off(name, handler); };
  }, [names]);
}

/** Runs `handler` when the user presses a key combination anywhere on the page. */
export function useHotkey(match: (event: KeyboardEvent) => boolean, handler: () => void) {
  const latest = useRef({ match, handler });
  latest.current = { match, handler };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (latest.current.match(event)) { event.preventDefault(); latest.current.handler(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Tracks a CSS media query, so layout-dependent behaviour matches what is on screen. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
