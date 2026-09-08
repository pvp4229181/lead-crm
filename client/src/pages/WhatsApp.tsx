import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Archive, Bot, Flame, PenSquare, Search, Settings as SettingsIcon, UserCheck } from 'lucide-react';
import { api } from '../lib/api';
import type { Paged, WAConversation } from '../lib/types';
import { useAuth } from '../context/Auth';
import { Loading } from '../components/ui';
import { getSocket } from '../lib/socket';
import { ChatPanel } from './whatsapp/ChatPanel';
import { LeadPanel } from './whatsapp/LeadPanel';
import { NewConversation } from './whatsapp/NewConversation';

const FILTERS = [
  { key: 'all', label: 'All', icon: Search },
  { key: 'unread', label: 'Unread', icon: Search },
  { key: 'ai', label: 'AI Handling', icon: Bot },
  { key: 'human', label: 'Human Handling', icon: UserCheck },
  { key: 'hot', label: 'Hot Leads', icon: Flame },
  { key: 'archived', label: 'Archived', icon: Archive },
] as const;

const time = (v?: string) => (v ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(v)) : '');
const TEMP_DOT: Record<string, string> = { Cold: 'bg-slate-300', Warm: 'bg-amber-400', Hot: 'bg-orange-500', 'Very Hot': 'bg-red-500' };

export default function WhatsApp() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<typeof FILTERS[number]['key']>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const params = new URLSearchParams({ filter, search });
  const conversations = useQuery({ queryKey: ['wa-conversations', filter, search], queryFn: () => api<Paged<WAConversation>>(`/whatsapp/conversations?${params.toString()}`), refetchInterval: 5000, refetchIntervalInBackground: false, refetchOnWindowFocus: 'always' });

  useEffect(() => {
    const socket = getSocket();
    const refresh = () => qc.invalidateQueries({ queryKey: ['wa-conversations'] });
    socket.on('message:new', refresh); socket.on('conversation:updated', refresh); socket.on('conversation:read', refresh);
    return () => { socket.off('message:new', refresh); socket.off('conversation:updated', refresh); socket.off('conversation:read', refresh); };
  }, [qc]);

  const list = conversations.data?.data ?? [];
  useEffect(() => { if (!selectedId && list.length) setSelectedId(list[0]!._id); }, [list, selectedId]);
  const selected = list.find(c => c._id === selectedId);
  const detail = useQuery({ queryKey: ['wa-conversation', selectedId], queryFn: () => api<{ conversation: WAConversation }>(`/whatsapp/conversations/${selectedId}`), enabled: Boolean(selectedId), refetchInterval: 5000, refetchIntervalInBackground: false, refetchOnWindowFocus: 'always' });
  const active = detail.data?.conversation ?? selected;

  const canManage = user && ['Administrator', 'Sales Manager'].includes(user.role.name);

  return <div className="grid h-[calc(100vh-44px)] grid-rows-[100%] grid-cols-[300px_1fr_320px] overflow-hidden">
    <aside className="flex min-h-0 flex-col border-r bg-white">
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-sm font-semibold">WhatsApp</h2>
        <div className="flex items-center gap-2">
          <button className="text-slate-500 hover:text-slate-800" title="Start a conversation with a lead" onClick={() => setComposing(true)}><PenSquare size={16} /></button>
          {canManage && <Link to="/whatsapp/settings" className="text-slate-500 hover:text-slate-800" title="WhatsApp AI settings"><SettingsIcon size={16} /></Link>}
        </div>
      </div>
      <div className="border-b p-2"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={14} /><input className="field search-field h-8" placeholder="Search conversations…" value={search} onChange={e => setSearch(e.target.value)} /></div></div>
      <div className="flex flex-wrap gap-1 border-b p-2">{FILTERS.map(f => <button key={f.key} className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${filter === f.key ? 'bg-[#0ea5e9] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`} onClick={() => setFilter(f.key)}>{f.label}</button>)}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversations.isLoading && <Loading />}
        {list.map(c => <button key={c._id} onClick={() => setSelectedId(c._id)} className={`flex w-full items-start gap-2.5 border-b p-3 text-left hover:bg-slate-50 ${selectedId === c._id ? 'bg-[#f0f9ff]' : ''}`}>
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#e0f2fe] text-[10px] font-bold text-[#0284c7]">{(c.customerName ?? c.phoneNumber).slice(0, 2).toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2"><b className="truncate text-xs">{c.customerName || c.phoneNumber}</b><span className="shrink-0 text-[10px] text-slate-400">{time(c.lastMessageAt)}</span></span>
            <span className="mt-0.5 block truncate text-[11px] text-slate-500">{c.lastMessage || 'No messages yet'}</span>
            <span className="mt-1 flex items-center gap-1.5">
              {c.lead && <span className={`h-1.5 w-1.5 rounded-full ${TEMP_DOT[c.lead.leadTemperature]}`} title={c.lead.leadTemperature} />}
              <span className="text-[10px] text-slate-400">{c.assignedTo?.name ?? 'Unassigned'}</span>
              {c.unreadCount > 0 && <span className="ml-auto rounded-full bg-[#25d366] px-1.5 py-0.5 text-[10px] font-bold text-white">{c.unreadCount}</span>}
            </span>
          </span>
        </button>)}
        {!conversations.isLoading && !list.length && <div className="p-6 text-center text-xs text-slate-400">
          No conversations here yet.
          <button className="mt-2 block w-full font-semibold text-[#0284c7] hover:underline" onClick={() => setComposing(true)}>Start one with a lead</button>
        </div>}
      </div>
    </aside>
    {composing && <NewConversation onClose={() => setComposing(false)} onSent={id => setSelectedId(id)} />}

    {active ? <ChatPanel conversation={active} onDeleted={() => {
      // Drop it from every cached filter view first: the auto-select effect below runs
      // before the refetch lands and would otherwise re-select the chat we just deleted.
      const gone = selectedId;
      setSelectedId(null);
      qc.setQueriesData<Paged<WAConversation>>({ queryKey: ['wa-conversations'] }, prev => (prev ? { ...prev, data: prev.data.filter(c => c._id !== gone) } : prev));
    }} /> : <div className="flex items-center justify-center bg-white text-sm text-slate-400">Select a conversation</div>}
    {active ? <LeadPanel conversation={active} /> : <div className="w-80 shrink-0 border-l bg-white" />}
  </div>;
}
