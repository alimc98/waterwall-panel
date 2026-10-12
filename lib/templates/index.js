'use strict';

const basic = require('./basic');
const stream = require('./stream');
const proxy = require('./proxy');
const layer3 = require('./layer3');
const reverse = require('./reverse');
const reverseReality = require('./reverse-reality');
const bitswap = require('./bitswap');
const protoswap = require('./protoswap');
const ops = require('./ops');

const ALL = [
  ...basic,
  ...stream,
  ...proxy,
  ...layer3,
  ...reverse,
  ...reverseReality,
  ...bitswap,
  ...protoswap,
  ...ops,
];

const byId = new Map(ALL.map((t) => [t.id, t]));

function get(id) {
  return byId.get(id) || null;
}

/** Catalog entry used by the UI form builder (no build function). */
function catalogEntry(tpl) {
  return {
    id: tpl.id,
    title: tpl.title,
    titleFa: tpl.titleFa || tpl.title,
    category: tpl.category,
    categoryFa: tpl.categoryFa || tpl.category,
    icon: tpl.icon || '🔗',
    sides: tpl.sides,
    summary: tpl.summary,
    summaryFa: tpl.summaryFa || tpl.summary,
    docs: tpl.docs || null,
    fieldGroups: tpl.fieldGroups || null,
    fields: tpl.fields || [],
    clientHint: tpl.clientHint || null,
    tags: tpl.tags || [],
  };
}

function catalog() {
  return ALL.map(catalogEntry);
}

module.exports = { ALL, get, catalog, catalogEntry };
