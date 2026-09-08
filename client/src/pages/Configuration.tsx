import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, RefreshCw, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { api, date } from '../lib/api';
import type { Named } from '../lib/types';
import { PageHeader } from '../components/Shell';
import { useAuth } from '../context/Auth';
import { Avatar, Button, Empty, Loading, Modal, RowMenu } from '../components/ui';

type AdminUser = Named & { email:string; active:boolean; role:Named; createdAt:string };
type Invitation = { _id:string; name:string; email:string; role:Named; invitedBy?:Named; status:string; expiresAt:string; createdAt:string };
const resources = ['users','roles','stages','tags','sources','campaigns','mediums','lostReasons'] as const;
// Sales Managers get people management only; the master-data endpoints stay Administrator-only.
const managerResources: Resource[] = ['users','roles'];
type Resource = typeof resources[number];
// Pipeline stages carry two fields beyond a name: the win probability that drives
// weighted forecasting, and the flag marking the stage that counts a deal as won.
type StageRecord = Named & { probability?:number; isWon?:boolean };

export default function Configuration(){
  const { user } = useAuth();
  const isAdmin = user?.role.name === 'Administrator';
  const visible = (isAdmin ? resources.slice() : managerResources) as Resource[];
  const [resource,setResource]=useState<Resource>('users');
  const [name,setName]=useState('');
  const [probability,setProbability]=useState('');
  const [isWon,setIsWon]=useState(false);
  const [invite,setInvite]=useState(false);
  const [addError,setAddError]=useState('');
  const remove=useMutation({mutationFn:(id:string)=>api(`/${resource}/${id}`,{method:'DELETE'}),onMutate:()=>setAddError(''),onSuccess:()=>qc.invalidateQueries({queryKey:[resource]}),onError:(cause:any)=>setAddError(cause?.message??'Could not delete this record.')});
  const qc=useQueryClient();
  const patch=useMutation({mutationFn:({id,...body}:{id:string;probability?:number;isWon?:boolean})=>api(`/${resource}/${id}`,{method:'PATCH',body:JSON.stringify(body)}),onMutate:()=>setAddError(''),onSuccess:()=>qc.invalidateQueries({queryKey:[resource]}),onError:(cause:any)=>setAddError(cause?.message??'Could not update this record.')});
  const records=useQuery({queryKey:[resource],queryFn:()=>api<Named[]>(`/${resource}`),enabled:resource!=='users'});
  async function add(){if(!name.trim())return;setAddError('');
    const body:Record<string,unknown>={name,sequence:(records.data?.length??0)*10+10};
    if(resource==='stages'){if(probability.trim()!=='')body.probability=Number(probability);body.isWon=isWon;}
    try{await api(`/${resource}`,{method:'POST',body:JSON.stringify(body)});setName('');setProbability('');setIsWon(false);qc.invalidateQueries({queryKey:[resource]})}
    catch(error:any){setAddError(error?.message??'Could not add this record.')}}
  return <>
    <PageHeader title="Configuration">{resource==='users'&&isAdmin&&<Button className="btn-primary" onClick={()=>setInvite(true)}><Mail size={15}/>Invite person</Button>}</PageHeader>
    <div className="grid min-h-[calc(100vh-99px)] md:grid-cols-[220px_1fr]">
      <aside className="border-r bg-white p-2">{visible.map(item=><button className={`block w-full rounded p-3 text-left text-xs capitalize ${resource===item?'bg-[#e0f2fe] font-semibold text-[#0369a1]':'hover:bg-slate-50'}`} onClick={()=>setResource(item)} key={item}>{item.replace(/([A-Z])/g,' $1')}</button>)}</aside>
      <section className="p-4">{resource==='users'?<UserAccess onInvite={()=>setInvite(true)} isAdmin={isAdmin}/>:resource==='roles'?<RoleAdmin isAdmin={isAdmin}/>:<div className="panel max-w-3xl"><div className="flex flex-wrap items-center gap-2 border-b p-3"><input className="field" value={name} onChange={event=>setName(event.target.value)} placeholder="Name"/>{resource==='stages'&&<><input className="field w-28" type="number" min="0" max="100" value={probability} onChange={event=>setProbability(event.target.value)} placeholder="Win %"/><label className="flex items-center gap-1 whitespace-nowrap text-xs text-slate-600"><input type="checkbox" checked={isWon} onChange={event=>setIsWon(event.target.checked)}/>Won stage</label></>}<Button className="btn-primary" onClick={add}>Add</Button></div>{addError&&<div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{addError}</div>}{records.isLoading?<Loading/>:records.data?.map(record=><div className="flex items-center gap-2 border-b p-3 text-sm font-semibold" key={record._id}><span className="truncate">{record.name}</span>{resource==='stages'&&<StageFields record={record as StageRecord} busy={patch.isPending} onChange={body=>patch.mutate({id:record._id,...body})}/>}<span className="ml-auto"><RowMenu busy={remove.isPending} onDelete={()=>{if(confirm(`Delete ${record.name}? This cannot be undone.`))remove.mutate(record._id)}}/></span></div>)}</div>}</section>
    </div>
    {invite&&<InvitePerson onClose={()=>setInvite(false)}/>} 
  </>;
}

