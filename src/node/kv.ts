import { Buffer } from 'node:buffer';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The part of Cloudflare's KVNamespace this server and the OAuth library use (get/put/delete/list with TTL and
 * metadata), on Node's built-in SQLite. One file, one writer process.
 */
type GetType = 'text' | 'json' | 'arrayBuffer';
type PutValue = string | ArrayBuffer | ArrayBufferView;
interface PutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
}

export class SqliteKV {
  private db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, expiration INTEGER, metadata TEXT);`);
  }

  private now = () => Math.floor(Date.now() / 1000);

  async get(key: string, opts?: GetType | { type?: GetType }): Promise<unknown> {
    const type = typeof opts === 'string' ? opts : (opts?.type ?? 'text');
    const row = this.db.prepare('SELECT value, expiration FROM kv WHERE key = ?').get(key) as { value: Uint8Array; expiration: number | null } | undefined;
    if (!row) return null;
    if (row.expiration !== null && row.expiration <= this.now()) {
      await this.delete(key);
      return null;
    }
    const bytes = Buffer.from(row.value);
    if (type === 'arrayBuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const text = bytes.toString('utf8');
    return type === 'json' ? JSON.parse(text) : text;
  }

  async put(key: string, value: PutValue, opts: PutOptions = {}): Promise<void> {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
    const expiration = opts.expiration ?? (opts.expirationTtl ? this.now() + opts.expirationTtl : null);
    this.db
      .prepare('INSERT INTO kv (key, value, expiration, metadata) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expiration = excluded.expiration, metadata = excluded.metadata')
      .run(key, bytes, expiration, opts.metadata === undefined ? null : JSON.stringify(opts.metadata));
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  /** Keys in order; the cursor is the last key returned. */
  async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const limit = Math.min(opts.limit ?? 1000, 1000);
    const prefix = opts.prefix ?? '';
    const rows = this.db
      .prepare('SELECT key, expiration, metadata FROM kv WHERE key >= ? AND key > ? AND (expiration IS NULL OR expiration > ?) ORDER BY key LIMIT ?')
      .all(prefix, opts.cursor ?? '', this.now(), limit + 1) as { key: string; expiration: number | null; metadata: string | null }[];
    const inPrefix = rows.filter((r) => r.key.startsWith(prefix));
    const page = inPrefix.slice(0, limit);
    const complete = inPrefix.length <= limit;
    return {
      keys: page.map((r) => ({ name: r.key, ...(r.expiration !== null && { expiration: r.expiration }), ...(r.metadata !== null && { metadata: JSON.parse(r.metadata) }) })),
      list_complete: complete,
      ...(!complete && { cursor: page[page.length - 1].key }),
    };
  }

  /** Drops expired rows (called now and then; reads already ignore them). */
  sweep() {
    this.db.prepare('DELETE FROM kv WHERE expiration IS NOT NULL AND expiration <= ?').run(this.now());
  }

  close() {
    this.db.close();
  }
}
