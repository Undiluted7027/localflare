import assert from "node:assert/strict";
import { test } from "node:test";
import { compileExpression, InvalidRuleset, RulesetStore } from "../src/rulesets.js";

test("Rules language expressions support grouping and reject unsupported fields", () => {
  const expression = compileExpression('(http.request.method eq "GET" and not http.request.uri.path contains "/admin") or http.host eq "other.example"');
  const context = { method: "GET", path: "/home", host: "site.example", zoneName: "site.example" };
  assert.equal(expression(context), true);
  assert.equal(expression({ ...context, path: "/admin" }), false);
  assert.equal(expression({ ...context, method: "POST", host: "other.example" }), true);
  assert.equal(compileExpression('starts_with(http.request.uri.path, "/ho")')(context), true);
  assert.throws(() => compileExpression('ip.src eq "127.0.0.1"'), InvalidRuleset);
  assert.throws(() => compileExpression('http.request.uri.path matches "^/"'), InvalidRuleset);
});

test("redirects terminate before rewrites; firewall sees the rewritten path", () => {
  const store = new RulesetStore();
  const zoneId = "zone-one";
  store.create(zoneId, {
    name: "redirects", kind: "zone", phase: "http_request_dynamic_redirect", rules: [{
      action: "redirect", expression: 'http.request.uri.path eq "/old"',
      action_parameters: { from_value: { target_url: { value: "https://site.example/new" }, status_code: 308, preserve_query_string: true } },
    }],
  });
  store.create(zoneId, {
    name: "rewrites", kind: "zone", phase: "http_request_transform", rules: [{
      action: "rewrite", expression: 'http.request.uri.path eq "/public"',
      action_parameters: { uri: { path: { value: "/private" } } },
    }],
  });
  const firewall = store.create(zoneId, {
    name: "firewall", kind: "zone", phase: "http_request_firewall_custom", rules: [
      { action: "log", expression: "true" },
      { action: "block", expression: 'http.request.uri.path eq "/private"', enabled: true },
    ],
  });
  assert.deepEqual(store.evaluate(zoneId, "site.example", "site.example", "GET", "/old", "a=1"), {
    kind: "redirect", status: 308, location: "https://site.example/new?a=1",
  });
  assert.deepEqual(store.evaluate(zoneId, "site.example", "site.example", "GET", "/public", ""), {
    kind: "block", status: 403, body: "Forbidden", contentType: "text/plain",
  });
  assert.deepEqual(store.evaluate(zoneId, "site.example", "site.example", "GET", "/safe", ""), { kind: "pass", path: "/safe" });

  assert.throws(() => store.update(zoneId, firewall.id, { rules: [
    { action: "block", expression: 'http.request.uri.path eq "/safe"' },
    { action: "block", expression: 'ip.src eq "127.0.0.1"' },
  ] }), InvalidRuleset);
  assert.equal(store.get(zoneId, firewall.id)?.version, "1");
  assert.deepEqual(store.evaluate(zoneId, "site.example", "site.example", "GET", "/safe", ""), { kind: "pass", path: "/safe" });

  const updated = store.update(zoneId, firewall.id, { rules: [{
    ref: firewall.rules[1]!.ref, action: "block", expression: 'http.request.uri.path eq "/safe"',
  }] });
  assert.equal(updated?.version, "2");
  assert.equal(updated.rules[0]?.id, firewall.rules[1]?.id);
  assert.equal(store.evaluate(zoneId, "site.example", "site.example", "GET", "/safe", "").kind, "block");
  store.deleteZone(zoneId);
  assert.deepEqual(store.list(zoneId), []);
});
