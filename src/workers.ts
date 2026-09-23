import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { KVStore } from "./kv.js";
import { D1Store } from "./d1.js";
import { R2Store } from "./r2.js";
import { QueueStore } from "./queues.js";

interface WorkerMetadata {
  main_module?: string;
  body_part?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  bindings?: Array<{ type: string; name: string; text?: string; class_name?: string; script_name?: string; namespace_id?: string; id?: string; bucket_name?: string; queue_name?: string }>;
  migrations?: { old_tag?: string; new_tag: string; steps: Array<{ new_sqlite_classes: string[] }> };
}

interface StoredWorker {
  content: string;
  directory: string;
  runtime: Miniflare;
  options: ConstructorParameters<typeof Miniflare>[0];
  producerQueues: string[];
  subdomain: { enabled: boolean; previews_enabled: boolean };
  script: {
    id: string;
    tag: string;
    created_on: string;
    modified_on: string;
    compatibility_date?: string;
    compatibility_flags?: string[];
    migration_tag?: string;
  };
}

export class InvalidWorkerUpload extends Error {}

function parseMetadata(value: FormDataEntryValue | null): WorkerMetadata {
  if (typeof value !== "string") throw new InvalidWorkerUpload("Missing metadata form field");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidWorkerUpload("Invalid metadata JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidWorkerUpload("Metadata must be an object");
  }
  const metadata = parsed as Record<string, unknown>;
  if (typeof metadata.main_module !== "string" && typeof metadata.body_part !== "string") {
    throw new InvalidWorkerUpload("Metadata needs main_module or body_part");
  }
  if (metadata.bindings !== undefined && !Array.isArray(metadata.bindings)) {
    throw new InvalidWorkerUpload("bindings must be an array");
  }
  if (metadata.compatibility_date !== undefined && typeof metadata.compatibility_date !== "string") {
    throw new InvalidWorkerUpload("compatibility_date must be a string");
  }
  if (metadata.compatibility_flags !== undefined && (
    !Array.isArray(metadata.compatibility_flags) ||
    !metadata.compatibility_flags.every((flag) => typeof flag === "string")
  )) {
    throw new InvalidWorkerUpload("compatibility_flags must be strings");
  }
  if (metadata.migrations !== undefined && (
    typeof metadata.migrations !== "object" || metadata.migrations === null ||
    !("new_tag" in metadata.migrations) || typeof metadata.migrations.new_tag !== "string" ||
    !("steps" in metadata.migrations) || !Array.isArray(metadata.migrations.steps) ||
    !metadata.migrations.steps.every((step: unknown) =>
      typeof step === "object" && step !== null &&
      Object.keys(step).every((key) => key === "new_sqlite_classes") &&
      "new_sqlite_classes" in step && Array.isArray(step.new_sqlite_classes) &&
      step.new_sqlite_classes.every((name: unknown) => typeof name === "string"))
  )) {
    throw new InvalidWorkerUpload("Only new_sqlite_classes Durable Object migrations are supported");
  }
  return parsed as WorkerMetadata;
}

function filenameFromMetadata(metadata: WorkerMetadata): string {
  const filename = metadata.main_module ?? metadata.body_part;
  if (!filename || filename !== basename(filename) || filename === "." || filename === "..") {
    throw new InvalidWorkerUpload("Invalid main module filename");
  }
  return filename;
}

function runtimeBindings(metadata: WorkerMetadata, kv: KVStore, d1: D1Store, r2: R2Store, queues: QueueStore) {
  const bindings: Record<string, string> = {};
  const durableObjects: Record<string, string> = {};
  const kvNamespaces: Record<string, string> = {};
  const d1Databases: Record<string, string> = {};
  const r2Buckets: Record<string, string> = {};
  const queueProducers: Record<string, string> = {};
  for (const binding of metadata.bindings ?? []) {
    if (typeof binding !== "object" || binding === null || typeof binding.name !== "string") {
      throw new InvalidWorkerUpload("Invalid binding");
    }
    if (binding.type === "plain_text" || binding.type === "secret_text") {
      if (typeof binding.text !== "string") throw new InvalidWorkerUpload("Text binding needs text");
      bindings[binding.name] = binding.text;
    } else if (binding.type === "durable_object_namespace") {
      if (typeof binding.class_name !== "string" || binding.script_name) {
        throw new InvalidWorkerUpload("Durable Object binding needs a local class_name");
      }
      durableObjects[binding.name] = binding.class_name;
    } else if (binding.type === "kv_namespace") {
      if (typeof binding.namespace_id !== "string" || !kv.has(binding.namespace_id)) {
        throw new InvalidWorkerUpload("KV binding needs an existing namespace_id");
      }
      kvNamespaces[binding.name] = binding.namespace_id;
    } else if (binding.type === "d1") {
      if (typeof binding.id !== "string" || !d1.has(binding.id)) {
        throw new InvalidWorkerUpload("D1 binding needs an existing database id");
      }
      d1Databases[binding.name] = binding.id;
    } else if (binding.type === "r2_bucket") {
      if (typeof binding.bucket_name !== "string" || !r2.has(binding.bucket_name)) {
        throw new InvalidWorkerUpload("R2 binding needs an existing bucket_name");
      }
      r2Buckets[binding.name] = r2.namespace(binding.bucket_name)!;
    } else if (binding.type === "queue") {
      if (typeof binding.queue_name !== "string" || !queues.hasName(binding.queue_name)) {
        throw new InvalidWorkerUpload("Queue binding needs an existing queue_name");
      }
      queueProducers[binding.name] = binding.queue_name;
    } else {
      throw new InvalidWorkerUpload(`Unsupported binding type: ${binding.type}`);
    }
  }
  return { bindings, durableObjects, kvNamespaces, d1Databases, r2Buckets, queueProducers };
}

