'use strict';

/**
 * Reachability checks between the two servers.
 *
 * A tunnel can be generated, uploaded, and reported as "deployed" while being
 * completely dead: the far side's firewall refuses the link port, or nothing is
 * listening yet. The user then spends half an hour blaming the config.
 *
 * These checks answer the only question that matters after a deploy:
 *   "can each side actually open a TCP connection to the other?"
 *
 * Both tests run *from the server that needs to connect*, so a firewall between
 * the two boxes shows up on the correct side.
 */

const { shellQuote } = require('./ssh');

const PORT_RE = /^\d{1,5}$/;

function validPort(port) {
  const n = Number(port);
  return PORT_RE.test(String(port)) && n >= 1 && n <= 65535;
}

/**
 * Ask a server to open a TCP connection to host:port and report what happened.
 *
 * One connection attempt, not three. `timeout` distinguishes the outcomes by its
 * own exit code, which is what makes this both fast and unambiguous:
 *
 *   0   -> something answered                          => open
 *   124 -> the timer killed it, the packets never came => filtered
 *   *   -> the host answered with RST, nothing listening => refused
 *
 * The target is probed first. A control connection to port 22 only runs when the
 * target failed, because port 22 is reachable by definition (the panel is
 * talking to the box over SSH) and therefore tells "the far side's firewall
 * blocked this port" apart from "this box has no egress at all" — the one
 * distinction worth an extra round trip, and only on the failure path.
 */
async function tcpProbe(sshExec, server, { host, port, timeout = 6 }) {
  if (!validPort(port)) return { port, verdict: 'invalid', detail: 'port out of range' };

  const secs = Math.max(1, Number(timeout));
  const target = Number(port);

  // Array-joined rather than one template literal: the shell needs its own $VAR
  // and $(...) and a JS template literal would interpolate those itself.
  const attempt = (h, p) =>
    [`rc=0`, `timeout ${secs} bash -c "exec 3<>/dev/tcp/${h}/${p}" >/dev/null 2>&1 || rc=$?`, `echo "$rc"`].join('\n');

  const first = await sshExec(server, attempt(host, target), { timeout: (secs + 15) * 1000 });
  const rc = (first.stdout || '').trim().split(/\s+/).pop();
  const classify = (code) => (code === '0' ? 'open' : code === '124' ? 'filtered' : 'refused');

  if (rc !== undefined && rc !== '' && rc !== 'UNKNOWN') {
    return { port: target, verdict: classify(rc), detail: null };
  }

  // Target gave no usable answer. Is the box able to reach the peer at all?
  const control = await sshExec(server, attempt(host, 22), { timeout: (secs + 15) * 1000 });
  const crc = (control.stdout || '').trim().split(/\s+/).pop();

  if (crc !== '0') {
    return {
      port: target,
      verdict: 'no-egress',
      detail: 'this server cannot reach port 22 on the peer either, so it has no usable path at all',
    };
  }

  return {
    port: target,
    verdict: 'unknown',
    detail: `probe command failed: ${(first.stderr || 'no output').trim().slice(0, 160)}`,
  };
}

/**
 * Which TCP ports is this box listening on? Used to explain a "refused" result:
 * the port is free, so the service is not up yet.
 */
