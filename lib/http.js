'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { readBody } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: message, ...extra });
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regexSource = pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1));
          return '([^/]+)';
        }
        if (segment === '*') {
          keys.push('wildcard');
          return '(.*)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({
      method,
      regex: new RegExp(`^${regexSource}$`),
      keys,
      handler,
    });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }
  post(p, h) {
    return this.add('POST', p, h);
  }
  patch(p, h) {
    return this.add('PATCH', p, h);
  }
  put(p, h) {
    return this.add('PUT', p, h);
  }
  delete(p, h) {
    return this.add('DELETE', p, h);
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      try {
        route.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(m[i + 1]);
        });
      } catch {
        // A malformed percent-escape in an id is the client's mistake. Letting
        // it throw here would surface as a 500 from the top-level handler.
        const err = new Error('malformed URL parameter');
        err.statusCode = 400;
        throw err;
      }
      return { handler: route.handler, params };
    }
    return null;
  }
}

async function parseJsonBody(req) {
  const type = req.headers['content-type'] || '';
  if (!type.includes('application/json')) return {};
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    const err = new Error('request body must be valid JSON');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Serve a file from `rootDir`, refusing to escape it.
 *
 * The containment check appends the separator. Comparing against the bare root
 * would also accept a *sibling* whose name merely begins with it — `/../public-x`
 * resolves outside the directory but still starts with `/…/public`.
 */
function serveStatic(res, rootDir, urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    // A malformed escape sequence is a bad request, not a server fault, and it
    // must not be allowed to fall through to the SPA and return index.html.
    sendError(res, 400, 'bad request');
    return true;
  }
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const target = path.resolve(rootDir, rel);
  const root = path.resolve(rootDir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    sendError(res, 403, 'forbidden');
    return true;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const ext = path.extname(target).toLowerCase();
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
  return true;
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

module.exports = { Router, sendJson, sendText, sendError, parseJsonBody, serveStatic, parseUrl, MIME };
