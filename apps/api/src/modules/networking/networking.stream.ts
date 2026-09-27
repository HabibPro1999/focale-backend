import type { FastifyReply } from "fastify";
import { networkingNotificationsSince } from "@app/db";
import type { ShutdownCoordinator } from "../../core/shutdown";
import type { NetworkingContext } from "./networking.service";

export async function openNotificationStream(reply: FastifyReply, { resolveContext, lifecycle }: { resolveContext: () => Promise<NetworkingContext>; lifecycle?: ShutdownCoordinator }) {
  lifecycle?.assertAcceptingStreams(reply);
  let ctx = await resolveContext();
  reply.hijack();
  for (const [key, value] of Object.entries(reply.getHeaders()))
    if (value !== undefined) reply.raw.setHeader(key, value);
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  reply.raw.write(`event: ready\ndata: {}\n\n`);
  // Overlapping reads tolerate commit/clock skew; the bounded sent-id set keeps rows from repeating.
  const sent = new Set<string>();
  let last = Date.now();
  let verifiedAt = Date.now();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (Date.now() - verifiedAt >= 30_000) {
        ctx = await resolveContext();
        verifiedAt = Date.now();
      }
      const checkedAt = Date.now();
      const rows = (await networkingNotificationsSince(ctx.event.id, ctx.profile.id, new Date(last - 10_000)))
        .filter((row) => !sent.has(row.id));
      last = checkedAt;
      for (const row of rows) sent.add(row.id);
      for (const id of sent) {
        if (sent.size <= 1000) break;
        sent.delete(id);
      }
      if (rows.length)
        reply.raw.write(
          `event: notifications\ndata: ${JSON.stringify(rows)}\n\n`,
        );
      else reply.raw.write(": heartbeat\n\n");
    } catch {
      reply.raw.end();
    } finally {
      busy = false;
    }
  }, 3000);
  const timeout = setTimeout(() => reply.raw.end(), 60_000);
  // Shutdown drain: tell the client when to reconnect (jittered), then close.
  const untrack = lifecycle?.trackStream((reconnectInMs) => {
    reply.raw.write(
      `event: shutdown\nretry: ${reconnectInMs}\ndata: ${JSON.stringify({ reconnectInMs })}\n\n`,
    );
    reply.raw.end();
  });
  reply.raw.on("close", () => {
    clearInterval(timer);
    clearTimeout(timeout);
    untrack?.();
  });
  }