function StageFields({record,busy,onChange}:{record:StageRecord;busy:boolean;onChange:(body:{probability?:number;isWon?:boolean})=>void}){
  // Committed on blur rather than per keystroke so a partially typed number never PATCHes.
  const commit=(raw:string)=>{const value=Number(raw);if(raw.trim()===''||Number.isNaN(value)||value===record.probability)return;onChange({probability:Math.min(100,Math.max(0,value))});};
  return <span className="flex items-center gap-3 text-xs font-normal text-slate-600">
    <label className="flex items-center gap-1">Win %<input className="field w-20 py-1" type="number" min="0" max="100" disabled={busy} defaultValue={record.probability??''} key={`${record._id}-${record.probability}`} onBlur={event=>commit(event.target.value)}/></label>
    <label className="flex items-center gap-1" title="Deals reaching this stage count as won"><input type="checkbox" disabled={busy} checked={Boolean(record.isWon)} onChange={event=>onChange({isWon:event.target.checked})}/>Won</label>
  </span>;
}

function UserAccess({onInvite,isAdmin}:{onInvite:()=>void;isAdmin:boolean}){
  const qc=useQueryClient();
  const {user:signedInUser}=useAuth();
  const [actionError,setActionError]=useState('');
  const users=useQuery({queryKey:['admin-users'],queryFn:()=>api<AdminUser[]>('/admin/users')});
  const roles=useQuery({queryKey:['admin-roles'],queryFn:()=>api<Named[]>('/admin/roles')});
  const invitations=useQuery({queryKey:['admin-invitations'],queryFn:()=>api<Invitation[]>('/admin/invitations'),enabled:isAdmin});
  const refresh=()=>qc.invalidateQueries({queryKey:['admin-invitations']});
  const update=useMutation({mutationFn:({id,...body}:{id:string;role?:string;active?:boolean})=>api(`/admin/users/${id}`,{method:'PATCH',body:JSON.stringify(body)}),onMutate:()=>setActionError(''),onSuccess:()=>qc.invalidateQueries({queryKey:['admin-users']}),onError:error=>setActionError(error instanceof Error?error.message:'Unable to update access')});
  const removeUser=useMutation({mutationFn:(id:string)=>api(`/admin/users/${id}`,{method:'DELETE'}),onMutate:()=>setActionError(''),onSuccess:()=>{qc.invalidateQueries({queryKey:['admin-users']});qc.invalidateQueries({queryKey:['admin-roles']})},onError:error=>setActionError(error instanceof Error?error.message:'Unable to delete user')});
  const resend=useMutation({mutationFn:(id:string)=>api(`/admin/invitations/${id}/resend`,{method:'POST'}),onSuccess:refresh,onError:error=>setActionError(error instanceof Error?error.message:'Unable to resend invitation')});
  const revoke=useMutation({mutationFn:(id:string)=>api(`/admin/invitations/${id}`,{method:'DELETE'}),onSuccess:refresh,onError:error=>setActionError(error instanceof Error?error.message:'Unable to revoke invitation')});
  if(users.isLoading||roles.isLoading||(isAdmin&&invitations.isLoading))return <Loading/>;
  return <div className="max-w-5xl space-y-4">
    <div className="grid gap-3 md:grid-cols-3"><RoleInfo title="Administrator" detail="Full CRM access, configuration, reports, and user management."/><RoleInfo title="Sales Manager" detail="Access to their own records and teams they lead or belong to."/><RoleInfo title="Salesperson" detail="Access primarily to leads and opportunities assigned to them."/></div>
    {actionError&&<div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">{actionError}<button className="float-right font-semibold" onClick={()=>setActionError('')}>Dismiss</button></div>}
    <div className="panel overflow-hidden"><div className="flex items-center border-b bg-slate-50 px-4 py-3"><div><h2 className="text-sm font-semibold">Users with access</h2><p className="text-xs text-slate-500">Active users can sign in. Suspend an account to revoke access temporarily, or delete it permanently.</p></div>{isAdmin&&<Button className="ml-auto" onClick={onInvite}><UserPlus size={14}/>Invite person</Button>}</div><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="border-b text-slate-500"><tr><th className="p-3">User</th><th>Email</th><th>Role</th><th>Status</th>{isAdmin&&<th className="pr-3 text-right">Actions</th>}</tr></thead><tbody>{users.data?.map(user=><tr className="border-b" key={user._id}><td className="p-3"><span className="flex items-center gap-2"><Avatar name={user.name}/><b>{user.name}</b></span></td><td>{user.email}</td><td><select className="field w-44" value={user.role?._id||''} disabled={update.isPending} onChange={event=>update.mutate({id:user._id,role:event.target.value})}>{roles.data?.map(role=><option key={role._id} value={role._id}>{role.name}</option>)}</select></td><td><button type="button" className={`badge ${user.active?'bg-emerald-50 text-emerald-700':'bg-amber-50 text-amber-700'}`} disabled={update.isPending||signedInUser?._id===user._id} title={signedInUser?._id===user._id?'You cannot suspend your own account':'Click to change access'} onClick={()=>update.mutate({id:user._id,active:!user.active})}>{user.active?'Active':'Suspended'}</button></td>{isAdmin&&<td className="pr-3 text-right">{signedInUser?._id!==user._id&&<RowMenu label="Delete user" busy={removeUser.isPending} onDelete={()=>{if(confirm(`Delete ${user.name}? Their login will be removed, their profile anonymized, and assignments cleared. Historical audit records will remain.`))removeUser.mutate(user._id)}}/>}</td>}</tr>)}</tbody></table></div></div>
    {isAdmin&&<div className="panel overflow-hidden"><div className="border-b bg-slate-50 px-4 py-3"><h2 className="text-sm font-semibold">Pending invitations</h2><p className="text-xs text-slate-500">Email links are single-use and expire automatically.</p></div>{invitations.data?.length?<div className="divide-y">{invitations.data.map(invitation=><div className="flex flex-wrap items-center gap-3 p-4" key={invitation._id}><span className="rounded-full bg-[#e0f2fe] p-2 text-[#0284c7]"><Mail size={15}/></span><div className="min-w-48 flex-1"><b className="block text-xs">{invitation.name}</b><span className="text-xs text-slate-500">{invitation.email}</span></div><span className="badge bg-sky-50 text-sky-700">{invitation.role?.name}</span><span className="text-[11px] text-slate-400">Expires {date(invitation.expiresAt)}</span><Button title="Send a fresh invitation link" disabled={resend.isPending} onClick={()=>resend.mutate(invitation._id)}><RefreshCw size={13}/>Resend</Button><Button title="Revoke invitation" disabled={revoke.isPending} onClick={()=>confirm(`Revoke the invitation for ${invitation.email}?`)&&revoke.mutate(invitation._id)}><Trash2 size={13}/></Button></div>)}</div>:<Empty title="No pending invitations" detail="Invite a person and assign their role before they join."/>}</div>}
  </div>;
}

function RoleAdmin({isAdmin}:{isAdmin:boolean}){
  const qc=useQueryClient();
  const [name,setName]=useState(''); const [error,setError]=useState('');
  const roles=useQuery({queryKey:['admin-roles'],queryFn:()=>api<(Named&{permissions:string[]})[]>('/admin/roles')});
  const users=useQuery({queryKey:['admin-users'],queryFn:()=>api<AdminUser[]>('/admin/users')});
  const fail=(cause:unknown,fallback:string)=>setError(cause instanceof Error?cause.message:fallback);
  const done=()=>{setError('');qc.invalidateQueries({queryKey:['admin-roles']});qc.invalidateQueries({queryKey:['admin-users']})};
  const create=useMutation({mutationFn:()=>api('/admin/roles',{method:'POST',body:JSON.stringify({name})}),onSuccess:()=>{setName('');done()},onError:cause=>fail(cause,'Unable to create this role')});
  const rename=useMutation({mutationFn:({id,next}:{id:string;next:string})=>api(`/admin/roles/${id}`,{method:'PATCH',body:JSON.stringify({name:next})}),onSuccess:done,onError:cause=>fail(cause,'Unable to rename this role')});
  const remove=useMutation({mutationFn:(id:string)=>api(`/admin/roles/${id}`,{method:'DELETE'}),onSuccess:done,onError:cause=>fail(cause,'Unable to delete this role')});
  const builtIn=new Set(['Administrator','Sales Manager','Salesperson']);
  if(roles.isLoading||users.isLoading)return <Loading/>;
  const countFor=(id:string)=>(users.data??[]).filter(person=>person.role?._id===id).length;
  return <div className="max-w-3xl space-y-3">
    <div className="rounded border border-sky-100 bg-sky-50 p-3 text-xs text-sky-900">Roles decide what a person can reach. The three built-in roles cannot be renamed or removed; add your own for narrower access, then assign them under <b>users</b>.</div>
    {error&&<div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}<button className="float-right font-semibold" onClick={()=>setError('')}>Dismiss</button></div>}
    <div className="panel overflow-hidden">
      {isAdmin&&<div className="flex gap-2 border-b p-3"><input className="field" value={name} placeholder="New role name" onChange={event=>setName(event.target.value)}/><Button className="btn-primary" disabled={!name.trim()||create.isPending} onClick={()=>create.mutate()}>Add</Button></div>}
      {roles.data?.map(role=><div className="flex items-center gap-2 border-b p-3 text-sm" key={role._id}>
        <ShieldCheck className="shrink-0 text-[#0284c7]" size={16}/>
        <span className="font-semibold">{role.name}</span>
        {builtIn.has(role.name)&&<span className="badge bg-slate-100 text-slate-500">built-in</span>}
        <span className="text-xs text-slate-400">{countFor(role._id)} user{countFor(role._id)===1?'':'s'}</span>
        {isAdmin&&!builtIn.has(role.name)&&<span className="ml-auto flex items-center gap-1">
          <Button title="Rename" disabled={rename.isPending} onClick={()=>{const next=prompt('Rename this role',role.name);if(next&&next.trim()&&next.trim()!==role.name)rename.mutate({id:role._id,next:next.trim()})}}>Rename</Button>
          <Button title="Delete" disabled={remove.isPending} onClick={()=>{if(confirm(`Delete the ${role.name} role?`))remove.mutate(role._id)}}><Trash2 size={13}/></Button>
        </span>}
      </div>)}
    </div>
  </div>;
}

