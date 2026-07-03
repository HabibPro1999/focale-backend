import type { FastifyReply } from "fastify";

export interface SseFrame {
  id?: string;
  event?: string;
  data?: unknown;
  retry?: number;
}

/**
 * Hand-rolled SSE writer over the raw HTTP response. The legacy route drove
 * `@fastify/sse`'s `reply.sse`, but that plugin only decorates the reply for
 * routes registered with `sse: true` — an option Nest's router never sets — so
 * we replicate its wire format and lifecycle here. Frame format mirrors
 * `@fastify/sse`'s `formatSSEMessage` (id, event, data, retry, blank line) so the
 * frontend's fetch-event-source parses it unchanged.
 */
export class SseStream {
  private connected = true;
  private headersSent = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closeCallbacks: Array<() => void> = [];

  constructor(private readonly reply: FastifyReply) {
    // Client disconnect (abort / TCP close) or a socket error ends the stream.
    reply.raw.on("close", () => this.cleanup());
    reply.raw.on("error", () => this.cleanup());
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private sendHeaders(): void {
    if (this.headersSent) return;
    this.reply.raw.setHeader("Content-Type", "text/event-stream");
    this.reply.raw.setHeader("Cache-Control", "no-cache");
    this.reply.raw.setHeader("Connection", "keep-alive");
    this.reply.raw.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    this.reply.raw.writeHead(200);
    this.headersSent = true;
  }

  /** Write one SSE frame. Rejects if the connection is closed (caller closes). */
  send(frame: SseFrame): Promise<void> {
    if (!this.connected) {
      return Promise.reject(new Error("SSE connection is closed"));
    }
    try {
      this.sendHeaders();
      let payload = "";
      if (frame.id) payload += `id: ${frame.id}\n`;
      if (frame.event) payload += `event: ${frame.event}\n`;
      if (frame.data !== undefined) {
        const dataStr = JSON.stringify(frame.data);
        for (const line of dataStr.split("\n")) payload += `data: ${line}\n`;
      }
      if (frame.retry) payload += `retry: ${frame.retry}\n`;
      payload += "\n";
      this.reply.raw.write(payload);
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err as Error);
    }
  }

  /** Enable heartbeat comment frames so proxies/LBs don't drop the idle stream. */
  keepAlive(heartbeatMs: number): void {
    if (this.heartbeatTimer || heartbeatMs <= 0) return;
    this.sendHeaders();
    this.heartbeatTimer = setInterval(() => {
      if (this.connected) this.reply.raw.write(": heartbeat\n\n");
      else this.stopHeartbeat();
    }, heartbeatMs);
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  /** Idempotent teardown: stop heartbeat, run close callbacks exactly once. */
  private cleanup(): void {
    if (!this.connected) return;
    this.connected = false;
    this.stopHeartbeat();
    const callbacks = this.closeCallbacks;
    this.closeCallbacks = [];
    for (const cb of callbacks) {
      try {
        cb();
      } catch {
        // best-effort
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Close the stream and end the underlying socket. Safe to call repeatedly. */
  close(): void {
    const wasConnected = this.connected;
    this.cleanup();
    if (wasConnected) {
      try {
        this.reply.raw.end();
      } catch {
        // already ended
      }
    }
  }
}
