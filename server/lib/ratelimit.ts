import type { NextFunction, Request, Response } from "express";

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

/** Simple sliding-window rate limiter keyed by IP (+ optional secondary key). */
export function rateLimit(options: { windowMs: number; max: number; keyPrefix?: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.ip || req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
    const key = `${options.keyPrefix || "rl"}:${ip}:${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }
    bucket.hits = bucket.hits.filter((t) => now - t < options.windowMs);
    if (bucket.hits.length >= options.max) {
      res.set("Retry-After", String(Math.ceil(options.windowMs / 1000)));
      res.status(429).json({ error: "Too many requests. Please slow down." });
      return;
    }
    bucket.hits.push(now);
    next();
  };
}

// Sweep stale buckets periodically so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    bucket.hits = bucket.hits.filter((t) => now - t < 600_000);
    if (bucket.hits.length === 0) buckets.delete(key);
  }
}, 300_000).unref();