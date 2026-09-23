import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export class InvalidDNSRecord extends Error {}

type RecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX";

export interface DNSRecord {
  id: string;
  zoneId: string;
  type: RecordType;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  proxiable: boolean;
  priority?: number;
  comment?: string;
  tags: string[];
  created_on: string;
  modified_on: string;
  comment_modified_on?: string;
  tags_modified_on?: string;
  meta: object;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Cloudflare accepts an apex, a relative name, or a full name and returns Punycode. */
export function normalizeRecordName(name: string, zoneName: string) {
  const trimmed = name.trim().replace(/\.$/, "").toLowerCase();
  const full = trimmed === "@" ? zoneName
    : trimmed === zoneName || trimmed.endsWith(`.${zoneName}`) ? trimmed
    : `${trimmed}.${zoneName}`;
  const ascii = domainToASCII(full);
  if (!ascii || ascii.length > 253 || !ascii.split(".").every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(label))) {
    throw new InvalidDNSRecord("Invalid DNS record name");
  }
  return ascii;
}

interface RecordFields {
  type: RecordType;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  proxiable: boolean;
  priority?: number;
  comment?: string;
  tags: string[];
}

function parseRecord(input: unknown, zoneName: string, previous?: DNSRecord): RecordFields {
  const body = object(input);
  if (!body) throw new InvalidDNSRecord("DNS record must be an object");
  const type = body.type ?? previous?.type;
  if (type !== "A" && type !== "AAAA" && type !== "CNAME" && type !== "TXT" && type !== "MX") {
    throw new InvalidDNSRecord("Unsupported DNS record type");
  }
  const name = body.name ?? previous?.name;
  if (typeof name !== "string" || !name.trim()) throw new InvalidDNSRecord("DNS record needs a name");
  const normalizedName = normalizeRecordName(name, zoneName);
  const content = body.content ?? previous?.content;
  if (typeof content !== "string" || !content) throw new InvalidDNSRecord("DNS record needs content");
  if (type === "A" && isIP(content) !== 4) throw new InvalidDNSRecord("A record needs an IPv4 address");
  if (type === "AAAA" && isIP(content) !== 6) throw new InvalidDNSRecord("AAAA record needs an IPv6 address");
  let normalizedContent = content;
  if (type === "CNAME" || type === "MX") {
    const target = domainToASCII(content.replace(/\.$/, "").toLowerCase());
    if (!target || !target.includes(".") || target === normalizedName ||
        !target.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
      throw new InvalidDNSRecord("Invalid DNS target name");
    }
    normalizedContent = target;
  }
  const ttl = body.ttl ?? previous?.ttl ?? 1;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) {
    throw new InvalidDNSRecord("DNS TTL must be automatic (1) or 60–86400 seconds");
  }
  const proxiable = type === "A" || type === "AAAA" || type === "CNAME";
  const proxied = body.proxied ?? previous?.proxied ?? false;
  if (typeof proxied !== "boolean" || (proxied && !proxiable)) {
    throw new InvalidDNSRecord("This DNS record cannot be proxied");
  }
  const priority = body.priority ?? previous?.priority;
  if (type === "MX" && (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 65535)) {
    throw new InvalidDNSRecord("MX record needs a priority from 0 to 65535");
  }
  if (type !== "MX" && priority !== undefined && priority !== null) {
    throw new InvalidDNSRecord("Priority is supported only on MX records");
  }
  const comment = body.comment ?? previous?.comment;
  if (comment !== undefined && (typeof comment !== "string" || comment.length > 500)) {
    throw new InvalidDNSRecord("Invalid DNS record comment");
  }
  const tags = body.tags ?? previous?.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string" && tag.length > 0)) {
    throw new InvalidDNSRecord("DNS record tags must be strings");
  }
  const settings = object(body.settings);
  if (settings && Object.keys(settings).length > 0) throw new InvalidDNSRecord("DNS record settings are not supported");
  return { type, name: normalizedName, content: normalizedContent, ttl, proxiable, proxied,
    ...(type === "MX" ? { priority: priority as number } : {}),
    ...(comment !== undefined ? { comment } : {}), tags };
}

function publicRecord(record: DNSRecord) {
  const { zoneId: _zoneId, ...result } = record;
  return result;
}

/** In-process DNS configuration, scoped by zone. No DNS server is started. */
export class DNSStore {
  private readonly records = new Map<string, DNSRecord>();

  list(zoneId: string) {
    return [...this.records.values()].filter((record) => record.zoneId === zoneId).map(publicRecord);
  }

  get(zoneId: string, id: string) {
    const record = this.records.get(id);
    return record?.zoneId === zoneId ? publicRecord(record) : undefined;
  }

  private checkConflicts(zoneId: string, fields: RecordFields, exceptId?: string) {
    for (const record of this.records.values()) {
      if (record.zoneId !== zoneId || record.id === exceptId || record.name !== fields.name) continue;
      if (record.type === "CNAME" || fields.type === "CNAME") {
        throw new InvalidDNSRecord("CNAME cannot coexist with another record at this name");
      }
      if (record.type === fields.type && record.content === fields.content) {
        throw new InvalidDNSRecord("DNS record already exists");
      }
    }
  }

  create(zoneId: string, zoneName: string, input: unknown) {
    const fields = parseRecord(input, zoneName);
    this.checkConflicts(zoneId, fields);
    const now = new Date().toISOString();
    const record: DNSRecord = {
      ...fields, id: randomUUID().replaceAll("-", ""), zoneId,
      created_on: now, modified_on: now, meta: {},
      ...(fields.comment !== undefined ? { comment_modified_on: now } : {}),
      ...(fields.tags.length > 0 ? { tags_modified_on: now } : {}),
    };
    this.records.set(record.id, record);
    return publicRecord(record);
  }

  update(zoneId: string, zoneName: string, id: string, input: unknown, replace: boolean) {
    const prior = this.records.get(id);
    if (!prior || prior.zoneId !== zoneId) return undefined;
    const body = object(input);
    if (!body) throw new InvalidDNSRecord("DNS record must be an object");
    if (replace && (body.type === undefined || body.name === undefined || body.content === undefined || body.ttl === undefined)) {
      throw new InvalidDNSRecord("DNS replacement needs type, name, content, and TTL");
    }
    const fields = parseRecord(input, zoneName, replace ? undefined : prior);
    this.checkConflicts(zoneId, fields, id);
    const now = new Date().toISOString();
    const record: DNSRecord = {
      ...fields, id, zoneId, created_on: prior.created_on, modified_on: now, meta: prior.meta,
      ...(fields.comment !== prior.comment ? { comment_modified_on: now }
        : prior.comment_modified_on ? { comment_modified_on: prior.comment_modified_on } : {}),
      ...(fields.tags.join("\0") !== prior.tags.join("\0") ? { tags_modified_on: now }
        : prior.tags_modified_on ? { tags_modified_on: prior.tags_modified_on } : {}),
    };
    this.records.set(id, record);
    return publicRecord(record);
  }

  delete(zoneId: string, id: string) {
    return this.get(zoneId, id) ? this.records.delete(id) : false;
  }

  deleteZone(zoneId: string) {
    for (const record of this.records.values()) if (record.zoneId === zoneId) this.records.delete(record.id);
  }
}
