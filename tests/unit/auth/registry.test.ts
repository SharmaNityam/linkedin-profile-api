import { describe, expect, it } from 'vitest';
import { LoginRegistry } from '../../../src/auth/registry.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const t0 = new Date('2026-01-01T00:00:00.000Z');

describe('LoginRegistry', () => {
  it('records a sign-in and reports it back from emailsFor', () => {
    const registry = new LoginRegistry();
    registry.record('1.2.3.4', 'a@example.com', t0);
    expect(registry.emailsFor('1.2.3.4', t0)).toEqual(new Set(['a@example.com']));
    expect(registry.count).toBe(1);
  });

  it('keeps IPs independent', () => {
    const registry = new LoginRegistry();
    registry.record('1.2.3.4', 'a@example.com', t0);
    registry.record('5.6.7.8', 'b@example.com', t0);
    expect(registry.emailsFor('1.2.3.4', t0)).toEqual(new Set(['a@example.com']));
    expect(registry.emailsFor('5.6.7.8', t0)).toEqual(new Set(['b@example.com']));
  });

  it('collapses repeat sign-ins by the same email into one entry in emailsFor', () => {
    const registry = new LoginRegistry();
    registry.record('1.2.3.4', 'a@example.com', t0);
    registry.record('1.2.3.4', 'a@example.com', new Date(t0.getTime() + 1000));
    expect(registry.emailsFor('1.2.3.4', t0)).toEqual(new Set(['a@example.com']));
    expect(registry.count).toBe(2);
  });

  it('emailsFor excludes rows before `since`', () => {
    const registry = new LoginRegistry();
    registry.record('1.2.3.4', 'a@example.com', t0);
    registry.record('1.2.3.4', 'b@example.com', new Date(t0.getTime() + DAY_MS));
    expect(registry.emailsFor('1.2.3.4', new Date(t0.getTime() + DAY_MS))).toEqual(
      new Set(['b@example.com']),
    );
  });

  it('sweeps rows once they age out of the 7-day window', () => {
    const registry = new LoginRegistry();
    registry.record('1.2.3.4', 'a@example.com', t0);
    expect(registry.count).toBe(1);

    // Still inside the window.
    registry.record('1.2.3.4', 'b@example.com', new Date(t0.getTime() + 6 * DAY_MS));
    expect(registry.count).toBe(2);

    // This record call's clock pushes the first entry outside the window.
    registry.record('1.2.3.4', 'c@example.com', new Date(t0.getTime() + 8 * DAY_MS));
    expect(registry.emailsFor('1.2.3.4', t0).has('a@example.com')).toBe(false);
    expect(registry.count).toBe(2);
  });

  it('respects a custom window', () => {
    const registry = new LoginRegistry({ windowMs: DAY_MS });
    registry.record('1.2.3.4', 'a@example.com', t0);
    registry.record('1.2.3.4', 'b@example.com', new Date(t0.getTime() + 2 * DAY_MS));
    expect(registry.count).toBe(1);
  });

  it('evicts the oldest row once past the row cap', () => {
    const registry = new LoginRegistry({ maxRows: 3 });
    registry.record('1.2.3.4', 'a@example.com', t0);
    registry.record('1.2.3.4', 'b@example.com', new Date(t0.getTime() + 1000));
    registry.record('1.2.3.4', 'c@example.com', new Date(t0.getTime() + 2000));
    expect(registry.count).toBe(3);

    registry.record('1.2.3.4', 'd@example.com', new Date(t0.getTime() + 3000));
    expect(registry.count).toBe(3);
    const emails = registry.emailsFor('1.2.3.4', t0);
    expect(emails.has('a@example.com')).toBe(false);
    expect(emails.has('d@example.com')).toBe(true);
  });
});
