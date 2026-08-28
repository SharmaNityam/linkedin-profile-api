export interface SessionCookies {
  /** name → value, including li_at. */
  jar: Map<string, string>;
  /** The CSRF token to echo in `csrf-token`, LinkedIn's JSESSIONID, unquoted. */
  csrfToken: string;
}

/** Parses a `Cookie:`-style string ("a=1; b=2") into a map. Later entries win. */
export function parseCookieString(input: string | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (input ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name) jar.set(name, value);
  }
  return jar;
}

export function serializeCookies(jar: Map<string, string>): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function buildSessionCookies(
  liAt: string,
  companions: string | undefined,
  mintCsrf: () => string,
): SessionCookies {
  const jar = parseCookieString(companions);
  jar.set('li_at', liAt);
  let csrfToken = unquote(jar.get('JSESSIONID'));
  if (!csrfToken) {
    csrfToken = mintCsrf();
    jar.set('JSESSIONID', `"${csrfToken}"`);
  }
  return { jar, csrfToken };
}

function unquote(value: string | undefined): string | undefined {
  return value?.replace(/^"|"$/g, '') || undefined;
}

/** Applies `Set-Cookie` headers to a jar. Cookies that LinkedIn is deleting ("delete me") are skipped. */
export function applySetCookies(jar: Map<string, string>, setCookies: string[]): void {
  for (const header of setCookies) {
    const [pair] = header.split(';');
    const i = pair?.indexOf('=') ?? -1;
    if (!pair || i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!name || /^"?delete me"?$/i.test(value)) continue;
    jar.set(name, value);
  }
}
