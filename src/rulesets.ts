import { randomUUID } from "node:crypto";

export class InvalidRuleset extends Error {}

type Phase = "http_request_dynamic_redirect" | "http_request_transform" | "http_request_firewall_custom";
type Action = "redirect" | "rewrite" | "block" | "log";
type Kind = "zone" | "custom";

interface Rule {
  id: string;
  version: string;
  last_updated: string;
  ref: string;
  enabled: boolean;
  expression: string;
  action: Action;
  description?: string;
  action_parameters?: Record<string, unknown>;
}

interface Ruleset {
  id: string;
  zoneId: string;
  name: string;
  description: string;
  kind: Kind;
  phase: Phase;
  version: string;
  last_updated: string;
  rules: Rule[];
}

type Field = "http.request.uri.path" | "http.request.method" | "http.host" | "cf.zone.name";
type Context = { path: string; method: string; host: string; zoneName: string };
type Predicate = (context: Context) => boolean;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function fieldValue(field: Field, context: Context): string {
  switch (field) {
    case "http.request.uri.path": return context.path;
    case "http.request.method": return context.method;
    case "http.host": return context.host;
    case "cf.zone.name": return context.zoneName;
  }
}

/** A deliberately small Rules language parser; unsupported expressions fail at write time. */
export function compileExpression(source: string): Predicate {
  const matches = source.match(/\s*(?:"(?:\\.|[^"\\])*"|[(),]|[a-zA-Z_][a-zA-Z0-9_.]*)/g) ?? [];
  const tokens = matches.map((part) => part.trim());
  if (!tokens.length || matches.join("") !== source.trimEnd()) {
    throw new InvalidRuleset("Unsupported rule expression");
  }
  let index = 0;
  const take = () => tokens[index++];
  const peek = () => tokens[index];
  const literal = () => {
    const token = take();
    if (!token?.startsWith('"')) throw new InvalidRuleset("Expected quoted string in rule expression");
    try { return JSON.parse(token) as string; }
    catch { throw new InvalidRuleset("Invalid string in rule expression"); }
  };
  const field = () => {
    const token = take();
    if (token !== "http.request.uri.path" && token !== "http.request.method" &&
        token !== "http.host" && token !== "cf.zone.name") {
      throw new InvalidRuleset(`Unsupported rule field: ${token ?? "end of expression"}`);
    }
    return token;
  };
  const primary = (): Predicate => {
    if (peek() === "(") {
      take();
      const predicate = disjunction();
      if (take() !== ")") throw new InvalidRuleset("Unclosed rule expression");
      return predicate;
    }
    if (peek() === "true") { take(); return () => true; }
    if (peek() === "false") { take(); return () => false; }
    if (peek() === "starts_with") {
      take();
      if (take() !== "(") throw new InvalidRuleset("Invalid starts_with expression");
      const selected = field();
      // Commas are parsed explicitly because the rest of this grammar has no punctuation lists.
      if (take() !== ",") throw new InvalidRuleset("Invalid starts_with expression");
      const expected = literal();
      if (take() !== ")") throw new InvalidRuleset("Invalid starts_with expression");
      return (context) => fieldValue(selected, context).startsWith(expected);
    }
    const selected = field();
    const operator = take();
    if (operator !== "eq" && operator !== "ne" && operator !== "contains") {
      throw new InvalidRuleset(`Unsupported rule operator: ${operator ?? "end of expression"}`);
    }
    const expected = literal();
    return (context) => {
      const actual = fieldValue(selected, context);
      return operator === "eq" ? actual === expected : operator === "ne" ? actual !== expected : actual.includes(expected);
    };
  };
  const negation = (): Predicate => {
    if (peek() === "not") { take(); const inner = negation(); return (context) => !inner(context); }
    return primary();
  };
  const conjunction = (): Predicate => {
    let left = negation();
    while (peek() === "and") { take(); const right = negation(); const prior = left; left = (context) => prior(context) && right(context); }
    return left;
  };
  const disjunction = (): Predicate => {
    let left = conjunction();
    while (peek() === "or") { take(); const right = conjunction(); const prior = left; left = (context) => prior(context) || right(context); }
    return left;
  };
  const result = disjunction();
  if (index !== tokens.length) throw new InvalidRuleset("Unsupported rule expression");
  return result;
}

