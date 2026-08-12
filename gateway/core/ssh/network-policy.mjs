import dns from "node:dns/promises";
import net from "node:net";

import { invariant } from "../errors.mjs";
import { normalizeSshHost } from "../scope.mjs";

function normalizeCidrs(values, field) {
  return [...new Set((values || []).map(String))].map((value) => {
    const match = value.trim().match(/^(.+)\/(\d{1,3})$/);
    invariant(match, "SSH_CIDR_INVALID", `${field} 包含无效 CIDR`, { status: 400, details: { cidr: value } });
    const address = match[1];
    const family = net.isIP(address);
    const prefix = Number(match[2]);
    invariant(family && prefix >= 0 && prefix <= (family === 4 ? 32 : 128), "SSH_CIDR_INVALID", `${field} 包含无效 CIDR`, { status: 400, details: { cidr: value } });
    return { address, prefix, family: family === 4 ? "ipv4" : "ipv6", source: `${address}/${prefix}` };
  });
}

function blockList(cidrs) {
  const list = new net.BlockList();
  for (const cidr of cidrs) list.addSubnet(cidr.address, cidr.prefix, cidr.family);
  return list;
}

function hostMatches(pattern, host) {
  const normalized = String(pattern || "").trim().toLowerCase();
  if (normalized.startsWith("*.")) return host.endsWith(normalized.slice(1)) && host !== normalized.slice(2);
  return host === normalized;
}

function normalizePorts(values, field) {
  return [...new Set((values || []).map(Number))].map((port) => {
    invariant(Number.isSafeInteger(port) && port >= 1 && port <= 65535, "SSH_POLICY_PORT_INVALID", `${field} 包含无效端口`, { status: 400 });
    return port;
  });
}

export class SshNetworkPolicy {
  constructor(options = {}) {
    this.allowedCidrs = normalizeCidrs(options.allowedCidrs, "allowedCidrs");
    this.deniedCidrs = normalizeCidrs(options.deniedCidrs, "deniedCidrs");
    this.allowedList = blockList(this.allowedCidrs);
    this.deniedList = blockList(this.deniedCidrs);
    this.allowedPorts = new Set(normalizePorts(options.allowedPorts, "allowedPorts"));
    this.deniedPorts = new Set(normalizePorts(options.deniedPorts, "deniedPorts"));
    this.deniedHosts = [...new Set((options.deniedHosts || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
    this.resolver = options.resolver || (async (host) => dns.lookup(host, { all: true, verbatim: true }));
  }

  async assertAllowed(profile) {
    const host = normalizeSshHost(profile?.host);
    const port = Number(profile?.port ?? 22);
    invariant(!this.deniedHosts.some((pattern) => hostMatches(pattern, host)), "SSH_HOST_FORBIDDEN", "管理员策略不允许连接该服务器", { status: 403, details: { host } });
    invariant(!this.deniedPorts.has(port) && (!this.allowedPorts.size || this.allowedPorts.has(port)), "SSH_PORT_FORBIDDEN", "管理员策略不允许使用该 SSH 端口", { status: 403, details: { port } });
    const ipFamily = net.isIP(host);
    let records;
    try {
      records = ipFamily ? [{ address: host, family: ipFamily }] : await this.resolver(host);
    } catch (error) {
      throw Object.assign(new Error("无法解析 SSH 服务器地址"), { code: "SSH_DNS_RESOLUTION_FAILED", status: 409, cause: error });
    }
    const addresses = [...new Map((records || []).map((record) => [String(record.address), { address: String(record.address), family: Number(record.family || net.isIP(record.address)) }])).values()];
    invariant(addresses.length > 0 && addresses.every((record) => [4, 6].includes(record.family)), "SSH_DNS_RESOLUTION_FAILED", "SSH 服务器地址没有可用 IP", { status: 409 });
    for (const record of addresses) {
      const family = record.family === 4 ? "ipv4" : "ipv6";
      invariant(!this.deniedList.check(record.address, family), "SSH_NETWORK_FORBIDDEN", "管理员策略不允许连接该网段", { status: 403, details: { address: record.address } });
      invariant(!this.allowedCidrs.length || this.allowedList.check(record.address, family), "SSH_NETWORK_FORBIDDEN", "服务器地址不在管理员允许的网段内", { status: 403, details: { address: record.address } });
    }
    addresses.sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
    return Object.freeze({ host, port, addresses: Object.freeze(addresses.map((entry) => Object.freeze(entry))), resolvedAddress: addresses[0].address });
  }
}

export function normalizeSshNetworkPolicy(input = {}) {
  const policy = new SshNetworkPolicy(input);
  return Object.freeze({
    allowedCidrs: Object.freeze(policy.allowedCidrs.map((entry) => entry.source)),
    deniedCidrs: Object.freeze(policy.deniedCidrs.map((entry) => entry.source)),
    allowedPorts: Object.freeze([...policy.allowedPorts].sort((left, right) => left - right)),
    deniedPorts: Object.freeze([...policy.deniedPorts].sort((left, right) => left - right)),
    deniedHosts: Object.freeze([...policy.deniedHosts].sort()),
  });
}
