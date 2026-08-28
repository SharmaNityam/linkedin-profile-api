const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a sign-in counts toward an IP's account budget. */
const WINDOW_MS = 7 * DAY_MS;
/** Hard ceiling on tracked rows, independent of the window. */
const MAX_ROWS = 50_000;

interface Row {
  ip: string;
  email: string;
  at: number;
}

export interface LoginRegistryOptions {
  windowMs?: number;
  maxRows?: number;
}

/**
 * In-memory record of which emails have signed in from which IPs, used to
 * cap distinct accounts per IP. No persistence: a restart clears it, which
 * just resets the deterrent — it never revokes a session.
 */
export class LoginRegistry {
  /** Insertion order, which is also chronological order since `at` only grows. */
  private readonly rows: Row[] = [];
  private readonly byIp = new Map<string, Row[]>();
  private readonly windowMs: number;
  private readonly maxRows: number;

  constructor(options: LoginRegistryOptions = {}) {
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.maxRows = options.maxRows ?? MAX_ROWS;
  }

  /** Records a successful sign-in. */
  record(ip: string, email: string, at: Date = new Date()): void {
    const atMs = at.getTime();
    const row: Row = { ip, email, at: atMs };
    this.rows.push(row);
    const list = this.byIp.get(ip);
    if (list) {
      list.push(row);
    } else {
      this.byIp.set(ip, [row]);
    }

    this.sweep(atMs);
    while (this.rows.length > this.maxRows) {
      this.evictOldest();
    }
  }

  /** Distinct emails seen from `ip` at or after `since`. */
  emailsFor(ip: string, since: Date): Set<string> {
    const sinceMs = since.getTime();
    const list = this.byIp.get(ip) ?? [];
    const emails = new Set<string>();
    for (const row of list) {
      if (row.at >= sinceMs) emails.add(row.email);
    }
    return emails;
  }

  /** Total tracked rows, across every IP. For tests. */
  get count(): number {
    return this.rows.length;
  }

  /** Drops rows older than the trailing window, relative to `nowMs`. */
  private sweep(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.rows.length > 0 && this.rows[0]!.at < cutoff) {
      this.evictOldest();
    }
  }

  /** Evicts the oldest row (`rows[0]`), from both the row list and its IP's bucket. */
  private evictOldest(): void {
    const row = this.rows.shift();
    if (!row) return;
    const list = this.byIp.get(row.ip);
    if (!list) return;
    const idx = list.indexOf(row);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this.byIp.delete(row.ip);
  }
}
