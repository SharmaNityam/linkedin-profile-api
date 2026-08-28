import { beforeEach, describe, expect, it } from 'vitest';
import type { NewPendingSignup, Repositories, User } from '../../src/auth/repositories.js';
import { AppError } from '../../src/errors.js';
import type { ErrorCode } from '../../src/errors.js';

/**
 * A syntactically valid UUID that never belongs to a row. Postgres rejects a
 * malformed uuid with a type error rather than returning nothing, so "absent"
 * has to be spelled with a real UUID for both implementations to agree.
 */
export const MISSING_ID = '00000000-0000-0000-0000-000000000000';

/** Accounts are created verified, so every fixture user carries a timestamp. */
const VERIFIED_AT = new Date('2026-01-01T00:00:00.000Z');

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (err: unknown) => err,
  );
}

async function expectAppError(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  const err = await caught(promise);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

/**
 * The contract every `Repositories` implementation has to satisfy. The memory
 * and Postgres suites run exactly this, so the in-memory implementation used by
 * tests and local dev cannot quietly drift from the one production runs on.
 */
export function repositorySuite(
  name: string,
  factory: () => Repositories | Promise<Repositories>,
  cleanup?: () => Promise<void>,
): void {
  describe(name, () => {
    let repos: Repositories;
    let seq = 0;

    beforeEach(async () => {
      await cleanup?.();
      repos = await factory();
      seq = 0;
    });

    /** Distinct email per call, spelled unlike its canonical form on purpose. */
    function newUser(): Promise<User> {
      seq += 1;
      return repos.users.create({
        email: `User.${seq}+tag@Example.com`,
        emailCanonical: `user${seq}@example.com`,
        passwordHash: `hash-${seq}`,
        emailVerifiedAt: VERIFIED_AT,
      });
    }

    describe('users', () => {
      it('creates a verified user with a uuid and no phone yet', async () => {
        const user = await newUser();

        expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        expect(user.email).toBe('User.1+tag@Example.com');
        expect(user.emailCanonical).toBe('user1@example.com');
        expect(user.passwordHash).toBe('hash-1');
        expect(user.emailVerifiedAt).toEqual(VERIFIED_AT);
        expect(user.phoneE164).toBeNull();
        expect(user.phoneVerifiedAt).toBeNull();
        expect(user.sessionVersion).toBe(0);
        expect(user.createdAt).toBeInstanceOf(Date);
        expect(Date.now() - user.createdAt.getTime()).toBeLessThan(60_000);
      });

      it('gives each user a distinct id', async () => {
        const [a, b] = [await newUser(), await newUser()];
        expect(a.id).not.toBe(b.id);
      });

      it('rejects a duplicate canonical email', async () => {
        await newUser();
        await expectAppError(
          repos.users.create({
            email: 'someone-else@example.com',
            emailCanonical: 'user1@example.com',
            passwordHash: 'other',
            emailVerifiedAt: VERIFIED_AT,
          }),
          'INTERNAL_ERROR',
        );
      });

      it('finds a user by id and by canonical email', async () => {
        const user = await newUser();

        expect(await repos.users.findById(user.id)).toEqual(user);
        expect(await repos.users.findByCanonicalEmail('user1@example.com')).toEqual(user);
      });

      it('matches the canonical column exactly, without normalising', async () => {
        await newUser();

        expect(await repos.users.findByCanonicalEmail('User.1+tag@Example.com')).toBeNull();
        expect(await repos.users.findByCanonicalEmail('USER1@EXAMPLE.COM')).toBeNull();
      });

      it('returns null for an unknown id, email or phone', async () => {
        expect(await repos.users.findById(MISSING_ID)).toBeNull();
        expect(await repos.users.findByCanonicalEmail('nobody@example.com')).toBeNull();
        expect(await repos.users.findByPhone('+14155550000')).toBeNull();
      });

      it('sets a phone and finds the user by it', async () => {
        const user = await newUser();
        const at = new Date('2026-01-02T03:04:05.000Z');

        expect(await repos.users.setPhone(user.id, '+14155551234', at)).toBe('ok');

        const stored = await repos.users.findById(user.id);
        expect(stored?.phoneE164).toBe('+14155551234');
        expect(stored?.phoneVerifiedAt).toEqual(at);
        expect(await repos.users.findByPhone('+14155551234')).toEqual(stored);
      });

      it('reports a phone already held by another user as taken', async () => {
        const first = await newUser();
        const second = await newUser();
        const at = new Date('2026-01-02T03:04:05.000Z');
        await repos.users.setPhone(first.id, '+14155551234', at);

        expect(await repos.users.setPhone(second.id, '+14155551234', at)).toBe('taken');

        expect((await repos.users.findById(second.id))?.phoneE164).toBeNull();
        expect((await repos.users.findByPhone('+14155551234'))?.id).toBe(first.id);
      });

      it('lets a user re-confirm the phone it already holds', async () => {
        const user = await newUser();
        await repos.users.setPhone(user.id, '+14155551234', new Date('2026-01-01T00:00:00.000Z'));

        const at = new Date('2026-02-01T00:00:00.000Z');
        expect(await repos.users.setPhone(user.id, '+14155551234', at)).toBe('ok');
        expect((await repos.users.findById(user.id))?.phoneVerifiedAt).toEqual(at);
      });

      it('bumps the session version, returning the new value', async () => {
        const user = await newUser();

        expect(await repos.users.bumpSessionVersion(user.id)).toBe(1);
        expect(await repos.users.bumpSessionVersion(user.id)).toBe(2);
        expect((await repos.users.findById(user.id))?.sessionVersion).toBe(2);
      });

      it('bumps only the requested user', async () => {
        const first = await newUser();
        const second = await newUser();

        await repos.users.bumpSessionVersion(first.id);

        expect((await repos.users.findById(second.id))?.sessionVersion).toBe(0);
      });

      it('fails loudly when writing to a user that does not exist', async () => {
        await expectAppError(
          repos.users.setPhone(MISSING_ID, '+14155559999', new Date()),
          'INTERNAL_ERROR',
        );
        await expectAppError(repos.users.bumpSessionVersion(MISSING_ID), 'INTERNAL_ERROR');
      });

      it('does not hand out a reference into its own storage', async () => {
        const user = await newUser();

        user.sessionVersion = 99;
        user.emailCanonical = 'tampered@example.com';

        const stored = await repos.users.findById(user.id);
        expect(stored?.sessionVersion).toBe(0);
        expect(stored?.emailCanonical).toBe('user1@example.com');
      });
    });

    describe('pending signups', () => {
      const expiresAt = new Date('2026-01-01T00:10:00.000Z');

      /** A submission for `who@example.com`, spelled however the caller typed it. */
      function submission(over: Partial<NewPendingSignup> = {}): NewPendingSignup {
        return {
          email: 'Who+tag@Example.com',
          emailCanonical: 'who@example.com',
          passwordHash: 'hash-a',
          codeHash: 'code-a',
          expiresAt,
          ...over,
        };
      }

      it('returns an empty list for an address with nothing pending', async () => {
        expect(await repos.pendingSignups.listByCanonicalEmail('who@example.com')).toEqual([]);
      });

      it('round-trips a created submission, with a uuid and zero attempts', async () => {
        const created = await repos.pendingSignups.create(submission());

        expect(created.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        expect(created.email).toBe('Who+tag@Example.com');
        expect(created.emailCanonical).toBe('who@example.com');
        expect(created.passwordHash).toBe('hash-a');
        expect(created.codeHash).toBe('code-a');
        expect(created.expiresAt).toEqual(expiresAt);
        expect(created.attempts).toBe(0);
        expect(created.createdAt).toBeInstanceOf(Date);
        expect(Date.now() - created.createdAt.getTime()).toBeLessThan(60_000);

        expect(await repos.pendingSignups.listByCanonicalEmail('who@example.com')).toEqual([
          created,
        ]);
      });

      // The whole point of the table: two people can have a submission in
      // flight for one address, and neither overwrites the other.
      it('keeps every submission for the same address, newest first', async () => {
        const first = await repos.pendingSignups.create(
          submission({ passwordHash: 'hash-first', codeHash: 'code-first' }),
        );
        const second = await repos.pendingSignups.create(
          submission({ passwordHash: 'hash-second', codeHash: 'code-second' }),
        );
        const third = await repos.pendingSignups.create(
          submission({ passwordHash: 'hash-third', codeHash: 'code-third' }),
        );

        const listed = await repos.pendingSignups.listByCanonicalEmail('who@example.com');
        expect(listed.map((row) => row.id)).toEqual([third.id, second.id, first.id]);
        expect(listed.map((row) => row.passwordHash)).toEqual([
          'hash-third',
          'hash-second',
          'hash-first',
        ]);
      });

      it('matches the canonical column exactly, without normalising', async () => {
        await repos.pendingSignups.create(submission());

        expect(await repos.pendingSignups.listByCanonicalEmail('Who+tag@Example.com')).toEqual([]);
        expect(await repos.pendingSignups.listByCanonicalEmail('WHO@EXAMPLE.COM')).toEqual([]);
      });

      it('counts attempts per row, leaving its siblings alone', async () => {
        const first = await repos.pendingSignups.create(submission({ codeHash: 'code-first' }));
        const second = await repos.pendingSignups.create(submission({ codeHash: 'code-second' }));

        await repos.pendingSignups.incrementAttempts(first.id);
        await repos.pendingSignups.incrementAttempts(first.id);

        const byId = new Map(
          (await repos.pendingSignups.listByCanonicalEmail('who@example.com')).map((row) => [
            row.id,
            row.attempts,
          ]),
        );
        expect(byId.get(first.id)).toBe(2);
        expect(byId.get(second.id)).toBe(0);
      });

      it('deletes a single row by id', async () => {
        const first = await repos.pendingSignups.create(submission({ codeHash: 'code-first' }));
        const second = await repos.pendingSignups.create(submission({ codeHash: 'code-second' }));

        await repos.pendingSignups.deleteById(first.id);

        const listed = await repos.pendingSignups.listByCanonicalEmail('who@example.com');
        expect(listed.map((row) => row.id)).toEqual([second.id]);
      });

      it('deletes every row for one address, and only that address', async () => {
        await repos.pendingSignups.create(submission({ codeHash: 'code-first' }));
        await repos.pendingSignups.create(submission({ codeHash: 'code-second' }));
        const other = await repos.pendingSignups.create(
          submission({ email: 'other@example.com', emailCanonical: 'other@example.com' }),
        );

        await repos.pendingSignups.deleteByCanonicalEmail('who@example.com');

        expect(await repos.pendingSignups.listByCanonicalEmail('who@example.com')).toEqual([]);
        expect(
          (await repos.pendingSignups.listByCanonicalEmail('other@example.com')).map((r) => r.id),
        ).toEqual([other.id]);
      });

      it('deletes expired rows, reporting how many, and keeps live ones', async () => {
        const stale = new Date('2026-01-01T00:00:00.000Z');
        const live = new Date('2026-01-01T01:00:00.000Z');
        await repos.pendingSignups.create(submission({ expiresAt: stale }));
        await repos.pendingSignups.create(
          submission({ emailCanonical: 'other@example.com', expiresAt: stale }),
        );
        const kept = await repos.pendingSignups.create(submission({ expiresAt: live }));

        expect(await repos.pendingSignups.deleteExpired(new Date('2026-01-01T00:30:00.000Z'))).toBe(
          2,
        );

        expect(
          (await repos.pendingSignups.listByCanonicalEmail('who@example.com')).map((r) => r.id),
        ).toEqual([kept.id]);
        expect(await repos.pendingSignups.deleteExpired(stale)).toBe(0);
      });

      it('treats an expiry exactly at the cutoff as expired', async () => {
        const at = new Date('2026-01-01T00:10:00.000Z');
        await repos.pendingSignups.create(submission({ expiresAt: at }));

        expect(await repos.pendingSignups.deleteExpired(at)).toBe(1);
      });

      it('treats incrementing or deleting a missing row as a no-op', async () => {
        await expect(repos.pendingSignups.incrementAttempts(MISSING_ID)).resolves.toBeUndefined();
        await expect(repos.pendingSignups.deleteById(MISSING_ID)).resolves.toBeUndefined();
        await expect(
          repos.pendingSignups.deleteByCanonicalEmail('nobody@example.com'),
        ).resolves.toBeUndefined();
      });

      it('does not hand out a reference into its own storage', async () => {
        const created = await repos.pendingSignups.create(submission());

        created.attempts = 99;
        created.passwordHash = 'tampered';

        const [stored] = await repos.pendingSignups.listByCanonicalEmail('who@example.com');
        expect(stored?.attempts).toBe(0);
        expect(stored?.passwordHash).toBe('hash-a');
      });
    });

    describe('phone validations', () => {
      const checkedAt = new Date('2026-01-01T00:00:00.000Z');
      const validation = {
        phoneE164: '+14155551234',
        provider: 'abstract',
        valid: true,
        type: 'mobile',
        raw: { valid: true, carrier: 'Verizon', nested: { ok: 1 } },
        checkedAt,
      };

      it('returns null for a number never checked', async () => {
        expect(await repos.phoneValidations.find('+14155559999')).toBeNull();
      });

      it('round-trips a saved verdict including the raw payload', async () => {
        await repos.phoneValidations.save(validation);

        expect(await repos.phoneValidations.find('+14155551234')).toEqual(validation);
      });

      it('stores a copy, not the caller’s object', async () => {
        const raw: Record<string, unknown> = { carrier: 'Verizon' };
        await repos.phoneValidations.save({ ...validation, raw });

        raw.carrier = 'tampered';

        expect((await repos.phoneValidations.find('+14155551234'))?.raw).toEqual({
          carrier: 'Verizon',
        });
      });

      it('accepts an inconclusive verdict', async () => {
        await repos.phoneValidations.save({
          phoneE164: '+14155550000',
          provider: 'abstract',
          valid: null,
          type: null,
          raw: null,
          checkedAt,
        });

        const stored = await repos.phoneValidations.find('+14155550000');
        expect(stored?.valid).toBeNull();
        expect(stored?.type).toBeNull();
        expect(stored?.raw).toBeNull();
      });

      it('overwrites an earlier verdict for the same number', async () => {
        await repos.phoneValidations.save(validation);

        const later = new Date('2026-06-01T00:00:00.000Z');
        await repos.phoneValidations.save({
          ...validation,
          valid: false,
          type: 'voip',
          raw: { valid: false },
          checkedAt: later,
        });

        expect(await repos.phoneValidations.find('+14155551234')).toEqual({
          ...validation,
          valid: false,
          type: 'voip',
          raw: { valid: false },
          checkedAt: later,
        });
      });
    });
  });
}
