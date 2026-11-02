/**
 * Token bucket in front of the email provider for networking emails (4.2).
 * One bucket per worker process, shared by every delivery lane: `ratePerSecond`
 * tokens a second, up to one second's worth banked. Sign-in codes (OTP) are
 * served before any other waiting email. A provider 429 pauses the bucket,
 * doubling the pause from 1 s up to 60 s while 429s keep coming; an accepted
 * email resets it.
 */
export type NetworkingEmailPriority = "otp" | "other";

const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class NetworkingEmailRateLimiter {
  private tokens: number;
  private refilledAt: number;
  private pausedUntil = 0;
  private backoffMs = 0;
  private readonly waiting: Record<NetworkingEmailPriority, Waiter[]> = { otp: [], other: [] };
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly ratePerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!(ratePerSecond > 0)) throw new Error("ratePerSecond must be positive");
    this.tokens = this.capacity;
    this.refilledAt = now();
  }

  private get capacity() {
    return Math.max(1, this.ratePerSecond);
  }

  /** Resolves when this email may go to the provider; rejects if `signal` aborts first. */
  take(priority: NetworkingEmailPriority, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const queue = this.waiting[priority];
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiting[priority].push(waiter);
      this.pump();
    });
  }

  /** The provider answered 429: pause every lane. Returns when sending may resume (epoch ms). */
  rateLimited(): number {
    this.backoffMs = this.backoffMs ? Math.min(MAX_BACKOFF_MS, this.backoffMs * 2) : FIRST_BACKOFF_MS;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + this.backoffMs);
    // Tokens start again from empty once the pause ends: no burst after a 429.
    this.tokens = 0;
    this.refilledAt = this.pausedUntil;
    this.reschedule();
    return this.pausedUntil;
  }

  /** The provider took an email: the next 429 starts from the first backoff again. */
  succeeded(): void {
    this.backoffMs = 0;
  }

  /** Waiting emails (for tests and logs). */
  get pending(): number {
    return this.waiting.otp.length + this.waiting.other.length;
  }

  private refill(now: number) {
    if (now <= this.refilledAt) return;
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.refilledAt) / 1000) * this.ratePerSecond);
    this.refilledAt = now;
  }

  private next(): Waiter | undefined {
    return this.waiting.otp.shift() ?? this.waiting.other.shift();
  }

  private pump() {
    const now = this.now();
    this.refill(now);
    while (this.pending && now >= this.pausedUntil && this.tokens >= 1) {
      const waiter = this.next()!;
      this.tokens -= 1;
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
    this.reschedule();
  }

  private reschedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending) return;
    const now = this.now();
    const refillMs = this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.ratePerSecond) * 1000;
    const waitMs = Math.max(this.pausedUntil - now, refillMs, 1);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, Math.ceil(waitMs));
    // A waiting email never keeps the process alive on its own.
    this.timer.unref?.();
  }
}

let shared: NetworkingEmailRateLimiter | undefined;

/** The worker process's bucket (recreated when the configured rate changes). */
export function networkingEmailRateLimiter(ratePerSecond: number): NetworkingEmailRateLimiter {
  if (!shared || shared.ratePerSecond !== ratePerSecond) shared = new NetworkingEmailRateLimiter(ratePerSecond);
  return shared;
}
