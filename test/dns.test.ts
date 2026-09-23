import assert from "node:assert/strict";
import { test } from "node:test";
import { acknowledgePurge, InvalidCachePurge } from "../src/cache.js";
import { DNSStore, InvalidDNSRecord, normalizeRecordName } from "../src/dns.js";

test("DNS records normalize names and preserve state across a rejected conflict", () => {
  const dns = new DNSStore();
  assert.equal(normalizeRecordName("Büro", "example.test"), "xn--bro-hoa.example.test");
  const first = dns.create("zone-one", "example.test", {
    name: "www", type: "A", content: "192.0.2.1", ttl: 1, proxied: true, comment: "first",
  });
  assert.equal(first.name, "www.example.test");
  assert.equal(first.proxiable, true);
  assert.throws(() => dns.create("zone-one", "example.test", {
    name: "www", type: "CNAME", content: "target.example.test", ttl: 60,
  }), InvalidDNSRecord);
  assert.throws(() => dns.create("zone-one", "example.test", {
    name: "www", type: "A", content: "192.0.2.1", ttl: 1,
  }), InvalidDNSRecord);
  assert.throws(() => dns.update("zone-one", "example.test", first.id, {
    content: "not an address",
  }, false), InvalidDNSRecord);
  assert.equal(dns.get("zone-one", first.id)?.content, "192.0.2.1");

  const replaced = dns.update("zone-one", "example.test", first.id, {
    name: "www", type: "A", content: "192.0.2.2", ttl: 120,
  }, true);
  assert.equal(replaced?.id, first.id);
  assert.equal(replaced?.content, "192.0.2.2");
  assert.equal(replaced?.comment, undefined);
  assert.equal(replaced?.proxied, false);
  assert.equal(dns.get("zone-two", first.id), undefined);
  dns.deleteZone("zone-one");
  assert.deepEqual(dns.list("zone-one"), []);
});

test("DNS validates record values and cache purge accepts one documented method", () => {
  const dns = new DNSStore();
  assert.throws(() => dns.create("zone", "example.test", {
    name: "bad", type: "A", content: "300.0.0.1", ttl: 60,
  }), InvalidDNSRecord);
  assert.throws(() => dns.create("zone", "example.test", {
    name: "mail", type: "MX", content: "mail.example.test", ttl: 30, priority: 10,
  }), InvalidDNSRecord);
  assert.throws(() => dns.create("zone", "example.test", {
    name: "mail", type: "MX", content: "mail.example.test", ttl: 60,
  }), InvalidDNSRecord);
  const mx = dns.create("zone", "example.test", {
    name: "@", type: "MX", content: "MAIL.Example.Test.", ttl: 60, priority: 10,
  });
  assert.equal(mx.content, "mail.example.test");
  assert.equal(mx.proxiable, false);
  assert.match(acknowledgePurge({ purge_everything: true }).id, /^[a-f0-9]{32}$/);
  assert.match(acknowledgePurge({ files: ["https://example.test/a.css"] }).id, /^[a-f0-9]{32}$/);
  assert.throws(() => acknowledgePurge({ purge_everything: true, files: ["https://example.test/a"] }), InvalidCachePurge);
  assert.throws(() => acknowledgePurge({ files: ["ftp://example.test/a"] }), InvalidCachePurge);
});
