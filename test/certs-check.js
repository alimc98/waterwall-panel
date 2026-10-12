const c = require('../lib/certs');

const bad = [
  'exam ple.com',
  'example .com',
  'example.com; rm -rf /',
  'example.com && curl evil',
  'example.com|cat',
  '-bad.com',
  'bad-.com',
  'example..com',
  '.example.com',
  '',
  '   ',
];

console.log('=== accepted ===');
for (const d of ['example.com', 'a.b.co.uk', '  EXAMPLE.com  ', 'https://example.com/x', 'xn--80ak6aa92e.com']) {
  const r = c.validateDomain(d);
  console.log('  ' + JSON.stringify(d).padEnd(26) + ' -> ok=' + r.ok + '  domain=' + r.domain);
}

console.log('');
console.log('=== rejected ===');
let wrong = 0;
for (const d of bad) {
  const r = c.validateDomain(d);
  if (r.ok) wrong++;
  console.log('  ' + JSON.stringify(d).padEnd(28) + ' -> ' + (r.ok ? 'ACCEPTED (BUG)' : 'rejected') + '  ' + (r.error || ''));
}
console.log('');
console.log(wrong ? wrong + ' STILL ACCEPTED' : 'all rejected correctly');