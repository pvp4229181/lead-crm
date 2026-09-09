import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { AIConfig, WATemplate, WhatsAppAccountRow } from '../../lib/types';
import { Button, Empty, Loading, RowMenu } from '../../components/ui';

// Behaviour, scoring and connection settings for ARIA. Customer-facing wording is not here:
// it lives in the automation templates, so this screen can never disagree with what is
// actually sent. Rendered as the "AI Settings" and "Accounts" tabs of WhatsApp Automation.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function AgentConfig() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['wa-ai-settings'], queryFn: () => api<AIConfig>('/whatsapp/ai-settings') });
  const templates = useQuery({ queryKey: ['wa-templates'], queryFn: () => api<WATemplate[]>('/whatsapp/templates') });
  const approvedTemplates = (templates.data ?? []).filter(t => t.status === 'APPROVED');
  const [form, setForm] = useState<AIConfig | null>(null);
  const [question, setQuestion] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (config.data && !form) setForm(config.data); }, [config.data, form]);

  const save = useMutation({
    mutationFn: (body: Partial<AIConfig>) => api<AIConfig>('/whatsapp/ai-settings', { method: 'PATCH', body: JSON.stringify(body) }),
    onMutate: () => setError(''),
    onSuccess: data => { setForm(data); qc.setQueryData(['wa-ai-settings'], data); setSaved(true); setTimeout(() => setSaved(false), 2000); },
    onError: cause => setError(cause instanceof Error ? cause.message : 'Could not save the AI settings.'),
  });
  const applyTemplate = useMutation({
    mutationFn: () => api<AIConfig>('/whatsapp/ai-settings/recommended-template', { method: 'POST' }),
    onMutate: () => setError(''),
    onSuccess: data => { setForm(data); qc.setQueryData(['wa-ai-settings'], data); setSaved(true); setTimeout(() => setSaved(false), 2000); },
    onError: cause => setError(cause instanceof Error ? cause.message : 'Could not apply the recommended template.'),
  });

  if (config.isLoading || !form) return <Loading />;
  const set = <K extends keyof AIConfig>(key: K, value: AIConfig[K]) => setForm({ ...form, [key]: value });
  const days = form.businessHours?.days ?? [];
  const dayFor = (d: number) => days.find(x => x.day === d);
  const setDay = (d: number, patch: Partial<{ enabled: boolean; start: string; end: string }>) => {
    const existing = dayFor(d);
    const next = existing ? { ...existing, ...patch } : { day: d, start: '09:30', end: '18:30', enabled: true, ...patch };
    const nextDays = [...days.filter(x => x.day !== d), next].sort((a, b) => a.day - b.day);
    set('businessHours', { timezone: form.businessHours?.timezone ?? 'Asia/Kolkata', days: nextDays });
  };
  const rules = form.escalationRules;
  const scoring = form.leadScoring ?? ({} as AIConfig['leadScoring']);
  const setRule = (key: keyof AIConfig['escalationRules'], value: unknown) => set('escalationRules', { ...rules, [key]: value });

  return <div className="max-w-3xl space-y-5">
    <section className="panel flex flex-wrap items-center gap-3 border-sky-200 bg-sky-50 p-4">
      <span className="rounded-full bg-white p-2 text-sky-600"><Sparkles size={18} /></span>
      <div className="min-w-64 flex-1"><h3 className="text-sm font-semibold">Recommended ARIA behaviour</h3><p className="text-xs text-slate-600">Resets the persona, qualification questions and escalation thresholds to the recommended sales configuration. Your company details, business hours, provider, connected account and every automation template are left untouched — customer-facing wording is edited on the Templates tab.</p></div>
      <Button disabled={applyTemplate.isPending} onClick={() => confirm('Reset the persona, qualification questions and escalation rules to the recommended configuration?') && applyTemplate.mutate()}><Sparkles size={14} />{applyTemplate.isPending ? 'Applying…' : 'Apply recommended behaviour'}</Button>
    </section>
    {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>}
    <section className="panel space-y-3 p-4">
      <h3 className="text-sm font-semibold">Identity</h3>
      <div className="grid grid-cols-2 gap-3">
        <label><span className="label">Agent name</span><input className="field" value={form.agentName} onChange={e => set('agentName', e.target.value)} /></label>
        <label><span className="label">Agent role</span><input className="field" value={form.agentRole} onChange={e => set('agentRole', e.target.value)} /></label>
        <label><span className="label">Company name</span><input className="field" value={form.companyName} onChange={e => set('companyName', e.target.value)} /></label>
        <label><span className="label">Tone</span><select className="field" value={form.tone} onChange={e => set('tone', e.target.value as AIConfig['tone'])}><option>Professional</option><option>Friendly</option><option>Casual</option><option>Sales-focused</option><option>Custom</option></select></label>
      </div>
      {form.tone === 'Custom' && <label><span className="label">Custom tone instructions</span><input className="field" value={form.customTone ?? ''} onChange={e => set('customTone', e.target.value)} /></label>}
      <label><span className="label">Company description</span><textarea className="field" rows={2} value={form.companyDescription ?? ''} onChange={e => set('companyDescription', e.target.value)} /></label>
      <label><span className="label">Default language</span><select className="field" value={form.language} onChange={e => set('language', e.target.value as AIConfig['language'])}><option value="auto">Auto-detect (English / Hindi / Hinglish)</option><option value="en">English</option><option value="hi">Hindi</option><option value="hinglish">Hinglish</option></select></label>
    </section>

    <section className="panel space-y-3 p-4">
      <h3 className="text-sm font-semibold">Qualification questions</h3>
      <p className="text-xs text-slate-500">Asked naturally, one at a time — never all at once.</p>
      {form.qualificationQuestions.map((q, i) => <div key={i} className="flex items-center gap-2"><input className="field flex-1" value={q} onChange={e => set('qualificationQuestions', form.qualificationQuestions.map((x, j) => (j === i ? e.target.value : x)))} /><button className="text-slate-400 hover:text-red-600" onClick={() => set('qualificationQuestions', form.qualificationQuestions.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div>)}
      <div className="flex gap-2"><input className="field flex-1" placeholder="Add a question…" value={question} onChange={e => setQuestion(e.target.value)} /><Button onClick={() => { if (question.trim()) { set('qualificationQuestions', [...form.qualificationQuestions, question.trim()]); setQuestion(''); } }}><Plus size={14} />Add</Button></div>
    </section>

    <section className="panel space-y-3 p-4">
      <h3 className="text-sm font-semibold">Business hours</h3>
      <label className="block max-w-xs"><span className="label">Timezone</span><input className="field" value={form.businessHours?.timezone ?? 'Asia/Kolkata'} onChange={e => set('businessHours', { timezone: e.target.value, days })} /></label>
      <div className="space-y-1">{DAY_LABELS.map((label, d) => { const day = dayFor(d); return <div key={d} className="flex items-center gap-3 text-xs">
        <label className="flex w-20 items-center gap-1.5"><input type="checkbox" checked={day?.enabled ?? false} onChange={e => setDay(d, { enabled: e.target.checked })} />{label}</label>
        <input type="time" className="field h-8 w-28" disabled={!day?.enabled} value={day?.start ?? '09:30'} onChange={e => setDay(d, { start: e.target.value })} />
        <span>to</span>
        <input type="time" className="field h-8 w-28" disabled={!day?.enabled} value={day?.end ?? '18:30'} onChange={e => setDay(d, { end: e.target.value })} />
      </div>; })}</div>
    </section>

    <section className="panel space-y-3 p-4">
      <h3 className="text-sm font-semibold">Auto-greet new CRM leads</h3>
      <p className="text-xs text-slate-500">When a lead with a phone number is created in the CRM, WhatsApp them automatically. WhatsApp only allows business-initiated messages via an <b>approved template</b>; the service list with links is sent right after they reply, once the 24-hour window opens.</p>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.autoGreetNewLeads === true} onChange={e => set('autoGreetNewLeads', e.target.checked)} />Send a WhatsApp greeting when a lead is added</label>
      <label className="block"><span className="label">Meta greeting template (must be approved)</span>
        <select className="field" value={form.autoGreetTemplate ?? ''} onChange={e => set('autoGreetTemplate', e.target.value)}>
          <option value="">— Select a template —</option>
          {approvedTemplates.map(t => <option key={t._id} value={t._id}>{t.templateName} ({t.language})</option>)}
        </select>
        {form.autoGreetNewLeads && !form.autoGreetTemplate && <span className="mt-1 block text-[11px] text-amber-600">Pick a template, or nothing will be sent.</span>}
        {!approvedTemplates.length && <span className="mt-1 block text-[11px] text-amber-600">No approved Meta templates yet — sync or add one on the Broadcasts tab.</span>}
      </label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.sendServiceListOnReply !== false} onChange={e => set('sendServiceListOnReply', e.target.checked)} />Send the service list when they reply</label>
      <p className="text-[11px] text-slate-400">The list is built from your Knowledge Base products and services — add a link to each one there and it appears here. The wording around it is the <b>service_catalogue</b> template.</p>
    </section>

    <section className="panel space-y-3 p-4">
      <h3 className="text-sm font-semibold">Customer choice (WhatsApp buttons)</h3>
      <p className="text-xs text-slate-500">Lets the customer pick AI or a human from buttons in their own WhatsApp, instead of the AI having to infer it from their wording.</p>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.welcomeMenuEnabled !== false} onChange={e => set('welcomeMenuEnabled', e.target.checked)} />Send a welcome menu on the first message</label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.humanHandoffButtonEnabled !== false} onChange={e => set('humanHandoffButtonEnabled', e.target.checked)} />Include a “talk to a human” button</label>
      <div className="grid grid-cols-2 gap-3">
        {([['question', 'Question button'], ['pricing', 'Pricing button'], ['human', 'Human button'], ['ai', 'Back-to-AI button']] as const).map(([key, label]) =>
          <label key={key}><span className="label">{label}</span>
            <input className="field" maxLength={20} value={form.menuButtonLabels?.[key] ?? ''} placeholder={key === 'question' ? 'Ask a question' : key === 'pricing' ? 'Pricing' : key === 'human' ? 'Talk to a human' : 'Back to AI'}
              onChange={e => set('menuButtonLabels', { ...form.menuButtonLabels, [key]: e.target.value })} />
          </label>)}
      </div>
      <p className="text-[11px] text-slate-400">WhatsApp caps button labels at 20 characters and allows 3 buttons per message. The buttons ARIA actually sends are configured on each template; these labels are the defaults used when a template defines none.</p>
      <p className="text-[11px] text-slate-400">The wording that accompanies a handoff or a return to ARIA lives in the <b>human_handoff</b> and <b>ai_resumed</b> templates.</p>
    </section>

    <section className="panel space-y-3 p-4">
      <h3 className="text-sm font-semibold">Model & behavior</h3>
      <div className="grid grid-cols-2 gap-3">
        <label><span className="label">Provider</span><select className="field" value={form.provider} onChange={e => set('provider', e.target.value as AIConfig['provider'])}><option value="mock">Mock (no API key needed)</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option></select></label>
        <label><span className="label">Model (optional override)</span><input className="field" placeholder="e.g. claude-sonnet-5" value={form.aiModel ?? ''} onChange={e => set('aiModel', e.target.value)} /></label>
        <label><span className="label">Creativity ({form.creativity.toFixed(2)})</span><input type="range" min={0} max={1} step={0.05} className="w-full" value={form.creativity} onChange={e => set('creativity', Number(e.target.value))} /></label>
        <label><span className="label">Max response length (chars)</span><input type="number" className="field" value={form.maxResponseLength} onChange={e => set('maxResponseLength', Number(e.target.value))} /></label>
        <label><span className="label">Max AI messages before escalation</span><input type="number" className="field" value={form.maxAiMessagesBeforeEscalation} onChange={e => set('maxAiMessagesBeforeEscalation', Number(e.target.value))} /></label>
      </div>
      <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={form.globalAiEnabled} onChange={e => set('globalAiEnabled', e.target.checked)} />Global AI Auto-Reply ON</label>
    </section>

    <section className="panel space-y-3 p-4">
      <h3 className="text-sm font-semibold">Lead scoring</h3>
      <p className="text-xs text-slate-500">Points ARIA adds when it detects each signal, capped at 100, plus the score at which a lead becomes Warm, Qualified or Hot. Crossing the Hot threshold fires the internal hot-lead alert.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {([['requestedPricing', 'Requested pricing'], ['requestedDemo', 'Requested a demo'], ['requestedQuotation', 'Requested a quotation'], ['providedBudget', 'Provided a budget'], ['timelineUnder30Days', 'Timeline under 30 days'], ['providedCompany', 'Provided a company'], ['providedEmail', 'Provided an email'], ['repeatedEngagement', 'Repeated engagement'], ['requestedHuman', 'Asked for a human']] as const).map(([key, text]) =>
          <label key={key}><span className="label">{text}</span>
            <input type="number" min={0} max={100} className="field" value={scoring[key] ?? 0}
              onChange={e => set('leadScoring', { ...scoring, [key]: Number(e.target.value) })} />
          </label>)}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {([['warmThreshold', 'Warm from'], ['qualifiedThreshold', 'Qualified from'], ['hotThreshold', 'Hot from']] as const).map(([key, text]) =>
          <label key={key}><span className="label">{text}</span>
            <input type="number" min={0} max={100} className="field" value={scoring[key] ?? 0}
              onChange={e => set('leadScoring', { ...scoring, [key]: Number(e.target.value) })} />
          </label>)}
      </div>
    </section>

    <section className="panel space-y-2 p-4">
      <h3 className="text-sm font-semibold">Human escalation rules</h3>
      {[['onHumanRequest', 'Customer explicitly asks for a human'], ['onNegativeSentiment', 'Customer sentiment turns negative'], ['onSeriousComplaint', 'Customer reports a serious complaint'], ['onComplexPricing', 'Complex pricing negotiation is detected'], ['onVipLead', 'High-value / VIP lead is detected'], ['onLowConfidence', 'AI confidence is too low to continue safely']].map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(rules[key as keyof typeof rules])} onChange={e => setRule(key as keyof typeof rules, e.target.checked)} />{label}</label>)}
      <div className="grid grid-cols-2 gap-3 pt-2">
        <label><span className="label">VIP lead score threshold</span><input type="number" className="field" value={rules.vipLeadScoreThreshold} onChange={e => setRule('vipLeadScoreThreshold', Number(e.target.value))} /></label>
        <label><span className="label">Low confidence threshold</span><input type="number" step={0.05} className="field" value={rules.lowConfidenceThreshold} onChange={e => setRule('lowConfidenceThreshold', Number(e.target.value))} /></label>
      </div>
    </section>

    <div className="flex items-center gap-3"><Button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate(form)}>{save.isPending ? 'Saving…' : 'Save settings'}</Button>{saved && <span className="text-xs font-semibold text-emerald-600">Saved</span>}</div>
  </div>;
}

