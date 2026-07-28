import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserAdapter, BrowserPool } from '../src/Browser';

type Session = { id: number };

class MockBrowserAdapter implements BrowserAdapter<Session> {
  private nextId = 1;
  private launched = false;
  private destroyed = new Set<number>();

  public createSessionCalls = 0;

  async launch(): Promise<void> {
    this.launched = true;
  }

  async close(): Promise<void> {
    this.launched = false;
  }

  async createSession(): Promise<Session> {
    this.createSessionCalls += 1;
    return { id: this.nextId++ };
  }

  async destroySession(session: Session): Promise<void> {
    this.destroyed.add(session.id);
  }
}

describe('BrowserPool', () => {
  let adapter: MockBrowserAdapter;
  let pool: BrowserPool<Session>;

  beforeEach(() => {
    adapter = new MockBrowserAdapter();
    pool = new BrowserPool({ adapter, maxSessions: 2 });
  });

  it('acquires and releases sessions', async () => {
    const session = await pool.acquire();
    expect(session.id).toBe(1);
    await pool.release(session);
    const reused = await pool.acquire();
    expect(reused.id).toBe(1);
  });

  it('queues acquires when max sessions are reached', async () => {
    const first = await pool.acquire();
    const second = await pool.acquire();
    const pendingPromise = pool.acquire();

    let resolved = false;
    pendingPromise.then(() => {
      resolved = true;
    });

    await pool.release(second);
    const third = await pendingPromise;
    expect(resolved).toBe(true);
    expect(third.id).toBe(2);
    await pool.release(first);
    await pool.release(third);
  });

  it('does not create more sessions than the configured limit under concurrent acquires', async () => {
    const poolWithSingleSession = new BrowserPool({ adapter, maxSessions: 1 });
    const firstAcquire = poolWithSingleSession.acquire();
    const secondAcquire = poolWithSingleSession.acquire();

    const first = await firstAcquire;
    expect(adapter.createSessionCalls).toBe(1);

    await poolWithSingleSession.release(first);
    const second = await secondAcquire;

    expect(adapter.createSessionCalls).toBe(1);
    expect(second.id).toBe(1);

    await poolWithSingleSession.release(second);
  });

  it('closes and rejects pending requests', async () => {
    const first = await pool.acquire();
    const second = await pool.acquire();
    const pending = pool.acquire();

    // Start close — it will wait for active workers to drain
    const closePromise = pool.close();
    // Release sessions — pool is closed, so they are destroyed, not reassigned
    await pool.release(first).catch(() => undefined);
    await pool.release(second).catch(() => undefined);
    // close completes once all workers drain
    await closePromise;

    await expect(pending).rejects.toThrow('BrowserPool');
  });
});
