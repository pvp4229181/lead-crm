import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, date } from '../lib/api';
import type { Activity } from '../lib/types';
import { PageHeader, SearchToolbar, type ToolbarState } from '../components/Shell';
import { Avatar, Button, Empty, Loading, Modal, RowMenu } from '../components/ui';

export function Activities(){
  const [search,setSearch]=useState('');
  const [error,setError]=useState('');
  const [toolbar,setToolbar]=useState<ToolbarState>({filters:{},groupBy:''});
  const queryClient=useQueryClient();
  const query=useQuery({queryKey:['activities'],queryFn:()=>api<Activity[]>('/activities')});
  const remove=useMutation({mutationFn:(id:string)=>api(`/activities/${id}`,{method:'DELETE'}),onMutate:()=>setError(''),onSuccess:()=>queryClient.invalidateQueries({queryKey:['activities']}),onError:(cause:any)=>setError(cause?.message??'Could not delete this activity.')});
  const all=query.data??[];
  const stateOf=(activity:Activity)=>activity.status==='completed'?'completed':new Date(activity.dueDate)<new Date()?'overdue':'planned';
  const distinct=(items:{value:string;label:string}[])=>Array.from(new Map(items.map(item=>[item.value,item])).values()).sort((a,b)=>a.label.localeCompare(b.label));
  const filterGroups=[
    {key:'state',label:'Status',options:[{value:'planned',label:'Planned'},{value:'overdue',label:'Overdue'},{value:'completed',label:'Completed'}]},
    {key:'assignedTo',label:'Assigned to',options:distinct(all.map(activity=>({value:activity.assignedTo?._id??'none',label:activity.assignedTo?.name??'Unassigned'})))},
    {key:'activityType',label:'Type',options:distinct(all.map(activity=>({value:activity.activityType?._id??'none',label:activity.activityType?.name??'Activity'})))},
    {key:'relatedModel',label:'Related to',options:distinct(all.map(activity=>({value:activity.relatedModel,label:activity.relatedModel})))},
  ];
  const data=all.filter(activity=>{
    if(!activity.summary.toLowerCase().includes(search.toLowerCase()))return false;
    const {state,assignedTo,activityType,relatedModel}=toolbar.filters;
    if(state&&stateOf(activity)!==state)return false;
    if(assignedTo&&(activity.assignedTo?._id??'none')!==assignedTo)return false;
    if(activityType&&(activity.activityType?._id??'none')!==activityType)return false;
    if(relatedModel&&activity.relatedModel!==relatedModel)return false;
    return true;
  });
  const groupNameOf=(activity:Activity)=>toolbar.groupBy==='state'?({completed:'Completed',overdue:'Overdue',planned:'Planned'})[stateOf(activity)]
    :toolbar.groupBy==='assignedTo'?(activity.assignedTo?.name??'Unassigned')
    :toolbar.groupBy==='activityType'?(activity.activityType?.name??'Activity')
    :toolbar.groupBy==='relatedModel'?activity.relatedModel
    :toolbar.groupBy==='dueDate'?date(activity.dueDate):'';
  const groups:[string,Activity[]][]=toolbar.groupBy
    ?Object.entries(data.reduce<Record<string,Activity[]>>((result,activity)=>{const key=groupNameOf(activity);(result[key]??=[]).push(activity);return result},{})).sort((a,b)=>a[0].localeCompare(b[0]))
    :[['',data]];
  if(query.isLoading)return <Loading/>;
  if(query.isError)return <PageError message={query.error.message}/>;
  return <><PageHeader title="Activities"/><SearchToolbar value={search} onChange={setSearch} resource="activities" state={toolbar} onState={setToolbar} filterGroups={filterGroups} groupOptions={[{value:'state',label:'Status'},{value:'assignedTo',label:'Assigned to'},{value:'activityType',label:'Type'},{value:'relatedModel',label:'Related to'},{value:'dueDate',label:'Due date'}]}/>{error&&<div className={`border-b px-4 py-2 text-xs ${error.startsWith('Deleted')||error==='Nothing to delete.'?'border-emerald-200 bg-emerald-50 text-emerald-700':'border-red-200 bg-red-50 text-red-700'}`}>{error}</div>}<div className="p-4"><div className="panel overflow-x-auto"><table className="w-full min-w-[720px] text-left text-xs"><thead className="border-b bg-slate-50"><tr>{['Activity','Type','Due date','Assigned to','Related to','Status'].map(label=><th className="p-3" key={label}>{label}</th>)}<th/></tr></thead><tbody>{groups.map(([groupName,rows])=><Fragment key={groupName}>{groupName&&<tr className="bg-slate-100"><td className="px-3 py-1.5 text-[11px] font-semibold text-slate-600" colSpan={7}>{groupName} ({rows.length})</td></tr>}{rows.map(activity=>{const overdue=new Date(activity.dueDate)<new Date()&&activity.status!=='completed';return <tr className="border-b hover:bg-slate-50" key={activity._id}><td className="p-3 font-semibold">{activity.summary}</td><td className="p-3">{activity.activityType?.name??'Activity'}</td><td className={`p-3 ${overdue?'text-red-600':''}`}>{date(activity.dueDate)}</td><td className="p-3"><span className="flex items-center gap-2"><Avatar name={activity.assignedTo?.name}/>{activity.assignedTo?.name??'Unassigned'}</span></td><td className="p-3">{activity.relatedModel}</td><td className="p-3"><span className={`badge ${activity.status==='completed'?'bg-emerald-100 text-emerald-700':overdue?'bg-red-100 text-red-700':'bg-blue-100 text-blue-700'}`}>{activity.status==='completed'?'Completed':overdue?'Overdue':'Planned'}</span></td><td className="p-3 text-right"><RowMenu label="Delete activity" busy={remove.isPending} onDelete={()=>{if(confirm('Delete this activity? This cannot be undone.'))remove.mutate(activity._id)}}/></td></tr>})}</Fragment>)}</tbody></table>{!data.length&&<Empty title="No activities" detail="There are no matching scheduled activities."/>}</div></div></>;
}

