import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, BarChart3, Bell, CalendarDays, Check, ChevronDown, ClipboardCheck, ContactRound, Gauge, KanbanSquare, LogOut, MessageCircle, Menu, Search, Settings, Star, UsersRound, Workflow, X } from 'lucide-react';
import { useAuth } from '../context/Auth';
import { api } from '../lib/api';
import { useHotkey, useLiveInterval, useSocketEvents } from '../lib/hooks';
import { Avatar } from './ui';
import { GlobalSearch } from './GlobalSearch';

const nav = [['Dashboard','/',Gauge],['Pipeline','/pipeline',KanbanSquare],['Leads','/leads',ContactRound],['WhatsApp','/whatsapp',MessageCircle],['Automation','/whatsapp/automation',Workflow],['Activities','/activities',ClipboardCheck],['Calendar','/calendar',CalendarDays],['Contacts','/contacts',UsersRound],['Reporting','/reporting',BarChart3],['Configuration','/configuration',Settings]] as const;

export function Shell({ children }: { children: ReactNode }) {
  const [mobile, setMobile] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const { user, logout } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();

  // The badge has to react to notifications raised by the AI pipeline while the user sits
  // on another screen, so it listens on the socket and keeps a slow poll as the fallback
  // for serverless deployments where no socket exists.
  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ read: boolean }[]>('/notifications'),
    refetchInterval: useLiveInterval(30000, 120000),
    refetchIntervalInBackground: false,
  });
  useSocketEvents({ 'notification:new': () => queryClient.invalidateQueries({ queryKey: ['notifications'] }) });
  const unread = (notifications.data ?? []).filter(item => !item.read).length;

  useHotkey(event => (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k', () => setSearching(true));
  useEffect(() => { setMobile(false); setUserMenu(false); }, [location.pathname]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `relative flex h-full items-center px-3 text-[13px] transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors ${isActive ? 'bg-white/12 font-semibold after:bg-white' : 'text-white/85 hover:bg-white/8 hover:text-white after:bg-transparent'}`;

  return <div className="min-h-screen">
    <header className="sticky top-0 z-40 flex h-11 items-center bg-[#0ea5e9] px-3 text-white shadow-sm">
      <button className="mr-2 rounded p-1 transition-colors hover:bg-white/15 md:hidden" aria-label={mobile ? 'Close menu' : 'Open menu'} aria-expanded={mobile} onClick={() => setMobile(!mobile)}>{mobile ? <X size={19}/> : <Menu size={19}/>}</button>
      <NavLink to="/" className="mr-5 flex items-center gap-2 text-[15px] font-semibold tracking-tight">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-white/20 text-[13px] font-bold">L</span>
        <span className="hidden sm:block">Lead CRM</span>
      </NavLink>
      <nav className="hidden h-full items-center md:flex">{nav.slice(1).map(([label,to]) => <NavLink key={to} to={to} className={linkClass}>{label}</NavLink>)}</nav>
      <div className="ml-auto flex items-center gap-1">
        <button className="flex items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-white/15" title="Search everything (Ctrl+K)" onClick={() => setSearching(true)}>
          <Search size={16}/>
          <kbd className="hidden rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold lg:block">Ctrl K</kbd>
        </button>
        <NavLink to="/notifications" className="relative rounded p-2 transition-colors hover:bg-white/15" title={unread ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications'}>
          <Bell size={17}/>
          {unread > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-amber-950">{unread > 9 ? '9+' : unread}</span>}
        </NavLink>
        <div className="relative">
          <button onClick={() => setUserMenu(!userMenu)} className="ml-1 flex items-center gap-2 rounded py-1 pl-2 pr-1 transition-colors hover:bg-white/15" aria-haspopup="menu" aria-expanded={userMenu}>
            <Avatar name={user?.name}/><span className="hidden text-xs lg:block">{user?.name}</span><ChevronDown size={13} className={`transition-transform ${userMenu ? 'rotate-180' : ''}`}/>
          </button>
          {userMenu && <><div className="fixed inset-0 z-40" onMouseDown={() => setUserMenu(false)}/>
            <div className="animate-pop absolute right-0 top-11 z-50 w-52 overflow-hidden rounded-lg border bg-white py-1 text-slate-700 shadow-xl">
              <div className="border-b px-3 py-2.5 text-xs"><b className="block truncate">{user?.name}</b><div className="truncate text-slate-400">{user?.email}</div><span className="badge mt-1.5 bg-sky-50 text-sky-700">{user?.role.name}</span></div>
              <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-slate-50" onClick={logout}><LogOut size={14}/>Sign out</button>
            </div></>}
        </div>
      </div>
    </header>
    {mobile && <><div className="fixed inset-0 top-11 z-20 bg-slate-900/20 md:hidden" onMouseDown={() => setMobile(false)}/>
      <nav className="animate-slide-down fixed inset-x-0 top-11 z-30 grid grid-cols-2 gap-1 border-b bg-white p-2 shadow-lg md:hidden">
        {nav.map(([label,to,Icon]) => <NavLink key={to} onClick={() => setMobile(false)} to={to} className={({isActive}) => `flex items-center gap-2 rounded-md p-3 text-sm transition-colors ${isActive ? 'bg-[#f0f9ff] font-semibold text-[#0284c7]' : 'hover:bg-slate-100'}`}><Icon size={17}/>{label}</NavLink>)}
      </nav></>}
    <main>{children}</main>
    {searching && <GlobalSearch onClose={() => setSearching(false)}/>}
  </div>;
}

export function PageHeader({title,subtitle,onNew,backTo,backLabel='Back',children}:{title:string;subtitle?:string;onNew?:()=>void;backTo?:string;backLabel?:string;children?:ReactNode}){const loc=useLocation(),navigate=useNavigate();return <div className="border-b bg-white px-4 py-2.5"><div className="flex flex-wrap items-center gap-2">{backTo&&<button type="button" className="btn h-8 shrink-0" aria-label={backLabel} title={backLabel} onClick={()=>navigate(backTo)}><ArrowLeft size={15}/><span className="hidden sm:inline">{backLabel}</span></button>}<div className="mr-auto"><div className="text-[11px] text-slate-400">CRM / {loc.pathname.split('/')[1]||'Dashboard'}</div><h1 className="text-lg font-semibold leading-tight">{title}</h1>{subtitle&&<p className="text-xs text-slate-500">{subtitle}</p>}</div>{onNew&&<button className="btn btn-primary" onClick={onNew}>New</button>}{children}</div></div>}

export type FilterGroup = { key: string; label: string; options: { value: string; label: string }[] };
export type ToolbarState = { filters: Record<string, string>; groupBy: string };
type SavedView = { _id: string; name: string; resource: string; query: { search?: string; filters?: Record<string, string>; groupBy?: string } };

const menuItem = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-50';

function ToolbarMenu({ label, count, width = 'w-60', children }: { label: string; count?: number; width?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="relative">
    <button className="btn" onClick={() => setOpen(!open)}>{label}{count ? <span className="ml-1 rounded bg-[#0ea5e9] px-1.5 text-[10px] font-semibold text-white">{count}</span> : null} <ChevronDown size={13}/></button>
    {open && <><div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)}/>
      <div className={`absolute left-0 top-9 z-50 max-h-80 overflow-auto rounded-md border bg-white py-1 shadow-xl ${width}`}>{children(() => setOpen(false))}</div></>}
  </div>;
}

export function SearchToolbar({ value, onChange, view, children, filterGroups = [], groupOptions = [], state, onState, resource }: {
  value: string; onChange: (v: string) => void; view?: ReactNode; children?: ReactNode;
  filterGroups?: FilterGroup[]; groupOptions?: { value: string; label: string }[];
  state?: ToolbarState; onState?: (next: ToolbarState) => void; resource?: string;
}) {
  const qc = useQueryClient();
  const filters = state?.filters ?? {}; const groupBy = state?.groupBy ?? '';
  const views = useQuery({ queryKey: ['filters'], queryFn: () => api<SavedView[]>('/filters'), enabled: Boolean(resource) });
  const saved = (views.data ?? []).filter(item => item.resource === resource);
  const saveView = useMutation({ mutationFn: (name: string) => api('/filters', { method: 'POST', body: JSON.stringify({ name, resource, query: { search: value, filters, groupBy } }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['filters'] }) });
  const dropView = useMutation({ mutationFn: (id: string) => api(`/filters/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['filters'] }) });
  const activeCount = Object.values(filters).filter(Boolean).length;
  return <div className="flex flex-wrap items-center gap-2 border-b bg-[#fafafa] px-4 py-2">
    <div className="relative min-w-52 max-w-xl flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={15}/><input className="field search-field" value={value} onChange={event => onChange(event.target.value)} placeholder="Search records…"/></div>
    {children}
    {filterGroups.length > 0 && <ToolbarMenu label="Filters" count={activeCount}>{close => <>
      {filterGroups.filter(group => group.options.length > 0).map(group => <div key={group.key}>
        <div className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{group.label}</div>
        {group.options.map(option => { const on = filters[group.key] === option.value; return <button key={option.value} className={`${menuItem} ${on ? 'font-semibold text-[#0284c7]' : ''}`} onClick={() => onState?.({ filters: { ...filters, [group.key]: on ? '' : option.value }, groupBy })}><Check size={13} className={on ? '' : 'invisible'}/>{option.label}</button>; })}
      </div>)}
      {activeCount > 0 && <button className={`${menuItem} mt-1 border-t text-red-600`} onClick={() => { onState?.({ filters: {}, groupBy }); close(); }}>Clear all filters</button>}
    </>}</ToolbarMenu>}
    {groupOptions.length > 0 && <ToolbarMenu label="Group By" count={groupBy ? 1 : 0} width="w-52">{close => <>
      {groupOptions.map(option => { const on = groupBy === option.value; return <button key={option.value} className={`${menuItem} ${on ? 'font-semibold text-[#0284c7]' : ''}`} onClick={() => { onState?.({ filters, groupBy: on ? '' : option.value }); close(); }}><Check size={13} className={on ? '' : 'invisible'}/>{option.label}</button>; })}
    </>}</ToolbarMenu>}
    {resource && <ToolbarMenu label="Favorites" count={saved.length} width="w-64">{close => <>
      {saved.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">No saved views yet.</div>}
      {saved.map(item => <div className="flex items-center" key={item._id}>
        <button className={`${menuItem} flex-1`} onClick={() => { onChange(item.query.search ?? ''); onState?.({ filters: item.query.filters ?? {}, groupBy: item.query.groupBy ?? '' }); close(); }}><Star size={13}/>{item.name}</button>
        <button className="px-2 text-slate-400 hover:text-red-600" title="Remove this view" onClick={() => dropView.mutate(item._id)}><X size={13}/></button>
      </div>)}
      <button className={`${menuItem} mt-1 border-t`} disabled={saveView.isPending} onClick={() => { const name = prompt('Name this view'); if (name && name.trim()) saveView.mutate(name.trim()); close(); }}><Star size={13}/>Save current view</button>
    </>}</ToolbarMenu>}
    {view}
  </div>;
}
