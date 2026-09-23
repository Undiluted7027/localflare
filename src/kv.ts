import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";

interface Namespace {
  id: string;
  title: string;
  runtime: Miniflare;
}

interface KVBinding {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer, options: {
    expiration?: number;
    expirationTtl?: number;
    metadata?: unknown;
  }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    cursor?: string;
  }>;
}

/** Keeps namespace identity and Miniflare's KV storage for one server lifetime. */
export class KVStore {
  readonly persistPath = mkdtempSync(join(tmpdir(), "localflare-kv-"));
  private readonly namespaces = new Map<string, Namespace>();

  list() {
    return [...this.namespaces.values()].map(({ id, title }) => ({ id, title }));
  }

  get(id: string) {
    const namespace = this.namespaces.get(id);
    return namespace && { id: namespace.id, title: namespace.title };
  }

  has(id: string) {
    return this.namespaces.has(id);
  }

  hasTitle(title: string, exceptId?: string) {
    return [...this.namespaces.values()].some((namespace) => namespace.title === title && namespace.id !== exceptId);
  }

  async create(title: string) {
    if (this.hasTitle(title)) return undefined;
    const id = randomUUID().replaceAll("-", "");
    // The binding's underlying namespace ID matches Worker bindings to this store.
    const runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('') } }",
      kvNamespaces: { KV: id },
      kvPersist: this.persistPath,
      cf: false,
    });
    this.namespaces.set(id, { id, title, runtime });
    try {
      await runtime.ready;
    } catch (error) {
      this.namespaces.delete(id);
      await runtime.dispose().catch(() => {});
      throw error;
    }
    return { id, title };
  }

  rename(id: string, title: string) {
    const namespace = this.namespaces.get(id);
    if (!namespace) return undefined;
    namespace.title = title;
    return { id, title };
  }

  async delete(id: string) {
    const namespace = this.namespaces.get(id);
    if (!namespace) return false;
    this.namespaces.delete(id);
    await namespace.runtime.dispose();
    return true;
  }

  async binding(id: string) {
    const namespace = this.namespaces.get(id);
    if (!namespace) return undefined;
    // Miniflare's conditional replacement type misidentifies KVNamespace as Request.
    return await namespace.runtime.getKVNamespace("KV") as unknown as KVBinding;
  }

  async dispose() {
    await Promise.all([...this.namespaces.values()].map(({ runtime }) => runtime.dispose()));
    this.namespaces.clear();
    await rm(this.persistPath, { recursive: true, force: true });
  }
}
