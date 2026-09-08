import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Archive, Bot, Flame, Inbox, PenSquare, Search, Settings as SettingsIcon, UserCheck, WifiOff, X } from 'lucide-react';
import { api } from '../lib/api';
import type { Paged, WAConversation } from '../lib/types';
import { useAuth } from '../context/Auth';
import { useDebounced, useLiveInterval, useMediaQuery, useRealtimeConnected, useSocketEvents } from '../lib/hooks';
import { ChatPanel } from './whatsapp/ChatPanel';
import { LeadPanel } from './whatsapp/LeadPanel';
import { NewConversation } from './whatsapp/NewConversation';

const FILTERS = [
  { key: 'all', label: 'All', icon: Inbox },
  { key: 'unread', label: 'Unread', icon: Inbox },
  { key: 'ai', label: 'AI Handling', icon: Bot },
  { key: 'human', label: 'Human Handling', icon: UserCheck },
  { key: 'hot', label: 'Hot Leads', icon: Flame },
  { key: 'archived', label: 'Archived', icon: Archive },
] as const;

const time = (v?: string) => {
  if (!v) return '';
  const at = new Date(v);
  const sameDay = new Date().toDateString() === at.toDateString();
  return new Intl.DateTimeFormat('en-US', sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' }).format(at);
};
const TEMP_DOT: Record<string, string> = { Cold: 'bg-slate-300', Warm: 'bg-amber-400', Hot: 'bg-orange-500', 'Very Hot': 'bg-red-500' };

function ConversationSkeleton() {
  return <div className="space-y-px">{Array.from({ length: 6 }, (_, index) => <div className="flex gap-2.5 border-b p-3" key={index}>
    <div className="skeleton h-8 w-8 shrink-0 rounded-full"/>
    <div className="flex-1 space-y-2 py-0.5"><div className="skeleton h-2.5 w-1/2 rounded"/><div className="skeleton h-2.5 w-4/5 rounded"/></div>
  </div>)}</div>;
}

export default function WhatsApp() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<typeof FILTERS[number]['key']>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [showLead, setShowLead] = useState(false);

  const query = useDebounced(search.trim(), 300);
  const live = useRealtimeConnected();
  const wide = useMediaQuery('(min-width: 768px)');
  const listInterval = useLiveInterval(5000, 30000);

  const params = useMemo(() => new URLSearchParams({ filter, search: query }).toString(), [filter, query]);
  const conversations = useQuery({
    queryKey: ['wa-conversations', filter, query],
    queryFn: () => api<Paged<WAConversation>>(`/whatsapp/conversations?${params}`),
    refetchInterval: listInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    placeholderData: previous => previous,
  });

  useSocketEvents({
    'message:new': () => qc.invalidateQueries({ queryKey: ['wa-conversations'] }),
    'conversation:updated': () => { qc.invalidateQueries({ queryKey: ['wa-conversations'] }); qc.invalidateQueries({ queryKey: ['wa-conversation'] }); },
    'conversation:read': () => qc.invalidateQueries({ queryKey: ['wa-conversations'] }),
  });

  const list = useMemo(() => conversations.data?.data ?? [], [conversations.data]);
  // Auto-opening the first chat only makes sense in the split layout; on a phone the list
  // is the whole screen and the user has not chosen anything yet.
  useEffect(() => { if (wide && !selectedId && list.length) setSelectedId(list[0]!._id); }, [wide, list, selectedId]);

  const selected = list.find(c => c._id === selectedId);
  // `messages=0` keeps this to the conversation header and lead panel; the message list is
  // owned by ChatPanel, which has its own live feed.
  const detail = useQuery({
    queryKey: ['wa-conversation', selectedId],
    queryFn: () => api<{ conversation: WAConversation }>(`/whatsapp/conversations/${selectedId}?messages=0`),
    enabled: Boolean(selectedId),
    refetchInterval: listInterval,
    refetchIntervalInBackground: false,
  });
  const active = detail.data?.conversation ?? selected;

  const canManage = user && ['Administrator', 'Sales Manager'].includes(user.role.name);
  const unreadTotal = list.reduce((sum, item) => sum + (item.unreadCount || 0), 0);

  const close = () => { setSelectedId(null); setShowLead(false); };

  return <div className="grid h-[calc(100vh-44px)] grid-rows-[100%] overflow-hidden md:grid-cols-[280px_1fr] xl:grid-cols-[300px_1fr_340px]">
    <aside className={`min-h-0 flex-col border-r bg-white ${selectedId ? 'hidden md:flex' : 'flex'}`}>
      <div className="flex items-center gap-2 border-b p-3">
        <h2 className="text-sm font-semibold">WhatsApp</h2>
        {unreadTotal > 0 && <span className="badge bg-[#25d366] text-white">{unreadTotal}</span>}
        {!live && <span title="Live updates unavailable — falling back to polling" className="text-amber-500"><WifiOff size={13}/></span>}
        <div className="ml-auto flex items-center gap-1">
          <button className="rounded p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800" title="Start a conversation with a lead" onClick={() => setComposing(true)}><PenSquare size={16}/></button>
          {canManage && <Link to="/whatsapp/settings" className="rounded p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800" title="WhatsApp AI settings"><SettingsIcon size={16}/></Link>}
        </div>
      </div>

      <div className="border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={14}/>
          <input className="field search-field h-8 pr-8" placeholder="Search conversations…" value={search} onChange={e => setSearch(e.target.value)}/>
          {search && <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-700" aria-label="Clear search" onClick={() => setSearch('')}><X size={13}/></button>}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b p-2">
        {FILTERS.map(f => <button key={f.key} className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${filter === f.key ? 'bg-[#0ea5e9] text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`} onClick={() => setFilter(f.key)}>{f.label}</button>)}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {conversations.isLoading && <ConversationSkeleton/>}
        {list.map(c => <button key={c._id} onClick={() => { setSelectedId(c._id); setShowLead(false); }} className={`flex w-full items-start gap-2.5 border-b p-3 text-left transition-colors hover:bg-slate-50 ${selectedId === c._id ? 'bg-[#f0f9ff] shadow-[inset_3px_0_0_#0ea5e9]' : ''}`}>
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#e0f2fe] text-[10px] font-bold text-[#0284c7]">{(c.customerName ?? c.phoneNumber).slice(0, 2).toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2"><b className="truncate text-xs">{c.customerName || c.phoneNumber}</b><span className="shrink-0 text-[10px] text-slate-400">{time(c.lastMessageAt)}</span></span>
            <span className={`mt-0.5 block truncate text-[11px] ${c.unreadCount > 0 ? 'font-semibold text-slate-700' : 'text-slate-500'}`}>{c.lastMessage || 'No messages yet'}</span>
            <span className="mt-1 flex items-center gap-1.5">
              {c.lead && <span className={`h-1.5 w-1.5 rounded-full ${TEMP_DOT[c.lead.leadTemperature]}`} title={c.lead.leadTemperature}/>}
              <span className="truncate text-[10px] text-slate-400">{c.assignedTo?.name ?? 'Unassigned'}</span>
              {c.unreadCount > 0 && <span className="ml-auto shrink-0 rounded-full bg-[#25d366] px-1.5 py-0.5 text-[10px] font-bold text-white">{c.unreadCount}</span>}
            </span>
          </span>
        </button>)}
        {!conversations.isLoading && !list.length && <div className="p-6 text-center text-xs text-slate-400">
          {query ? <>No conversations match “{query}”.</> : <>No conversations here yet.
            <button className="mt-2 block w-full font-semibold text-[#0284c7] transition-colors hover:text-[#0369a1] hover:underline" onClick={() => setComposing(true)}>Start one with a lead</button></>}
        </div>}
      </div>
    </aside>

    {composing && <NewConversation onClose={() => setComposing(false)} onSent={id => setSelectedId(id)}/>}

    {active
      ? <ChatPanel
          conversation={active}
          onBack={close}
          onToggleLead={() => setShowLead(value => !value)}
          onDeleted={() => {
            // Drop it from every cached filter view first: the auto-select effect above runs
            // before the refetch lands and would otherwise re-select the chat we just deleted.
            const gone = selectedId;
            close();
            qc.setQueriesData<Paged<WAConversation>>({ queryKey: ['wa-conversations'] }, prev => (prev ? { ...prev, data: prev.data.filter(c => c._id !== gone) } : prev));
          }}
        />
      : <div className="hidden items-center justify-center bg-white text-sm text-slate-400 md:flex">Select a conversation</div>}

    {/* In-grid on wide screens; a dismissible drawer everywhere else. */}
    {active
      ? <div className="hidden xl:block"><LeadPanel conversation={active}/></div>
      : <div className="hidden border-l bg-white xl:block"/>}
    {active && showLead && <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30 xl:hidden" onMouseDown={event => event.target === event.currentTarget && setShowLead(false)}>
      <div className="animate-slide-left flex h-full w-80 max-w-full flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <b className="text-sm">Lead details</b>
          <button className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-100" aria-label="Close lead details" onClick={() => setShowLead(false)}><X size={16}/></button>
        </div>
        <div className="min-h-0 flex-1"><LeadPanel conversation={active} embedded/></div>
      </div>
    </div>}
  </div>;
}
