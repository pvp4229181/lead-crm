import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { BarChart3, CalendarDays, ClipboardCheck, ContactRound, CornerDownLeft, Gauge, KanbanSquare, MessageCircle, Search, Settings, UsersRound } from 'lucide-react';
import { api, money } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import type { Lead, Opportunity, Paged, WAConversation } from '../lib/types';

type Result = { id: string; group: string; title: string; detail: string; to: string; Icon: typeof Search };

const PAGES: Result[] = [
  { id: 'p-dashboard', group: 'Go to', title: 'Dashboard', detail: 'Pipeline and activity overview', to: '/', Icon: Gauge },
  { id: 'p-pipeline', group: 'Go to', title: 'Pipeline', detail: 'Kanban of open opportunities', to: '/pipeline', Icon: KanbanSquare },
  { id: 'p-leads', group: 'Go to', title: 'Leads', detail: 'All lead records', to: '/leads', Icon: ContactRound },
  { id: 'p-whatsapp', group: 'Go to', title: 'WhatsApp Inbox', detail: 'Conversations and the AI agent', to: '/whatsapp', Icon: MessageCircle },
  { id: 'p-activities', group: 'Go to', title: 'Activities', detail: 'Planned and overdue work', to: '/activities', Icon: ClipboardCheck },
  { id: 'p-calendar', group: 'Go to', title: 'Calendar', detail: 'Activities by date', to: '/calendar', Icon: CalendarDays },
  { id: 'p-contacts', group: 'Go to', title: 'Contacts', detail: 'People and companies', to: '/contacts', Icon: UsersRound },
  { id: 'p-reporting', group: 'Go to', title: 'Reporting', detail: 'Opportunity analysis', to: '/reporting', Icon: BarChart3 },
  { id: 'p-configuration', group: 'Go to', title: 'Configuration', detail: 'Users, roles and master data', to: '/configuration', Icon: Settings },
];

/**
 * Command palette behind the header's search button and Ctrl/Cmd-K. Searches the three
 * record types a salesperson jumps between, and doubles as keyboard navigation.
 */
export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const query = useDebounced(term.trim(), 250);
  const listRef = useRef<HTMLDivElement>(null);

  const enabled = query.length >= 2;
  const leads = useQuery({ queryKey: ['search-leads', query], enabled, queryFn: () => api<Paged<Lead>>(`/leads?limit=5&search=${encodeURIComponent(query)}`) });
  const deals = useQuery({ queryKey: ['search-deals', query], enabled, queryFn: () => api<Paged<Opportunity>>(`/opportunities?limit=5&search=${encodeURIComponent(query)}`) });
  const chats = useQuery({ queryKey: ['search-chats', query], enabled, queryFn: () => api<Paged<WAConversation>>(`/whatsapp/conversations?filter=all&limit=5&search=${encodeURIComponent(query)}`) });

  const results = useMemo<Result[]>(() => {
    const lowered = query.toLowerCase();
    const pages = PAGES.filter(page => !lowered || page.title.toLowerCase().includes(lowered));
    if (!enabled) return pages;
    return [
      ...(leads.data?.data ?? []).map<Result>(lead => ({ id: `l-${lead._id}`, group: 'Leads', title: lead.title, detail: [lead.contactName, lead.companyName, lead.phone].filter(Boolean).join(' · ') || 'Lead', to: '/leads', Icon: ContactRound })),
      ...(deals.data?.data ?? []).map<Result>(deal => ({ id: `o-${deal._id}`, group: 'Opportunities', title: deal.title, detail: `${deal.stage?.name ?? 'No stage'} · ${money(deal.expectedRevenue)}`, to: `/opportunities/${deal._id}`, Icon: KanbanSquare })),
      ...(chats.data?.data ?? []).map<Result>(chat => ({ id: `c-${chat._id}`, group: 'Conversations', title: chat.customerName || chat.phoneNumber, detail: chat.lastMessage || chat.phoneNumber, to: '/whatsapp', Icon: MessageCircle })),
      ...pages,
    ];
  }, [enabled, query, leads.data, deals.data, chats.data]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => { listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const go = (result?: Result) => { if (!result) return; navigate(result.to); onClose(); };
  const loading = enabled && (leads.isFetching || deals.isFetching || chats.isFetching);

  let lastGroup = '';
  return <div className="fixed inset-0 z-[80] flex items-start justify-center bg-slate-900/40 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="animate-pop w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
      <div className="flex items-center gap-2 border-b px-4">
        <Search size={16} className="shrink-0 text-slate-400" />
        <input
          autoFocus
          className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
          placeholder="Search leads, opportunities, conversations…"
          value={term}
          onChange={event => setTerm(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, results.length - 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
            else if (event.key === 'Enter') { event.preventDefault(); go(results[active]); }
            else if (event.key === 'Escape') onClose();
          }}
        />
        {loading && <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-200 border-t-[#0284c7]" />}
        <kbd className="hidden shrink-0 rounded border bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 sm:block">Esc</kbd>
      </div>

      <div ref={listRef} className="scrollbar-thin max-h-80 overflow-y-auto py-1">
        {results.map((result, index) => {
          const header = result.group !== lastGroup ? result.group : '';
          lastGroup = result.group;
          return <div key={result.id}>
            {header && <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{header}</div>}
            <button
              data-active={index === active}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${index === active ? 'bg-[#f0f9ff]' : 'hover:bg-slate-50'}`}
              onMouseMove={() => setActive(index)}
              onClick={() => go(result)}
            >
              <result.Icon size={15} className={index === active ? 'text-[#0284c7]' : 'text-slate-400'} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-slate-800">{result.title}</span>
                <span className="block truncate text-[11px] text-slate-500">{result.detail}</span>
              </span>
              {index === active && <CornerDownLeft size={13} className="shrink-0 text-slate-300" />}
            </button>
          </div>;
        })}
        {!results.length && <p className="px-4 py-8 text-center text-xs text-slate-400">{enabled ? `Nothing matches “${query}”.` : 'Type at least two characters to search records.'}</p>}
      </div>

      <div className="flex items-center gap-3 border-t bg-slate-50 px-4 py-2 text-[10px] text-slate-400">
        <span><kbd className="font-semibold">↑↓</kbd> navigate</span>
        <span><kbd className="font-semibold">↵</kbd> open</span>
        <span className="ml-auto">Leads · Opportunities · Conversations</span>
      </div>
    </div>
  </div>;
}
