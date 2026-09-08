import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarDays, Frown, Meh, Smile, Trash2 } from 'lucide-react';
import { api, date, money } from '../../lib/api';
import { useToast } from '../../components/Toast';
import type { Activity, Metadata, WAConversation, WALead } from '../../lib/types';

const TEMP_TONE: Record<string, string> = { Cold: 'bg-slate-100 text-slate-600', Warm: 'bg-amber-100 text-amber-700', Hot: 'bg-orange-100 text-orange-700', 'Very Hot': 'bg-red-100 text-red-700' };
const SENTIMENT_ICON = { positive: <Smile size={14} className="text-emerald-500" />, neutral: <Meh size={14} className="text-slate-400" />, negative: <Frown size={14} className="text-red-500" /> } as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div><div className="mt-0.5 text-xs text-slate-700">{children}</div></div>; }
function Chips({ items }: { items: string[] }) { return items.length ? <div className="flex flex-wrap gap-1">{items.map((x, i) => <span key={i} className="badge bg-slate-100 text-slate-600">{x}</span>)}</div> : <span className="text-slate-400">—</span>; }

// `embedded` renders the body alone, for the drawer the inbox opens below xl where the
// panel has no column of its own.
export function LeadPanel({ conversation, embedded }: { conversation: WAConversation; embedded?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const lead = conversation.lead;
  const meta = useQuery({ queryKey: ['metadata'], queryFn: () => api<Metadata>('/metadata') });
  const meetings = useQuery({ queryKey: ['wa-meetings', conversation._id], queryFn: () => api<Activity[]>(`/whatsapp/conversations/${conversation._id}/meetings`), enabled: Boolean(lead) });
  const [edit, setEdit] = useState<Partial<WALead>>({});
  const [meetingError, setMeetingError] = useState('');
  useEffect(() => { setEdit({}); setMeetingError(''); }, [lead?._id]);

  const saveLead = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<WALead>(`/leads/${lead!._id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { toast.success('Lead updated'); qc.invalidateQueries({ queryKey: ['wa-conversations'] }); qc.invalidateQueries({ queryKey: ['wa-conversation', conversation._id] }); },
    onError: cause => toast.error(cause, 'Could not save that change.'),
  });
  const assign = useMutation({
    mutationFn: (assignedTo: string) => api(`/whatsapp/conversations/${conversation._id}`, { method: 'PATCH', body: JSON.stringify({ assignedTo: assignedTo || null }) }),
    onSuccess: () => { toast.success('Conversation reassigned'); qc.invalidateQueries({ queryKey: ['wa-conversations'] }); },
    onError: cause => toast.error(cause, 'Could not reassign this conversation.'),
  });
  const deleteMeeting = useMutation({
    mutationFn: (meetingId: string) => api(`/whatsapp/conversations/${conversation._id}/meetings/${meetingId}`, { method: 'DELETE' }),
    onMutate: () => setMeetingError(''),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wa-meetings', conversation._id] });
      qc.invalidateQueries({ queryKey: ['activities'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (cause: any) => setMeetingError(cause?.message ?? 'Could not delete the scheduled meeting.'),
  });

  const shell = embedded ? 'h-full w-full overflow-y-auto bg-white p-4' : 'h-full min-h-0 w-full overflow-y-auto border-l bg-white p-4';
  if (!lead) return <div className={`${shell} text-xs text-slate-400`}>No lead linked to this conversation yet.</div>;

  const commit = (field: keyof WALead) => { const value = edit[field]; if (value === undefined) return; saveLead.mutate({ [field]: value }); };

  return <div className={`scrollbar-thin ${shell}`}>
    <div className="mb-3 flex items-center justify-between">
      {!embedded && <h3 className="text-sm font-semibold">Lead details</h3>}
      <span className={`badge ml-auto ${TEMP_TONE[lead.leadTemperature]}`}>{lead.leadTemperature} · {lead.leadScore}</span>
    </div>
    <div className="mb-4 rounded-lg border border-sky-100 bg-sky-50/60 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-sky-800"><CalendarDays size={14} />Scheduled meetings</div>
      {meetings.isLoading && <p className="text-[11px] text-slate-400">Loading meetings…</p>}
      {meetings.data?.map(meeting => <div className="flex items-start gap-2 border-t border-sky-100 py-2 first:border-t-0 first:pt-0 last:pb-0" key={meeting._id}>
        <div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold text-slate-700">{meeting.summary}</p><p className="mt-0.5 text-[10px] text-slate-500">{new Date(meeting.dueDate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</p></div>
        <button type="button" title="Delete scheduled meeting" aria-label="Delete scheduled meeting" disabled={deleteMeeting.isPending} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40" onClick={() => confirm(`Delete scheduled meeting “${meeting.summary}”?`) && deleteMeeting.mutate(meeting._id)}><Trash2 size={13} /></button>
      </div>)}
      {!meetings.isLoading && !meetings.data?.length && <p className="text-[11px] text-slate-400">No meetings scheduled.</p>}
      {meetingError && <p className="mt-2 text-[11px] text-red-600">{meetingError}</p>}
    </div>
    <div className="space-y-3">
      <Field label="Customer"><input className="field h-8" defaultValue={lead.contactName ?? ''} onChange={e => setEdit(x => ({ ...x, contactName: e.target.value }))} onBlur={() => commit('contactName')} /></Field>
      <Field label="Phone">{conversation.phoneNumber}</Field>
      <Field label="Email"><input className="field h-8" type="email" defaultValue={lead.email ?? ''} onChange={e => setEdit(x => ({ ...x, email: e.target.value }))} onBlur={() => commit('email')} /></Field>
      <Field label="Company"><input className="field h-8" defaultValue={lead.companyName ?? ''} onChange={e => setEdit(x => ({ ...x, companyName: e.target.value }))} onBlur={() => commit('companyName')} /></Field>
      <Field label="Stage"><span className="badge bg-sky-100 text-sky-700 capitalize">{lead.qualificationStatus}</span></Field>
      <Field label="Source">{lead.source?.name ?? '—'}</Field>
      <Field label="Salesperson">
        <select className="field h-8" defaultValue={lead.salesperson?._id ?? ''} onChange={e => assign.mutate(e.target.value)}>
          <option value="">Unassigned</option>
          {meta.data?.users.map(u => <option key={u._id} value={u._id}>{u.name}</option>)}
        </select>
      </Field>
      <Field label="Expected revenue">{money(lead.expectedRevenue)}</Field>
      <Field label="Budget"><input className="field h-8" defaultValue={lead.budget ?? ''} onChange={e => setEdit(x => ({ ...x, budget: e.target.value }))} onBlur={() => commit('budget')} /></Field>
      <Field label="Timeline"><input className="field h-8" defaultValue={lead.purchaseTimeline ?? ''} onChange={e => setEdit(x => ({ ...x, purchaseTimeline: e.target.value }))} onBlur={() => commit('purchaseTimeline')} /></Field>
      <Field label="Quantity">{lead.quantity ?? '—'}</Field>
      <Field label="Products of interest"><Chips items={lead.productInterest} /></Field>
      <Field label="Requirements"><Chips items={lead.requirements} /></Field>
      <Field label="Pain points"><Chips items={lead.painPoints} /></Field>
      <Field label="Objections"><Chips items={lead.objections} /></Field>
      <Field label="Tags"><Chips items={lead.tags.map(t => t.name)} /></Field>
      <Field label="Sentiment"><span className="flex items-center gap-1 capitalize">{conversation.sentiment && SENTIMENT_ICON[conversation.sentiment]}{conversation.sentiment ?? 'unknown'} {conversation.sentimentConfidence != null && <span className="text-slate-400">({Math.round(conversation.sentimentConfidence * 100)}%)</span>}</span></Field>
      <Field label="Detected intent"><span className="badge bg-violet-100 text-violet-700">{conversation.detectedIntent ?? '—'}</span></Field>
      <Field label="Sales probability">{lead.salesProbability != null ? `${lead.salesProbability}%` : '—'}</Field>
      <Field label="AI summary"><p className="leading-4">{lead.aiSummary || '—'}</p></Field>
      <Field label="Recommended next action"><p className="leading-4">{lead.recommendedNextAction || '—'}</p></Field>
      {lead.lastAiAnalysisAt && <Field label="Last AI analysis">{date(lead.lastAiAnalysisAt)}</Field>}
      <Link className="btn mt-2 flex justify-center" to="/leads">Open in Leads</Link>
    </div>
  </div>;
}
