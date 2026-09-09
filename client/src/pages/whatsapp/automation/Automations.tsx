import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, date } from '../../../lib/api';
import type { Automation, AutomationCatalogue, AutomationTemplate, TemplateStatus } from '../../../lib/types';
import { Button, Empty, Loading, Modal, RowMenu } from '../../../components/ui';
import { STATUS_TONE } from './Templates';

const label = (value: string) => value.replace(/_/g, ' ').replace(/^./, character => character.toUpperCase());
const describeDelay = (automation: Automation) => (automation.delay?.value ? `after ${automation.delay.value} ${automation.delay.unit}` : 'immediately');

export default function Automations() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  const catalogue = useQuery({ queryKey: ['automation-catalogue'], queryFn: () => api<AutomationCatalogue>('/automation/catalogue'), staleTime: 300000 });
  const automations = useQuery({ queryKey: ['automations'], queryFn: () => api<Automation[]>('/automations') });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['automations'] });
  const remove = useMutation({ mutationFn: (id: string) => api(`/automations/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TemplateStatus }) => api(`/automations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: invalidate,
  });

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-slate-500">An automation binds a trigger to a template and a set of actions. Pause one to stop it firing without deleting it.</p>
      <Button className="btn-primary h-8" onClick={() => setEditing('new')}><Plus size={14} />New automation</Button>
    </div>

    {automations.isLoading ? <Loading /> : !automations.data?.length ? (
      <Empty title="No automations yet" detail="Run the ARIA seed, or create an automation for one of the available triggers." />
    ) : <div className="panel divide-y">
      {automations.data.map(automation => {
        const template = typeof automation.template === 'object' ? automation.template : null;
        return <div key={automation._id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
          <div className="min-w-56 flex-1">
            <button className="text-left" onClick={() => setEditing(automation)}>
              <b>{automation.name}</b>
              {automation.source === 'aria' && <span className="badge ml-2 bg-sky-50 text-sky-700">ARIA</span>}
            </button>
            <p className="text-xs text-slate-500">{automation.description}</p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              On <b>{label(automation.trigger)}</b>, {describeDelay(automation)} → {template ? template.templateName : (automation.actions ?? []).map(action => label(action.type)).join(', ') || 'no action'}
              {automation.maxAttempts > 1 && ` · up to ${automation.maxAttempts} attempts`}
              {automation.runCount > 0 && ` · ran ${automation.runCount}×`}
              {automation.lastRunAt && ` · last ${date(automation.lastRunAt)}`}
            </p>
            {automation.lastError && <p className="text-[11px] text-red-600">Last error: {automation.lastError}</p>}
          </div>
          <span className={`badge ${STATUS_TONE[automation.status]}`}>{automation.status}</span>
          <RowMenu
            busy={remove.isPending || setStatus.isPending}
            itemsTitle="Automation"
            items={[
              { label: 'Edit', onSelect: () => setEditing(automation) },
              { label: automation.status === 'active' ? 'Pause' : 'Activate', active: automation.status === 'active', onSelect: () => setStatus.mutate({ id: automation._id, status: automation.status === 'active' ? 'paused' : 'active' }) },
            ]}
            onDelete={() => confirm(`Delete "${automation.name}"? Queued runs will be cancelled.`) && remove.mutate(automation._id)}
          />
        </div>;
      })}
    </div>}

    {editing && <AutomationForm automation={editing === 'new' ? null : editing} catalogue={catalogue.data} onClose={() => setEditing(null)} />}
  </div>;
}

const STOP_CONDITIONS = ['lead_replied', 'lead_won', 'lead_lost', 'lead_opted_out', 'human_takeover', 'conversation_paused'];

function AutomationForm({ automation, catalogue, onClose }: { automation: Automation | null; catalogue?: AutomationCatalogue; onClose: () => void }) {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['automation-templates', '', '', ''], queryFn: () => api<AutomationTemplate[]>('/automation-templates') });
  const [form, setForm] = useState<any>(automation
    ? { ...automation, template: typeof automation.template === 'object' ? automation.template?._id : automation.template }
    : { name: '', description: '', trigger: 'new_whatsapp_lead', template: '', actions: [], conditions: [], delay: { value: 0, unit: 'minutes' }, maxAttempts: 1, repeatEveryHours: 0, stopOn: [], priority: 100, status: 'draft' });
  const [error, setError] = useState('');
  const set = (key: string, value: unknown) => setForm((current: any) => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name, description: form.description, trigger: form.trigger, template: form.template || null,
        conditions: form.conditions ?? [], delay: form.delay, actions: form.actions ?? [],
        maxAttempts: form.maxAttempts, repeatEveryHours: form.repeatEveryHours, stopOn: form.stopOn ?? [],
        priority: form.priority, status: form.status,
      };
      return automation
        ? api(`/automations/${automation._id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : api('/automations', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations'] }); onClose(); },
    onError: (cause: any) => setError(cause?.message ?? 'Could not save the automation.'),
  });

  const toggleStop = (value: string) => set('stopOn', (form.stopOn ?? []).includes(value) ? form.stopOn.filter((item: string) => item !== value) : [...(form.stopOn ?? []), value]);
  const toggleAction = (type: string) => set('actions', (form.actions ?? []).some((action: any) => action.type === type)
    ? form.actions.filter((action: any) => action.type !== type)
    : [...(form.actions ?? []), { type, config: {} }]);

  return <Modal title={automation ? `Edit ${automation.name}` : 'New automation'} onClose={onClose} width="max-w-2xl">
    <form onSubmit={event => { event.preventDefault(); setError(''); save.mutate(); }}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
        <label><span className="label">Name</span><input required className="field" value={form.name} onChange={event => set('name', event.target.value)} /></label>
        <label><span className="label">Description</span><input className="field" value={form.description ?? ''} onChange={event => set('description', event.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label><span className="label">Trigger</span>
            <select className="field" value={form.trigger} onChange={event => set('trigger', event.target.value)}>
              {(catalogue?.triggers ?? []).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label><span className="label">Template</span>
            <select className="field" value={form.template ?? ''} onChange={event => set('template', event.target.value)}>
              <option value="">No message (actions only)</option>
              {(templates.data ?? []).map(template => <option key={template._id} value={template._id}>{template.templateName}</option>)}
            </select>
          </label>
        </div>
        <p className="text-[11px] text-slate-400">{(catalogue?.triggers ?? []).find(item => item.key === form.trigger)?.description}</p>

        <div>
          <span className="label">Actions (a template is sent automatically when none are selected)</span>
          <div className="flex flex-wrap gap-1">
            {(catalogue?.actionTypes ?? []).map(type => <button key={type} type="button"
              className={`badge ${(form.actions ?? []).some((action: any) => action.type === type) ? 'bg-[#0ea5e9] text-white' : 'bg-slate-100 text-slate-600'}`}
              onClick={() => toggleAction(type)}>{label(type)}</button>)}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label><span className="label">Delay</span>
            <div className="flex gap-2">
              <input type="number" min={0} className="field w-20" value={form.delay?.value ?? 0} onChange={event => set('delay', { ...form.delay, value: Number(event.target.value) })} />
              <select className="field flex-1" value={form.delay?.unit ?? 'minutes'} onChange={event => set('delay', { ...form.delay, unit: event.target.value })}>
                <option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option>
              </select>
            </div>
          </label>
          <label><span className="label">Max attempts</span><input type="number" min={1} className="field" value={form.maxAttempts} onChange={event => set('maxAttempts', Number(event.target.value))} /></label>
          <label><span className="label">Repeat every (hours)</span><input type="number" min={0} className="field" value={form.repeatEveryHours} onChange={event => set('repeatEveryHours', Number(event.target.value))} /></label>
        </div>

        <div>
          <span className="label">Stop conditions</span>
          <div className="flex flex-wrap gap-1">
            {STOP_CONDITIONS.map(value => <button key={value} type="button"
              className={`badge ${(form.stopOn ?? []).includes(value) ? 'bg-[#0ea5e9] text-white' : 'bg-slate-100 text-slate-600'}`}
              onClick={() => toggleStop(value)}>{label(value)}</button>)}
          </div>
          <p className="mt-1 text-[11px] text-slate-400">A customer reply, a won/lost lead, an opt-out and a human takeover always cancel pending runs, whatever is selected here.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label><span className="label">Priority (lower runs first)</span><input type="number" className="field" value={form.priority} onChange={event => set('priority', Number(event.target.value))} /></label>
          <label><span className="label">Status</span>
            <select className="field" value={form.status} onChange={event => set('status', event.target.value)}>
              {(catalogue?.statuses ?? []).map(item => <option key={item} value={item}>{label(item)}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t bg-slate-50 p-3">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button className="btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save automation'}</Button>
      </div>
    </form>
  </Modal>;
}
