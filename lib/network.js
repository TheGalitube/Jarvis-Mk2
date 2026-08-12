import { hostname, networkInterfaces } from "node:os";

function splitValues(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hostWithoutPort(value) {
  const item = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");

  if (item.startsWith("[")) {
    return item.slice(1, item.indexOf("]"));
  }

  const colon = item.lastIndexOf(":");

  return colon > -1 && item.indexOf(":") === colon
    ? item.slice(0, colon)
    : item;
}

export function discoverIPv4Addresses(
  interfaces = networkInterfaces(),
) {
  const addresses = new Set(["127.0.0.1"]);

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && entry.address) {
        addresses.add(entry.address);
      }
    }
  }

  return [...addresses];
}

export function buildNetworkAccess({
  port,
  env = process.env,
  interfaces,
  machineName = hostname(),
}) {
  const hosts = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    machineName,
  ]);

  for (const address of discoverIPv4Addresses(interfaces)) {
    hosts.add(address);
  }

  for (const configured of splitValues(env.JARVIS_ALLOWED_HOSTS)) {
    hosts.add(hostWithoutPort(configured));
  }

  const allowedHosts = new Set();
  const allowedOrigins = new Set();

  for (const host of hosts) {
    const hostHeader =
      host.includes(":") && host !== "localhost"
        ? `[${host}]`
        : host;

    // Direkter Zugriff auf Port 3210
    allowedHosts.add(
      `${hostHeader}:${port}`.toLowerCase(),
    );

    allowedOrigins.add(
      `http://${hostHeader}:${port}`.toLowerCase(),
    );

    allowedOrigins.add(
      `https://${hostHeader}:${port}`.toLowerCase(),
    );

    // Reverse Proxy / Tailscale Serve ohne Backend-Port
    allowedHosts.add(
      hostHeader.toLowerCase(),
    );

    allowedOrigins.add(
      `http://${hostHeader}`.toLowerCase(),
    );

    allowedOrigins.add(
      `https://${hostHeader}`.toLowerCase(),
    );
  }

  return {
    allowedHosts,
    allowedOrigins,
  };
}

export function getBindHost(env = process.env) {
  return env.JARVIS_BIND_HOST?.trim() || "0.0.0.0";
}
