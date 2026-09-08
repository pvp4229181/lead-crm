import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useLocation } from 'react-router-dom';
import { AppWindow, BarChart3, Bell, CalendarDays, Check, ChevronDown, ClipboardCheck, ContactRound, Gauge, KanbanSquare, MessageCircle, Menu, Search, Settings, Star, UsersRound, X } from 'lucide-react';
import { useAuth } from '../context/Auth';
import { api } from '../lib/api';
import { Avatar } from './ui';

const nav = [['Dashboard','/',Gauge],['Pipeline','/pipeline',KanbanSquare],['Leads','/leads',ContactRound],['WhatsApp','/whatsapp',MessageCircle],['Activities','/activities',ClipboardCheck],['Calendar','/calendar',CalendarDays],['Contacts','/contacts',UsersRound],['Reporting','/reporting',BarChart3],['Configuration','/configuration',Settings]] as const;

export function Shell({ children }: { children: ReactNode }) {
  const [mobile, setMobile] = useState(false); const [userMenu, setUserMenu] = useState(false); const { user, logout } = useAuth();
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ read: boolean }[]>('/notifications') });
  const unread = (notifications.data ?? []).filter(item => !item.read).length;
  return <div className="min-h-screen">
    <header className="sticky top-0 z-40 flex h-11 items-center bg-[#0ea5e9] px-3 text-white shadow">
      <button className="mr-3 md:hidden" onClick={() => setMobile(!mobile)}>{mobile ? <X size={19}/> : <Menu size={19}/>}</button>
      <button className="mr-2 hidden p-1 md:block" title="App launcher"><AppWindow size={18}/></button>
      <NavLink to="/" className="mr-5 text-[15px] font-semibold tracking-tight">Lead CRM</NavLink>
      <nav className="hidden h-full items-center md:flex">{nav.slice(1).map(([label,to]) => <NavLink key={to} to={to} className={({isActive}) => `flex h-full items-center px-3 text-[13px] ${isActive ? 'bg-white/14' : 'hover:bg-white/8'}`}>{label}</NavLink>)}</nav>
      <div className="ml-auto flex items-center gap-1"><button className="p-2" title="Global search"><Search size={17}/></button><NavLink to="/notifications" className="relative p-2" title={unread ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications'}><Bell size={17}/>{unread > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-400"/>}</NavLink><div className="relative"><button onClick={() => setUserMenu(!userMenu)} className="ml-1 flex items-center gap-2 py-1 pl-2"><Avatar name={user?.name}/><span className="hidden text-xs lg:block">{user?.name}</span><ChevronDown size={13}/></button>{userMenu && <div className="absolute right-0 top-10 w-48 rounded border bg-white py-1 text-slate-700 shadow-xl"><div className="border-b px-3 py-2 text-xs"><b>{user?.name}</b><div className="text-slate-400">{user?.role.name}</div></div><button className="w-full px-3 py-2 text-left text-xs hover:bg-slate-50" onClick={logout}>Sign out</button></div>}</div></div>
    </header>
    {mobile && <nav className="fixed inset-x-0 top-11 z-30 grid grid-cols-2 border-b bg-white p-2 shadow md:hidden">{nav.map(([label,to,Icon]) => <NavLink key={to} onClick={() => setMobile(false)} to={to} className="flex items-center gap-2 rounded p-3 text-sm hover:bg-slate-100"><Icon size={17}/>{label}</NavLink>)}</nav>}
    <main>{children}</main>
  </div>;
}

export function PageHeader({title,subtitle,onNew,children}:{title:string;subtitle?:string;onNew?:()=>void;children?:ReactNode}){const loc=useLocation();return <div className="border-b bg-white px-4 py-2.5"><div className="flex flex-wrap items-center gap-2"><div className="mr-auto"><div className="text-[11px] text-slate-400">CRM / {loc.pathname.split('/')[1]||'Dashboard'}</div><h1 className="text-lg font-semibold leading-tight">{title}</h1>{subtitle&&<p className="text-xs text-slate-500">{subtitle}</p>}</div>{onNew&&<button className="btn btn-primary" onClick={onNew}>New</button>}{children}</div></div>}

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
