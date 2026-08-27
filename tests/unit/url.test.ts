import { describe, expect, it } from 'vitest';
import { parseCompanyUrl, parseProfileUrl } from '../../src/linkedin/url.js';
import { InvalidUrlError } from '../../src/errors.js';

describe('parseProfileUrl', () => {
  it.each([
    ['https://www.linkedin.com/in/sharmanityam/', 'sharmanityam'],
    ['https://www.linkedin.com/in/sharmanityam', 'sharmanityam'],
    ['http://linkedin.com/in/sharmanityam', 'sharmanityam'],
    ['linkedin.com/in/sharmanityam?trk=public_profile', 'sharmanityam'],
    ['https://in.linkedin.com/in/sharmanityam', 'sharmanityam'],
    ['https://www.linkedin.com/mwlite/in/sharmanityam', 'sharmanityam'],
    ['https://www.linkedin.com/in/sharmanityam/details/experience/', 'sharmanityam'],
    ['https://www.linkedin.com/in/john-doe-1a2b3c/', 'john-doe-1a2b3c'],
    ['https://www.linkedin.com/in/%E5%BC%A0%E4%B8%89-123', '张三-123'],
    ['  https://www.linkedin.com/in/sharmanityam/  ', 'sharmanityam'],
    ['sharmanityam', 'sharmanityam'],
  ])('%s → %s', (input, slug) => {
    const parsed = parseProfileUrl(input);
    expect(parsed.publicIdentifier).toBe(slug);
    expect(parsed.canonicalUrl).toBe(`https://www.linkedin.com/in/${encodeURIComponent(slug)}/`);
  });

  it.each([
    ['', /empty/],
    ['https://www.google.com/in/foo', /not linkedin\.com/],
    ['https://evil-linkedin.com/in/foo', /not linkedin\.com/],
    ['https://www.linkedin.com/company/brackets', /company URL/],
    ['https://www.linkedin.com/school/srmist', /school URL/],
    ['https://www.linkedin.com/feed/', /expected a profile url/i],
    ['https://www.linkedin.com/in/', /expected a profile url/i],
    ['https://www.linkedin.com/in/a', /not a valid profile slug/],
    ['https://www.linkedin.com/in/%E0%A4%A', /malformed/i],
    ['not a url at all', /not a valid profile slug/],
    ['https://www.linkedin.com/in/foo bar/', /not a valid profile slug/],
  ])('rejects %s', (input, message) => {
    expect(() => parseProfileUrl(input)).toThrow(InvalidUrlError);
    expect(() => parseProfileUrl(input)).toThrow(message);
  });
});

describe('parseCompanyUrl', () => {
  it.each([
    ['https://www.linkedin.com/company/anthropicresearch/', 'anthropicresearch', 'company'],
    ['linkedin.com/company/anthropicresearch/about/?x=1', 'anthropicresearch', 'company'],
    ['https://in.linkedin.com/school/iithyderabad/', 'iithyderabad', 'school'],
    ['https://www.linkedin.com/school/s.r.m.-institute-of-science-&-technology-chennai/', 's.r.m.-institute-of-science-&-technology-chennai', 'school'],
    ['anthropicresearch', 'anthropicresearch', 'company'],
  ])('%s → %s (%s)', (input, universalName, kind) => {
    const r = parseCompanyUrl(input);
    expect(r.universalName).toBe(universalName);
    expect(r.kind).toBe(kind);
    expect(r.canonicalUrl).toBe(`https://www.linkedin.com/${kind}/${encodeURIComponent(universalName)}/`);
  });
  it.each([
    ['', /empty/],
    ['https://www.linkedin.com/in/jane-doe/', /\/v1\/profile/],
    ['https://example.com/company/x', /not linkedin\.com/],
    ['https://www.linkedin.com/jobs/view/1', /company/],
    ['https://www.linkedin.com/company/', /company/],
  ])('rejects %s', (input, msg) => {
    expect(() => parseCompanyUrl(input)).toThrow(msg);
  });
  it('profile parser points company URLs at /v1/company', () => {
    expect(() => parseProfileUrl('https://www.linkedin.com/company/acme')).toThrow(/\/v1\/company/);
  });
});