function RoleInfo({title,detail}:{title:string;detail:string}){return <div className="panel flex gap-3 p-3"><ShieldCheck className="shrink-0 text-[#0284c7]" size={18}/><div><b className="text-xs">{title}</b><p className="mt-1 text-[11px] leading-4 text-slate-500">{detail}</p></div></div>}

function InvitePerson({onClose}:{onClose:()=>void}){
  const qc=useQueryClient();
  const roles=useQuery({queryKey:['admin-roles'],queryFn:()=>api<Named[]>('/admin/roles')});
  const [form,setForm]=useState({name:'',email:'',role:''}); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  async function submit(event:React.FormEvent){event.preventDefault();setBusy(true);setError('');try{await api('/admin/invitations',{method:'POST',body:JSON.stringify(form)});await qc.invalidateQueries({queryKey:['admin-invitations']});onClose()}catch(cause){setError(cause instanceof Error?cause.message:'Unable to send invitation')}finally{setBusy(false)}}
  return <Modal title="Invite Person to Lead CRM" onClose={onClose} width="max-w-md"><form onSubmit={submit}><div className="space-y-4 p-5"><div className="rounded border border-sky-100 bg-sky-50 p-3 text-xs text-sky-900">Choose the person’s access role now. They will receive a private email link and set their own password.</div><label><span className="label">Full name</span><input className="field" required minLength={2} value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/></label><label><span className="label">Email address</span><input className="field" type="email" required value={form.email} onChange={event=>setForm({...form,email:event.target.value})}/></label><label><span className="label">Access role</span><select className="field" required value={form.role} onChange={event=>setForm({...form,role:event.target.value})}><option value="">Select a role</option>{roles.data?.map(role=><option key={role._id} value={role._id}>{role.name}</option>)}</select></label>{error&&<p className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}</div><div className="flex justify-end gap-2 border-t bg-slate-50 p-3"><Button type="button" onClick={onClose}>Cancel</Button><Button className="btn-primary" disabled={busy}><Mail size={14}/>{busy?'Sending…':'Send invitation'}</Button></div></form></Modal>;
}
