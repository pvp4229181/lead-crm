import { io, type Socket } from 'socket.io-client';

// Real-time is only attached server-side under traditional hosting (see server.ts);
// on a Vercel serverless deployment this simply never connects, and callers should
// pair any socket-driven UI with a react-query refetchInterval as a fallback.
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) socket = io({ path: '/socket.io', withCredentials: true, autoConnect: true, reconnection: true });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
