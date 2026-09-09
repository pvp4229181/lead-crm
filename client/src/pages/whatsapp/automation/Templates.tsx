import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Play, Plus, Search } from 'lucide-react';
import { api, date } from '../../../lib/api';
import type { AutomationCatalogue, AutomationTemplate, TemplateStatus, TemplateTestResult } from '../../../lib/types';
import { Button, Empty, Loading, Modal, RowMenu } from '../../../components/ui';
import { useDebounced } from '../../../lib/hooks';

export const STATUS_TONE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600', active: 'bg-emerald-100 text-emerald-700',
  paused: 'bg-amber-100 text-amber-700', archived: 'bg-slate-100 text-slate-400',
};
const label = (value: string) => value.replace(/_/g, ' ').replace(/^./, character => character.toUpperCase());

export default function Templates() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<AutomationTemplate | 'new' | null>(null);
  const [testing, setTesting] = useState<AutomationTemplate | null>(null);
  const debounced = useDebounced(search);

  const catalogue = useQuery({ queryKey: ['automation-catalogue'], queryFn: () => api<AutomationCatalogue>('/automation/catalogue'), staleTime: 300000 });
  const params = new URLSearchParams();
  if (debounced) params.set('search', debounced);
  if (category) params.set('category', category);
  if (status) params.set('status', status);
  const templates = useQuery({
    queryKey: ['automation-templates', debounced, category, status],
    queryFn: () => api<AutomationTemplate[]>(`/automation-templates${params.toString() ? `?${params}` : ''}`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['automation-templates'] });
  const remove = useMutation({ mutationFn: (id: string) => api(`/automation-templates/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
  const duplicate = useMutation({ mutationFn: (id: string) => api(`/automation-templates/${id}/duplicate`, { method: 'POST' }), onSuccess: invalidate });
  const setStatusFor = useMutation({
    mutationFn: ({ id, next }: { id: string; next: TemplateStatus }) => api(`/automation-templates/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: next }) }),
    onSuccess: invalidate,
  });

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-52 max-w-md flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={15} />
        <input className="field search-field" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search templates…" />
      </div>
      <select className="field h-8 w-44" value={category} onChange={event => setCategory(event.target.value)}>
        <option value="">All categories</option>
        {(catalogue.data?.categories ?? []).map(item => <option key={item} value={item}>{label(item)}</option>)}
      </select>
      <select className="field h-8 w-36" value={status} onChange={event => setStatus(event.target.value)}>
        <option value="">All statuses</option>
        {(catalogue.data?.statuses ?? []).map(item => <option key={item} value={item}>{label(item)}</option>)}
      </select>
      <Button className="btn-primary ml-auto h-8" onClick={() => setEditing('new')}><Plus size={14} />New template</Button>
    </div>

    {templates.isLoading ? <Loading /> : !templates.data?.length ? (
      <Empty title="No templates match" detail="Clear the filters, or create a template for the trigger you need." />
    ) : <div className="panel overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead className="border-b bg-[#fafafa] text-left text-[11px] uppercase tracking-wide text-slate-500">
          <tr><th className="p-2 pl-3">Name</th><th className="p-2">Category</th><th className="p-2">Trigger</th><th className="p-2">AI</th><th className="p-2">Status</th><th className="p-2">Updated</th><th className="p-2 pr-3 text-right">Actions</th></tr>
        </thead>
        <tbody className="divide-y">
          {templates.data.map(template => <tr key={template._id} className="hover:bg-slate-50">
            <td className="p-2 pl-3">
              <button className="text-left" onClick={() => setEditing(template)}>
                <b>{template.templateName}</b>
                {template.source === 'aria' && <span className="badge ml-2 bg-sky-50 text-sky-700">ARIA</span>}
                <div className="font-mono text-[11px] text-slate-400">{template.templateKey}</div>
              </button>
            </td>
            <td className="p-2 text-xs">{label(template.category)}</td>
            <td className="p-2 text-xs text-slate-500">{label(template.trigger)}</td>
            <td className="p-2 text-xs">{template.aiEnabled ? 'Yes' : '—'}</td>
            <td className="p-2"><span className={`badge ${STATUS_TONE[template.status]}`}>{template.status}</span></td>
            <td className="p-2 text-xs text-slate-400">{date(template.updatedAt)}</td>
            <td className="p-2 pr-3 text-right">
              <div className="flex items-center justify-end gap-1">
                <button className="text-slate-500 hover:text-slate-900" title="Test / preview" onClick={() => setTesting(template)}><Play size={14} /></button>
                <button className="text-slate-500 hover:text-slate-900" title="Duplicate" disabled={duplicate.isPending} onClick={() => duplicate.mutate(template._id)}><Copy size={14} /></button>
                <RowMenu
                  busy={remove.isPending || setStatusFor.isPending}
                  itemsTitle="Template"
                  items={[
                    { label: 'Edit', onSelect: () => setEditing(template) },
                    { label: template.status === 'active' ? 'Deactivate' : 'Activate', active: template.status === 'active', onSelect: () => setStatusFor.mutate({ id: template._id, next: template.status === 'active' ? 'paused' : 'active' }) },
                    { label: 'Archive', disabled: template.status === 'archived', onSelect: () => setStatusFor.mutate({ id: template._id, next: 'archived' }) },
                  ]}
                  onDelete={() => confirm(`Delete "${template.templateName}"? Automations using it must be removed first.`) && remove.mutate(template._id)}
                />
              </div>
            </td>
          </tr>)}
        </tbody>
      </table>
    </div>}

    {editing && <TemplateForm template={editing === 'new' ? null : editing} catalogue={catalogue.data} onClose={() => setEditing(null)} />}
    {testing && <TemplateTest template={testing} onClose={() => setTesting(null)} />}
  </div>;
}

