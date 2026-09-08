import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, CheckCheck, Clock, FileText, MapPin, Paperclip, RefreshCw, Send, Trash2, User as UserIcon, Video, Wand2, X } from 'lucide-react';
import { api } from '../../lib/api';
import type { WAConversation, WAMessage, WATemplate } from '../../lib/types';
import { getSocket } from '../../lib/socket';
import { useAuth } from '../../context/Auth';
import { Button, Modal } from '../../components/ui';

const time = (v?: string) => (v ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(v)) : '');

function StatusTick({ status }: { status: WAMessage['status'] }) {
  if (status === 'FAILED') return <span className="font-bold text-red-300" title="Failed to send">!</span>;
  if (status === 'READ') return <CheckCheck size={14} className="text-sky-300" />;
  if (status === 'DELIVERED') return <CheckCheck size={14} className="text-white/60" />;
  if (status === 'SENT') return <Check size={14} className="text-white/60" />;
  return <Clock size={12} className="text-white/45" />;
}

function MediaBubble({ message }: { message: WAMessage }) {
  if (message.type === 'image' && message.mediaUrl) return <div className="max-w-72"><img src={message.mediaUrl} alt={message.caption ?? 'image'} className="rounded-md" />{message.caption && <p className="mt-1 text-xs">{message.caption}</p>}</div>;
  if (message.type === 'video' && message.mediaUrl) return <div className="max-w-72 flex items-center gap-2"><Video size={16} /><a className="underline" href={message.mediaUrl} target="_blank" rel="noreferrer">Video message</a></div>;
  if (message.type === 'audio' && message.mediaUrl) return <audio controls src={message.mediaUrl} className="max-w-64" />;
  if (message.type === 'document') return <a href={message.mediaUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline"><FileText size={16} />{message.filename ?? 'Document'}</a>;
  if (message.type === 'location' && message.location) return <a className="flex items-center gap-2 underline" target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${message.location.lat},${message.location.lng}`}><MapPin size={16} />{message.location.name ?? 'Shared location'}</a>;
  return <span className="italic opacity-60">Unsupported message type ({message.type})</span>;
}

const CONTROL_LABEL: Record<string, string> = { AI_ACTIVE: 'AI Active', WAITING_HUMAN: 'Waiting for Human', HUMAN_ACTIVE: 'Human Mode', AI_PAUSED: 'AI Paused' };
// Tuned for the dark conversation surface rather than the light CRM chrome around it.
const CONTROL_TONE: Record<string, string> = {
  AI_ACTIVE: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  WAITING_HUMAN: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  HUMAN_ACTIVE: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  AI_PAUSED: 'bg-slate-500/20 text-slate-300 ring-1 ring-slate-400/30',
};

export function ChatPanel({ conversation, onDeleted }: { conversation: WAConversation; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WAMessage | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const messages = useQuery({ queryKey: ['wa-messages', conversation._id], queryFn: () => api<WAMessage[]>(`/whatsapp/conversations/${conversation._id}/messages`) });

  useEffect(() => {
    const socket = getSocket();
    const onMessage = (payload: { conversationId: string; message: WAMessage }) => { if (payload.conversationId === conversation._id) qc.setQueryData<WAMessage[]>(['wa-messages', conversation._id], (prev = []) => [...prev, payload.message]); };
    const onStatus = (payload: { conversationId: string; messageId: string; status: WAMessage['status'] }) => { if (payload.conversationId === conversation._id) qc.setQueryData<WAMessage[]>(['wa-messages', conversation._id], (prev = []) => prev.map(m => (m._id === payload.messageId ? { ...m, status: payload.status } : m))); };
    const onDeletedMessage = (payload: { conversationId: string; message: WAMessage }) => { if (payload.conversationId === conversation._id) qc.setQueryData<WAMessage[]>(['wa-messages', conversation._id], (prev = []) => prev.map(message => message._id === payload.message._id ? payload.message : message)); };
    socket.on('message:new', onMessage); socket.on('message:status', onStatus); socket.on('message:deleted', onDeletedMessage);
    return () => { socket.off('message:new', onMessage); socket.off('message:status', onStatus); socket.off('message:deleted', onDeletedMessage); };
  }, [conversation._id, qc]);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages.data?.length]);
  useEffect(() => { api(`/whatsapp/conversations/${conversation._id}/read`, { method: 'POST' }).then(() => qc.invalidateQueries({ queryKey: ['wa-conversations'] })).catch(() => {}); }, [conversation._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useMutation({
    mutationFn: (body: string) => api<WAMessage>(`/whatsapp/conversations/${conversation._id}/messages`, { method: 'POST', body: JSON.stringify({ text: body }) }),
    onSuccess: message => { qc.setQueryData<WAMessage[]>(['wa-messages', conversation._id], (prev = []) => [...prev, message]); setText(''); setSuggestion(''); qc.invalidateQueries({ queryKey: ['wa-conversations'] }); },
  });
  const takeover = useMutation({ mutationFn: () => api(`/whatsapp/conversations/${conversation._id}/takeover`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-conversations'] }) });
  const resumeAi = useMutation({ mutationFn: () => api(`/whatsapp/conversations/${conversation._id}/resume-ai`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-conversations'] }) });
  const suggest = useMutation({ mutationFn: () => api<{ text: string }>(`/whatsapp/conversations/${conversation._id}/suggest-reply`, { method: 'POST' }), onSuccess: r => setSuggestion(r.text) });
  const templates = useQuery({ queryKey: ['wa-templates'], queryFn: () => api<WATemplate[]>('/whatsapp/templates'), enabled: showTemplates });

  const archive = useMutation({
    mutationFn: () => api(`/whatsapp/conversations/${conversation._id}`, { method: 'PATCH', body: JSON.stringify({ archived: !conversation.archived }) }),
    onSuccess: () => { setConfirmDelete(false); qc.invalidateQueries({ queryKey: ['wa-conversations'] }); },
  });
  const remove = useMutation({
    mutationFn: () => api(`/whatsapp/conversations/${conversation._id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDelete(false);
      qc.removeQueries({ queryKey: ['wa-messages', conversation._id] });
      qc.invalidateQueries({ queryKey: ['wa-conversations'] });
      onDeleted?.();
    },
  });
  const deleteMessage = useMutation({
    mutationFn: (messageId: string) => api<WAMessage>(`/whatsapp/conversations/${conversation._id}/messages/${messageId}`, { method: 'DELETE' }),
    onSuccess: deleted => {
      qc.setQueryData<WAMessage[]>(['wa-messages', conversation._id], (prev = []) => prev.map(message => message._id === deleted._id ? deleted : message));
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ['wa-conversations'] });
      qc.invalidateQueries({ queryKey: ['wa-conversation', conversation._id] });
    },
  });
  const canDelete = user && ['Administrator', 'Sales Manager'].includes(user.role.name);

  const isHuman = conversation.controlStatus === 'HUMAN_ACTIVE';
  const canTakeover = conversation.controlStatus !== 'HUMAN_ACTIVE';

  // Dark conversation surface, deliberately distinct from the light CRM chrome around it:
  // the chat reads as a messaging window, the sidebars stay part of the CRM.
  return <div className="flex h-full min-h-0 min-w-0 flex-col bg-[#0b141a] text-[#e9edef]">
    <div className="flex items-center gap-3 border-b border-white/8 bg-[#111b21] px-4 py-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-bold text-emerald-300">{(conversation.customerName ?? conversation.phoneNumber).slice(0, 2).toUpperCase()}</div>
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{conversation.customerName || conversation.phoneNumber}</div><div className="text-xs text-white/45">{conversation.phoneNumber}</div></div>
      <span className={`badge ${CONTROL_TONE[conversation.controlStatus]}`}>
        <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${conversation.controlStatus === 'AI_ACTIVE' ? 'bg-emerald-400' : conversation.controlStatus === 'AI_PAUSED' ? 'bg-slate-400' : 'bg-amber-400'}`} />
        {CONTROL_LABEL[conversation.controlStatus]}
      </span>
      {/* `.btn` in index.css is unlayered, so it outranks Tailwind utilities — the dark
          overrides need `!` to actually apply. */}
      {canTakeover
        ? <Button className="h-8 !border-white/15 !bg-white/10 !text-white hover:!bg-white/20" disabled={takeover.isPending} onClick={() => takeover.mutate()}><UserIcon size={13} />Take over</Button>
        : <Button className="h-8 !border-emerald-500/40 !bg-emerald-500/15 !text-emerald-200 hover:!bg-emerald-500/25" disabled={resumeAi.isPending} onClick={() => resumeAi.mutate()}><Bot size={13} />Resume AI</Button>}
      {canDelete && <button type="button" title="Delete this chat" className="rounded p-1.5 text-white/45 hover:bg-red-500/15 hover:text-red-300" onClick={() => setConfirmDelete(true)}><Trash2 size={15} /></button>}
    </div>

    {confirmDelete && <Modal title="Delete this chat?" width="max-w-md" onClose={() => setConfirmDelete(false)}>
      <div className="space-y-3 p-5 text-sm text-slate-600">
        <p>This permanently deletes the conversation with <b>{conversation.customerName || conversation.phoneNumber}</b> and all {messages.data?.length ?? 0} of its messages. It cannot be undone.</p>
        {/* Deleting here is local only — WhatsApp gives no API to unsend a delivered message. */}
        <p className="text-xs text-slate-400">The messages stay on the customer's phone — this only clears them from the CRM. The lead record and its history are kept.</p>
        {remove.isError && <p className="text-xs text-red-600">{(remove.error as any)?.message ?? 'Could not delete this chat.'}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t bg-slate-50 p-3">
        <Button type="button" onClick={() => setConfirmDelete(false)}>Cancel</Button>
        {!conversation.archived && <Button type="button" disabled={archive.isPending} onClick={() => archive.mutate()}>Archive instead</Button>}
        <Button className="!border-red-600 !bg-red-600 !text-white hover:!bg-red-700" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? 'Deleting…' : 'Delete permanently'}</Button>
      </div>
    </Modal>}

    {deleteTarget && <Modal title="Delete this message?" width="max-w-md" onClose={() => { if (!deleteMessage.isPending) { setDeleteTarget(null); deleteMessage.reset(); } }}>
      <div className="space-y-3 p-5 text-sm text-slate-600">
        <div className="max-h-28 overflow-auto rounded-md bg-slate-100 p-3 text-xs text-slate-700">
          {deleteTarget.text || deleteTarget.caption || `[${deleteTarget.type} message]`}
        </div>
        <p>This hides the original content and leaves a “This message was deleted” marker in the CRM conversation.</p>
        <p className="text-xs text-slate-400">The original message will remain visible in WhatsApp on the customer's and sender's phones.</p>
        {deleteMessage.isError && <p className="text-xs text-red-600">{(deleteMessage.error as any)?.message ?? 'Could not delete this message.'}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t bg-slate-50 p-3">
        <Button type="button" disabled={deleteMessage.isPending} onClick={() => { setDeleteTarget(null); deleteMessage.reset(); }}>Cancel</Button>
        <Button className="!border-red-600 !bg-red-600 !text-white hover:!bg-red-700" disabled={deleteMessage.isPending} onClick={() => deleteMessage.mutate(deleteTarget._id)}>{deleteMessage.isPending ? 'Deleting…' : 'Delete message'}</Button>
      </div>
    </Modal>}

    <div ref={listRef} className="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
      {messages.isLoading && <div className="text-center text-xs text-white/40">Loading messages…</div>}
      {messages.data?.map(message => {
        const mine = message.direction === 'OUTBOUND';
        return <div key={message._id} className={`group flex items-center gap-1 ${mine ? 'justify-end' : 'justify-start'}`}>
          <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm shadow-sm ${mine ? (message.aiGenerated ? 'bg-[#046c4e] text-white' : 'bg-[#005c4b] text-white') : 'bg-[#202c33] text-[#e9edef]'}`}>
            {message.aiGenerated && <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-white/70"><Bot size={11} />AI</div>}
            {message.deletedAt ? <p className="italic text-white/50">This message was deleted</p> : message.type === 'text' ? <p className="whitespace-pre-wrap break-words">{message.text}</p> : <MediaBubble message={message} />}
            <div className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${mine ? 'text-white/55' : 'text-white/40'}`}>{time(message.timestamp)}{mine && !message.deletedAt && <StatusTick status={message.status} />}</div>
          </div>
          {canDelete && !message.deletedAt && <button type="button" title="Delete message from CRM" aria-label="Delete message from CRM" disabled={deleteMessage.isPending} className="rounded p-1.5 text-white/35 opacity-40 transition hover:bg-red-500/15 hover:text-red-300 focus:opacity-100 disabled:opacity-20 sm:opacity-0 sm:group-hover:opacity-100" onClick={() => { deleteMessage.reset(); setDeleteTarget(message); }}><Trash2 size={14} /></button>}
        </div>;
      })}
      {!messages.isLoading && !messages.data?.length && <div className="text-center text-xs text-white/40">No messages yet.</div>}
    </div>

    {isHuman && <div className="border-t border-white/8 bg-[#111b21] px-4 py-2">
      {suggestion ? <div className="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 p-2 text-xs">
        <Wand2 size={14} className="mt-0.5 shrink-0 text-amber-300" />
        <p className="flex-1 text-white/85">{suggestion}</p>
        <button title="Regenerate" className="text-amber-300 hover:text-amber-200" onClick={() => suggest.mutate()} disabled={suggest.isPending}><RefreshCw size={13} /></button>
        <button className="font-semibold text-amber-300 hover:text-amber-200" onClick={() => setText(suggestion)}>Use</button>
        <button className="text-white/40 hover:text-white/70" onClick={() => setSuggestion('')}><X size={13} /></button>
      </div> : <button className="flex items-center gap-1.5 text-xs font-semibold text-amber-300 hover:text-amber-200" disabled={suggest.isPending} onClick={() => suggest.mutate()}><Wand2 size={13} />{suggest.isPending ? 'Thinking…' : 'Suggest a reply'}</button>}
    </div>}

    <form className="flex items-center gap-2 border-t border-white/8 bg-[#111b21] p-2.5" onSubmit={event => { event.preventDefault(); if (text.trim()) send.mutate(text.trim()); }}>
      <button type="button" title="Templates" className="p-2 text-white/50 hover:text-white/85" onClick={() => setShowTemplates(v => !v)}><Paperclip size={17} /></button>
      <input className="h-9 flex-1 rounded-lg border border-white/10 bg-[#2a3942] px-3 text-[13px] text-white placeholder:text-white/35 outline-none focus:border-emerald-500/50" placeholder="Type a message…" value={text} onChange={event => setText(event.target.value)} />
      <Button type="submit" className="h-9 !border-emerald-600 !bg-emerald-600 !text-white hover:!bg-emerald-500" disabled={send.isPending || !text.trim()}><Send size={15} /></Button>
    </form>
    {showTemplates && <div className="scrollbar-thin max-h-48 overflow-auto border-t border-white/8 bg-[#111b21] p-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">Approved templates</div>
      {templates.data?.filter(t => t.status === 'APPROVED').map(t => <button key={t._id} className="block w-full rounded p-2 text-left text-xs text-white/80 hover:bg-white/8" onClick={() => { setText(t.body); setShowTemplates(false); }}><b className="text-white">{t.templateName}</b> — {t.body}</button>)}
      {templates.data && !templates.data.filter(t => t.status === 'APPROVED').length && <p className="p-2 text-xs text-white/40">No approved templates yet. Add one under WhatsApp Settings.</p>}
    </div>}
  </div>;
}