type CalendarMode='Month'|'Week'|'Day';
const dayKey=(value:Date|string)=>{const dateValue=new Date(value);return `${dateValue.getFullYear()}-${String(dateValue.getMonth()+1).padStart(2,'0')}-${String(dateValue.getDate()).padStart(2,'0')}`};

export function Calendar(){
  const navigate=useNavigate();
  const query=useQuery({queryKey:['activities'],queryFn:()=>api<Activity[]>('/activities')});
  const [mode,setMode]=useState<CalendarMode>('Month');
  const [cursor,setCursor]=useState(()=>new Date());
  const activities=query.data??[];
  const grouped=useMemo(()=>{
    const groups=(query.data??[]).reduce<Record<string,Activity[]>>((result,activity)=>{const key=dayKey(activity.dueDate);(result[key]??=[]).push(activity);return result},{});
    Object.values(groups).forEach(items=>items.sort(compareActivities));
    return groups;
  },[query.data]);
  const upcoming=useMemo(()=>{
    const today=startOfDay(new Date()).getTime();
    return (query.data??[]).filter(activity=>activity.status!=='completed'&&startOfDay(activity.dueDate).getTime()>=today).sort(compareActivities).slice(0,7);
  },[query.data]);
  const stats=useMemo(()=>{
    const source=query.data??[];
    return {today:source.filter(activity=>activityState(activity)==='today').length,overdue:source.filter(activity=>activityState(activity)==='overdue').length,completed:source.filter(activity=>activity.status==='completed').length};
  },[query.data]);
  if(query.isLoading)return <><PageHeader title="Calendar" subtitle="Plan activities, calls, meetings and follow-ups"/><CalendarLoading/></>;
  if(query.isError)return <><PageHeader title="Calendar" subtitle="Plan activities, calls, meetings and follow-ups"/><PageError message={query.error.message}/></>;
  const move=(direction:number)=>setCursor(current=>{const next=new Date(current);if(mode==='Month'){next.setDate(1);next.setMonth(next.getMonth()+direction)}else if(mode==='Week')next.setDate(next.getDate()+direction*7);else next.setDate(next.getDate()+direction);return next});
  const openActivity=(activity:Activity)=>{const related=activity.relatedId as unknown;const id=typeof related==='string'?related:related&&typeof related==='object'&&'_id' in related?String((related as {_id:string})._id):'';if(activity.relatedModel==='Opportunity'&&id)navigate(`/opportunities/${id}`);else if(activity.relatedModel==='Lead')navigate('/leads');else if(activity.relatedModel==='Contact'||activity.relatedModel==='Company')navigate('/contacts');else navigate('/activities')};
  const selectDay=(day:Date)=>{setCursor(new Date(day));setMode('Day')};
  const {start,end}=calendarRange(cursor,mode);
  const visibleCount=activities.filter(activity=>{const due=new Date(activity.dueDate);return due>=start&&due<end}).length;
  return <>
    <PageHeader title="Calendar" subtitle="Plan activities, calls, meetings and follow-ups"/>
    <div className="border-b border-slate-200 bg-white px-3 py-3 sm:px-4"><div className="flex flex-wrap items-center gap-3">
      <div className="flex overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"><button type="button" onClick={()=>move(-1)} className="grid h-9 w-9 place-items-center border-r border-slate-200 text-slate-500 transition hover:bg-sky-50 hover:text-sky-700" aria-label={`Previous ${mode.toLowerCase()}`}><ChevronLeft size={17}/></button><button type="button" onClick={()=>setCursor(new Date())} className="h-9 px-3 text-xs font-semibold text-slate-700 transition hover:bg-sky-50 hover:text-sky-700">Today</button><button type="button" onClick={()=>move(1)} className="grid h-9 w-9 place-items-center border-l border-slate-200 text-slate-500 transition hover:bg-sky-50 hover:text-sky-700" aria-label={`Next ${mode.toLowerCase()}`}><ChevronRight size={17}/></button></div>
      <div className="min-w-[190px] flex-1 sm:text-center"><div className="text-base font-semibold tracking-tight text-slate-800">{calendarTitle(cursor,mode)}</div><div className="text-[11px] text-slate-400">{visibleCount} {visibleCount===1?'activity':'activities'} in this view</div></div>
      <div className="flex rounded-lg bg-slate-100 p-1" aria-label="Calendar view">{(['Month','Week','Day'] as const).map(view=><button type="button" aria-pressed={mode===view} onClick={()=>setMode(view)} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${mode===view?'bg-white text-sky-700 shadow-sm ring-1 ring-slate-200':'text-slate-500 hover:text-slate-800'}`} key={view}>{view}</button>)}</div>
    </div></div>
    <div className="bg-slate-50/70 p-3 sm:p-4">
      {!activities.length&&<div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-800"><b>Your calendar is clear.</b> Scheduled activities will appear here automatically.</div>}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_290px]"><section className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">{mode==='Month'?<MonthView cursor={cursor} grouped={grouped} open={openActivity} selectDay={selectDay}/>:mode==='Week'?<WeekView cursor={cursor} grouped={grouped} open={openActivity} selectDay={selectDay}/>:<DayView cursor={cursor} activities={grouped[dayKey(cursor)]??[]} open={openActivity}/>}</section><UpcomingPanel activities={upcoming} stats={stats} open={openActivity}/></div>
    </div>
  </>;
}

function MonthView({cursor,grouped,open,selectDay}:{cursor:Date;grouped:Record<string,Activity[]>;open:(activity:Activity)=>void;selectDay:(day:Date)=>void}){
  const first=new Date(cursor.getFullYear(),cursor.getMonth(),1);const start=startOfWeek(first);const days=Array.from({length:42},(_,index)=>addDays(start,index));
  return <div className="overflow-x-auto"><div className="grid min-w-[840px] grid-cols-7">
    {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((label,index)=><div className={`border-b border-slate-200 px-2 py-2.5 text-center text-[10px] font-bold uppercase tracking-[.12em] ${index>4?'bg-slate-50 text-slate-400':'bg-white text-slate-500'}`} key={label}>{label}</div>)}
    {days.map(day=><CalendarCell day={day} currentMonth={day.getMonth()===cursor.getMonth()} activities={grouped[dayKey(day)]??[]} open={open} selectDay={selectDay} key={dayKey(day)}/>) }
  </div></div>
}

function WeekView({cursor,grouped,open,selectDay}:{cursor:Date;grouped:Record<string,Activity[]>;open:(activity:Activity)=>void;selectDay:(day:Date)=>void}){
  const start=startOfWeek(cursor);const days=Array.from({length:7},(_,index)=>addDays(start,index));
  return <div className="overflow-x-auto"><div className="grid min-h-[570px] min-w-[910px] grid-cols-7">{days.map(day=>{const today=dayKey(day)===dayKey(new Date());const items=grouped[dayKey(day)]??[];return <div className={`border-r border-slate-200 last:border-r-0 ${today?'bg-sky-50/45':'bg-white'}`} key={dayKey(day)}>
    <button type="button" onClick={()=>selectDay(day)} className={`flex w-full flex-col items-center border-b border-slate-200 px-2 py-3 transition hover:bg-sky-50 ${today?'text-sky-700':'text-slate-500'}`}><span className="text-[10px] font-bold uppercase tracking-wider">{day.toLocaleDateString('en-US',{weekday:'short'})}</span><span className={`mt-1 grid h-8 w-8 place-items-center rounded-full text-sm font-semibold ${today?'bg-sky-600 text-white shadow-sm':'text-slate-700'}`}>{day.getDate()}</span><span className="mt-1 text-[10px]">{items.length} {items.length===1?'activity':'activities'}</span></button>
    <div className="space-y-2 p-2.5">{items.length?items.map(activity=><ActivityCard activity={activity} open={open} compact key={activity._id}/>):<div className="rounded-lg border border-dashed border-slate-200 py-6 text-center text-[10px] text-slate-400">No activities</div>}</div>
  </div>})}</div></div>
}

function DayView({cursor,activities,open}:{cursor:Date;activities:Activity[];open:(activity:Activity)=>void}){const today=dayKey(cursor)===dayKey(new Date());return <div className="min-h-[570px]">
  <div className={`flex items-center gap-3 border-b border-slate-200 px-4 py-4 sm:px-5 ${today?'bg-sky-50/70':'bg-white'}`}><div className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${today?'bg-sky-600 text-white shadow-sm':'bg-slate-100 text-slate-700'}`}><span className="text-lg font-bold leading-none">{cursor.getDate()}</span></div><div><div className="text-sm font-semibold text-slate-800">{cursor.toLocaleDateString('en-US',{weekday:'long'})}{today&&<span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold uppercase text-sky-700">Today</span>}</div><div className="mt-0.5 text-xs text-slate-500">{cursor.toLocaleDateString('en-US',{month:'long',year:'numeric'})} · {activities.length} scheduled</div></div></div>
  {activities.length?<div className="divide-y divide-slate-100">{activities.map(activity=><div className="grid gap-3 px-4 py-3 sm:grid-cols-[88px_minmax(0,1fr)] sm:px-5" key={activity._id}><div className="flex items-start gap-1.5 pt-2 text-xs font-medium text-slate-400"><Clock3 size={13} className="mt-0.5"/>{activityTime(activity)}</div><ActivityCard activity={activity} open={open}/></div>)}</div>:<Empty title="No activities scheduled" detail="This day is clear. Choose another date or create an activity from a CRM record."/>}
</div>}

function CalendarCell({day,currentMonth,activities,open,selectDay}:{day:Date;currentMonth:boolean;activities:Activity[];open:(activity:Activity)=>void;selectDay:(day:Date)=>void}){const today=dayKey(day)===dayKey(new Date());return <div className={`h-[122px] border-b border-r border-slate-200 p-1.5 sm:h-[132px] ${today?'bg-sky-50/80':currentMonth?'bg-white':'bg-slate-50/70'}`}>
  <button type="button" onClick={()=>selectDay(day)} aria-label={`Open ${day.toLocaleDateString('en-US',{month:'long',day:'numeric'})}`} className={`mb-0.5 grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold transition ${today?'bg-sky-600 text-white shadow-sm':currentMonth?'text-slate-600 hover:bg-sky-100 hover:text-sky-700':'text-slate-400 hover:bg-slate-200'}`}>{day.getDate()}</button>
  <div className={`space-y-1 ${currentMonth?'':'opacity-65'}`}>{activities.slice(0,3).map(activity=><MonthEvent activity={activity} open={open} key={activity._id}/>)}</div>{activities.length>3&&<button type="button" onClick={()=>selectDay(day)} className="mt-1 block w-full truncate px-1 text-left text-[10px] font-semibold text-sky-700 hover:text-sky-900">+{activities.length-3} more</button>}
</div>}

function MonthEvent({activity,open}:{activity:Activity;open:(activity:Activity)=>void}){const state=activityState(activity);const tone=eventTone(state);return <button type="button" onClick={()=>open(activity)} className={`flex h-6 w-full items-center gap-1.5 rounded-md border px-1.5 text-left text-[10px] font-medium shadow-[0_1px_1px_rgba(15,23,42,.04)] transition ${tone.card}`} title={`${activity.summary} · ${stateLabel(state)}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`}/><span className="truncate">{activity.summary}</span></button>}

function ActivityCard({activity,open,compact=false}:{activity:Activity;open:(activity:Activity)=>void;compact?:boolean}){const state=activityState(activity);const tone=eventTone(state);return <button type="button" onClick={()=>open(activity)} className={`w-full rounded-lg border text-left shadow-[0_1px_2px_rgba(15,23,42,.05)] transition hover:-translate-y-px hover:shadow-md ${tone.card} ${compact?'p-2':'p-3'}`}>
  <div className="flex items-start gap-2"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.dot}`}/><span className={`min-w-0 flex-1 font-semibold leading-4 ${compact?'text-[11px]':'text-xs'}`}>{activity.summary}</span></div>
  <div className={`mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 ${compact?'text-[9px]':'text-[10px]'} opacity-75`}><span>{activity.activityType?.name??'Activity'}</span><span>·</span><span>{activity.relatedModel}</span>{!compact&&<><span>·</span><span>{activity.assignedTo?.name??'Unassigned'}</span></>}</div>
  <div className={`mt-2 flex items-center justify-between ${compact?'text-[9px]':'text-[10px]'}`}><span className="font-medium opacity-75">{activityTime(activity)}</span><span className="font-bold">{stateLabel(state)}</span></div>
</button>}

function UpcomingPanel({activities,stats,open}:{activities:Activity[];stats:{today:number;overdue:number;completed:number};open:(activity:Activity)=>void}){return <aside className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm xl:sticky xl:top-16">
  <div className="border-b border-slate-200 p-4"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg bg-sky-100 text-sky-700"><CalendarDays size={16}/></span><div><h2 className="text-sm font-semibold text-slate-800">Upcoming</h2><p className="text-[10px] text-slate-400">Your next scheduled activities</p></div></div></div>
  <div className="grid grid-cols-2 gap-2 border-b border-slate-100 p-3"><div className="rounded-lg border border-sky-100 bg-sky-50 p-2.5"><div className="flex items-center gap-1.5 text-[10px] font-semibold text-sky-700"><Clock3 size={12}/>Due today</div><div className="mt-1 text-xl font-bold text-sky-900">{stats.today}</div></div><div className={`rounded-lg border p-2.5 ${stats.overdue?'border-rose-100 bg-rose-50':'border-slate-100 bg-slate-50'}`}><div className={`flex items-center gap-1.5 text-[10px] font-semibold ${stats.overdue?'text-rose-700':'text-slate-500'}`}><AlertTriangle size={12}/>Overdue</div><div className={`mt-1 text-xl font-bold ${stats.overdue?'text-rose-900':'text-slate-700'}`}>{stats.overdue}</div></div></div>
  <div className="max-h-[490px] overflow-y-auto p-3">{activities.length?<div className="space-y-2">{activities.map(activity=>{const tone=eventTone(activityState(activity));return <button type="button" onClick={()=>open(activity)} className="group flex w-full gap-2.5 rounded-lg border border-transparent p-2 text-left transition hover:border-sky-100 hover:bg-sky-50" key={activity._id}><div className={`mt-1 h-8 w-1 shrink-0 rounded-full ${tone.dot}`}/><div className="min-w-0 flex-1"><div className="truncate text-[11px] font-semibold text-slate-700 group-hover:text-sky-800">{activity.summary}</div><div className="mt-1 flex items-center gap-1 text-[10px] text-slate-400"><span>{formatUpcomingDate(activity.dueDate)}</span><span>·</span><span className="truncate">{activity.activityType?.name??'Activity'}</span></div><div className="mt-1 truncate text-[10px] text-slate-400">{activity.assignedTo?.name??'Unassigned'} · {activity.relatedModel}</div></div><ChevronRight size={13} className="mt-2 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-sky-600"/></button>})}</div>:<div className="py-10 text-center"><CheckCircle2 size={24} className="mx-auto text-sky-300"/><div className="mt-2 text-xs font-semibold text-slate-600">Nothing upcoming</div><p className="mt-1 text-[10px] text-slate-400">Your future schedule is clear.</p></div>}</div>
  <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 text-[10px] text-slate-500"><span className="flex items-center gap-1.5"><CheckCircle2 size={12} className="text-emerald-500"/>Completed</span><b className="text-slate-700">{stats.completed}</b></div>
</aside>}

function CalendarLoading(){return <div className="bg-slate-50/70 p-4"><div className="animate-pulse space-y-4"><div className="h-12 rounded-xl border border-slate-200 bg-white"/><div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_290px]"><div className="h-[610px] rounded-xl border border-slate-200 bg-white"><div className="grid grid-cols-7 gap-px border-b bg-slate-100 p-px">{Array.from({length:7},(_,index)=><div className="h-10 bg-slate-50" key={index}/>)}</div><div className="grid grid-cols-7 gap-px bg-slate-100 p-px">{Array.from({length:28},(_,index)=><div className="h-24 bg-white p-3" key={index}><div className="h-3 w-5 rounded bg-sky-100"/></div>)}</div></div><div className="h-80 rounded-xl border border-slate-200 bg-white"/></div></div></div>}

type ActivityState='planned'|'today'|'overdue'|'completed';
function activityState(activity:Activity):ActivityState{if(activity.status==='completed')return'completed';const due=startOfDay(activity.dueDate).getTime();const today=startOfDay(new Date()).getTime();if(due<today)return'overdue';if(due===today)return'today';return'planned'}
function eventTone(state:ActivityState){if(state==='overdue')return{card:'border-rose-200 bg-rose-50 text-rose-900 hover:bg-rose-100',dot:'bg-rose-500'};if(state==='today')return{card:'border-sky-300 bg-sky-100 text-sky-950 hover:bg-sky-200',dot:'bg-sky-600'};if(state==='completed')return{card:'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100',dot:'bg-emerald-500'};return{card:'border-blue-200 bg-blue-50 text-blue-900 hover:bg-blue-100',dot:'bg-blue-500'}}
function stateLabel(state:ActivityState){return state==='today'?'Due today':state.charAt(0).toUpperCase()+state.slice(1)}
function startOfDay(value:Date|string){const result=new Date(value);result.setHours(0,0,0,0);return result}
function startOfWeek(value:Date){const result=startOfDay(value);const mondayOffset=(result.getDay()+6)%7;result.setDate(result.getDate()-mondayOffset);return result}
function addDays(value:Date,amount:number){const result=new Date(value);result.setDate(result.getDate()+amount);return result}
function compareActivities(left:Activity,right:Activity){if(left.status!==right.status)return left.status==='completed'?1:-1;return new Date(left.dueDate).getTime()-new Date(right.dueDate).getTime()}
function activityTime(activity:Activity){return new Date(activity.dueDate).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}
function formatUpcomingDate(value:string){const due=new Date(value);const difference=Math.round((startOfDay(due).getTime()-startOfDay(new Date()).getTime())/86400000);if(difference===0)return'Today';if(difference===1)return'Tomorrow';return due.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}
function calendarRange(cursor:Date,mode:CalendarMode){if(mode==='Month')return{start:new Date(cursor.getFullYear(),cursor.getMonth(),1),end:new Date(cursor.getFullYear(),cursor.getMonth()+1,1)};if(mode==='Week'){const start=startOfWeek(cursor);return{start,end:addDays(start,7)}}const start=startOfDay(cursor);return{start,end:addDays(start,1)}}

function calendarTitle(cursor:Date,mode:CalendarMode){if(mode==='Month')return cursor.toLocaleDateString('en-US',{month:'long',year:'numeric'});if(mode==='Day')return cursor.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});const start=startOfWeek(cursor);const end=addDays(start,6);return `${start.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${end.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`}

export function Contacts(){
  const [tab,setTab]=useState<'contacts'|'companies'>('contacts');const query=useQuery({queryKey:[tab],queryFn:()=>api<any[]>(`/${tab}`)});
  const [error,setError]=useState('');
  const queryClient=useQueryClient();
  const remove=useMutation({mutationFn:(id:string)=>api(`/${tab}/${id}`,{method:'DELETE'}),onMutate:()=>setError(''),onSuccess:()=>queryClient.invalidateQueries({queryKey:[tab]}),onError:(cause:any)=>setError(cause?.message??`Could not delete this ${tab==='contacts'?'contact':'company'}.`)});
  const [wiping,setWiping]=useState(false);
  const count=query.data?.length??0;
  // Bulk delete is irreversible and unscoped, so it is kept behind its own confirmation
  // dialog rather than the one-click RowMenu used for a single record.
  const wipe=useMutation({
    mutationFn:()=>api<{deleted:number;cleared:number}>(`/bulk/${tab}`,{method:'DELETE'}),
    onMutate:()=>setError(''),
    onSuccess:result=>{setWiping(false);queryClient.invalidateQueries();setError(result.deleted?`Deleted ${result.deleted} ${result.deleted===1?'record':'records'}.${result.cleared?` Cleared ${result.cleared} linked reference${result.cleared===1?'':'s'}.`:''}`:'Nothing to delete.');},
    onError:(cause:any)=>{setWiping(false);setError(cause?.message??'Could not delete these records.');},
  });
  return <><PageHeader title="Contacts & Companies"><div className="flex items-center gap-2"><div className="flex"><button className={`btn ${tab==='contacts'?'bg-slate-100':''}`} onClick={()=>setTab('contacts')}>Contacts</button><button className={`btn ${tab==='companies'?'bg-slate-100':''}`} onClick={()=>setTab('companies')}>Companies</button></div><Button className="btn text-red-600 hover:bg-red-50 disabled:opacity-40" disabled={!count} onClick={()=>setWiping(true)}><Trash2 size={14}/>Delete all {tab==='contacts'?'contacts':'companies'}</Button></div></PageHeader>{wiping&&<WipeDialog resource={tab} count={count} busy={wipe.isPending} onClose={()=>setWiping(false)} onConfirm={()=>wipe.mutate()}/>}{error&&<div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>}{query.isLoading?<Loading/>:query.isError?<PageError message={query.error.message}/>:<div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{query.data?.map(record=><div className="panel flex gap-3 p-4" key={record._id}><Avatar name={record.name} size={38}/><div className="min-w-0"><b className="block truncate text-sm">{record.name}</b><div className="mt-1 truncate text-xs text-slate-500">{[record.jobPosition||record.industry,record.company?.name].filter(Boolean).join(' · ')||'—'}</div><div className="truncate text-xs text-slate-400">{record.email}</div></div><div className="ml-auto"><RowMenu label={tab==='contacts'?'Delete contact':'Delete company'} busy={remove.isPending} onDelete={()=>{if(confirm(`Delete ${record.name}? This cannot be undone.`))remove.mutate(record._id)}}/></div></div>)}</div>}</>;
}

function PageError({message}:{message:string}){return <div className="p-4"><div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700"><b>Unable to load this page.</b><p className="mt-1 text-xs">{message}</p></div></div>}

// Typing the resource name is deliberate friction: this wipes every record of the type and
// cannot be undone, unlike the per-record delete beside it.
function WipeDialog({resource,count,busy,onClose,onConfirm}:{resource:'contacts'|'companies';count:number;busy:boolean;onClose:()=>void;onConfirm:()=>void}){
  const [typed,setTyped]=useState('');
  const linked=resource==='contacts'?'opportunities and WhatsApp conversations':'contacts and opportunities';
  return <Modal title={`Delete all ${resource}?`} onClose={onClose} width="max-w-md">
    <div className="space-y-3 p-5 text-sm">
      <p>This permanently deletes <b>all {count} {resource}</b>. It cannot be undone.</p>
      <p className="text-xs text-slate-500">Any {linked} still linked to them will have that link cleared, so they stay intact but lose the reference.</p>
      <label className="block"><span className="label">Type <b>{resource}</b> to confirm</span>
        <input autoFocus className="field" value={typed} onChange={e=>setTyped(e.target.value)} placeholder={resource}/>
      </label>
    </div>
    <div className="flex justify-end gap-2 border-t bg-slate-50 p-3">
      <Button type="button" onClick={onClose}>Cancel</Button>
      <Button className="btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-40" disabled={typed.trim()!==resource||busy} onClick={onConfirm}>{busy?'Deleting…':`Delete all ${resource}`}</Button>
    </div>
  </Modal>;
}