const EMPTY: Partial<AutomationTemplate> = {
  templateName: '', templateKey: '', category: 'other', description: '', trigger: 'new_whatsapp_lead',
  messageType: 'text', message: '', requiredVariables: [], askMode: false, buttons: [], conditions: [],
  aiEnabled: false, internalOnly: false, priority: 100, status: 'draft',
};

function TemplateForm({ template, catalogue, onClose }: { template: AutomationTemplate | null; catalogue?: AutomationCatalogue; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Partial<AutomationTemplate>>(template ?? EMPTY);
  const [error, setError] = useState('');
  const set = <K extends keyof AutomationTemplate>(key: K, value: AutomationTemplate[K]) => setForm(current => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, delay: form.delay ?? { value: 0, unit: 'minutes' } };
      return template
        ? api(`/automation-templates/${template._id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : api('/automation-templates', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automation-templates'] }); onClose(); },
    onError: (cause: any) => setError(cause?.message ?? 'Could not save the template.'),
  });

  // Clicking a variable inserts it at the caret, which is far quicker than remembering
  // the exact spelling of thirty-odd placeholders.
  const insert = (name: string) => {
    const field = document.getElementById('template-message') as HTMLTextAreaElement | null;
    const token = `{{${name}}}`;
    if (!field) return set('message', `${form.message ?? ''}${token}`);
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const next = `${field.value.slice(0, start)}${token}${field.value.slice(end)}`;
    set('message', next);
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + token.length, start + token.length); });
  };

  const grouped = useMemo(() => {
    const groups = new Map<string, { name: string; label: string }[]>();
    for (const variable of catalogue?.variables ?? []) {
      if (!groups.has(variable.group)) groups.set(variable.group, []);
      groups.get(variable.group)!.push(variable);
    }
    return [...groups.entries()];
  }, [catalogue]);

  const used = [...new Set([...(form.message ?? '').matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map(match => match[1]!.toLowerCase()))];

  return <Modal title={template ? `Edit ${template.templateName}` : 'New template'} onClose={onClose} width="max-w-5xl">
    <form onSubmit={event => { event.preventDefault(); setError(''); save.mutate(); }}>
      <div className="max-h-[70vh] overflow-y-auto p-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label><span className="label">Template name</span><input required className="field" value={form.templateName ?? ''} onChange={event => set('templateName', event.target.value)} /></label>
              <label><span className="label">Template key</span>
                <input required className="field font-mono text-xs" value={form.templateKey ?? ''} disabled={Boolean(template)} placeholder="welcome_message"
                  onChange={event => set('templateKey', event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
                {template && <span className="mt-1 block text-[11px] text-slate-400">The key is fixed once created — automations reference it.</span>}
              </label>
            </div>
            <label><span className="label">Description</span><input className="field" value={form.description ?? ''} onChange={event => set('description', event.target.value)} /></label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label><span className="label">Category</span>
                <select className="field" value={form.category} onChange={event => set('category', event.target.value as AutomationTemplate['category'])}>
                  {(catalogue?.categories ?? []).map(item => <option key={item} value={item}>{label(item)}</option>)}
                </select>
              </label>
              <label><span className="label">Trigger</span>
                <select className="field" value={form.trigger} onChange={event => set('trigger', event.target.value)}>
                  {(catalogue?.triggers ?? []).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
                </select>
              </label>
              <label><span className="label">Message type</span>
                <select className="field" value={form.messageType} onChange={event => set('messageType', event.target.value as AutomationTemplate['messageType'])}>
                  <option value="text">Text</option><option value="interactive">Interactive (buttons)</option><option value="internal">Internal notification</option>
                </select>
              </label>
            </div>
            <p className="text-[11px] text-slate-400">{(catalogue?.triggers ?? []).find(item => item.key === form.trigger)?.description}</p>

            <label><span className="label">Message</span>
              <textarea id="template-message" required className="field font-mono text-xs" rows={12} value={form.message ?? ''} onChange={event => set('message', event.target.value)} />
            </label>
            <div className="flex flex-wrap gap-3 text-xs">
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.aiEnabled === true} onChange={event => set('aiEnabled', event.target.checked)} />AI may adapt this message</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.internalOnly === true} onChange={event => set('internalOnly', event.target.checked)} />Internal only (never sent to the customer)</label>
              <label className="flex items-center gap-2" title="Lines whose variable the CRM already knows are dropped, so ARIA only asks for what is missing.">
                <input type="checkbox" checked={form.askMode === true} onChange={event => set('askMode', event.target.checked)} />Information request
              </label>
            </div>

            {form.messageType === 'interactive' && <div>
              <span className="label">Reply buttons (max 3, 20 characters each)</span>
              {(form.buttons ?? []).map((button, index) => <div key={index} className="mb-1 flex gap-2">
                <input className="field flex-1 font-mono text-xs" value={button.id} placeholder="wa_action_human" onChange={event => set('buttons', (form.buttons ?? []).map((item, position) => position === index ? { ...item, id: event.target.value } : item))} />
                <input className="field flex-1" maxLength={20} value={button.title} placeholder="Talk to a human" onChange={event => set('buttons', (form.buttons ?? []).map((item, position) => position === index ? { ...item, title: event.target.value } : item))} />
                <button type="button" className="btn h-8" onClick={() => set('buttons', (form.buttons ?? []).filter((_, position) => position !== index))}>Remove</button>
              </div>)}
              {(form.buttons ?? []).length < 3 && <Button type="button" className="h-8" onClick={() => set('buttons', [...(form.buttons ?? []), { id: '', title: '' }])}><Plus size={13} />Add button</Button>}
            </div>}

            <ConditionEditor value={form.conditions ?? []} fields={catalogue?.conditionFields ?? []} onChange={next => set('conditions', next)} />

            <div className="grid gap-3 sm:grid-cols-3">
              <label><span className="label">Delay</span>
                <div className="flex gap-2">
                  <input type="number" min={0} className="field w-20" value={form.delay?.value ?? 0} onChange={event => set('delay', { value: Number(event.target.value), unit: form.delay?.unit ?? 'minutes' })} />
                  <select className="field flex-1" value={form.delay?.unit ?? 'minutes'} onChange={event => set('delay', { value: form.delay?.value ?? 0, unit: event.target.value as AutomationTemplate['delay'] extends undefined ? never : 'minutes' | 'hours' | 'days' })}>
                    <option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option>
                  </select>
                </div>
              </label>
              <label><span className="label">Priority (lower runs first)</span><input type="number" className="field" value={form.priority ?? 100} onChange={event => set('priority', Number(event.target.value))} /></label>
              <label><span className="label">Status</span>
                <select className="field" value={form.status} onChange={event => set('status', event.target.value as TemplateStatus)}>
                  {(catalogue?.statuses ?? []).map(item => <option key={item} value={item}>{label(item)}</option>)}
                </select>
              </label>
            </div>
            <label><span className="label">Required variables (comma separated — the message is not sent without them)</span>
              <input className="field font-mono text-xs" value={(form.requiredVariables ?? []).join(', ')} placeholder="quote_number, quote_amount"
                onChange={event => set('requiredVariables', event.target.value.split(',').map(item => item.trim()).filter(Boolean))} />
            </label>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>

          <aside className="space-y-3 lg:border-l lg:pl-4">
            <div>
              <h4 className="text-xs font-semibold">Available variables</h4>
              <p className="mt-0.5 text-[11px] text-slate-400">Click to insert. Unresolved ones are removed before sending.</p>
            </div>
            <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
              {grouped.map(([group, variables]) => <div key={group}>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{group}</div>
                <div className="flex flex-wrap gap-1">
                  {variables.map(variable => <button key={variable.name} type="button" title={variable.label}
                    className={`badge font-mono ${used.includes(variable.name) ? 'bg-[#0ea5e9] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                    onClick={() => insert(variable.name)}>{variable.name}</button>)}
                </div>
              </div>)}
            </div>
          </aside>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t bg-slate-50 p-3">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button className="btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save template'}</Button>
      </div>
    </form>
  </Modal>;
}

function ConditionEditor({ value, fields, onChange }: { value: { field: string; operator: string; value?: unknown }[]; fields: string[]; onChange: (next: any[]) => void }) {
  const operators = ['equals', 'not_equals', 'contains', 'not_contains', 'exists', 'not_exists', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_true', 'is_false'];
  return <div>
    <span className="label">Conditions (all must be true)</span>
    {value.map((condition, index) => <div key={index} className="mb-1 flex flex-wrap gap-2">
      <select className="field h-8 flex-1" value={condition.field} onChange={event => onChange(value.map((item, position) => position === index ? { ...item, field: event.target.value } : item))}>
        {fields.map(field => <option key={field} value={field}>{field}</option>)}
      </select>
      <select className="field h-8 w-32" value={condition.operator} onChange={event => onChange(value.map((item, position) => position === index ? { ...item, operator: event.target.value } : item))}>
        {operators.map(operator => <option key={operator} value={operator}>{operator.replace(/_/g, ' ')}</option>)}
      </select>
      <input className="field h-8 w-32" value={String(condition.value ?? '')} placeholder="value" onChange={event => onChange(value.map((item, position) => position === index ? { ...item, value: event.target.value } : item))} />
      <button type="button" className="btn h-8" onClick={() => onChange(value.filter((_, position) => position !== index))}>Remove</button>
    </div>)}
    <Button type="button" className="h-8" onClick={() => onChange([...value, { field: fields[0] ?? 'lead.leadScore', operator: 'exists' }])}><Plus size={13} />Add condition</Button>
  </div>;
}

function TemplateTest({ template, onClose }: { template: AutomationTemplate; onClose: () => void }) {
  const [phone, setPhone] = useState('');
  const [send, setSend] = useState(false);
  const conversations = useQuery({
    queryKey: ['wa-conversations', 'test-picker'],
    queryFn: () => api<{ data: { _id: string; phoneNumber: string; customerName?: string }[] }>('/whatsapp/conversations?limit=50'),
  });
  const test = useMutation({
    mutationFn: () => api<TemplateTestResult>(`/automation-templates/${template._id}/test`, { method: 'POST', body: JSON.stringify({ conversation: phone || undefined, send }) }),
  });

  return <Modal title={`Test — ${template.templateName}`} onClose={onClose} width="max-w-2xl">
    <div className="space-y-3 p-5">
      <label><span className="label">Render against a conversation (optional)</span>
        <select className="field" value={phone} onChange={event => setPhone(event.target.value)}>
          <option value="">Use sample values</option>
          {(conversations.data?.data ?? []).map(conversation => <option key={conversation._id} value={conversation._id}>{conversation.customerName || conversation.phoneNumber}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={send} disabled={!phone} onChange={event => setSend(event.target.checked)} />
        Actually deliver it to that conversation (otherwise this is a dry run)
      </label>
      <Button className="btn-primary h-8" disabled={test.isPending} onClick={() => test.mutate()}><Play size={13} />{test.isPending ? 'Rendering…' : 'Run test'}</Button>

      {test.data && <div className="space-y-2">
        <div className="whitespace-pre-wrap rounded-md border bg-[#e7ffdb] p-3 text-sm">{test.data.text || '(nothing would be sent)'}</div>
        {test.data.usingSamples && <p className="text-[11px] text-slate-400">Rendered with sample values — pick a conversation to see the real data.</p>}
        {test.data.missing?.length > 0 && <p className="text-xs text-amber-600">Unresolved: {test.data.missing.join(', ')}{test.data.blocked ? ' — required, so this message would not be sent.' : ' — those lines are dropped before sending.'}</p>}
        {test.data.sent && <p className="text-xs font-semibold text-emerald-600">Delivered.</p>}
        {!test.data.sent && test.data.reason && <p className="text-xs text-red-600">{test.data.reason}</p>}
      </div>}
      {test.isError && <p className="text-xs text-red-600">{(test.error as any)?.message ?? 'Test failed.'}</p>}
    </div>
    <div className="flex justify-end border-t bg-slate-50 p-3"><Button onClick={onClose}>Close</Button></div>
  </Modal>;
}
