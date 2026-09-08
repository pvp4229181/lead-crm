import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Frown, Meh, Smile } from 'lucide-react';
import { api, date, money } from '../../lib/api';
import type { Metadata, WAConversation, WALead } from '../../lib/types';

const TEMP_TONE: Record<string, string> = { Cold: 'bg-slate-100 text-slate-600', Warm: 'bg-amber-100 text-amber-700', Hot: 'bg-orange-100 text-orange-700', 'Very Hot': 'bg-red-100 text-red-700' };
const SENTIMENT_ICON = { positive: <Smile size={14} className="text-emerald-500" />, neutral: <Meh size={14} className="text-slate-400" />, negative: <Frown size={14} className="text-red-500" /> } as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div><div className="mt-0.5 text-xs text-slate-700">{children}</div></div>; }
function Chips({ items }: { items: string[] }) { return items.length ? <div className="flex flex-wrap gap-1">{items.map((x, i) => <span key={i} className="badge bg-slate-100 text-slate-600">{x}</span>)}</div> : <span className="text-slate-400">—</span>; }

export function LeadPanel({ conversation }: { conversation: WAConversation }) {
  const qc = useQueryClient();
  const lead = conversation.lead;
  const meta = useQuery({ queryKey: ['metadata'], queryFn: () => api<Metadata>('/metadata') });
  const [edit, setEdit] = useState<Partial<WALead>>({});
  useEffect(() => { setEdit({}); }, [lead?._id]);

  const saveLead = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<WALead>(`/leads/${lead!._id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['wa-conversations'] }); qc.invalidateQueries({ queryKey: ['wa-conversation', conversation._id] }); },
  });
  const assign = useMutation({
    mutationFn: (assignedTo: string) => api(`/whatsapp/conversations/${conversation._id}`, { method: 'PATCH', body: JSON.stringify({ assignedTo: assignedTo || null }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-conversations'] }),
  });

  if (!lead) return <div className="w-80 shrink-0 border-l bg-white p-4 text-xs text-slate-400">No lead linked to this conversation yet.</div>;

  const commit = (field: keyof WALead) => { const value = edit[field]; if (value === undefined) return; saveLead.mutate({ [field]: value }); };

  return <div className="h-full min-h-0 w-80 shrink-0 overflow-y-auto border-l bg-white p-4">
    <div className="mb-3 flex items-center justify-between">
      <h3 className="text-sm font-semibold">Lead details</h3>
      <span className={`badge ${TEMP_TONE[lead.leadTemperature]}`}>{lead.leadTemperature} · {lead.leadScore}</span>
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
      <a className="btn mt-2 block text-center" href={`/leads`}>Open in Leads</a>
    </div>
  </div>;
}
