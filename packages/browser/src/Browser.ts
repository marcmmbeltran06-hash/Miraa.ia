export interface BrowserAdapter<TSession = unknown> {
  launch(): Promise<void>;
  close(): Promise<void>;
  createSession(): Promise<TSession>;
  destroySession(session: TSession): Promise<void>;
}

export interface BrowserPoolOptions<TSession> {
  adapter: BrowserAdapter<TSession>;
  maxSessions?: number;
}

interface PendingAcquire<TSession> {
  resolve: (session: TSession) => void;
  reject: (error: unknown) => void;
}

export class BrowserPool<TSession = unknown> {
  private readonly adapter: BrowserAdapter<TSession>;
  private readonly maxSessions: number;
  private availableSessions: TSession[] = [];
  private activeSessions = new Set<TSession>();
  private pendingAcquires: PendingAcquire<TSession>[] = [];
  private creatingSessions = 0;
  private launched = false;
  private closed = false;

  activeWorkers = 0;
  private closeResolver: (() => void) | null = null;
  private closeTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: BrowserPoolOptions<TSession>) {
    this.adapter = options.adapter;
    this.maxSessions = options.maxSessions ?? 3;
  }

  private log(msg: string): void {
    console.log(`[BrowserPool] ${msg}`);
  }

  async initialize(): Promise<void> {
    if (this.closed) {
      throw new Error('BrowserPool is closed');
    }
    if (this.launched) {
      return;
    }
    await this.adapter.launch();
    if (this.closed) {
      await this.adapter.close().catch(() => undefined);
      throw new Error('BrowserPool is closed');
    }
    this.launched = true;
  }

  async acquire(): Promise<TSession> {
    if (this.closed) {
      throw new Error('BrowserPool is closed');
    }

    await this.initialize();

    if (this.availableSessions.length > 0) {
      const session = this.availableSessions.pop() as TSession;
      this.activeSessions.add(session);
      this.activeWorkers++;
      this.log(`Worker acquired — active: ${this.activeWorkers}, borrowed: ${this.activeSessions.size}, available: ${this.availableSessions.length}`);
      return session;
    }

    if (this.activeSessions.size + this.creatingSessions < this.maxSessions) {
      this.creatingSessions += 1;
      try {
        const session = await this.adapter.createSession();
        if (this.closed) {
          await this.adapter.destroySession(session).catch(() => undefined);
          throw new Error('BrowserPool is closed');
        }
        this.activeSessions.add(session);
        this.activeWorkers++;
        this.log(`Worker acquired (new) — active: ${this.activeWorkers}, borrowed: ${this.activeSessions.size}`);
        return session;
      } finally {
        this.creatingSessions = Math.max(0, this.creatingSessions - 1);
      }
    }

    return new Promise<TSession>((resolve, reject) => {
      this.pendingAcquires.push({ resolve, reject });
    });
  }

  async release(session: TSession): Promise<void> {
    if (!this.activeSessions.has(session)) {
      throw new Error('Session does not belong to this pool');
    }

    this.activeSessions.delete(session);
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);

    if (this.closed) {
      await this.adapter.destroySession(session).catch(() => undefined);
      this.log(`Worker released (closed) — active: ${this.activeWorkers}`);
      this.tryDrain();
      return;
    }

    if (this.pendingAcquires.length > 0) {
      const next = this.pendingAcquires.shift() as PendingAcquire<TSession>;
      this.activeSessions.add(session);
      this.activeWorkers++;
      next.resolve(session);
      this.log(`Worker released (reassigned) — active: ${this.activeWorkers}, borrowed: ${this.activeSessions.size}`);
      return;
    }

    this.availableSessions.push(session);
    this.log(`Worker released — active: ${this.activeWorkers}, borrowed: ${this.activeSessions.size}, available: ${this.availableSessions.length}`);
    this.tryDrain();
  }

  private tryDrain(): void {
    if (this.closeResolver && this.activeWorkers === 0) {
      this.log('All workers finished — resuming close');
      if (this.closeTimeout) {
        clearTimeout(this.closeTimeout);
        this.closeTimeout = null;
      }
      const resolve = this.closeResolver;
      this.closeResolver = null;
      resolve();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.log('Close requested');
    this.closed = true;

    if (this.activeWorkers > 0) {
      this.log(`Waiting for ${this.activeWorkers} active worker(s) to finish...`);
      await new Promise<void>((resolve) => {
        this.closeResolver = resolve;
        this.closeTimeout = setTimeout(() => {
          this.log(`Close timeout: ${this.activeWorkers} worker(s) still active, forcing close`);
          this.closeResolver = null;
          this.closeTimeout = null;
          resolve();
        }, 30_000);
      });
    }

    this.log('Closing sessions...');
    for (const session of this.availableSessions) {
      await this.adapter.destroySession(session).catch(() => undefined);
    }
    this.availableSessions = [];

    for (const session of this.activeSessions) {
      await this.adapter.destroySession(session).catch(() => undefined);
    }
    this.activeSessions.clear();

    while (this.pendingAcquires.length > 0) {
      const pending = this.pendingAcquires.shift() as PendingAcquire<TSession>;
      pending.reject(new Error('BrowserPool closed'));
    }

    if (this.launched) {
      this.log('Closing browser...');
      await this.adapter.close();
    }
    this.log('Close complete');
  }
}
