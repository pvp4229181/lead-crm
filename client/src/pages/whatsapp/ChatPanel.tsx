import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, Bot, Check, CheckCheck, ChevronLeft, Clock, FileText, Info, MapPin, Paperclip, RefreshCw, Send, Trash2, TriangleAlert, User as UserIcon, Video, Wand2, X } from 'lucide-react';
import { api } from '../../lib/api';
import type { WAConversation, WAMessage, WATemplate } from '../../lib/types';
import { useLiveInterval, useSocketEvents } from '../../lib/hooks';
import { useAuth } from '../../context/Auth';
import { useToast } from '../../components/Toast';
import { Button, Modal } from '../../components/ui';

const time = (v?: string) => (v ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(v)) : '');

const dayLabel = (value: string) => {
  const at = new Date(value);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (at.toDateString() === today.toDateString()) return 'Today';
  if (at.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: at.getFullYear() === today.getFullYear() ? undefined : 'numeric' }).format(at);
};

function StatusTick({ status }: { status: WAMessage['status'] }) {
  if (status === 'FAILED') return <TriangleAlert size={12} className="text-red-300" aria-label="Failed to send" />;
  if (status === 'READ') return <CheckCheck size={14} className="text-sky-300" />;
  if (status === 'DELIVERED') return <CheckCheck size={14} className="text-white/60" />;
  if (status === 'SENT') return <Check size={14} className="text-white/60" />;
  return <Clock size={12} className="text-white/45" />;
}

