/*
 * Dump every template's shape: what it declares, and which of its fields look
 * like ports, addresses or listeners.
 *
 * The live harness has to place both halves of a link on one host, which means
 * remapping every port it finds and pointing every destination at loopback.
 * That is only safe if the mapping is derived from the declared fields rather
 * than guessed, so this prints what there is to work with.
 *
 *   node test/live/dump-shapes.js
 */
'use strict';

const templates = require('../../lib/templates');

const PORTISH = /port|listen|dest|address|host|domain|sni|endpoint|server|url|local/i;

for (const tpl of templates.ALL) {
  const fields = tpl.fields || [];
  const ports = fields.filter((f) => PORTISH.test(f.key));
  const auto = fields.filter((f) => typeof f.default === 'string' && f.default.startsWith('auto:'));
  console.log(`\n=== ${tpl.id} ===`);
  console.log(`  name        : ${tpl.name || ''}`);
  console.log(`  portish     : ${ports.map((f) => `${f.key}=${JSON.stringify(f.default)}`).join(', ') || '(none)'}`);
  console.log(`  auto secrets: ${auto.map((f) => f.key).join(', ') || '(none)'}`);
}
