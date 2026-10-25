'use strict';

const crypto = require('node:crypto');

/** Deep clone that is safe for plain JSON data. */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Stable JSON stringify with 2-space indent. */
function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

/** Strip characters that are unsafe inside a WaterWall node name / label. */
function safeName(input, fallback = 'item') {
  const cleaned = String(input || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively drop empty objects/arrays and nullish values. */
function prune(value) {
  if (Array.isArray(value)) {
    const out = value.map(prune).filter((v) => v !== undefined);
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const pruned = prune(val);
      if (pruned === undefined) continue;
      if (isPlainObject(pruned) && Object.keys(pruned).length === 0) continue;
      if (Array.isArray(pruned) && pruned.length === 0) continue;
      out[key] = pruned;
    }
    return out;
  }
  if (value === null || value === undefined) return undefined;
  return value;
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function slug(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Parse a JSON body from a request stream. */
function readBody(req, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      // The size limit is the client's fault, and the answer has to say so.
      // Without a status code this surfaced as a 500, which blamed the panel
      // and read as a server fault.
      if (!err.statusCode) err.statusCode = 413;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        const err = new Error('request body too large');
        err.statusCode = 413;
        fail(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

module.exports = {
  clone,
  pretty,
  uuid,
  nowIso,
  safeName,
  slug,
  isPlainObject,
  prune,
  timingSafeEqual,
  randomToken,
  readBody,
};
