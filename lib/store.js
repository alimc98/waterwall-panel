'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { clone, nowIso, uuid, randomToken } = require('./util');

/**
 * Tiny JSON-file backed store with atomic writes.
 * Everything the panel knows lives under DATA_DIR:
 *   panel.json      panel settings + API token
 *   servers.json    registered WaterWall servers (iran / foreign / any)
 *   tunnels.json    tunnel definitions
 *   events.jsonl    audit log
 */
class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.state = {
      panel: this._load('panel.json', null),
      servers: this._load('servers.json', []),
      tunnels: this._load('tunnels.json', []),
    };
    // Servers written before ordering existed have no `priority`. Number them
    // once in their stored order, so every list the panel already shows keeps
    // its order and a later move only has to swap two numbers.
    let renumbered = false;
    this.state.servers.forEach((server, index) => {
      if (!Number.isFinite(Number(server.priority))) {
        server.priority = index + 1;
        renumbered = true;
      }
    });
    if (renumbered) this.persist('servers');
    if (!this.state.panel) {
      this.state.panel = {
        token: randomToken(24),
        createdAt: nowIso(),
        logLevel: 'info',
      };
      this._save('panel.json', this.state.panel);
    }
  }

  _file(name) {
    return path.join(this.dir, name);
  }

  _load(name, fallback) {
    try {
      const raw = fs.readFileSync(this._file(name), 'utf8');
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  _save(name, value) {
    const target = this._file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
  }

  persist(what) {
    if (what === 'panel') this._save('panel.json', this.state.panel);
    if (what === 'servers') this._save('servers.json', this.state.servers);
    if (what === 'tunnels') this._save('tunnels.json', this.state.tunnels);
  }

  log(event) {
    const entry = { at: nowIso(), id: uuid(), ...event };
    fs.appendFileSync(this._file('events.jsonl'), `${JSON.stringify(entry)}\n`);
    const listeners = this._listeners || [];
    for (const fn of listeners) {
      try {
        fn(entry);
      } catch {
        /* ignore */
      }
    }
    return entry;
  }

  onLog(fn) {
    this._listeners = this._listeners || [];
    this._listeners.push(fn);
  }

  // ---- panel ----------------------------------------------------------
  getPanel() {
    return this.state.panel;
  }

  // ---- servers --------------------------------------------------------
  /**
   * Servers in the operator's order.
   *
   * The order is visible everywhere — the server table, which exit a tunnel
   * pairs with when it only takes one, and the foreign checkbox list — so it
   * is stored rather than derived from creation time. London always coming
   * first was exactly the complaint that added this field.
   */
  listServers() {
    return clone(
      [...this.state.servers].sort(
        (a, b) =>
          (Number(a.priority) || 0) - (Number(b.priority) || 0) ||
          String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
      ),
    );
  }

  getServer(id) {
    return clone(this.state.servers.find((s) => s.id === id) || null);
  }

  addServer(input) {
    const server = {
      id: input.id || uuid(),
      name: input.name || 'server',
      role: ['iran', 'relay', 'foreign'].includes(input.role) ? input.role : 'foreign', // iran | relay | foreign
      host: input.host || '',
      sshPort: Number(input.sshPort) || 22,
      sshUser: input.sshUser || 'root',
      sshKeyPath: input.sshKeyPath || '',
      sshPassword: input.sshPassword || '',
      waterwallPath: input.waterwallPath || '/opt/waterwall',
      serviceName: input.serviceName || 'waterwall',
      agentEnabled: Boolean(input.agentEnabled),
      agentToken: input.agentToken || randomToken(16),
      priority:
        Number.isFinite(Number(input.priority)) && Number(input.priority) > 0
          ? Number(input.priority)
          : this.state.servers.reduce((max, s) => Math.max(max, Number(s.priority) || 0), 0) + 1,
      lastSeen: null,
      lastStatus: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.state.servers.push(server);
    this.persist('servers');
    this.log({ type: 'server.add', serverId: server.id, name: server.name });
    return clone(server);
  }

  updateServer(id, patch) {
    const idx = this.state.servers.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const allowed = [
      'name',
      'role',
      'host',
      'sshPort',
      'sshUser',
      'sshKeyPath',
      'sshPassword',
      'waterwallPath',
      'serviceName',
      'agentEnabled',
      'priority',
    ];
    const current = this.state.servers[idx];
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      if (key === 'role' && !['iran', 'relay', 'foreign'].includes(patch[key])) continue;
      current[key] = patch[key];
    }
    if (patch.sshPort !== undefined) current.sshPort = Number(patch.sshPort) || 22;
    if (patch.priority !== undefined) current.priority = Number(patch.priority) || current.priority;
    current.updatedAt = nowIso();
    this.persist('servers');
    this.log({ type: 'server.update', serverId: id });
    return clone(current);
  }

  /**
   * Swap a server with its neighbour in the visible order.
   *
   * The whole list is renumbered 1..n afterwards: priorities can collide after
   * imports or hand edits, and a swap between two equal numbers would look like
   * a no-op to the operator.
   */
  moveServer(id, direction) {
    const ordered = this.listServers();
    const index = ordered.findIndex((s) => s.id === id);
    if (index === -1) return null;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= ordered.length) return ordered;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    ordered.forEach((server, i) => {
      const stored = this.state.servers.find((s) => s.id === server.id);
      if (stored) stored.priority = i + 1;
    });
    this.persist('servers');
    this.log({ type: 'server.move', serverId: id, direction });
    return this.listServers();
  }

  deleteServer(id) {
    const before = this.state.servers.length;
    this.state.servers = this.state.servers.filter((s) => s.id !== id);
    if (this.state.servers.length !== before) {
      this.persist('servers');
      this.log({ type: 'server.delete', serverId: id });
      return true;
    }
    return false;
  }

  reportStatus(id, status) {
    const server = this.state.servers.find((s) => s.id === id);
    if (!server) return null;
    server.lastSeen = nowIso();
    server.lastStatus = { ...status, at: nowIso() };
    this.persist('servers');
    return clone(server);
  }

  // ---- tunnels --------------------------------------------------------
  listTunnels() {
    return clone(this.state.tunnels);
  }

  getTunnel(id) {
    return clone(this.state.tunnels.find((t) => t.id === id) || null);
  }

  addTunnel(input) {
    const tunnel = {
      id: input.id || uuid(),
      name: input.name || 'tunnel',
      template: input.template || 'tcp-forward',
      notes: input.notes || '',
      enabled: input.enabled !== false,
      options: input.options || {},
      targetServers: input.targetServers || {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.state.tunnels.push(tunnel);
    this.persist('tunnels');
    this.log({ type: 'tunnel.create', tunnelId: tunnel.id, template: tunnel.template });
    return clone(tunnel);
  }

  updateTunnel(id, patch) {
    const tunnel = this.state.tunnels.find((t) => t.id === id);
    if (!tunnel) return null;
    for (const key of ['name', 'notes', 'enabled', 'options', 'targetServers']) {
      if (patch[key] !== undefined) tunnel[key] = patch[key];
    }
    tunnel.updatedAt = nowIso();
    this.persist('tunnels');
    this.log({ type: 'tunnel.update', tunnelId: id });
    return clone(tunnel);
  }

  deleteTunnel(id) {
    const before = this.state.tunnels.length;
    this.state.tunnels = this.state.tunnels.filter((t) => t.id !== id);
    if (this.state.tunnels.length !== before) {
      this.persist('tunnels');
      this.log({ type: 'tunnel.delete', tunnelId: id });
      return true;
    }
    return false;
  }

  // ---- backup ---------------------------------------------------------
  /**
   * Everything needed to stand the panel up on another machine.
   *
   * The API token is deliberately left out: a restored panel must not start
   * answering to a token that was printed into a file the operator may have
   * copied around. Set `WW_PANEL_TOKEN` on the new install to keep the old one.
   * SSH key files are not copied either — only the path the panel expects them
   * at — so a restore on a fresh box still needs the key put in place.
   */
  exportState() {
    return {
      format: 'waterwall-panel-backup',
      version: 1,
      createdAt: nowIso(),
      panel: { logLevel: this.state.panel.logLevel || 'info' },
      // Exported in the operator's order, not the storage order: a restore on a
      // fresh panel must come back with the same exit priority it had before.
      servers: this.listServers(),
      tunnels: clone(this.state.tunnels),
    };
  }

  /**
   * Replace servers and/or tunnels from a backup.
   *
   * Each record is rebuilt field by field rather than copied verbatim, so a
   * hand-edited or older backup cannot inject properties the rest of the panel
   * would then trust (or a role the deployer does not know about).
   */
  importState(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('فایل پشتیبان باید یک آبجکت JSON باشد');
    }
    if (input.format && input.format !== 'waterwall-panel-backup') {
      throw new Error(`فرمت پشتیبان ناشناخته است: ${input.format}`);
    }
    const servers = Array.isArray(input.servers) ? input.servers : null;
    const tunnels = Array.isArray(input.tunnels) ? input.tunnels : null;
    if (!servers && !tunnels) {
      throw new Error('پشتیبان شامل سرور یا تانل نیست');
    }

    if (servers) {
      this.state.servers = servers.map((s, index) => ({
        id: s.id || uuid(),
        name: s.name || 'server',
        role: ['iran', 'relay', 'foreign'].includes(s.role) ? s.role : 'foreign',
        host: s.host || '',
        sshPort: Number(s.sshPort) || 22,
        sshUser: s.sshUser || 'root',
        sshKeyPath: s.sshKeyPath || '',
        sshPassword: s.sshPassword || '',
        waterwallPath: s.waterwallPath || '/opt/waterwall',
        serviceName: s.serviceName || 'waterwall',
        agentEnabled: Boolean(s.agentEnabled),
        agentToken: s.agentToken || randomToken(16),
        priority:
          Number.isFinite(Number(s.priority)) && Number(s.priority) > 0 ? Number(s.priority) : index + 1,
        lastSeen: s.lastSeen || null,
        lastStatus: s.lastStatus || null,
        createdAt: s.createdAt || nowIso(),
        updatedAt: nowIso(),
      }));
      this.persist('servers');
    }

    if (tunnels) {
      this.state.tunnels = tunnels.map((t) => ({
        id: t.id || uuid(),
        name: t.name || 'tunnel',
        template: t.template || 'tcp-forward',
        notes: t.notes || '',
        enabled: t.enabled !== false,
        options: t.options && typeof t.options === 'object' && !Array.isArray(t.options) ? t.options : {},
        targetServers:
          t.targetServers && typeof t.targetServers === 'object' && !Array.isArray(t.targetServers)
            ? t.targetServers
            : {},
        createdAt: t.createdAt || nowIso(),
        updatedAt: nowIso(),
      }));
      this.persist('tunnels');
    }

    const counts = { servers: this.state.servers.length, tunnels: this.state.tunnels.length };
    this.log({ type: 'backup.restore', ...counts });
    return counts;
  }
}

module.exports = { Store };
