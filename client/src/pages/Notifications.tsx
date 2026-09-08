import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/Shell';
import { Button, Empty, Loading, RowMenu } from '../components/ui';
import { api, date } from '../lib/api';

type Notification = { _id: string; title: string; message: string; read: boolean; createdAt: string; link?: string };

export default function Notifications() {
  const queryClient = useQueryClient();
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api<Notification[]>('/notifications') });
  const [error, setError] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const fail = (cause: unknown, fallback: string) => setError(cause instanceof Error ? cause.message : fallback);

  const remove = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}`, { method: 'DELETE' }),
    onMutate: () => setError(''),
    onSuccess: refresh,
    onError: cause => fail(cause, 'Could not delete this notification.'),
  });
  const markAllRead = useMutation({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onMutate: () => setError(''),
    onSuccess: refresh,
    onError: cause => fail(cause, 'Could not mark notifications as read.'),
  });
  const clearAll = useMutation({
    mutationFn: () => api<{ deleted: number }>('/notifications', { method: 'DELETE' }),
    onMutate: () => setError(''),
    onSuccess: () => {
      queryClient.setQueryData<Notification[]>(['notifications'], []);
      void refresh();
    },
    onError: cause => fail(cause, 'Could not clear notifications.'),
  });

  if (notifications.isLoading) return <Loading />;
  const items = notifications.data ?? [];
  const hasUnread = items.some(item => !item.read);

  return <>
    <PageHeader title="Notifications" backTo="/" backLabel="Back to dashboard">
      <Button disabled={!hasUnread || markAllRead.isPending || clearAll.isPending} onClick={() => markAllRead.mutate()}><CheckCheck size={15} />{markAllRead.isPending ? 'Marking…' : 'Mark all read'}</Button>
      <Button className="text-red-600 hover:bg-red-50" disabled={!items.length || clearAll.isPending || remove.isPending} onClick={() => confirm(`Clear all ${items.length} notification${items.length === 1 ? '' : 's'}? This cannot be undone.`) && clearAll.mutate()}><Trash2 size={15} />{clearAll.isPending ? 'Clearing…' : 'Clear all'}</Button>
    </PageHeader>
    {error && <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>}
    <div className="mx-auto max-w-3xl p-4"><div className="panel overflow-hidden">
      {items.map(item => <div key={item._id} className={`flex items-start gap-1 border-b pr-2 hover:bg-slate-50 ${item.read ? '' : 'bg-[#f0f9ff]'}`}>
        <button onClick={async () => { if (!item.read) { await api(`/notifications/${item._id}`, { method: 'PATCH', body: JSON.stringify({ read: true }) }); void refresh(); } }} className="flex flex-1 gap-3 p-4 text-left">
          <span className="rounded-full bg-[#e0f2fe] p-2 text-[#0284c7]"><Bell size={16} /></span>
          <span><b className="block text-sm">{item.title}</b><span className="text-xs text-slate-500">{item.message}</span><small className="mt-1 block text-slate-400">{date(item.createdAt)}</small></span>
          {!item.read && <span className="ml-auto mt-2 h-2 w-2 rounded-full bg-[#0284c7]" />}
        </button>
        <span className="pt-4"><RowMenu label="Delete" busy={remove.isPending || clearAll.isPending} onDelete={() => confirm('Delete this notification?') && remove.mutate(item._id)} /></span>
      </div>)}
      {!items.length && <Empty title="You're all caught up" detail="New CRM notifications will appear here." />}
    </div></div>
  </>;
}
