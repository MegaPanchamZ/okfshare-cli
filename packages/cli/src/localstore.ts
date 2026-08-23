import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type BundleRow = {
  dir: string;
  shareId: string;
  slug: string;
  title: string;
  revision: number;
  digest: string;
  updatedAt: string;
};

type Database = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
};

let database: Database | null | undefined;

async function open(): Promise<Database | null> {
  if (database !== undefined) return database;
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as {
      DatabaseSync: new (path: string) => Database;
    };
    const dir = join(homedir(), ".config", "okfshare");
    await mkdir(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "state.db"));
    db.exec(
      "CREATE TABLE IF NOT EXISTS bundles (dir TEXT PRIMARY KEY, share_id TEXT NOT NULL, slug TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, digest TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)",
    );
    database = db;
  } catch {
    database = null;
  }
  return database;
}

export async function rememberBundle(
  input: Omit<BundleRow, "updatedAt">,
): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    db.prepare(
      "INSERT INTO bundles (dir, share_id, slug, title, revision, digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dir) DO UPDATE SET share_id=excluded.share_id, slug=excluded.slug, title=excluded.title, revision=excluded.revision, digest=excluded.digest, updated_at=excluded.updated_at",
    ).run(
      resolve(input.dir),
      input.shareId,
      input.slug,
      input.title,
      input.revision,
      input.digest,
      new Date().toISOString(),
    );
  } catch {}
}

export async function forgetBundle(dir: string): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    db.prepare("DELETE FROM bundles WHERE dir = ?").run(resolve(dir));
  } catch {}
}

export async function listBundles(): Promise<BundleRow[]> {
  const db = await open();
  if (!db) return [];
  try {
    return db
      .prepare("SELECT * FROM bundles ORDER BY updated_at DESC")
      .all() as unknown as BundleRow[];
  } catch {
    return [];
  }
}
