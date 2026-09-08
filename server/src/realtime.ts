import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { User } from './models/index.js';

// Socket.IO needs a long-lived process, so it's only attached in server.ts (traditional
// hosting / local dev). The Vercel serverless entry (api/index.ts) never calls attachRealtime,
// so emit() below is a safe no-op there — the client UI falls back to polling in that case.
let io: SocketServer | null = null;

export function attachRealtime(server: HttpServer) {
  io = new SocketServer(server, { cors: { origin: process.env.CLIENT_URL ?? 'http://localhost:5173', credentials: true } });
  io.use(async (socket, next) => {
    try {
      const raw = socket.handshake.auth?.token as string | undefined;
      const cookieHeader = socket.handshake.headers.cookie ?? '';
      const cookieToken = /orbit_token=([^;]+)/.exec(cookieHeader)?.[1];
      const token = raw ?? cookieToken;
      if (!token) return next(new Error('Authentication required'));
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as { sub: string };
      const user = await User.findById(payload.sub).select('_id role active deletedAt').populate('role', 'name');
      if (!user?.active || user.deletedAt) return next(new Error('Authentication required'));
      (socket.data as any).userId = String(user._id);
      (socket.data as any).role = (user.role as any)?.name;
      next();
    } catch { next(new Error('Authentication required')); }
  });
  io.on('connection', socket => {
    socket.join('whatsapp:all');
    socket.join(`user:${(socket.data as any).userId}`);
  });
  return io;
}

export function emitToConversation(conversationId: string, event: string, payload: unknown) {
  io?.to('whatsapp:all').emit(event, { conversationId, ...((payload as object) ?? {}) });
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function disconnectUser(userId: string) {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

export const isRealtimeAttached = () => io !== null;
