import { describe, expect, it } from 'vitest';
import { CompanyNotFoundError, ProfileNotFoundError } from '../../src/errors.js';

describe('errors', () => {
  it('CompanyNotFoundError is a 404 with its own code', () => {
    const err = new CompanyNotFoundError('acme');
    expect(err.status).toBe(404);
    expect(err.code).toBe('COMPANY_NOT_FOUND');
    expect(err.message).toContain('acme');
    expect(err.details).toEqual({ universalName: 'acme' });
  });
  it('ProfileNotFoundError keeps its code', () => {
    expect(new ProfileNotFoundError('x').code).toBe('PROFILE_NOT_FOUND');
  });
});
