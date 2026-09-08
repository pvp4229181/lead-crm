import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { api } from '../../lib/api';
import type { Paged, WALead, WATemplate } from '../../lib/types';
import { Button, Modal } from '../../components/ui';
import { useDebounced } from '../../lib/hooks';

// Counts the {{n}} placeholders a template body declares, so the form can ask for exactly
// the values Meta will expect — a mismatch is rejected by the API at send time.
const variableCount = (body: string) => {
  const found = new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1]));
  return found.size;
};

// Meta template names are lowercase letters, digits and underscores — never spaces. Typing a
// human phrase ("hi sir") is the usual cause of error 132001, so catch it before we send.
const TEMPLATE_NAME_RULE = /^[a-z0-9_]+$/;
const nameProblem = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed || TEMPLATE_NAME_RULE.test(trimmed)) return '';
  return /\s/.test(trimmed)
    ? "Template names can't contain spaces — Meta uses lowercase words joined by underscores, like hello_world."
    : 'Template names use only lowercase letters, numbers and underscores, like hello_world.';
};

export function NewConversation({ onClose, onSent }: { onClose: () => void; onSent: (conversationId: string) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [leadId, setLeadId] = useState('');
  const [phone, setPhone] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [rawTemplate, setRawTemplate] = useState('');
  const [variables, setVariables] = useState<string[]>([]);
  const [error, setError] = useState('');

  const leadQuery = useDebounced(search.trim());
  const leads = useQuery({ queryKey: ['wa-lead-picker', leadQuery], queryFn: () => api<Paged<WALead>>(`/leads?limit=20&search=${encodeURIComponent(leadQuery)}`), placeholderData: previous => previous });
  const templates = useQuery({ queryKey: ['wa-templates'], queryFn: () => api<WATemplate[]>('/whatsapp/templates') });
  const approved = useMemo(() => (templates.data ?? []).filter(t => t.status === 'APPROVED'), [templates.data]);
  const selectedTemplate = approved.find(t => t._id === templateId);
  const slots = selectedTemplate ? variableCount(selectedTemplate.body) : 0;
  const selectedLead = leads.data?.data.find(l => l._id === leadId);
  const rawProblem = templateId ? '' : nameProblem(rawTemplate);

  const send = useMutation({
    mutationFn: () => api<{ conversation: string }>('/whatsapp/send', {
      method: 'POST',
      body: JSON.stringify({
        ...(leadId ? { lead: leadId } : { phone }),
        ...(templateId ? { template: templateId } : { templateName: rawTemplate, language: 'en_US' }),
        variables: variables.slice(0, slots).map(v => v ?? ''),
      }),
    }),
    onSuccess: result => {
      qc.invalidateQueries({ queryKey: ['wa-conversations'] });
      onSent(result.conversation);
      onClose();
    },
    onError: (cause: any) => setError(cause?.message ?? 'Could not send the message.'),
  });

  const canSend = (leadId || phone.trim().length >= 6) && (templateId || rawTemplate.trim()) && !rawProblem && !send.isPending;

  return <Modal title="Start a WhatsApp conversation" onClose={onClose} width="max-w-lg">
    <div className="space-y-3 p-5">
      <div className="rounded border border-sky-100 bg-sky-50 p-3 text-xs text-sky-900">
        WhatsApp only allows a business to open a conversation with a <b>template approved by Meta</b>.
        Once the customer replies, a 24-hour window opens and you can chat freely in the inbox.
      </div>

      <label className="block"><span className="label">Lead</span>
        <input className="field mb-1" placeholder="Search leads by name, company, phone…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="field" value={leadId} onChange={e => { setLeadId(e.target.value); setPhone(''); }}>
          <option value="">— Send to a phone number instead —</option>
          {leads.data?.data.filter(l => l.phone).map(l => <option key={l._id} value={l._id}>{l.contactName || l.title} · {l.phone}</option>)}
        </select>
      </label>

      {!leadId && <label className="block"><span className="label">Phone number (with country code)</span>
        <input className="field" placeholder="919876543210" value={phone} onChange={e => setPhone(e.target.value)} />
      </label>}

      <label className="block"><span className="label">Template</span>
        <select className="field" value={templateId} onChange={e => { setTemplateId(e.target.value); setVariables([]); }}>
          <option value="">— Enter a Meta template name manually —</option>
          {approved.map(t => <option key={t._id} value={t._id}>{t.templateName} ({t.language})</option>)}
        </select>
        {!templates.isLoading && !approved.length && <span className="mt-1 block text-[11px] text-slate-500">No approved templates stored yet — use <b>Templates → Sync from Meta</b> to pull in the ones already approved on your WhatsApp account, then pick one here.</span>}
      </label>

      {!templateId && <label className="block"><span className="label">Meta template name</span>
        <input className="field" placeholder="hello_world" value={rawTemplate} onChange={e => setRawTemplate(e.target.value)} />
        <span className="mt-1 block text-[11px] text-slate-500">This must be the exact name registered with Meta, not the message text. Every test number ships with the pre-approved <code>hello_world</code> template — useful for a first send.</span>
        {rawProblem && <span className="mt-1 block text-[11px] text-amber-700">{rawProblem}</span>}
      </label>}

      {selectedTemplate && <div className="rounded border bg-slate-50 p-2 text-xs text-slate-600">{selectedTemplate.body}</div>}

      {Array.from({ length: slots }, (_, i) => <label className="block" key={i}>
        <span className="label">Variable {`{{${i + 1}}}`}</span>
        <input className="field" value={variables[i] ?? ''} onChange={e => setVariables(v => { const next = [...v]; next[i] = e.target.value; return next; })} />
      </label>)}

      {selectedLead && <p className="text-xs text-slate-500">Sending to <b>{selectedLead.contactName || selectedLead.title}</b> at {selectedLead.phone}</p>}
      {error && <p className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}
    </div>
    <div className="flex justify-end gap-2 border-t bg-slate-50 p-3">
      <Button type="button" onClick={onClose}>Cancel</Button>
      <Button className="btn-primary" disabled={!canSend} onClick={() => { setError(''); send.mutate(); }}><Send size={14} />{send.isPending ? 'Sending…' : 'Send'}</Button>
    </div>
  </Modal>;
}