function ruleInput(input: unknown, phase: Phase, previous?: Rule): Rule {
  const value = object(input);
  if (!value || typeof value.expression !== "string" || typeof value.action !== "string") {
    throw new InvalidRuleset("Rule needs action and expression");
  }
  compileExpression(value.expression);
  const action = value.action;
  const allowed = phase === "http_request_dynamic_redirect" ? action === "redirect"
    : phase === "http_request_transform" ? action === "rewrite"
    : action === "block" || action === "log";
  if (!allowed) throw new InvalidRuleset(`Action ${action} is unsupported in ${phase}`);
  const params = object(value.action_parameters);
  if (action === "rewrite") {
    const uri = object(params?.uri);
    const path = object(uri?.path);
    if (typeof path?.value !== "string" || !path.value.startsWith("/") ||
        Object.keys(uri ?? {}).some((key) => key !== "path")) {
      throw new InvalidRuleset("Only static path rewrites are supported");
    }
  }
  if (action === "redirect") {
    const fromValue = object(params?.from_value);
    const targetURL = object(fromValue?.target_url);
    if (typeof targetURL?.value !== "string" || ![301, 302, 307, 308, undefined].includes(fromValue?.status_code as number | undefined)) {
      throw new InvalidRuleset("Only static redirects with a standard status are supported");
    }
  }
  if (action === "block" && params && Object.keys(params).length > 0) {
    const blockResponse = object(params.response);
    if (!blockResponse || typeof blockResponse.content !== "string" ||
        typeof blockResponse.content_type !== "string" || typeof blockResponse.status_code !== "number") {
      throw new InvalidRuleset("Invalid block response parameters");
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new InvalidRuleset("Invalid rule enabled flag");
  if (value.ref !== undefined && typeof value.ref !== "string") throw new InvalidRuleset("Invalid rule ref");
  if (value.description !== undefined && typeof value.description !== "string") throw new InvalidRuleset("Invalid rule description");
  const id = previous?.id ?? randomUUID().replaceAll("-", "");
  return {
    id, version: String(previous ? Number(previous.version) + 1 : 1), last_updated: new Date().toISOString(),
    ref: typeof value.ref === "string" ? value.ref : previous?.ref ?? id,
    enabled: value.enabled ?? true, expression: value.expression, action: action as Action,
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(params ? { action_parameters: params } : {}),
  };
}

function publicRuleset(ruleset: Ruleset) {
  const { zoneId: _zoneId, ...publicValue } = ruleset;
  return publicValue;
}

export type Evaluation =
  | { kind: "pass"; path: string }
  | { kind: "block"; status: number; body: string; contentType: string }
  | { kind: "redirect"; status: number; location: string };

export class RulesetStore {
  private readonly items = new Map<string, Ruleset>();

  list(zoneId: string) {
    return [...this.items.values()].filter((item) => item.zoneId === zoneId)
      .map(({ rules: _rules, zoneId: _zoneId, ...summary }) => summary);
  }

  get(zoneId: string, id: string) {
    const item = this.items.get(id);
    return item?.zoneId === zoneId ? publicRuleset(item) : undefined;
  }

  create(zoneId: string, input: unknown) {
    const body = object(input);
    if (!body || typeof body.name !== "string" || !body.name ||
        (body.kind !== "zone" && body.kind !== "custom") ||
        (body.phase !== "http_request_dynamic_redirect" && body.phase !== "http_request_transform" &&
         body.phase !== "http_request_firewall_custom") ||
        (body.description !== undefined && typeof body.description !== "string") ||
        (body.rules !== undefined && !Array.isArray(body.rules))) {
      throw new InvalidRuleset("Invalid ruleset name, kind, phase, description, or rules");
    }
    if (body.kind === "custom" && body.phase !== "http_request_firewall_custom") {
      throw new InvalidRuleset("Custom rulesets are supported only in the firewall phase");
    }
    if (body.kind === "zone" && [...this.items.values()].some((item) =>
      item.zoneId === zoneId && item.kind === "zone" && item.phase === body.phase)) {
      throw new InvalidRuleset("Zone phase entry point already exists");
    }
    const rules = (body.rules ?? []).map((rule: unknown) => ruleInput(rule, body.phase as Phase));
    const now = new Date().toISOString();
    const item: Ruleset = {
      id: randomUUID().replaceAll("-", ""), zoneId, name: body.name, description: body.description ?? "",
      kind: body.kind, phase: body.phase, version: "1", last_updated: now, rules,
    };
    this.items.set(item.id, item);
    return publicRuleset(item);
  }

  update(zoneId: string, id: string, input: unknown) {
    const item = this.items.get(id);
    if (!item || item.zoneId !== zoneId) return undefined;
    const body = object(input);
    if (!body || (body.description !== undefined && typeof body.description !== "string") ||
        (body.rules !== undefined && !Array.isArray(body.rules)) ||
        (body.name !== undefined && body.name !== item.name) ||
        (body.kind !== undefined && body.kind !== item.kind) ||
        (body.phase !== undefined && body.phase !== item.phase)) {
      throw new InvalidRuleset("Invalid ruleset update");
    }
    const rules = body.rules === undefined ? item.rules : body.rules.map((inputRule: unknown) => {
      const value = object(inputRule);
      const old = item.rules.find((rule) => (typeof value?.id === "string" && rule.id === value.id) ||
        (typeof value?.ref === "string" && rule.ref === value.ref));
      return ruleInput(inputRule, item.phase, old);
    });
    item.rules = rules;
    if (body.description !== undefined) item.description = body.description;
    item.version = String(Number(item.version) + 1);
    item.last_updated = new Date().toISOString();
    return publicRuleset(item);
  }

  delete(zoneId: string, id: string) {
    return this.get(zoneId, id) ? this.items.delete(id) : false;
  }

  deleteZone(zoneId: string) {
    for (const item of this.items.values()) if (item.zoneId === zoneId) this.items.delete(item.id);
  }

  evaluate(zoneId: string, zoneName: string, host: string, method: string, path: string, query: string): Evaluation {
    const phases: Phase[] = ["http_request_dynamic_redirect", "http_request_transform", "http_request_firewall_custom"];
    const rulesets = [...this.items.values()].filter((item) => item.zoneId === zoneId && item.kind === "zone");
    let currentPath = path;
    for (const phase of phases) {
      const ruleset = rulesets.find((item) => item.phase === phase);
      if (!ruleset) continue;
      for (const rule of ruleset.rules) {
        if (!rule.enabled || !compileExpression(rule.expression)({ path: currentPath, method, host, zoneName })) continue;
        if (rule.action === "redirect") {
          const from = object(rule.action_parameters?.from_value)!;
          let location = object(from.target_url)!.value as string;
          if (from.preserve_query_string && query) location += (location.includes("?") ? "&" : "?") + query;
          return { kind: "redirect", status: (from.status_code as number | undefined) ?? 301, location };
        }
        if (rule.action === "rewrite") {
          currentPath = object(object(rule.action_parameters?.uri)?.path)!.value as string;
          break;
        }
        if (rule.action === "block") {
          const custom = object(rule.action_parameters?.response);
          return { kind: "block", status: (custom?.status_code as number | undefined) ?? 403,
            body: (custom?.content as string | undefined) ?? "Forbidden",
            contentType: (custom?.content_type as string | undefined) ?? "text/plain" };
        }
      }
    }
    return { kind: "pass", path: currentPath };
  }
}
