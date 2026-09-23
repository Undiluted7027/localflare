import { randomUUID } from "node:crypto";

interface Consumer {
  consumer_id: string;
  created_on: string;
  queue_name: string;
  script_name: string;
  type: "worker";
  dead_letter_queue: string;
  settings: { batch_size?: number; max_retries?: number; max_wait_time_ms?: number; retry_delay?: number };
}

interface Queue {
  queue_id: string;
  queue_name: string;
  created_on: string;
  modified_on: string;
  consumers: Consumer[];
  settings: { delivery_delay?: number; delivery_paused?: boolean; message_retention_period?: number };
}

export class InvalidQueue extends Error {}

export function validQueueName(name: string) {
  return name.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(name);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new InvalidQueue(`Invalid ${label}`);
  }
  return value;
}

function queueSettings(value: unknown): Queue["settings"] {
  if (value === undefined) return {};
  if (!record(value)) throw new InvalidQueue("Invalid queue settings");
  if (Object.keys(value).some((key) => !["delivery_delay", "delivery_paused", "message_retention_period"].includes(key))) {
    throw new InvalidQueue("Unsupported queue setting");
  }
  const delivery_delay = optionalInteger(value.delivery_delay, "delivery_delay", 0, 86400);
  const message_retention_period = optionalInteger(value.message_retention_period, "message_retention_period", 60, 1209600);
  if (value.delivery_paused !== undefined && typeof value.delivery_paused !== "boolean") {
    throw new InvalidQueue("Invalid delivery_paused");
  }
  return {
    ...(delivery_delay !== undefined ? { delivery_delay } : {}),
    ...(message_retention_period !== undefined ? { message_retention_period } : {}),
    ...(value.delivery_paused !== undefined ? { delivery_paused: value.delivery_paused } : {}),
  };
}

function consumerSettings(value: unknown): Consumer["settings"] {
  if (value === undefined) return {};
  if (!record(value)) throw new InvalidQueue("Invalid consumer settings");
  if (Object.keys(value).some((key) => !["batch_size", "max_retries", "max_wait_time_ms", "retry_delay"].includes(key))) {
    throw new InvalidQueue("Unsupported consumer setting");
  }
  const batch_size = optionalInteger(value.batch_size, "batch_size", 1, 100);
  const max_retries = optionalInteger(value.max_retries, "max_retries", 0, 100);
  const max_wait_time_ms = optionalInteger(value.max_wait_time_ms, "max_wait_time_ms", 0, 60000);
  const retry_delay = optionalInteger(value.retry_delay, "retry_delay", 0, 86400);
  return {
    ...(batch_size !== undefined ? { batch_size } : {}),
    ...(max_retries !== undefined ? { max_retries } : {}),
    ...(max_wait_time_ms !== undefined ? { max_wait_time_ms } : {}),
    ...(retry_delay !== undefined ? { retry_delay } : {}),
  };
}

function publicQueue(queue: Queue) {
  return {
    ...queue,
    consumers: queue.consumers.map((consumer) => ({ ...consumer, settings: { ...consumer.settings } })),
    consumers_total_count: queue.consumers.length,
    settings: { ...queue.settings },
  };
}

/** Queue and consumer configuration for a single Localflare server lifetime. */
export class QueueStore {
  private readonly queues = new Map<string, Queue>();

  list(name?: string) {
    return [...this.queues.values()]
      .filter((queue) => name === undefined || queue.queue_name === name)
      .map(publicQueue)
      .sort((a, b) => a.queue_name.localeCompare(b.queue_name));
  }

  get(id: string) {
    const queue = this.queues.get(id);
    return queue && publicQueue(queue);
  }

  hasName(name: string) {
    return [...this.queues.values()].some((queue) => queue.queue_name === name);
  }

  create(body: unknown) {
    if (!record(body) || typeof body.queue_name !== "string" || !validQueueName(body.queue_name)) {
      throw new InvalidQueue("Invalid queue_name");
    }
    if (this.hasName(body.queue_name)) return undefined;
    if (body.jurisdiction !== undefined) throw new InvalidQueue("Queue jurisdiction is not supported locally");
    const now = new Date().toISOString();
    const queue: Queue = {
      queue_id: randomUUID().replaceAll("-", ""), queue_name: body.queue_name,
      created_on: now, modified_on: now, consumers: [], settings: queueSettings(body.settings),
    };
    this.queues.set(queue.queue_id, queue);
    return publicQueue(queue);
  }

  delete(id: string) {
    const queue = this.queues.get(id);
    if (!queue) return "missing" as const;
    if (queue.consumers.length > 0) return "has-consumers" as const;
    this.queues.delete(id);
    return "deleted" as const;
  }

  listConsumers(id: string) {
    return this.queues.get(id)?.consumers.map((consumer) => ({ ...consumer, settings: { ...consumer.settings } }));
  }

  getConsumer(id: string, consumerId: string) {
    return this.listConsumers(id)?.find((consumer) => consumer.consumer_id === consumerId);
  }

  createConsumer(id: string, body: unknown) {
    const queue = this.queues.get(id);
    if (!queue) return undefined;
    if (!record(body) || body.type !== "worker" || typeof body.script_name !== "string" || !body.script_name) {
      throw new InvalidQueue("Only Worker consumers with script_name are supported");
    }
    if (queue.consumers.some((consumer) => consumer.script_name === body.script_name)) {
      throw new InvalidQueue("Worker already consumes this queue");
    }
    if (body.dead_letter_queue !== undefined && (typeof body.dead_letter_queue !== "string" ||
        !this.hasName(body.dead_letter_queue))) {
      throw new InvalidQueue("Dead letter queue must exist");
    }
    const consumer: Consumer = {
      consumer_id: randomUUID().replaceAll("-", ""), created_on: new Date().toISOString(),
      queue_name: queue.queue_name, script_name: body.script_name, type: "worker",
      dead_letter_queue: body.dead_letter_queue ?? "", settings: consumerSettings(body.settings),
    };
    queue.consumers.push(consumer);
    queue.modified_on = new Date().toISOString();
    return { ...consumer, settings: { ...consumer.settings } };
  }

  deleteConsumer(id: string, consumerId: string) {
    const queue = this.queues.get(id);
    if (!queue) return false;
    const index = queue.consumers.findIndex((consumer) => consumer.consumer_id === consumerId);
    if (index < 0) return false;
    queue.consumers.splice(index, 1);
    queue.modified_on = new Date().toISOString();
    return true;
  }

  consumersForScript(scriptName: string) {
    return [...this.queues.values()].flatMap((queue) => queue.consumers
      .filter((consumer) => consumer.script_name === scriptName)
      .map((consumer) => ({ queue_name: queue.queue_name, settings: consumer.settings,
        dead_letter_queue: consumer.dead_letter_queue })));
  }
}
