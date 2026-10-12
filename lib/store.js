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
  listServers() {
    return clone(this.state.servers);
  }

  getServer(id) {
    return clone(this.state.servers.find((s) => s.id === id) || null);
  }

  addServer(input) {
    const server = {
      id: input.id || uuid(),
      name: input.name || 'server',
      role: input.role || 'foreign', // iran | foreign
      host: input.host || '',
      sshPort: Number(input.sshPort) || 22,
      sshUser: input.sshUser || 'root',
      sshKeyPath: input.sshKeyPath || '',
      sshPassword: input.sshPassword || '',
      waterwallPath: input.waterwallPath || '/opt/waterwall',
      serviceName: input.serviceName || 'waterwall',
      agentEnabled: Boolean(input.agentEnabled),
      agentToken: input.agentToken || randomToken(16),
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
    ];
    const current = this.state.servers[idx];
    for (const key of allowed) {
      if (patch[key] !== undefined) current[key] = patch[key];
    }
    if (patch.sshPort !== undefined) current.sshPort = Number(patch.sshPort) || 22;
    current.updatedAt = nowIso();
    this.persist('servers');
    this.log({ type: 'server.update', serverId: id });
    return clone(current);
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
}

module.exports = { Store };
