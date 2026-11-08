// Per-IP sliding-window rate limiting, shared by the API routes.
// In-memory, so it's per server instance: exact under `vercel dev`, best-effort
// on Vercel where requests can land on different instances.

function createRateLimiter({ limit, windowMs }) {
  const hits = new Map(); // ip -> timestamps of requests inside the window

  return function check(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);

    if (recent.length >= limit) {
      hits.set(ip, recent);
      const retryAfterSec = Math.ceil((windowMs - (now - recent[0])) / 1000);
      return { allowed: false, retryAfterSec };
    }

    recent.push(now);
    hits.set(ip, recent);

    // Drop idle IPs so the map doesn't grow forever.
    if (hits.size > 5000) {
      for (const [key, times] of hits) {
        if (now - times[times.length - 1] >= windowMs) hits.delete(key);
      }
    }
    return { allowed: true };
  };
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

module.exports = { createRateLimiter, clientIp };
