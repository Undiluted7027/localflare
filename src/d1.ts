import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";

interface Database {
  uuid: string;
  name: string;
  created_at: string;
  version: "production";
  read_replication: { mode: "auto" | "disabled" };
  runtime: Miniflare;
}

export type SqlParam = string | number | boolean | null;
export interface D1Query {
  sql: string;
  params?: SqlParam[];
}

/** Split statements outside SQLite strings, quoted identifiers, and comments. */
export function splitSql(sql: string) {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | "]" | undefined;
  let lineComment = false;
  let blockComment = false;
  let hasCode = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) index++;
        else quote = undefined;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index++;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      hasCode = true;
    } else if (char === "[") {
      quote = "]";
      hasCode = true;
    } else if (char === ";") {
      const statement = sql.slice(start, index).trim();
      if (hasCode) statements.push(statement);
      start = index + 1;
      hasCode = false;
    } else if (!/\s/.test(char ?? "")) {
      hasCode = true;
    }
  }
  const tail = sql.slice(start).trim();
  if (hasCode) statements.push(tail);
  return statements;
}

/** Owns D1 database identities and SQLite files for one Localflare server. */
export class D1Store {
  readonly persistPath = mkdtempSync(join(tmpdir(), "localflare-d1-"));
  private readonly databases = new Map<string, Database>();

  list() {
    return [...this.databases.values()].map(({ uuid, name, created_at, version, read_replication }) => (
      { uuid, name, created_at, version, read_replication }
    ));
  }

  get(idOrName: string) {
    const database = this.find(idOrName);
    if (!database) return undefined;
    const { uuid, name, created_at, version, read_replication } = database;
    return { uuid, name, created_at, version, read_replication };
  }

  has(uuid: string) {
    return this.databases.has(uuid);
  }

  async create(name: string) {
    if (this.find(name)) return undefined;
    const uuid = randomUUID();
    const runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('') } }",
      d1Databases: { DB: uuid },
      d1Persist: this.persistPath,
      cf: false,
    });
    const database: Database = {
      uuid, name, created_at: new Date().toISOString(), version: "production",
      read_replication: { mode: "disabled" }, runtime,
    };
    this.databases.set(uuid, database);
    try {
      await runtime.ready;
      await runtime.getD1Database("DB");
    } catch (error) {
      this.databases.delete(uuid);
      await runtime.dispose().catch(() => {});
      throw error;
    }
    return this.get(uuid);
  }

  async delete(idOrName: string) {
    const database = this.find(idOrName);
    if (!database) return false;
    this.databases.delete(database.uuid);
    await database.runtime.dispose();
    return true;
  }

  update(uuid: string, mode: "auto" | "disabled") {
    const database = this.databases.get(uuid);
    if (!database) return undefined;
    database.read_replication = { mode };
    return this.get(uuid);
  }

  async query(uuid: string, queries: D1Query[]) {
    const database = this.databases.get(uuid);
    if (!database) return undefined;
    const db = await database.runtime.getD1Database("DB");
    const prepared = queries.flatMap(({ sql, params }) => {
      const statements = splitSql(sql);
      if (params && statements.length !== 1) throw new Error("Parameters require one SQL statement");
      return statements.map((statement) => {
        const query = db.prepare(statement);
        return params ? query.bind(...params) : query;
      });
    });
    if (prepared.length === 0) throw new Error("SQL query cannot be empty");
    return db.batch(prepared);
  }

  async dispose() {
    await Promise.all([...this.databases.values()].map(({ runtime }) => runtime.dispose()));
    this.databases.clear();
    await rm(this.persistPath, { recursive: true, force: true });
  }

  private find(idOrName: string) {
    return this.databases.get(idOrName) ?? [...this.databases.values()].find(({ name }) => name === idOrName);
  }
}
