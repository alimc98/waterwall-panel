'use strict';

/**
 * Builds the downloadable forms of the agent.
 *
 * A server outside the country fetches the agent from GitHub, and the raw
 * bytes do not always survive every path. The same bytes, gzipped or
 * base64-encoded, come through whole, so all three forms are published and
 * the installers try them in turn.
 *
 * Run with:  node scripts/build-agent-assets.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const AGENT = path.join(ROOT, 'agent', 'agent.js');

const source = fs.readFileSync(AGENT);
const raw = source.length;

const gz = zlib.gzipSync(source, { level: 9 });
const b64 = Buffer.from(source).toString('base64').split('\n');

const targets = [
  { file: path.join(ROOT, 'agent', 'agent.js.gz'), body: gz },
  { file: path.join(ROOT, 'agent', 'agent.js.b64'), body: b64.join('\n') + '\n' },
];

for (const { file, body } of targets) {
  fs.writeFileSync(file, body);
  console.log('%-24s %8d bytes', path.relative(ROOT, file), body.length);
}
console.log('%-24s %8d bytes (the source)', 'agent/agent.js', raw);
