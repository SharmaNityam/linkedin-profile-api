import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/linkedin/cache.js';
import { Semaphore } from '../../src/linkedin/semaphore.js';

describe('TtlCache', () => {
  it('expires entries after the ttl', () => {
    let now = 0;
    const cache = new TtlCache<number>(100, 10, () => now);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    now = 100;
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts least-recently-used entries beyond maxEntries', () => {
    const cache = new TtlCache<number>(1000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('is a no-op when ttl is 0', () => {
    const cache = new TtlCache<number>(0);
    cache.set('a', 1);
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('Semaphore', () => {
  it('never runs more than `limit` tasks at once', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('releases the slot when a task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(sem.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
