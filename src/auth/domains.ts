/**
 * The allowlist gate on `/auth/request-code`: a deterrent against throwaway
 * addresses, not proof of identity (a real check needs a third-party
 * disposable-domain API). Applied to the canonical address, so folding
 * happens before this ever runs.
 */
export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export function isDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.includes(domainOf(email));
}

/** "Use a gmail.com, yahoo.com, outlook.com or myyahoo.com address" style message. */
export function domainNotAllowedMessage(allowedDomains: readonly string[]): string {
  if (allowedDomains.length === 0) return 'No email domains are allowed';
  if (allowedDomains.length === 1) return `Use a ${allowedDomains[0]} address`;
  const head = allowedDomains.slice(0, -1).join(', ');
  const last = allowedDomains[allowedDomains.length - 1];
  return `Use a ${head} or ${last} address`;
}