function queueConsumers(name: string, queues: QueueStore) {
  return Object.fromEntries(queues.consumersForScript(name).map((consumer) => [consumer.queue_name, {
    maxBatchSize: consumer.settings.batch_size,
    maxBatchTimeout: consumer.settings.max_wait_time_ms === undefined ? undefined : consumer.settings.max_wait_time_ms / 1000,
    maxRetries: consumer.settings.max_retries,
    retryDelay: consumer.settings.retry_delay,
    deadLetterQueue: consumer.dead_letter_queue || undefined,
  }]));
}

/** Owns uploaded scripts and their workerd instances for one Localflare server. */
export class WorkerStore {
  private readonly scripts = new Map<string, StoredWorker>();
  private readonly durableObjectRoot = mkdtempSync(join(tmpdir(), "localflare-do-"));

  constructor(private readonly kv: KVStore, private readonly d1: D1Store,
    private readonly r2: R2Store, private readonly queues: QueueStore) {}

  async refreshQueueConsumers(name: string) {
    const worker = this.scripts.get(name);
    if (!worker) return;
    worker.options = { ...worker.options, queueConsumers: queueConsumers(name, this.queues) };
    await worker.runtime.setOptions(worker.options);
  }

  get(name: string) {
    return this.scripts.get(name);
  }

  usesQueue(queueName: string) {
    return [...this.scripts.values()].some((worker) => worker.producerQueues.includes(queueName));
  }

  setSubdomain(name: string, settings: { enabled: boolean; previews_enabled: boolean }) {
    const worker = this.scripts.get(name);
    if (!worker) return false;
    worker.subdomain = settings;
    return true;
  }

  list() {
    return [...this.scripts.values()].map(({ script }) => script);
  }

  async put(name: string, form: FormData) {
    const metadata = parseMetadata(form.get("metadata"));
    const filename = filenameFromMetadata(metadata);
    const file = form.get(filename);
    if (!(file instanceof File)) throw new InvalidWorkerUpload(`Missing ${filename} module`);
    const content = await file.text();
    const directory = await mkdtemp(join(tmpdir(), "localflare-worker-"));
    let runtime: Miniflare | undefined;
    let options: ConstructorParameters<typeof Miniflare>[0] | undefined;
    let producerQueues: string[] = [];

    try {
      await writeFile(join(directory, filename), content);
      const bindings = runtimeBindings(metadata, this.kv, this.d1, this.r2, this.queues);
      producerQueues = Object.values(bindings.queueProducers);
      const common = {
        modulesRoot: directory,
        ...bindings,
        queueConsumers: queueConsumers(name, this.queues),
        kvPersist: this.kv.persistPath,
        d1Persist: this.d1.persistPath,
        r2Persist: this.r2.persistPath,
        durableObjectsPersist: Object.keys(bindings.durableObjects).length > 0
          ? join(this.durableObjectRoot, encodeURIComponent(name))
          : undefined,
        compatibilityDate: metadata.compatibility_date,
        compatibilityFlags: metadata.compatibility_flags,
        cf: false,
      };
      options = metadata.body_part
        ? { ...common, scriptPath: join(directory, filename) }
        : { ...common, modules: [{ type: "ESModule", path: join(directory, filename) }] };
      runtime = new Miniflare(options);
      // Startup is eager so an invalid Worker cannot replace a working deployment.
      await runtime.ready;
    } catch (error) {
      try {
        // A failed startup can also make dispose reject; preserve the startup error.
        await runtime?.dispose().catch(() => {});
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      if (typeof error === "object" && error !== null && "code" in error &&
          (error.code === "ERR_RUNTIME_FAILURE" || error.code === "ERR_MODULE_PARSE")) {
        throw new InvalidWorkerUpload("Worker failed to start");
      }
      throw error;
    }

    if (!runtime || !options) throw new Error("Worker runtime did not initialize");

    const previous = this.scripts.get(name);
    const now = new Date().toISOString();
    const script = {
      id: name,
      tag: randomUUID().replaceAll("-", ""),
      created_on: previous?.script.created_on ?? now,
      modified_on: now,
      compatibility_date: metadata.compatibility_date,
      compatibility_flags: metadata.compatibility_flags,
      migration_tag: metadata.migrations?.new_tag ?? previous?.script.migration_tag,
    };
    this.scripts.set(name, {
      content,
      directory,
      runtime,
      options,
      producerQueues,
      script,
      subdomain: previous?.subdomain ?? { enabled: false, previews_enabled: false },
    });
    if (previous) await this.disposeWorker(previous);
    return { ...script, deployment_id: randomUUID(), startup_time_ms: 0 };
  }

  async delete(name: string) {
    const worker = this.scripts.get(name);
    if (!worker) return false;
    this.scripts.delete(name);
    await this.disposeWorker(worker);
    await rm(join(this.durableObjectRoot, encodeURIComponent(name)), { recursive: true, force: true });
    return true;
  }

  async dispatch(name: string, request: Request) {
    const worker = this.scripts.get(name);
    if (!worker) return undefined;
    return worker.runtime.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.body ? await request.arrayBuffer() : undefined,
    });
  }

  async dispose() {
    await Promise.all([...this.scripts.values()].map((worker) => this.disposeWorker(worker)));
    this.scripts.clear();
    await rm(this.durableObjectRoot, { recursive: true, force: true });
  }

  private async disposeWorker(worker: StoredWorker) {
    await worker.runtime.dispose();
    await rm(worker.directory, { recursive: true, force: true });
  }
}
