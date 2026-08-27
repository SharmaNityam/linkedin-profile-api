import { beforeEach, describe, expect, it } from 'vitest';
import type { Repositories, User } from '../../src/auth/repositories.js';
import { AppError } from '../../src/errors.js';
import type { ErrorCode } from '../../src/errors.js';

/**
 * A syntactically valid UUID that never belongs to a row. Postgres rejects a
 * malformed uuid with a type error rather than returning nothing, so "absent"
 * has to be spelled with a real UUID for both implementations to agree.
 */
export const MISSING_ID = '00000000-0000-0000-0000-000000000000';

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
      });
    }

    describe('users', () => {
      it('creates a user with a uuid and unverified defaults', async () => {
        const user = await newUser();

        expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        expect(user.email).toBe('User.1+tag@Example.com');
        expect(user.emailCanonical).toBe('user1@example.com');
        expect(user.passwordHash).toBe('hash-1');
        expect(user.emailVerifiedAt).toBeNull();
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

      it('marks the email verified', async () => {
        const user = await newUser();
        const at = new Date('2026-01-01T00:00:00.000Z');

        await repos.users.markEmailVerified(user.id, at);

        expect((await repos.users.findById(user.id))?.emailVerifiedAt).toEqual(at);
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

      it('replaces the stored password hash', async () => {
        const user = await newUser();

        await repos.users.updatePasswordHash(user.id, 'hash-rotated');

        expect((await repos.users.findById(user.id))?.passwordHash).toBe('hash-rotated');
      });

      it('rotates the password of only the requested user, leaving the rest alone', async () => {
        const first = await newUser();
        const second = await newUser();

        await repos.users.updatePasswordHash(first.id, 'hash-rotated');

        const stored = await repos.users.findById(first.id);
        expect(stored).toEqual({ ...first, passwordHash: 'hash-rotated' });
        expect((await repos.users.findById(second.id))?.passwordHash).toBe('hash-2');
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
        const at = new Date();
        await expectAppError(repos.users.markEmailVerified(MISSING_ID, at), 'INTERNAL_ERROR');
        await expectAppError(
          repos.users.setPhone(MISSING_ID, '+14155559999', at),
          'INTERNAL_ERROR',
        );
        await expectAppError(repos.users.bumpSessionVersion(MISSING_ID), 'INTERNAL_ERROR');
        await expectAppError(
          repos.users.updatePasswordHash(MISSING_ID, 'hash-rotated'),
          'INTERNAL_ERROR',
        );
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

    describe('email verifications', () => {
      const expiresAt = new Date('2026-01-01T00:10:00.000Z');

      it('returns null when there is nothing stored', async () => {
        const user = await newUser();
        expect(await repos.verifications.find(user.id)).toBeNull();
      });

      it('round-trips an upserted verification', async () => {
        const user = await newUser();
        const record = { userId: user.id, codeHash: 'abc123', expiresAt, attempts: 0 };

        await repos.verifications.upsert(record);

        expect(await repos.verifications.find(user.id)).toEqual(record);
      });

      it('replaces the previous code on re-upsert, resetting attempts', async () => {
        const user = await newUser();
        await repos.verifications.upsert({
          userId: user.id,
          codeHash: 'old',
          expiresAt,
          attempts: 0,
        });
        await repos.verifications.incrementAttempts(user.id);

        const later = new Date('2026-01-01T00:20:00.000Z');
        await repos.verifications.upsert({
          userId: user.id,
          codeHash: 'new',
          expiresAt: later,
          attempts: 0,
        });

        expect(await repos.verifications.find(user.id)).toEqual({
          userId: user.id,
          codeHash: 'new',
          expiresAt: later,
          attempts: 0,
        });
      });

      it('increments attempts one at a time', async () => {
        const user = await newUser();
        await repos.verifications.upsert({
          userId: user.id,
          codeHash: 'abc',
          expiresAt,
          attempts: 0,
        });

        await repos.verifications.incrementAttempts(user.id);
        expect((await repos.verifications.find(user.id))?.attempts).toBe(1);

        await repos.verifications.incrementAttempts(user.id);
        expect((await repos.verifications.find(user.id))?.attempts).toBe(2);
      });

      it('keeps each user’s verification separate', async () => {
        const first = await newUser();
        const second = await newUser();
        await repos.verifications.upsert({
          userId: first.id,
          codeHash: 'one',
          expiresAt,
          attempts: 0,
        });
        await repos.verifications.upsert({
          userId: second.id,
          codeHash: 'two',
          expiresAt,
          attempts: 0,
        });

        await repos.verifications.incrementAttempts(first.id);

        expect((await repos.verifications.find(first.id))?.codeHash).toBe('one');
        expect((await repos.verifications.find(second.id))?.attempts).toBe(0);
      });

      it('deletes, after which find returns null', async () => {
        const user = await newUser();
        await repos.verifications.upsert({
          userId: user.id,
          codeHash: 'abc',
          expiresAt,
          attempts: 0,
        });

        await repos.verifications.delete(user.id);

        expect(await repos.verifications.find(user.id)).toBeNull();
      });

      it('treats incrementing or deleting a missing verification as a no-op', async () => {
        await expect(repos.verifications.incrementAttempts(MISSING_ID)).resolves.toBeUndefined();
        await expect(repos.verifications.delete(MISSING_ID)).resolves.toBeUndefined();
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