function MediaBubble({ message }: { message: WAMessage }) {
  if (message.type === 'image' && message.mediaUrl) return <div className="max-w-72"><img src={message.mediaUrl} alt={message.caption ?? 'image'} className="rounded-md" loading="lazy" />{message.caption && <p className="mt-1 text-xs">{message.caption}</p>}</div>;
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

const PAGE_SIZE = 50;

export function ChatPanel({ conversation, onDeleted, onBack, onToggleLead }: {
  conversation: WAConversation;
  onDeleted?: () => void;
  onBack?: () => void;
  onToggleLead?: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const toast = useToast();
  const [text, setText] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WAMessage | null>(null);
  const [older, setOlder] = useState<WAMessage[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Socket.IO cannot stay connected on Vercel's serverless functions, so the open chat
  // polls quickly when there is no live feed and only keeps a slow safety net when there is.
  const messages = useQuery({
    queryKey: ['wa-messages', conversation._id],
    queryFn: () => api<WAMessage[]>(`/whatsapp/conversations/${conversation._id}/messages?limit=${PAGE_SIZE}`),
    refetchInterval: useLiveInterval(3000, 30000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
  });

  // Older pages are held outside the query cache: the recent page refetches on a timer and
  // would otherwise discard the history the user just scrolled back through.
  useEffect(() => { setOlder([]); setText(''); setSuggestion(''); }, [conversation._id]);

  const all = useMemo(() => {
    const seen = new Set<string>();
    return [...older, ...(messages.data ?? [])]
      .filter(message => !seen.has(message._id) && seen.add(message._id))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [older, messages.data]);

  const loadOlder = useMutation({
    mutationFn: () => api<WAMessage[]>(`/whatsapp/conversations/${conversation._id}/messages?limit=${PAGE_SIZE}&before=${encodeURIComponent(all[0]!.timestamp)}`),
    onSuccess: page => {
      if (!page.length) { toast.toast('You have reached the start of this conversation.'); return; }
      const list = listRef.current;
      const before = list?.scrollHeight ?? 0;
      setOlder(current => [...page, ...current]);
      // Keep the reader where they were rather than jumping to the new top.
      requestAnimationFrame(() => { if (list) list.scrollTop += list.scrollHeight - before; });
    },
    onError: cause => toast.error(cause, 'Could not load older messages.'),
  });

  const upsert = useCallback((message: WAMessage) => {
    qc.setQueryData<WAMessage[]>(['wa-messages', conversation._id], (prev = []) =>
      prev.some(existing => existing._id === message._id) ? prev.map(existing => existing._id === message._id ? message : existing) : [...prev, message]);
  }, [qc, conversation._id]);

  useSocketEvents({
    'message:new': (payload: { conversationId: string; message: WAMessage }) => { if (payload.conversationId === conversation._id) upsert(payload.message); },
    'message:deleted': (payload: { conversationId: string; message: WAMessage }) => {
      if (payload.conversationId !== conversation._id) return;
      upsert(payload.message);
      setOlder(current => current.map(message => message._id === payload.message._id ? payload.message : message));
    },
    'message:status': (payload: { conversationId: string; messageId: string; status: WAMessage['status'] }) => {
      if (payload.conversationId !== conversation._id) return;
      qc.setQueryData<WAMessage[]>(['wa-messages', conversation._id], (prev = []) => prev.map(m => (m._id === payload.messageId ? { ...m, status: payload.status } : m)));
    },
  });

  // Only follow new messages when the reader is already at the bottom, so scrolling back
  // through history is not yanked away by an incoming reply.
  const lastId = all[all.length - 1]?._id;
  useEffect(() => { if (atBottom) listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [lastId, atBottom]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [conversation._id]);

  useEffect(() => { api(`/whatsapp/conversations/${conversation._id}/read`, { method: 'POST' }).then(() => qc.invalidateQueries({ queryKey: ['wa-conversations'] })).catch(() => {}); }, [conversation._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useMutation({
    mutationFn: (body: string) => api<WAMessage>(`/whatsapp/conversations/${conversation._id}/messages`, { method: 'POST', body: JSON.stringify({ text: body }) }),
    onMutate: async body => {
      // Show the bubble straight away; WhatsApp's own client sets that expectation.
      const optimisticId = `pending-${Date.now()}`;
      qc.setQueryData<WAMessage[]>(['wa-messages', conversation._id], (prev = []) => [...prev, {
        _id: optimisticId, conversation: conversation._id, direction: 'OUTBOUND', type: 'text', text: body,
        timestamp: new Date().toISOString(), status: 'QUEUED', aiGenerated: false,
      } as WAMessage]);
      setAtBottom(true);
      return { optimisticId, body };
    },
    onSuccess: (message, _body, context) => {
      qc.setQueryData<WAMessage[]>(['wa-messages', conversation._id], (prev = []) =>
        prev.filter(existing => existing._id !== context?.optimisticId && existing._id !== message._id).concat(message));
      setText(''); setSuggestion('');
      qc.invalidateQueries({ queryKey: ['wa-conversations'] });
    },
    onError: (cause, _body, context) => {
      // The API records a FAILED message before returning the error, so drop the optimistic
      // bubble and let the refetch surface the real one instead of showing it twice.
      qc.setQueryData<WAMessage[]>(['wa-messages', conversation._id], (prev = []) => prev.filter(existing => existing._id !== context?.optimisticId));
      qc.invalidateQueries({ queryKey: ['wa-messages', conversation._id] });
      toast.error(cause, 'WhatsApp did not accept that message.');
      // Give the text back so the message is not lost to a transient failure.
      if (context?.body) { setText(current => current || context.body); composerRef.current?.focus(); }
    },
  });

  const takeover = useMutation({ mutationFn: () => api(`/whatsapp/conversations/${conversation._id}/takeover`, { method: 'POST' }), onSuccess: () => { toast.success('You are now handling this chat'); qc.invalidateQueries({ queryKey: ['wa-conversations'] }); qc.invalidateQueries({ queryKey: ['wa-conversation', conversation._id] }); }, onError: cause => toast.error(cause, 'Could not take over this chat.') });
  const resumeAi = useMutation({ mutationFn: () => api(`/whatsapp/conversations/${conversation._id}/resume-ai`, { method: 'POST' }), onSuccess: () => { toast.success('The AI agent is handling this chat again'); qc.invalidateQueries({ queryKey: ['wa-conversations'] }); qc.invalidateQueries({ queryKey: ['wa-conversation', conversation._id] }); }, onError: cause => toast.error(cause, 'Could not hand this chat back to the AI.') });
  const suggest = useMutation({ mutationFn: () => api<{ text: string }>(`/whatsapp/conversations/${conversation._id}/suggest-reply`, { method: 'POST' }), onSuccess: r => setSuggestion(r.text), onError: cause => toast.error(cause, 'The AI could not draft a reply right now.') });
  const templates = useQuery({ queryKey: ['wa-templates'], queryFn: () => api<WATemplate[]>('/whatsapp/templates'), enabled: showTemplates });

  const archive = useMutation({
    mutationFn: () => api(`/whatsapp/conversations/${conversation._id}`, { method: 'PATCH', body: JSON.stringify({ archived: !conversation.archived }) }),
    onSuccess: () => { setConfirmDelete(false); toast.success(conversation.archived ? 'Chat restored' : 'Chat archived'); qc.invalidateQueries({ queryKey: ['wa-conversations'] }); },
    onError: cause => toast.error(cause, 'Could not archive this chat.'),
  });
  const remove = useMutation({
    mutationFn: () => api(`/whatsapp/conversations/${conversation._id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDelete(false);
      qc.removeQueries({ queryKey: ['wa-messages', conversation._id] });
      qc.invalidateQueries({ queryKey: ['wa-conversations'] });
      toast.success('Chat deleted');
      onDeleted?.();
    },
  });
  const deleteMessage = useMutation({
    mutationFn: (messageId: string) => api<WAMessage>(`/whatsapp/conversations/${conversation._id}/messages/${messageId}`, { method: 'DELETE' }),
    onSuccess: deleted => {
      upsert(deleted);
      setOlder(current => current.map(message => message._id === deleted._id ? deleted : message));
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ['wa-conversations'] });
      qc.invalidateQueries({ queryKey: ['wa-conversation', conversation._id] });
    },
  });
  const canDelete = user && ['Administrator', 'Sales Manager'].includes(user.role.name);

  const aiActive = conversation.controlStatus === 'AI_ACTIVE' && conversation.aiEnabled;
  const isHuman = !aiActive;

  const submit = () => { const body = text.trim(); if (body && !send.isPending) send.mutate(body); };

  // Dark conversation surface, deliberately distinct from the light CRM chrome around it:
  // the chat reads as a messaging window, the sidebars stay part of the CRM.
  return <div className="flex h-full min-h-0 min-w-0 flex-col bg-[#0b141a] text-[#e9edef]">
    <div className="flex items-center gap-2 border-b border-white/8 bg-[#111b21] px-3 py-2.5 sm:gap-3 sm:px-4">
      {onBack && <button type="button" className="-ml-1 rounded p-1 text-white/60 transition-colors hover:bg-white/10 hover:text-white md:hidden" aria-label="Back to conversations" onClick={onBack}><ChevronLeft size={19} /></button>}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-bold text-emerald-300">{(conversation.customerName ?? conversation.phoneNumber).slice(0, 2).toUpperCase()}</div>
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{conversation.customerName || conversation.phoneNumber}</div><div className="truncate text-xs text-white/45">{conversation.phoneNumber}</div></div>
      <button type="button" title={aiActive ? 'AI mode is active. Click to switch to Human mode.' : 'Human mode is active. Click to switch to AI mode.'} aria-label={aiActive ? 'Switch to Human mode' : 'Switch to AI mode'} className={`badge h-8 shrink-0 gap-1.5 transition hover:brightness-125 disabled:opacity-50 ${CONTROL_TONE[conversation.controlStatus]}`} disabled={takeover.isPending||resumeAi.isPending} onClick={()=>aiActive?takeover.mutate():resumeAi.mutate()}>
        {aiActive?<Bot size={13}/>:<UserIcon size={13}/>}<span className="hidden sm:inline">{CONTROL_LABEL[conversation.controlStatus]}</span><span className="hidden xl:inline">→ {aiActive?'Human':'AI'}</span>
      </button>
      {onToggleLead && <button type="button" title="Lead details" className="shrink-0 rounded p-1.5 text-white/45 transition-colors hover:bg-white/10 hover:text-white xl:hidden" onClick={onToggleLead}><Info size={16} /></button>}
      {canDelete && <button type="button" title="Delete this chat" className="shrink-0 rounded p-1.5 text-white/45 transition-colors hover:bg-red-500/15 hover:text-red-300" onClick={() => setConfirmDelete(true)}><Trash2 size={15} /></button>}
    </div>

    {confirmDelete && <Modal title="Delete this chat?" width="max-w-md" onClose={() => setConfirmDelete(false)}>
      <div className="space-y-3 p-5 text-sm text-slate-600">
        <p>This permanently deletes the conversation with <b>{conversation.customerName || conversation.phoneNumber}</b> and all {all.length} of its messages. It cannot be undone.</p>
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

    <div
      ref={listRef}
      className="scrollbar-thin relative min-h-0 flex-1 space-y-1.5 overflow-y-auto p-4"
      onScroll={event => { const el = event.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80); }}
    >
      {messages.isLoading && <div className="space-y-2">{[70, 45, 60].map((width, index) => <div key={index} className={`flex ${index % 2 ? 'justify-end' : 'justify-start'}`}><div className="skeleton-dark h-10 rounded-xl" style={{ width: `${width}%` }} /></div>)}</div>}

      {!messages.isLoading && all.length >= PAGE_SIZE && <div className="flex justify-center pb-1">
        <button className="rounded-full bg-white/8 px-3 py-1 text-[11px] font-semibold text-white/60 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-40" disabled={loadOlder.isPending} onClick={() => loadOlder.mutate()}>
          {loadOlder.isPending ? 'Loading…' : 'Load earlier messages'}
        </button>
      </div>}

      {all.map((message, index) => {
        const mine = message.direction === 'OUTBOUND';
        const previous = all[index - 1];
        const newDay = !previous || new Date(previous.timestamp).toDateString() !== new Date(message.timestamp).toDateString();
        const pending = message._id.startsWith('pending-');
        return <div key={message._id}>
          {newDay && <div className="my-3 flex justify-center"><span className="rounded-full bg-white/8 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">{dayLabel(message.timestamp)}</span></div>}
          <div className={`group flex items-center gap-1 ${mine ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm transition-opacity sm:max-w-[75%] ${pending ? 'opacity-60' : ''} ${message.status === 'FAILED' ? 'bg-red-950/60 text-red-50 ring-1 ring-red-500/40' : mine ? (message.aiGenerated ? 'bg-[#046c4e] text-white' : 'bg-[#005c4b] text-white') : 'bg-[#202c33] text-[#e9edef]'}`}>
              {message.aiGenerated && <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-white/70"><Bot size={11} />AI</div>}
              {message.deletedAt ? <p className="italic text-white/50">This message was deleted</p> : message.type === 'text' ? <p className="whitespace-pre-wrap break-words">{message.text}</p> : <MediaBubble message={message} />}
              <div className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${mine ? 'text-white/55' : 'text-white/40'}`}>{time(message.timestamp)}{mine && !message.deletedAt && <StatusTick status={message.status} />}</div>
              {message.status === 'FAILED' && message.failReason && <p className="mt-1 border-t border-red-400/25 pt-1 text-[10px] text-red-200/80">{message.failReason}</p>}
            </div>
            {canDelete && !message.deletedAt && !pending && <button type="button" title="Delete message from CRM" aria-label="Delete message from CRM" disabled={deleteMessage.isPending} className="rounded p-1.5 text-white/35 opacity-40 transition hover:bg-red-500/15 hover:text-red-300 focus:opacity-100 disabled:opacity-20 sm:opacity-0 sm:group-hover:opacity-100" onClick={() => { deleteMessage.reset(); setDeleteTarget(message); }}><Trash2 size={14} /></button>}
          </div>
        </div>;
      })}
      {!messages.isLoading && !all.length && <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
        <p className="text-xs text-white/50">No messages yet.</p>
        <p className="text-[11px] text-white/30">Anything you send here appears in the customer's WhatsApp.</p>
      </div>}
    </div>

    {!atBottom && <div className="relative">
      <button className="absolute -top-14 right-5 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-[#202c33] text-white/70 shadow-lg transition-colors hover:text-white" aria-label="Jump to latest message" onClick={() => { setAtBottom(true); listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown size={16} /></button>
    </div>}

    {isHuman && <div className="border-t border-white/8 bg-[#111b21] px-4 py-2">
      {suggestion ? <div className="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 p-2 text-xs">
        <Wand2 size={14} className="mt-0.5 shrink-0 text-amber-300" />
        <p className="flex-1 text-white/85">{suggestion}</p>
        <button title="Regenerate" className="text-amber-300 transition-colors hover:text-amber-200" onClick={() => suggest.mutate()} disabled={suggest.isPending}><RefreshCw size={13} className={suggest.isPending ? 'animate-spin' : ''} /></button>
        <button className="font-semibold text-amber-300 transition-colors hover:text-amber-200" onClick={() => { setText(suggestion); composerRef.current?.focus(); }}>Use</button>
        <button className="text-white/40 transition-colors hover:text-white/70" aria-label="Dismiss suggestion" onClick={() => setSuggestion('')}><X size={13} /></button>
      </div> : <button className="flex items-center gap-1.5 text-xs font-semibold text-amber-300 transition-colors hover:text-amber-200" disabled={suggest.isPending} onClick={() => suggest.mutate()}><Wand2 size={13} />{suggest.isPending ? 'Thinking…' : 'Suggest a reply'}</button>}
    </div>}

    <form className="flex items-end gap-2 border-t border-white/8 bg-[#111b21] p-2.5" onSubmit={event => { event.preventDefault(); submit(); }}>
      <button type="button" title="Templates" aria-label="Insert a template" className="rounded p-2 text-white/50 transition-colors hover:bg-white/10 hover:text-white/85" onClick={() => setShowTemplates(v => !v)}><Paperclip size={17} /></button>
      <textarea
        ref={composerRef}
        rows={1}
        className="scrollbar-thin max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-white/10 bg-[#2a3942] px-3 py-2 text-[13px] leading-5 text-white outline-none transition-colors placeholder:text-white/35 focus:border-emerald-500/50"
        placeholder="Type a message…  (Enter to send, Shift+Enter for a new line)"
        value={text}
        onChange={event => {
          setText(event.target.value);
          // Grow with the content instead of hiding longer replies behind a one-line input.
          event.target.style.height = 'auto';
          event.target.style.height = `${Math.min(event.target.scrollHeight, 128)}px`;
        }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }}
      />
      <Button type="submit" className="h-9 shrink-0 !border-emerald-600 !bg-emerald-600 !text-white hover:!bg-emerald-500" aria-label="Send message" disabled={send.isPending || !text.trim()}><Send size={15} /></Button>
    </form>

    {showTemplates && <div className="scrollbar-thin max-h-48 overflow-auto border-t border-white/8 bg-[#111b21] p-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">Approved templates</div>
      {templates.data?.filter(t => t.status === 'APPROVED').map(t => <button key={t._id} className="block w-full rounded p-2 text-left text-xs text-white/80 transition-colors hover:bg-white/8" onClick={() => { setText(t.body); setShowTemplates(false); composerRef.current?.focus(); }}><b className="text-white">{t.templateName}</b> — {t.body}</button>)}
      {templates.data && !templates.data.filter(t => t.status === 'APPROVED').length && <p className="p-2 text-xs text-white/40">No approved templates yet. Add one under WhatsApp Settings.</p>}
    </div>}
  </div>;
}
