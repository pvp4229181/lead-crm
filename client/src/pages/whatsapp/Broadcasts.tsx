import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Send } from 'lucide-react';
import { api } from '../../lib/api';
import type { WACampaign, WATemplate } from '../../lib/types';
import { Button, Empty, Loading, Modal, RowMenu } from '../../components/ui';

const STATUS_TONE: Record<string, string> = { PENDING: 'bg-amber-100 text-amber-700', APPROVED: 'bg-emerald-100 text-emerald-700', REJECTED: 'bg-red-100 text-red-700' };
const CAMPAIGN_TONE: Record<string, string> = { draft: 'bg-slate-100 text-slate-600', scheduled: 'bg-sky-100 text-sky-700', sending: 'bg-amber-100 text-amber-700', completed: 'bg-emerald-100 text-emerald-700', failed: 'bg-red-100 text-red-700', cancelled: 'bg-slate-100 text-slate-500' };

/**
 * The Meta-approved message template registry.
 *
 * These are NOT ARIA automation templates: they are WhatsApp Cloud API templates, owned and
 * approved by Meta, and the only thing WhatsApp allows a business to send to someone who
 * has not messaged in the last 24 hours. ARIA's own messaging lives under the Templates tab.
 */
export function MetaTemplates() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const templates = useQuery({ queryKey: ['wa-templates'], queryFn: () => api<WATemplate[]>('/whatsapp/templates') });
  const remove = useMutation({ mutationFn: (id: string) => api(`/whatsapp/templates/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-templates'] }) });
  const setStatus = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api(`/whatsapp/templates/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-templates'] }) });
  // Meta owns the real template list. Pulling it in beats retyping names by hand, which is
  // what produces "template name does not exist" at send time.
  const [syncNote, setSyncNote] = useState('');
  const sync = useMutation({
    mutationFn: () => api<{ created: number; updated: number; total: number }>('/whatsapp/templates/sync', { method: 'POST' }),
    onSuccess: result => { qc.invalidateQueries({ queryKey: ['wa-templates'] }); setSyncNote(`Synced ${result.total} template${result.total === 1 ? '' : 's'} from Meta — ${result.created} new, ${result.updated} updated.`); },
    onError: (e: any) => setSyncNote(e?.message ?? 'Could not reach Meta.'),
  });

  return <div>
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="text-xs text-slate-500">
        <b>Meta message templates.</b> Approved by Meta and required to open a conversation outside the 24-hour customer session.
        ARIA's own automated messages are on the <b>Templates</b> tab.
      </div>
      <div className="flex shrink-0 gap-2">
        <Button className="h-8" disabled={sync.isPending} onClick={() => { setSyncNote(''); sync.mutate(); }}><RefreshCw size={14} className={sync.isPending ? 'animate-spin' : undefined} />{sync.isPending ? 'Syncing…' : 'Sync from Meta'}</Button>
        <Button className="btn-primary h-8" onClick={() => setOpen(true)}><Plus size={14} />New template</Button>
      </div>
    </div>
    {syncNote && <p className={`mb-3 rounded p-2 text-xs ${sync.isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{syncNote}</p>}
    {templates.isLoading ? <Loading /> : !templates.data?.length ? <Empty title="No templates yet" detail="Hit Sync from Meta to pull in the templates already approved on your WhatsApp account." /> : <div className="panel divide-y">
      {templates.data.map(t => <div key={t._id} className="flex items-start gap-3 p-3 text-sm">
        <div className="min-w-0 flex-1"><b>{t.templateName}</b> <span className="badge bg-slate-100 text-slate-500">{t.category}</span> <span className="text-xs text-slate-400">{t.language}</span><p className="mt-0.5 text-xs text-slate-500">{t.body}</p></div>
        <select className="field h-8 w-32" value={t.status} onChange={e => setStatus.mutate({ id: t._id, status: e.target.value })}><option value="PENDING">Pending</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select>
        <span className={`badge ${STATUS_TONE[t.status]}`}>{t.status}</span>
        <RowMenu busy={remove.isPending} onDelete={() => confirm('Delete this template?') && remove.mutate(t._id)} />
      </div>)}
    </div>}
    {open && <TemplateForm onClose={() => setOpen(false)} />}
  </div>;
}

function TemplateForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ templateName: '', category: 'UTILITY', language: 'en_US', header: '', body: '', footer: '' });
  const [error, setError] = useState('');
  const create = useMutation({ mutationFn: () => api('/whatsapp/templates', { method: 'POST', body: JSON.stringify(form) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['wa-templates'] }); onClose(); }, onError: (e: any) => setError(e?.message ?? 'Could not save.') });
  return <Modal title="New WhatsApp Template" onClose={onClose} width="max-w-lg"><form onSubmit={e => { e.preventDefault(); create.mutate(); }}>
    <div className="space-y-3 p-5">
      <label><span className="label">Template name</span><input required className="field" value={form.templateName} onChange={e => setForm({ ...form, templateName: e.target.value })} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label><span className="label">Category</span><select className="field" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}><option value="MARKETING">Marketing</option><option value="UTILITY">Utility</option><option value="AUTHENTICATION">Authentication</option></select></label>
        <label><span className="label">Language</span><input className="field" value={form.language} onChange={e => setForm({ ...form, language: e.target.value })} /></label>
      </div>
      <label><span className="label">Header (optional)</span><input className="field" value={form.header} onChange={e => setForm({ ...form, header: e.target.value })} /></label>
      <label><span className="label">Body</span><textarea required className="field" rows={4} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} placeholder="Use {{1}}, {{2}} for variables" /></label>
      <label><span className="label">Footer (optional)</span><input className="field" value={form.footer} onChange={e => setForm({ ...form, footer: e.target.value })} /></label>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
    <div className="flex justify-end gap-2 border-t bg-slate-50 p-3"><Button type="button" onClick={onClose}>Cancel</Button><Button className="btn-primary" disabled={create.isPending}>Save</Button></div>
  </form></Modal>;
}

export function Campaigns() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const campaigns = useQuery({ queryKey: ['wa-campaigns'], queryFn: () => api<WACampaign[]>('/whatsapp/campaigns') });
  const send = useMutation({ mutationFn: (id: string) => api(`/whatsapp/campaigns/${id}/send`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-campaigns'] }) });
  const remove = useMutation({ mutationFn: (id: string) => api(`/whatsapp/campaigns/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-campaigns'] }) });

  return <div>
    <div className="mb-3 flex items-center justify-between"><p className="text-xs text-slate-500">Campaigns message leads using an approved template — respecting WhatsApp's opt-in and 24-hour session policies.</p><Button className="btn-primary h-8" onClick={() => setOpen(true)}><Plus size={14} />New campaign</Button></div>
    {campaigns.isLoading ? <Loading /> : !campaigns.data?.length ? <Empty title="No campaigns yet" detail="Create a campaign and target it at a segment of your leads." /> : <div className="panel divide-y">
      {campaigns.data.map(c => <div key={c._id} className="flex items-center gap-3 p-3 text-sm">
        <div className="min-w-0 flex-1"><b>{c.campaignName}</b> <span className={`badge ${CAMPAIGN_TONE[c.status]}`}>{c.status}</span><p className="text-xs text-slate-500">Template: {c.template?.templateName ?? '—'} · Audience: {c.audienceSize} · Sent {c.sent} · Failed {c.failed}</p></div>
        {c.status === 'draft' || c.status === 'scheduled' ? <Button className="h-8" disabled={send.isPending} onClick={() => confirm(`Send "${c.campaignName}" now to ${c.audienceSize} leads?`) && send.mutate(c._id)}><Send size={13} />Send now</Button> : null}
        <RowMenu busy={remove.isPending} onDelete={() => confirm('Delete this campaign?') && remove.mutate(c._id)} />
      </div>)}
    </div>}
    {open && <CampaignForm onClose={() => setOpen(false)} />}
  </div>;
}

function CampaignForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['wa-templates'], queryFn: () => api<WATemplate[]>('/whatsapp/templates') });
  const [form, setForm] = useState({ campaignName: '', template: '', temperature: [] as string[], stage: [] as string[] });
  const [preview, setPreview] = useState<number | null>(null);
  const [error, setError] = useState('');
  const approved = (templates.data ?? []).filter(t => t.status === 'APPROVED');
  const audience = { temperature: form.temperature, stage: form.stage };
  const previewAudience = useMutation({ mutationFn: () => api<{ count: number }>('/whatsapp/campaigns/preview-audience', { method: 'POST', body: JSON.stringify({ audience }) }), onSuccess: r => setPreview(r.count) });
  const create = useMutation({ mutationFn: () => api('/whatsapp/campaigns', { method: 'POST', body: JSON.stringify({ campaignName: form.campaignName, template: form.template, audience }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['wa-campaigns'] }); onClose(); }, onError: (e: any) => setError(e?.message ?? 'Could not save.') });
  const toggle = (key: 'temperature' | 'stage', value: string) => setForm(f => ({ ...f, [key]: f[key].includes(value) ? f[key].filter(x => x !== value) : [...f[key], value] }));

  return <Modal title="New WhatsApp Campaign" onClose={onClose} width="max-w-lg"><form onSubmit={e => { e.preventDefault(); create.mutate(); }}>
    <div className="space-y-3 p-5">
      <label><span className="label">Campaign name</span><input required className="field" value={form.campaignName} onChange={e => setForm({ ...form, campaignName: e.target.value })} /></label>
      <label><span className="label">Template</span><select required className="field" value={form.template} onChange={e => setForm({ ...form, template: e.target.value })}><option value="">Select an approved template</option>{approved.map(t => <option key={t._id} value={t._id}>{t.templateName}</option>)}</select>{!approved.length && <p className="mt-1 text-xs text-amber-600">No approved templates yet — approve one on the Templates tab first.</p>}</label>
      <div><span className="label">Lead temperature</span><div className="flex flex-wrap gap-1">{['Cold', 'Warm', 'Qualified', 'Hot'].map(t => <button type="button" key={t} className={`badge ${form.temperature.includes(t) ? 'bg-[#0ea5e9] text-white' : 'bg-slate-100 text-slate-600'}`} onClick={() => toggle('temperature', t)}>{t}</button>)}</div></div>
      <div><span className="label">Pipeline stage</span><div className="flex flex-wrap gap-1">{['new', 'contacted', 'engaged', 'qualified', 'proposal', 'negotiation'].map(s => <button type="button" key={s} className={`badge capitalize ${form.stage.includes(s) ? 'bg-[#0ea5e9] text-white' : 'bg-slate-100 text-slate-600'}`} onClick={() => toggle('stage', s)}>{s}</button>)}</div></div>
      <Button type="button" className="h-8" disabled={previewAudience.isPending} onClick={() => previewAudience.mutate()}>Preview audience size</Button>
      {preview != null && <p className="text-xs text-slate-500">{preview} lead(s) match this audience.</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
    <div className="flex justify-end gap-2 border-t bg-slate-50 p-3"><Button type="button" onClick={onClose}>Cancel</Button><Button className="btn-primary" disabled={create.isPending || !form.template}>Save as draft</Button></div>
  </form></Modal>;
}
