import test from "node:test";
import assert from "node:assert/strict";
import { buildNetworkAccess, discoverIPv4Addresses, getBindHost } from "../lib/network.js";

test("discovers IPv4 addresses from all interfaces", () => {
  assert.deepEqual(discoverIPv4Addresses({
    ethernet: [{ family: "IPv4", address: "192.168.1.75" }],
    tailscale0: [{ family: "IPv4", address: "100.111.0.8" }],
    loopback: [{ family: "IPv6", address: "::1" }],
  }), ["127.0.0.1", "192.168.1.75", "100.111.0.8"]);
});

test("allows discovered addresses and configured DNS names", () => {
  const access = buildNetworkAccess({
    port: 3210,
    machineName: "jarvis-pc",
    interfaces: { lan: [{ family: "IPv4", address: "192.168.1.75" }] },
    env: { JARVIS_ALLOWED_HOSTS: "jarvis.tailnet.ts.net" },
  });
  assert.equal(access.allowedHosts.has("192.168.1.75:3210"), true);
  assert.equal(access.allowedOrigins.has("http://100.111.0.8:3210"), false);
  assert.equal(access.allowedHosts.has("jarvis.tailnet.ts.net:3210"), true);
  assert.equal(access.allowedOrigins.has("http://jarvis.tailnet.ts.net:3210"), true);
});

test("defaults to all interfaces and supports an explicit bind host", () => {
  assert.equal(getBindHost({}), "0.0.0.0");
  assert.equal(getBindHost({ JARVIS_BIND_HOST: "100.111.0.8" }), "100.111.0.8");
});