async function listeningPorts(sshExec, server) {
  const script = `ss -lnt 2>/dev/null | awk 'NR>1 {split($4,a,":"); print a[length(a)]}' | sort -un | tr '\\n' ' '`;
  const res = await sshExec(server, script, { timeout: 20000 });
  if (res.failed) return [];
  return res.stdout
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Summarise this host's firewall, so a filtered result can be answered with a
 * concrete rule instead of a guess.
 */
async function firewallSummary(sshExec, server) {
  // Array-joined for the same reason as tcpProbe: $() must reach the shell.
  const script = [
    'if command -v ufw >/dev/null 2>&1; then',
    '  echo "FW=ufw $(ufw status 2>/dev/null | head -1)"',
    'elif command -v firewall-cmd >/dev/null 2>&1; then',
    '  echo "FW=firewalld $(firewall-cmd --state 2>/dev/null)"',
    'elif command -v nft >/dev/null 2>&1; then',
    '  echo "FW=nftables $(nft list ruleset 2>/dev/null | wc -l) rules"',
    'elif command -v iptables >/dev/null 2>&1; then',
    '  echo "FW=iptables $(iptables -S INPUT 2>/dev/null | head -1)"',
    'else',
    '  echo "FW=none"',
    'fi',
  ].join('\n');
  const res = await sshExec(server, script, { timeout: 20000 });
  return (res.stdout || 'FW=unknown').trim();
}

/** Does this box have a working TCP path to the other one at all? */
async function mutualReachability(sshExec, a, b) {
  const out = {};
  for (const [name, server, target] of [
    [`${a.role || 'a'}-to-${b.role || 'b'}`, a, b],
    [`${b.role || 'b'}-to-${a.role || 'a'}`, b, a],
  ]) {
    // Probe each other's SSH port: it is known-open on both, so this isolates
    // connectivity from "is a service running".
    const r = await tcpProbe(sshExec, server, { host: target.host, port: 22, timeout: 8 });
    out[name] = r.verdict;
  }
  return out;
}

/**
 * The full post-deploy check for a tunnel.
 *
 * `link` is the port the foreign side listens on for the Iran box; `user` is the
 * user-facing entry on Iran. The link has to work for any traffic to flow at all.
 */
async function checkTunnel(sshExec, sides, { link, user } = {}) {
  const report = { link: null, entry: null, firewalls: {}, mutual: null, problems: [] };

  // Each leg spawns a separate ssh process, which on Windows is slow enough that
  // running them in sequence noticeably delays the deploy response.
  const [iranFw, foreignFw, mutual] = await Promise.all([
    firewallSummary(sshExec, sides.iran),
    firewallSummary(sshExec, sides.foreign),
    mutualReachability(sshExec, sides.iran, sides.foreign),
  ]);
  report.firewalls.iran = iranFw;
  report.firewalls.foreign = foreignFw;
  report.mutual = mutual;

  const [lp, ep] = await Promise.all([
    link && sides.foreign
      ? tcpProbe(sshExec, sides.iran, { host: sides.foreign.host, port: link })
      : Promise.resolve(null),
    // The entry port is measured from the foreign box, which is as close to
    // "outside" as the panel gets without a third vantage point.
    user && sides.iran
      ? tcpProbe(sshExec, sides.foreign, { host: sides.iran.host, port: user })
      : Promise.resolve(null),
  ]);

  if (lp) {
    report.link = { from: 'iran', to: 'foreign', ...lp };
    if (lp.verdict === 'refused') {
      report.listening = await listeningPorts(sshExec, sides.foreign);
      report.problems.push({
        kind: 'link-refused',
        message: `سرور خارج روی پورت ${lp.port} پاسخ RST می‌دهد، یعنی چیزی روی آن گوش نمی‌دهد. سرویس روی آن سرور فعال است؟`,
        listening: report.listening,
      });
    } else if (lp.verdict === 'filtered') {
      report.problems.push({
        kind: 'link-filtered',
        message: `ایران نمی‌تواند به پورت ${lp.port} سرور خارج وصل شود. پکت‌ها فیلتر می‌شوند یا فایروال سرور خارج این پورت را باز نکرده است.`,
        fix: `ufw allow from ${sides.iran.host} to any port ${lp.port} proto tcp`,
      });
    } else if (lp.verdict === 'no-egress') {
      report.problems.push({
        kind: 'iran-no-egress',
        message:
          'سرور ایران حتی به پورت ۲۲ سرور خارج وصل نمی‌شود، پس نتیجه پورت لینک بی‌معنی است. مسیر شبکه ایران را بررسی کنید.',
      });
    }
  }

  if (ep) {
    report.entry = { from: 'foreign', to: 'iran', ...ep };
    if (ep.verdict === 'filtered') {
      report.problems.push({
        kind: 'entry-filtered',
        message: `پورت کاربران ${user} روی سرور ایران از بیرون در دسترس نیست. فایروال سرور ایران آن را باز کرده است؟`,
        fix: `ufw allow ${user}/tcp`,
      });
    } else if (ep.verdict === 'refused') {
      report.problems.push({
        kind: 'entry-refused',
        message: `چیزی روی پورت ${user} سرور ایران گوش نمی‌دهد؛ کانفیگ ممکن است اعمال نشده باشد.`,
      });
    }
  }

  report.ok = report.problems.length === 0;
  return report;
}

/**
 * Turn a detected problem into a concrete, minimal firewall rule.
 *
 * Only ever proposes an allow rule scoped to the other server, never a wider
 * one: the link port exists to serve exactly one peer, and "open to the world"
 * would be the wrong default to hand someone who is already fixing a firewall.
 */
function fixCommandFor(problem, sides) {
  switch (problem.kind) {
    case 'link-filtered':
      return `ufw allow from ${sides.iran.host} to any port ${problem.port} proto tcp`;
    case 'entry-filtered':
      return `ufw allow ${problem.port}/tcp`;
    default:
      return null;
  }
}

/**
 * Apply a firewall rule on a server.
 *
 * Deliberately narrow: only `ufw allow ...` commands that fit the known shapes,
 * because this is a panel acting on a live host and a mistaken command here can
 * lock someone out or expose a port. Anything else is refused rather than run.
 */
async function applyFirewallFix(sshExec, server, command) {
  const shape =
    /^ufw allow from \S+ to any port \d{1,5} proto (tcp|udp)$/.test(command) ||
    /^ufw allow \d{1,5}\/(tcp|udp)$/.test(command);
  if (!shape) {
    return { ok: false, error: 'only scoped ufw allow rules can be applied automatically' };
  }
  const res = await sshExec(server, command, { timeout: 30000 });
  return { ok: !res.failed, output: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

module.exports = {
  tcpProbe,
  listeningPorts,
  firewallSummary,
  mutualReachability,
  checkTunnel,
  validPort,
  fixCommandFor,
  applyFirewallFix,
};