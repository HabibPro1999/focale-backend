import { Injectable, type OnApplicationShutdown } from "@nestjs/common";

/**
 * Tracks every open SSE stream's cleanup closure so graceful shutdown can
 * force-close them (otherwise long-lived streams keep the process alive). Each
 * process/pod has its own registry — connections are never shared across
 * instances. Ported from the legacy module-level `activeConnections` set +
 * `drainRealtimeConnections`.
 */
@Injectable()
export class RealtimeConnectionRegistry implements OnApplicationShutdown {
  private readonly connections = new Set<() => void>();

  add(close: () => void): void {
    this.connections.add(close);
  }

  remove(close: () => void): void {
    this.connections.delete(close);
  }

  /** Best-effort force-close of every tracked connection, then clear. */
  drainAll(): void {
    for (const close of this.connections) {
      try {
        close();
      } catch {
        // best-effort drain
      }
    }
    this.connections.clear();
  }

  onApplicationShutdown(): void {
    this.drainAll();
  }
}
