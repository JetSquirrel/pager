// A small D1-shaped layer over the Durable Object's SQLite, so request code reads the same and every row is metered.
// Everything here is synchronous underneath: a request's reads and writes happen in one turn of the object.

type Row = Record<string, unknown>;

export interface SqlLike {
  exec(
    query: string,
    ...bindings: any[]
  ): {
    toArray(): Row[];
    readonly rowsRead: number;
    readonly rowsWritten: number;
  };
}

export class Stmt {
  constructor(
    private db: Db,
    private query: string,
    private params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): Stmt {
    return new Stmt(this.db, this.query, params);
  }

  /** Runs now, without a promise. */
  execute(): { rows: Row[]; written: number } {
    return this.db.execute(this.query, this.params);
  }

  async first<T = Row>(): Promise<T | null> {
    return (this.execute().rows[0] as T | undefined) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    return { results: this.execute().rows as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: this.execute().written } };
  }
}

export class Db {
  private rowsRead = 0;
  private rowsWritten = 0;

  constructor(
    private sql: SqlLike,
    private transaction: <T>(fn: () => T) => T,
  ) {}

  prepare(query: string): Stmt {
    return new Stmt(this, query);
  }

  execute(query: string, params: unknown[]): { rows: Row[]; written: number } {
    const cursor = this.sql.exec(query, ...params);
    const rows = cursor.toArray();
    this.rowsRead += cursor.rowsRead;
    this.rowsWritten += cursor.rowsWritten;
    return { rows, written: cursor.rowsWritten };
  }

  /** All or nothing. `meta.changes` is rows written, indexes included: compare it with zero, not with a row count. */
  async batch(statements: Stmt[]): Promise<{ meta: { changes: number } }[]> {
    return this.transaction(() => statements.map((s) => ({ meta: { changes: s.execute().written } })));
  }

  /** The counters since the last call. */
  take(): { rowsRead: number; rowsWritten: number } {
    const taken = { rowsRead: this.rowsRead, rowsWritten: this.rowsWritten };
    this.rowsRead = this.rowsWritten = 0;
    return taken;
  }
}

/** Key-value rows with optional expiry: shaped like Workers KV, kept in the same database. */
export class KvTable {
  constructor(private db: Db) {}

  async get(key: string): Promise<string | null> {
    return this.read(key);
  }

  read(key: string): string | null {
    const [row] = this.db.execute("SELECT v, expires FROM kv WHERE k = ?", [key]).rows;
    if (!row) return null;
    return row.expires != null && (row.expires as number) <= Date.now() ? null : (row.v as string);
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.write(key, value, opts?.expirationTtl);
  }

  write(key: string, value: string, ttlSeconds?: number): void {
    this.db.execute("INSERT OR REPLACE INTO kv (k, v, expires) VALUES (?, ?, ?)", [key, value, ttlSeconds ? Date.now() + ttlSeconds * 1000 : null]);
  }

  async delete(key: string): Promise<void> {
    this.db.execute("DELETE FROM kv WHERE k = ?", [key]);
  }

  /** The value at `key`, created once with `make` if there is none. */
  once(key: string, make: () => string): string {
    const existing = this.read(key);
    if (existing !== null) return existing;
    const value = make();
    this.write(key, value);
    return value;
  }
}

export function migrate(db: Db, kv: KvTable, migrations: string[]): void {
  db.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires INTEGER)", []);
  const done = Number(kv.read("schema") ?? 0);
  for (let i = done; i < migrations.length; i++) {
    db.execute(migrations[i], []);
    kv.write("schema", String(i + 1));
  }
}
