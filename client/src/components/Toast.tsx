import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Info, X } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info';
type Toast = { id: number; kind: ToastKind; message: string };
type ToastApi = {
  toast: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (cause: unknown, fallback?: string) => void;
};

const ToastContext = createContext<ToastApi>({ toast: () => {}, success: () => {}, error: () => {} });

const TONE: Record<ToastKind, { className: string; Icon: typeof Check }> = {
  success: { className: 'border-emerald-200 bg-emerald-50 text-emerald-900', Icon: Check },
  error: { className: 'border-red-200 bg-red-50 text-red-900', Icon: AlertTriangle },
  info: { className: 'border-sky-200 bg-sky-50 text-sky-900', Icon: Info },
};

/**
 * Small transient feedback for actions whose result is otherwise invisible — a saved
 * inline edit, a failed background mutation. Errors stay up longer than confirmations
 * because they usually need reading.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts(current => current.filter(item => item.id !== id)), []);
  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++;
    setToasts(current => [...current.slice(-3), { id, kind, message }]);
    setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 3500);
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    toast,
    success: message => toast(message, 'success'),
    error: (cause, fallback = 'Something went wrong.') => toast(cause instanceof Error ? cause.message : fallback, 'error'),
  }), [toast]);

  return <ToastContext.Provider value={api}>
    {children}
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map(item => {
        const { className, Icon } = TONE[item.kind];
        return <div key={item.id} role="status" className={`animate-slide-up pointer-events-auto flex items-start gap-2 rounded-lg border p-3 text-xs shadow-lg ${className}`}>
          <Icon size={15} className="mt-px shrink-0" />
          <span className="flex-1 leading-relaxed">{item.message}</span>
          <button className="shrink-0 opacity-50 transition hover:opacity-100" aria-label="Dismiss" onClick={() => dismiss(item.id)}><X size={13} /></button>
        </div>;
      })}
    </div>
  </ToastContext.Provider>;
}

export const useToast = () => useContext(ToastContext);
