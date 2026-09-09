import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import type { AutomationCatalogue, AutomationLog, Paged } from '../../../lib/types';
import { Empty, Loading } from '../../../components/ui';
import { useLiveInterval } from '../../../lib/hooks';

const STATUS_TONE: Record<string, string> = {
  completed: 'bg-emerald-100 text-emerald-700', failed: 'bg-red-100 text-red-700',
  skipped: 'bg-slate-100 text-slate-500', cancelled: 'bg-slate-100 text-slate-400',
  running: 'bg-sky-100 text-sky-700', pending: 'bg-amber-100 text-amber-700',
};
const STATUSES = ['completed', 'failed', 'skipped', 'cancelled', 'running', 'pending'];
const label = (value: string) => value.replace(/_/g, ' ').replace(/^./, character => character.toUpperCase());
const time = (value?: string) => (value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—');

export default function Logs() {
  const [status, setStatus] = useState('');
  const [trigger, setTrigger] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const catalogue = useQuery({ queryKey: ['automation-catalogue'], queryFn: () => api<AutomationCatalogue>('/automation/catalogue'), staleTime: 300000 });
  const params = new URLSearchParams({ page: String(page), limit: '30' });
  if (status) params.set('status', status);
  if (trigger) params.set('trigger', trigger);
  const logs = useQuery({
    queryKey: ['automation-logs', status, trigger, page],
    queryFn: () => api<Paged<AutomationLog>>(`/automation-logs?${params}`),
    refetchInterval: useLiveInterval(20000, 60000),
  });
  const summary = useQuery({ queryKey: ['automation-log-summary'], queryFn: () => api<{ byStatus: { _id: string; count: number }[]; pendingScheduled: number }>('/automation-logs/summary') });

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <select className="field h-8 w-40" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
        <option value="">All statuses</option>
        {STATUSES.map(item => <option key={item} value={item}>{label(item)}</option>)}
      </select>
      <select className="field h-8 w-56" value={trigger} onChange={event => { setTrigger(event.target.value); setPage(1); }}>
        <option value="">All triggers</option>
        {(catalogue.data?.triggers ?? []).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select>
      <div className="ml-auto flex flex-wrap gap-1 text-[11px]">
        {(summary.data?.byStatus ?? []).map(entry => <span key={entry._id} className={`badge ${STATUS_TONE[entry._id] ?? ''}`}>{entry._id}: {entry.count}</span>)}
        {(summary.data?.pendingScheduled ?? 0) > 0 && <span className="badge bg-amber-100 text-amber-700">{summary.data!.pendingScheduled} queued</span>}
      </div>
    </div>

    {logs.isLoading ? <Loading /> : !logs.data?.data.length ? (
      <Empty title="No automation runs yet" detail="Runs appear here as soon as ARIA reacts to a WhatsApp message." />
    ) : <>
      <div className="panel divide-y">
        {logs.data.data.map(log => <div key={log._id} className="p-3 text-sm">
          <button className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setExpanded(expanded === log._id ? null : log._id)}>
            <span className={`badge ${STATUS_TONE[log.status]}`}>{log.status}</span>
            <b>{log.automation?.name ?? log.template?.templateName ?? label(log.trigger)}</b>
            <span className="text-xs text-slate-400">{label(log.trigger)}</span>
            {log.attempt > 1 && <span className="badge bg-slate-100 text-slate-500">attempt {log.attempt}</span>}
            <span className="ml-auto text-xs text-slate-400">{time(log.startedAt)}{log.durationMs != null && ` · ${log.durationMs}ms`}</span>
          </button>
          <p className="mt-0.5 text-xs text-slate-500">
            {log.lead?.contactName || log.conversation?.customerName || log.conversation?.phoneNumber || 'No linked record'}
            {log.error && <span className="text-red-600"> — {log.error}</span>}
          </p>
          {expanded === log._id && <div className="mt-2 space-y-1 rounded bg-slate-50 p-2 text-[11px]">
            {log.executedActions.length === 0 && <p className="text-slate-400">No actions were executed.</p>}
            {log.executedActions.map((action, index) => <div key={index} className="flex gap-2">
              <span className={`badge ${STATUS_TONE[action.status] ?? ''}`}>{action.status}</span>
              <b className="shrink-0">{label(action.type)}</b>
              <span className="min-w-0 flex-1 truncate text-slate-500">{action.detail}</span>
            </div>)}
            {log.template && <p className="text-slate-400">Template: {log.template.templateName} ({log.template.templateKey})</p>}
          </div>}
        </div>)}
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Page {logs.data.pagination.page} of {logs.data.pagination.pages || 1} · {logs.data.pagination.total} runs</span>
        <div className="flex gap-2">
          <button className="btn h-8" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <button className="btn h-8" disabled={page >= (logs.data.pagination.pages || 1)} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      </div>
    </>}
  </div>;
}
