'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { findProxyHelper } = require('./ssh');

/**
 * Panel outbound ("internet for the panel").
 *
 * When the Iran server loses its direct international route, the panel can no
 * longer SSH to the foreign servers, so it cannot deploy configs. This module
 * runs a local Xray client (a user-supplied config with a SOCKS inbound) and
 * makes every SSH/SCP the panel performs go through that SOCKS port. The Xray
 * outbound itself can travel over a route that still works (a CDN, another
 * relay, a domestic hop that is allowed out, ...).
 *
 * The config is stored verbatim so the operator can paste exactly what their
 * client uses; only the SOCKS inbound is normalised, because the panel needs to
 * know which local port to point OpenSSH at.
 */

const DEFAULT_PORT = 1081;

const BINARY_CANDIDATES = [
  '/usr/local/x-ui/bin/xray-linux-amd64',
  '/usr/local/bin/xray',
  '/usr/bin/xray',
  '/opt/xray/xray',
  '/root/xray/xray',
];

function findBinary() {
  for (const candidate of BINARY_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

function socksInbound(config, port) {
  const inbounds = Array.isArray(config.inbounds) ? config.inbounds : [];
  const socks = inbounds.find((i) => i && i.protocol === 'socks');
  if (socks) {
    socks.listen = '127.0.0.1';
    socks.port = Number(port);
    socks.settings = { udp: false, ...(socks.settings || {}) };
  } else {
    inbounds.unshift({
      listen: '127.0.0.1',
      port: Number(port),
      protocol: 'socks',
      settings: { udp: false },
    });
  }
  config.inbounds = inbounds;
  return config;
}

/** Probe a local TCP port: resolves true when something accepts there. */
function portOpen(port, timeout = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect({ host: '127.0.0.1', port });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Outbound {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'outbound');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.settingsPath = path.join(this.dir, 'settings.json');
    this.configPath = path.join(this.dir, 'config.json');
    this.logPath = path.join(this.dir, 'xray.log');
    this.child = null;
    this.startedAt = null;
    this.lastError = null;
    this.settings = this.#readSettings();
  }

  #readSettings() {
    const fallback = {
      enabled: false,
      port: DEFAULT_PORT,
      binary: findBinary(),
      config: '',
      updatedAt: null,
    };
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      return { ...fallback, ...raw, port: Number(raw.port) || DEFAULT_PORT };
    } catch {
      return fallback;
    }
  }

  #writeSettings() {
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** The port OpenSSH should use, or null when the proxy is not active. */
  proxyPort() {
    return this.running ? this.settings.port : null;
  }

  status() {
    const b = this.settings.binary || '';
    return {
      enabled: Boolean(this.settings.enabled),
      running: this.running,
      port: this.settings.port,
      binary: b,
      binaryPresent: Boolean(b && fs.existsSync(b)),
      proxyHelper: findProxyHelper(),
      pid: this.child && this.running ? this.child.pid : null,
      since: this.startedAt,
      lastError: this.lastError,
      config: this.settings.config || '',
      logPath: this.logPath,
    };
  }

  /**
   * Validate and store a config without starting it.
   *
   * A wrong JSON body is the operator's mistake, so the caller returns 400 with
   * the parse message instead of pretending the save worked.
   */
  save({ config, port, binary } = {}) {
    const nextPort = Number(port) || this.settings.port || DEFAULT_PORT;
    if (nextPort < 1 || nextPort > 65535) throw new Error('port must be between 1 and 65535');
    let parsed = null;
    if (typeof config === 'string' && config.trim()) {
      try {
        parsed = JSON.parse(config);
      } catch (err) {
        throw new Error(`config is not valid JSON: ${err.message}`);
      }
    }
    if (parsed) socksInbound(parsed, nextPort);
    this.settings = {
      ...this.settings,
      port: nextPort,
      binary: typeof binary === 'string' && binary.trim() ? binary.trim() : this.settings.binary || findBinary(),
      config: parsed ? JSON.stringify(parsed, null, 2) : '',
      updatedAt: new Date().toISOString(),
    };
    this.#writeSettings();
    return this.status();
  }

  async start() {
    if (this.running) return this.status();
    const configText = this.settings.config;
    if (!configText) {
      this.lastError = 'کانفیگی ذخیره نشده';
      throw new Error('ابتدا یک کانفیگ Xray با اینباند SOCKS ذخیره کنید');
    }
    let parsed;
    try {
      parsed = JSON.parse(configText);
    } catch (err) {
      throw new Error(`saved config is not valid JSON: ${err.message}`);
    }
    socksInbound(parsed, this.settings.port);
    fs.writeFileSync(this.configPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });

    const binary = this.settings.binary || findBinary();
    if (!binary || !fs.existsSync(binary)) {
      this.lastError = 'باینری Xray پیدا نشد — مسیر آن را در تنظیمات وارد کنید';
      throw new Error(`باینری Xray پیدا نشد (${binary || 'empty path'}). مسیر آن را در تنظیمات وارد کنید.`);
    }
    // OpenSSH cannot talk SOCKS itself: the ProxyCommand hands off to netcat.
    // Without one, every SSH would fail *after* the operator thought the path
    // was up, so refuse to start and say what to install.
    if (!findProxyHelper()) {
      this.lastError = 'netcat (nc/ncat) روی این سیستم نصب نیست';
      throw new Error('برای رد کردن SSH از پروکسی به netcat نیاز است: apt install -y netcat-openbsd');
    }

    const log = fs.openSync(this.logPath, 'a');
    const child = spawn(binary, ['-c', this.configPath], {
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    this.child = child;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        if (code !== 0) this.lastError = `Xray بسته شد (کد ${code ?? signal}) — لاگ را ببینید`;
      }
    });
    fs.closeSync(log);

    // Wait for the SOCKS listener, so the first SSH after "start" does not race
    // against Xray's own startup.
    for (let i = 0; i < 30; i += 1) {
      if (!this.running) break;
      if (await portOpen(this.settings.port)) {
        this.settings.enabled = true;
        this.#writeSettings();
        return this.status();
      }
      await sleep(200);
    }
    this.lastError = this.running
      ? `Xray اجرا شد ولی چیزی روی 127.0.0.1:${this.settings.port} گوش نمی‌دهد`
      : this.lastError || 'Xray اجرا نشد';
    await this.stop();
    throw new Error(this.lastError);
  }

  /** Stop the process without touching the saved "start on boot" flag. */
  kill() {
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.startedAt = null;
  }

  async stop() {
    this.kill();
    this.settings.enabled = false;
    this.#writeSettings();
    return this.status();
  }

  /** Start on panel boot when the operator left it enabled. */
  async autostart() {
    if (!this.settings.enabled) return;
    if (!this.settings.config) return;
    try {
      await this.start();
      console.log(`  Outbound : 127.0.0.1:${this.settings.port} (panel SSH goes through it)`);
    } catch (err) {
      console.log(`  Outbound : failed to start — ${err.message}`);
    }
  }

  /**
   * The saved settings, for a panel backup.
   *
   * The Xray config is included: it is what makes the path work after a restore,
   * and the backup file is already treated as sensitive (it carries agent
   * tokens too).
   */
  exportSettings() {
    return {
      enabled: Boolean(this.settings.enabled),
      port: this.settings.port,
      binary: this.settings.binary || '',
      config: this.settings.config || '',
    };
  }

  /**
   * Apply settings from a backup.
   *
   * A binary path from another machine is only kept when it exists here;
   * otherwise the local lookup takes over, so a restore does not leave the
   * panel pointing at `/usr/local/bin/xray` on a box that installed it
   * somewhere else.
   */
  importSettings(input = {}) {
    const port = Number(input.port) || DEFAULT_PORT;
    if (port < 1 || port > 65535) throw new Error('پورت خروجی در فایل پشتیبان معتبر نیست');
    let config = '';
    if (typeof input.config === 'string' && input.config.trim()) {
      try {
        JSON.parse(input.config); // validate before anything is written
      } catch (err) {
        throw new Error(`کانفیگ Xray در فایل پشتیبان معتبر نیست: ${err.message}`);
      }
      config = input.config;
    }
    const binary = typeof input.binary === 'string' && input.binary.trim() ? input.binary.trim() : '';
    this.kill();
    this.settings = {
      ...this.settings,
      enabled: false, // never auto-start a restored path; the operator enables it
      port,
      binary: binary && fs.existsSync(binary) ? binary : findBinary(),
      config,
      updatedAt: new Date().toISOString(),
    };
    this.#writeSettings();
    return this.status();
  }

  tailLog(lines = 120) {
    try {
      const content = fs.readFileSync(this.logPath, 'utf8');
      return content.split(/\r?\n/).slice(-Number(lines)).join('\n');
    } catch {
      return '';
    }
  }
}

module.exports = { Outbound, findBinary, DEFAULT_PORT };
