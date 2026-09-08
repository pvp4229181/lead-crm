import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, money } from '../../lib/api';
import type { KBArticle, KBFaq, KBProduct, KBService } from '../../lib/types';
import { Button, Empty, Loading, Modal, RowMenu } from '../../components/ui';

type Kind = 'products' | 'services' | 'faqs' | 'articles';
const TABS: { key: Kind; label: string }[] = [{ key: 'products', label: 'Products' }, { key: 'services', label: 'Services' }, { key: 'faqs', label: 'FAQs' }, { key: 'articles', label: 'Knowledge Articles' }];

export default function Knowledge() {
  const [kind, setKind] = useState<Kind>('products');
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['kb', kind], queryFn: () => api<any[]>(`/whatsapp/knowledge/${kind}`) });
  const remove = useMutation({ mutationFn: (id: string) => api(`/whatsapp/knowledge/${kind}/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['kb', kind] }) });

  return <div>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {TABS.map(t => <button key={t.key} className={`rounded-full px-3 py-1 text-xs font-semibold ${kind === t.key ? 'bg-[#0ea5e9] text-white' : 'bg-slate-100 text-slate-600'}`} onClick={() => setKind(t.key)}>{t.label}</button>)}
      <Button className="btn-primary ml-auto h-8" onClick={() => setOpen(true)}><Plus size={14} />Add</Button>
    </div>
    {list.isLoading ? <Loading /> : !list.data?.length ? <Empty title="Nothing here yet" detail="Add content so the AI can answer accurately without guessing." /> : <div className="panel divide-y">
      {kind === 'products' || kind === 'services' ? (list.data as (KBProduct | KBService)[]).map(item => <div key={item._id} className="flex items-center gap-3 p-3 text-sm">
        <div className="min-w-0 flex-1"><b>{item.name}</b>{item.category && <span className="ml-2 text-xs text-slate-400">{item.category}</span>}<p className="truncate text-xs text-slate-500">{item.description}</p></div>
        {item.price != null && <span className="badge bg-emerald-100 text-emerald-700">{item.priceType === 'starting_at' ? 'from ' : ''}{money(item.price)}</span>}
        <RowMenu busy={remove.isPending} onDelete={() => confirm('Delete this record?') && remove.mutate(item._id)} />
      </div>) : kind === 'faqs' ? (list.data as KBFaq[]).map(item => <div key={item._id} className="flex items-start gap-3 p-3 text-sm">
        <div className="min-w-0 flex-1"><b>{item.question}</b><p className="mt-0.5 text-xs text-slate-500">{item.answer}</p></div>
        <RowMenu busy={remove.isPending} onDelete={() => confirm('Delete this FAQ?') && remove.mutate(item._id)} />
      </div>) : (list.data as KBArticle[]).map(item => <div key={item._id} className="flex items-start gap-3 p-3 text-sm">
        <div className="min-w-0 flex-1"><b>{item.title}</b><span className="ml-2 badge bg-slate-100 text-slate-500">{item.category}</span><p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{item.content}</p></div>
        <RowMenu busy={remove.isPending} onDelete={() => confirm('Delete this article?') && remove.mutate(item._id)} />
      </div>)}
    </div>}
    {open && <KnowledgeForm kind={kind} onClose={() => setOpen(false)} />}
  </div>;
}

function KnowledgeForm({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/whatsapp/knowledge/${kind}`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['kb', kind] }); onClose(); },
    onError: (e: any) => setError(e?.message ?? 'Could not save.'),
  });
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm(f => ({ ...f, [key]: e.target.value }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (kind === 'products' || kind === 'services') create.mutate({ name: form.name, description: form.description, category: form.category, price: form.price ? Number(form.price) : undefined, priceType: form.priceType || 'fixed', link: form.link || undefined });
    else if (kind === 'faqs') create.mutate({ question: form.question, answer: form.answer, category: form.category });
    else create.mutate({ title: form.title, content: form.content, category: form.category || 'other' });
  };
  return <Modal title={`Add ${kind === 'faqs' ? 'FAQ' : kind.slice(0, -1)}`} onClose={onClose} width="max-w-lg"><form onSubmit={submit}>
    <div className="space-y-3 p-5">
      {(kind === 'products' || kind === 'services') && <>
        <label><span className="label">Name</span><input required className="field" onChange={set('name')} /></label>
        <label><span className="label">Description</span><textarea className="field" rows={3} onChange={set('description')} /></label>
        <div className="grid grid-cols-2 gap-3"><label><span className="label">Category</span><input className="field" onChange={set('category')} /></label><label><span className="label">Price (₹)</span><input type="number" className="field" onChange={set('price')} /></label></div>
        <label><span className="label">Link (shown in the WhatsApp service list)</span><input className="field" type="url" placeholder="https://yoursite.com/service" onChange={set('link')} /></label>
        <label><span className="label">Price type</span><select className="field" onChange={set('priceType')}><option value="fixed">Fixed</option><option value="starting_at">Starting at</option><option value="custom">Custom / quote</option></select></label>
      </>}
      {kind === 'faqs' && <><label><span className="label">Question</span><input required className="field" onChange={set('question')} /></label><label><span className="label">Answer</span><textarea required className="field" rows={4} onChange={set('answer')} /></label><label><span className="label">Category</span><input className="field" onChange={set('category')} /></label></>}
      {kind === 'articles' && <><label><span className="label">Title</span><input required className="field" onChange={set('title')} /></label><label><span className="label">Content</span><textarea required className="field" rows={5} onChange={set('content')} /></label><label><span className="label">Category</span><select className="field" onChange={set('category')}><option value="other">Other</option><option value="policy">Policy</option><option value="company">Company</option><option value="pricing">Pricing</option><option value="sales_script">Sales script</option></select></label></>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
    <div className="flex justify-end gap-2 border-t bg-slate-50 p-3"><Button type="button" onClick={onClose}>Cancel</Button><Button className="btn-primary" disabled={create.isPending}>Save</Button></div>
  </form></Modal>;
}
