import { randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";

export type ZoneType = "full" | "partial" | "secondary" | "internal";

const settingValues = {
  always_use_https: ["on", "off"],
  ssl: ["off", "flexible", "full", "strict"],
  security_level: ["off", "essentially_off", "low", "medium", "high", "under_attack"],
  min_tls_version: ["1.0", "1.1", "1.2", "1.3"],
} as const;

export type SettingId = keyof typeof settingValues;

const settingDefaults: Record<SettingId, string> = {
  always_use_https: "off",
  ssl: "full",
  security_level: "medium",
  min_tls_version: "1.2",
};

interface Setting {
  id: SettingId;
  value: string;
  editable: true;
  modified_on: string | null;
}

interface Zone {
  id: string;
  name: string;
  type: ZoneType;
  status: "pending";
  account: { id: string; name: string };
  created_on: string;
  modified_on: string;
  activated_on: null;
  development_mode: 0;
  meta: object;
  name_servers: string[];
  original_dnshost: null;
  original_name_servers: null;
  original_registrar: null;
  owner: { id: string; name: string; type: "organization" };
  plan: { id: string; name: "Free"; is_subscribed: true };
  paused: boolean;
  settings: Map<SettingId, Setting>;
}

export function normalizeZoneName(name: string) {
  const ascii = domainToASCII(name.toLowerCase());
  if (ascii.length === 0 || ascii.length > 253 || !ascii.includes(".")) return undefined;
  if (!ascii.split(".").every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return undefined;
  }
  return ascii;
}

function publicZone(zone: Zone) {
  const { settings: _settings, ...result } = zone;
  return result;
}

/** Zone IDs become the parent identity for Rulesets and DNS in later checkpoints. */
export class ZoneStore {
  private readonly zones = new Map<string, Zone>();

  constructor(private readonly account: { id: string; name: string }) {}

  list() {
    return [...this.zones.values()].map(publicZone);
  }

  get(id: string) {
    const zone = this.zones.get(id);
    return zone && publicZone(zone);
  }

  create(name: string, type: ZoneType) {
    if ([...this.zones.values()].some((zone) => zone.name === name)) return undefined;
    const id = randomUUID().replaceAll("-", "");
    const now = new Date().toISOString();
    const settings = new Map<SettingId, Setting>();
    for (const [settingId, value] of Object.entries(settingDefaults) as Array<[SettingId, string]>) {
      settings.set(settingId, { id: settingId, value, editable: true, modified_on: null });
    }
    const zone: Zone = {
      id, name, type, status: "pending", account: this.account,
      created_on: now, modified_on: now, activated_on: null,
      development_mode: 0, meta: {}, name_servers: [],
      original_dnshost: null, original_name_servers: null, original_registrar: null,
      owner: { id: this.account.id, name: this.account.name, type: "organization" },
      plan: { id: "free", name: "Free", is_subscribed: true },
      paused: false, settings,
    };
    this.zones.set(id, zone);
    return publicZone(zone);
  }

  edit(id: string, change: { paused?: boolean; type?: ZoneType }) {
    const zone = this.zones.get(id);
    if (!zone) return undefined;
    if (change.paused !== undefined) zone.paused = change.paused;
    if (change.type !== undefined) zone.type = change.type;
    zone.modified_on = new Date().toISOString();
    return publicZone(zone);
  }

  delete(id: string) {
    return this.zones.delete(id);
  }

  listSettings(zoneId: string) {
    return [...this.zones.get(zoneId)?.settings.values() ?? []];
  }

  getSetting(zoneId: string, settingId: string) {
    return this.zones.get(zoneId)?.settings.get(settingId as SettingId);
  }

  acceptsSetting(settingId: string, value: unknown): settingId is SettingId {
    return Object.hasOwn(settingValues, settingId) && typeof value === "string" &&
      (settingValues[settingId as SettingId] as readonly string[]).includes(value);
  }

  editSettings(zoneId: string, changes: Array<{ id: SettingId; value: string }>) {
    const zone = this.zones.get(zoneId);
    if (!zone) return undefined;
    const now = new Date().toISOString();
    for (const { id, value } of changes) {
      zone.settings.set(id, { id, value, editable: true, modified_on: now });
    }
    zone.modified_on = now;
    return changes.map(({ id }) => zone.settings.get(id)!);
  }
}