export function Accounts() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['wa-accounts'], queryFn: () => api<WhatsAppAccountRow[]>('/whatsapp/accounts') });
  const [form, setForm] = useState({ label: '', phoneNumberId: '', businessAccountId: '', displayPhoneNumber: '' });
  const [error, setError] = useState('');
  const create = useMutation({ mutationFn: () => api('/whatsapp/accounts', { method: 'POST', body: JSON.stringify(form) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['wa-accounts'] }); setForm({ label: '', phoneNumberId: '', businessAccountId: '', displayPhoneNumber: '' }); }, onError: (e: any) => setError(e?.message ?? 'Could not save.') });
  const remove = useMutation({ mutationFn: (id: string) => api(`/whatsapp/accounts/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-accounts'] }) });
  const subscription = useQuery({ queryKey: ['wa-webhook-subscription'], queryFn: () => api<{ ok: boolean; configured: boolean; subscribed: boolean; apps?: { id?: string; name?: string }[]; phoneNumberMatched?: boolean; phoneNumbers?: { id?: string; displayPhoneNumber?: string; verifiedName?: string }[]; error?: string }>('/whatsapp/webhook-subscription') });
  const enableInbound = useMutation({
    mutationFn: () => api<{ subscribed: boolean }>('/whatsapp/webhook-subscription', { method: 'POST' }),
    onMutate: () => setError(''),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-webhook-subscription'] }),
    onError: (e: any) => setError(e?.message ?? 'Meta could not subscribe this app.'),
  });

  return <div className="max-w-2xl space-y-4">
    <div className="rounded border border-sky-100 bg-sky-50 p-3 text-xs text-sky-900">The live access token is read from the <code>WHATSAPP_ACCESS_TOKEN</code> server environment variable, never stored here or sent to the browser. This list is for tracking which Meta phone numbers are connected.</div>
    <div className={`rounded border p-3 text-xs ${subscription.data?.subscribed ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
      <div className="flex items-center justify-between gap-3">
        <div><b>Inbound message delivery:</b> {subscription.isLoading ? 'Checking Meta…' : subscription.data?.subscribed ? `Enabled${subscription.data.apps?.[0]?.name ? ` for ${subscription.data.apps[0].name}` : ''}` : 'Not enabled'}</div>
        {!subscription.data?.subscribed && <Button className="h-8" disabled={enableInbound.isPending || subscription.isLoading} onClick={() => enableInbound.mutate()}>{enableInbound.isPending ? 'Enabling…' : 'Enable inbound messages'}</Button>}
      </div>
      {!subscription.isLoading && !subscription.data?.subscribed && <p className="mt-1">Callback verification alone is not enough. This subscribes the Meta app to the configured WhatsApp Business Account.</p>}
      {subscription.data?.subscribed && subscription.data.phoneNumberMatched === false && <p className="mt-1 text-red-700">The configured Phone Number ID does not belong to this WhatsApp Business Account. Update the deployment environment with the matching WABA ID.</p>}
      {subscription.data?.error && <p className="mt-1 text-red-700">{subscription.data.error}</p>}
    </div>
    <div className="panel space-y-2 p-4">
      <div className="grid grid-cols-2 gap-2"><input className="field" placeholder="Label" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} /><input className="field" placeholder="Display phone number" value={form.displayPhoneNumber} onChange={e => setForm({ ...form, displayPhoneNumber: e.target.value })} /><input className="field" placeholder="Phone Number ID" value={form.phoneNumberId} onChange={e => setForm({ ...form, phoneNumberId: e.target.value })} /><input className="field" placeholder="Business Account ID" value={form.businessAccountId} onChange={e => setForm({ ...form, businessAccountId: e.target.value })} /></div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <Button className="btn-primary h-8" disabled={create.isPending || !form.label || !form.phoneNumberId} onClick={() => create.mutate()}><Plus size={14} />Add account</Button>
    </div>
    {accounts.isLoading ? <Loading /> : !accounts.data?.length ? <Empty title="No accounts registered" detail="Add the WhatsApp Business phone number connected via WHATSAPP_PHONE_NUMBER_ID." /> : <div className="panel divide-y">{accounts.data.map(a => <div key={a._id} className="flex items-center gap-3 p-3 text-sm"><div className="flex-1"><b>{a.label}</b> <span className="text-xs text-slate-400">{a.displayPhoneNumber}</span></div><RowMenu busy={remove.isPending} onDelete={() => confirm('Remove this account?') && remove.mutate(a._id)} /></div>)}</div>}
  </div>;
}
