import type { Server } from "socket.io";

let io: Server | null = null;

/** Open socket count per user id. A user is online while at least one tab is connected. */
const connections = new Map<string, number>();

export function setIo(server: Server): void {
  io = server;
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function markConnected(userId: string): boolean {
  const next = (connections.get(userId) || 0) + 1;
  connections.set(userId, next);
  return next === 1;
}

/** Returns true when the user's last connection closed. */
export function markDisconnected(userId: string): boolean {
  const next = (connections.get(userId) || 1) - 1;
  if (next <= 0) {
    connections.delete(userId);
    return true;
  }
  connections.set(userId, next);
  return false;
}

export function isOnline(userId: string): boolean {
  return (connections.get(userId) || 0) > 0;
}
