import assert from "node:assert/strict";
import test from "node:test";

import { SshNetworkPolicy, normalizeSshNetworkPolicy } from "../gateway/core/ssh/network-policy.mjs";

test("SSH network policy authorizes every resolved address and pins one transport address", async () => {
  const policy = new SshNetworkPolicy({
    allowedCidrs: ["10.0.0.0/8", "2001:db8::/32"],
    deniedCidrs: ["10.9.0.0/16"],
    allowedPorts: [22, 2222],
    resolver: async () => [{ address: "10.2.3.4", family: 4 }, { address: "2001:db8::2", family: 6 }],
  });
  const result = await policy.assertAllowed({ host: "cluster.example", port: 22 });
  assert.equal(result.resolvedAddress, "10.2.3.4");
  assert.deepEqual(result.addresses.map((entry) => entry.address), ["10.2.3.4", "2001:db8::2"]);
});

test("SSH network policy rejects a mixed DNS answer instead of allowing rebinding", async () => {
  const policy = new SshNetworkPolicy({
    allowedCidrs: ["10.0.0.0/8"],
    resolver: async () => [{ address: "10.2.3.4", family: 4 }, { address: "198.51.100.9", family: 4 }],
  });
  await assert.rejects(() => policy.assertAllowed({ host: "mixed.example", port: 22 }), (error) => error?.code === "SSH_NETWORK_FORBIDDEN");
});

test("SSH network policy enforces host patterns and ports and returns normalized admin config", async () => {
  const policy = new SshNetworkPolicy({
    deniedHosts: ["*.blocked.example"],
    deniedPorts: [23],
    resolver: async () => [{ address: "203.0.113.2", family: 4 }],
  });
  await assert.rejects(() => policy.assertAllowed({ host: "node.blocked.example", port: 22 }), (error) => error?.code === "SSH_HOST_FORBIDDEN");
  await assert.rejects(() => policy.assertAllowed({ host: "allowed.example", port: 23 }), (error) => error?.code === "SSH_PORT_FORBIDDEN");
  assert.deepEqual(normalizeSshNetworkPolicy({ allowedCidrs: ["10.0.0.0/8"], allowedPorts: [2222, 22] }), {
    allowedCidrs: ["10.0.0.0/8"], deniedCidrs: [], allowedPorts: [22, 2222], deniedPorts: [], deniedHosts: [],
  });
});
