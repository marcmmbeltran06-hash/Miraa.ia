import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '../src/Storage';

describe('InMemoryStorage', () => {
  it('stores and retrieves values by key', async () => {
    const storage = new InMemoryStorage<string>();
    await storage.set('hello', 'world');
    expect(await storage.get('hello')).toBe('world');
  });

  it('returns undefined for missing keys', async () => {
    const storage = new InMemoryStorage<number>();
    expect(await storage.get('missing')).toBeUndefined();
  });

  it('deletes keys and confirms existence', async () => {
    const storage = new InMemoryStorage<boolean>();
    await storage.set('flag', true);
    expect(await storage.has('flag')).toBe(true);
    expect(await storage.delete('flag')).toBe(true);
    expect(await storage.has('flag')).toBe(false);
  });

  it('clears all values', async () => {
    const storage = new InMemoryStorage<string>();
    await storage.set('a', '1');
    await storage.set('b', '2');
    await storage.clear();
    expect(await storage.has('a')).toBe(false);
    expect(await storage.has('b')).toBe(false);
  });
});
