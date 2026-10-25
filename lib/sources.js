'use strict';

/**
 * Where the agent and the installer are fetched from.
 *
 * The panel lives on an Iranian host, and the path from there to a foreign
 * box is the one that gets cut: a transfer of the raw agent.js stops a few
 * hundred bytes in and is reset. Measured on a foreign box:
 *
 *   panel (raw agent.js)      12 B/s, timed out after 75 s at 904 bytes
 *   panel (gzip agent.js)     25 KB/s, complete
 *   raw.githubusercontent      37 KB/s, complete
 *   github release asset      11 MB/s, complete
 *
 * So a foreign server should not fetch the agent from the panel at all. It
 * should fetch it from a source outside the country, and only fall back to
 * the panel when those are unreachable. An Iranian server is the opposite:
 * the panel is right there and answers in milliseconds, so it is the first
 * choice and the foreign sources are the fallback.
 *
 * This module decides the order, and the installers walk it.
 */

/** The repository the agent and the installers are published in. */
const PANEL_REPO = 'alimc98/waterwall-panel';

/** The raw file base on GitHub. */
const RAW_BASE = `https://raw.githubusercontent.com/${PANEL_REPO}/main`;

/**
 * The sources for the agent, in the order they should be tried.
 *
 * Each entry has a `kind` that says how the bytes have to be read:
 *   'raw'    the file as it is
 *   'gzip'   the file gzipped, and gunzipped on arrival
 *   'base64' the file base64-encoded, and decoded on arrival
 *
 * @param {string} panelUrl   the panel's own base URL
 * @param {object} opts
 * @param {string} opts.role   the server's role: 'iran' or 'foreign'
 * @param {boolean} opts.foreignFirst  put the outside-the-country sources first
 */
function agentSources(panelUrl, { role = 'foreign', foreignFirst = null } = {}) {
  const base = String(panelUrl || '').replace(/\/+$/, '');
  const panel = [
    { url: `${base}/agent.js`, kind: 'raw', from: 'panel' },
    { url: `${base}/agent.js.gz`, kind: 'gzip', from: 'panel' },
    { url: `${base}/agent.js.b64`, kind: 'base64', from: 'panel' },
  ];
  const github = [
    { url: `${RAW_BASE}/agent/agent.js`, kind: 'raw', from: 'github' },
    { url: `${RAW_BASE}/agent/agent.js.gz`, kind: 'gzip', from: 'github' },
    { url: `${RAW_BASE}/agent/agent.js.b64`, kind: 'base64', from: 'github' },
  ];

  // The panel host itself is the fastest source for a server in the same
  // country, and the foreign ones are the fastest for everyone else. The
  // role decides unless the caller says otherwise.
  const domestic = role === 'iran' || role === 'relay';
  const outside = foreignFirst === null ? !domestic : foreignFirst === true;
  return outside ? [...github, ...panel] : [...panel, ...github];
}

/**
 * The sources for the one-file installer, in the order they should be tried.
 *
 * The installer itself is a shell script, and a script that is cut in the
 * middle does not fail loudly - it fails at some later line, with an error
 * that points nowhere near the cause. So it is fetched as a whole file and
 * its size is checked before it runs.
 *
 * @param {string} panelUrl
 * @param {object} opts
 */
function installerSources(panelUrl, { role = 'foreign', foreignFirst = null } = {}) {
  const base = String(panelUrl || '').replace(/\/+$/, '');
  const panel = [{ url: `${base}/install-agent.sh`, from: 'panel' }];
  const github = [{ url: `${RAW_BASE}/public/install-agent.sh`, from: 'github' }];
  const domestic = role === 'iran' || role === 'relay';
  const outside = foreignFirst === null ? !domestic : foreignFirst === true;
  return outside ? [...github, ...panel] : [...panel, ...github];
}

/**
 * The shell fragment that turns a source list into a fetch loop.
 *
 * The installer scripts share this so both of them walk the sources the
 * same way: each source is tried in turn, and the first one that produces
 * a complete file wins.
 *
 * @param {Array<{url: string, kind: string}>} sources
 * @param {string} destVar    the shell variable that holds the destination
 * @param {number} minSize    the smallest acceptable size
 * @param {string} fetchFn    the name of the fetch function to call
 * @param {string} decodeFn   the name of the base64 decoder, or ''
 */
function fetchLoopShell(sources, destVar, minSize, fetchFn, decodeFn = '') {
  const lines = [];
  lines.push(`local _src _kind _dest="${destVar}" _ok=0`);
  lines.push(`for _src in ${sources.map((s) => JSON.stringify(s.url)).join(' ')}; do`);
  lines.push('  case "$_src" in');
  lines.push('    *.gz)  _kind=gzip ;;');
  lines.push('    *.b64) _kind=base64 ;;');
  lines.push('    *)     _kind=raw ;;');
  lines.push('  esac');
  lines.push('  info "agent       : trying $_src"');
  lines.push('  rm -f "$_dest" "$_dest.gz" "$_dest.b64" "$_dest.out"');
  lines.push(`  if [ "$_kind" = gzip ]; then`);
  lines.push(`    if ${fetchFn} "$_src" "$_dest.gz" 500 && gunzip -c "$_dest.gz" > "$_dest.out" 2>/dev/null \\`);
  lines.push(`       && [ "$(wc -c < "$_dest.out" 2>/dev/null || echo 0)" -ge ${minSize} ]; then`);
  lines.push('      mv -f "$_dest.out" "$_dest"; _ok=1; break');
  lines.push('    fi');
  lines.push('    rm -f "$_dest.gz" "$_dest.out"');
  lines.push('  elif [ "$_kind" = base64 ]; then');
  lines.push(`    if ${fetchFn} "$_src" "$_dest.b64" 500 && ${decodeFn} "$_dest.b64" > "$_dest.out" 2>/dev/null \\`);
  lines.push(`       && [ "$(wc -c < "$_dest.out" 2>/dev/null || echo 0)" -ge ${minSize} ]; then`);
  lines.push('      mv -f "$_dest.out" "$_dest"; _ok=1; break');
  lines.push('    fi');
  lines.push('    rm -f "$_dest.b64" "$_dest.out"');
  lines.push('  else');
  lines.push(`    if ${fetchFn} "$_src" "$_dest" ${minSize}; then _ok=1; break; fi`);
  lines.push('    rm -f "$_dest"');
  lines.push('  fi');
  lines.push('done');
  lines.push('rm -f "$_dest.gz" "$_dest.b64" "$_dest.out"');
  lines.push('if [ "$_ok" -ne 1 ]; then return 1; fi');
  lines.push('return 0');
  return lines.join('\n');
}

module.exports = {
  PANEL_REPO,
  RAW_BASE,
  agentSources,
  installerSources,
  fetchLoopShell,
};
