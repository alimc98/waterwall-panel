'use strict';

const { coreFields, coreOpts, destFields, listenFields, node, chainConfig } = require('./common');

/**
 * Layer 4 relays: plain forward, encrypted forward, obfuscated forward.
 * Iran side = entry (listener), foreign side = exit (connector).
 */

const j = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

const tcpForward = {
  id: 'tcp-forward',
  title: 'TCP Port Forward',
  titleFa: 'فی-forward ساده TCP',
  category: 'basic',
  categoryFa: 'پایه',
  icon: '🔌',
  sides: ['iran', 'foreign'],
  summary: 'TcpListener -> TcpConnector — the simplest WaterWall chain.',
  summaryFa: 'زنجیره TcpListener -> TcpConnector؛ ساده‌ترین حالت واتروال. یک پورت TCP در سمت ایران به مقصدی در سمت خارج وصل می‌شود.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/getting-started/tutorial-part3',
  tags: ['tcp', 'forward', 'relay'],
  clientHint: 'Clients connect straight to the Iran-side port (raw TCP relay, no client protocol).',
  fields: [
    ...listenFields({ listenAddress: '0.0.0.0', listenPort: 8080 }),
    ...destFields({ destAddress: 'example.com', destPort: 80 }),
    {
      key: 'whitelist',
      group: 'advanced',
      label: 'Whitelist (IPs / CIDRs)',
      labelFa: 'لیست سفید',
      type: 'list',
      default: [],
      help: 'TcpListener.settings.whitelist — leave empty to allow everyone.',
    },
    {
      key: 'blacklist',
      group: 'advanced',
      label: 'Blacklist (IPs / CIDRs)',
      labelFa: 'لیست سیاه',
      type: 'list',
      default: [],
    },
    {
      key: 'initialIdleTimeoutMs',
      group: 'advanced',
      label: 'Initial idle timeout (ms)',
      labelFa: 'تایم‌اوت اولیه',
      type: 'number',
      default: 60000,
      min: 1,
    },
    {
      key: 'activeIdleTimeoutMs',
      group: 'advanced',
      label: 'Active idle timeout (ms)',
      labelFa: 'تایم‌اوت فعال',
      type: 'number',
      default: 600000,
      min: 1,
    },
    ...coreFields(),
  ],
  build({ options }) {
    const strategy = options._core?.domainStrategy || 'prefer-ipv4';
    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: {
          'configs/tcp-forward.json': j(
            chainConfig('tcp-forward-iran', [
              node(
                'entry',
                'TcpListener',
                {
                  address: options.listenAddress,
                  port: Number(options.listenPort),
                  nodelay: options.nodelay !== false,
                  whitelist: options.whitelist?.length ? options.whitelist : undefined,
                  blacklist: options.blacklist?.length ? options.blacklist : undefined,
                  'initial-idle-timeout-ms': Number(options.initialIdleTimeoutMs) || 60000,
                  'active-idle-timeout-ms': Number(options.activeIdleTimeoutMs) || 600000,
                },
                'exit',
              ),
              node('exit', 'TcpConnector', {
                address: options.destAddress,
                port: Number(options.destPort),
                nodelay: true,
                'domain-strategy': strategy,
              }),
            ]),
          ),
        },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/tcp-forward.json': j(
            chainConfig('tcp-forward-foreign', [
              node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.destPort) }, 'fwd'),
              node('fwd', 'TcpConnector', { address: options.destAddress, port: Number(options.destPort) }),
            ]),
          ),
        },
      },
      notes: [
        `Iran listens on ${options.listenAddress}:${options.listenPort}`,
        `Foreign relays ${options.destAddress}:${options.destPort}`,
      ],
      warnings: ['A raw TCP forward is unencrypted. Put an Encryption/TLS node in front of it if traffic leaves your LAN.'],
    };
  },
};

const udpForward = {
  id: 'udp-forward',
  title: 'UDP Forward',
  titleFa: 'فی-forward ساده UDP',
  category: 'basic',
  categoryFa: 'پایه',
  icon: '📡',
  sides: ['iran', 'foreign'],
  summary: 'UdpListener -> UdpConnector — stateful UDP relay, one line per remote peer.',
  summaryFa: 'زنجیره UdpListener -> UdpConnector؛ رله UDP حالت‌دار با یک خط به ازای هر peer.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/UdpListener',
  tags: ['udp'],
  clientHint: 'Send UDP datagrams to the Iran-side port; they are relayed to the destination.',
  fields: [
    { key: 'listenAddress', group: 'listen', label: 'Listen address', labelFa: 'آدرس شنود', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'listen', label: 'Listen port', labelFa: 'پورت شنود', type: 'number', default: 5353, min: 1, max: 65535, required: true },
    ...destFields({ destAddress: '1.1.1.1', destPort: 53 }),
    ...coreFields(),
  ],
  build({ options }) {
    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: {
          'configs/udp-forward.json': j(
            chainConfig('udp-forward-iran', [
              node('entry', 'UdpListener', { address: options.listenAddress, port: Number(options.listenPort) }, 'out'),
              node('out', 'UdpConnector', { address: options.destAddress, port: Number(options.destPort) }),
            ]),
          ),
        },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/udp-forward.json': j(
            chainConfig('udp-forward-foreign', [
              node('public', 'UdpListener', { address: '0.0.0.0', port: Number(options.destPort) }, 'out'),
              node('out', 'UdpConnector', { address: options.destAddress, port: Number(options.destPort) }),
            ]),
          ),
        },
      },
      notes: ['UdpListener is stateful: one line is kept per remote peer (~30s idle for new peers).'],
    };
  },
};

const tcpUdpForward = {
  id: 'tcp-udp-forward',
  title: 'TCP + UDP Forward',
  titleFa: 'فی-forward همزمان TCP و UDP',
  category: 'basic',
  categoryFa: 'پایه',
  icon: '🔀',
  sides: ['iran', 'foreign'],
  summary: 'TcpUdpListener -> TcpUdpConnector — one port number serving both TCP and UDP.',
  summaryFa: 'زنجیره TcpUdpListener -> TcpUdpConnector؛ یک شماره پورت برای TCP و UDP با هم.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/TcpUdpListener',
  tags: ['tcp', 'udp'],
  fields: [
    { key: 'listenAddress', group: 'listen', label: 'Listen address', labelFa: 'آدرس شنود', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'listen', label: 'Listen port', labelFa: 'پورت شنود', type: 'number', default: 443, min: 1, max: 65535, required: true },
    ...destFields({ destAddress: 'example.com', destPort: 443 }),
    ...coreFields(),
  ],
  build({ options }) {
    const strategy = options._core?.domainStrategy || 'prefer-ipv4';
    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: {
          'configs/tcp-udp.json': j(
            chainConfig('tcp-udp-iran', [
              node('entry', 'TcpUdpListener', { address: options.listenAddress, port: Number(options.listenPort), nodelay: true }, 'out'),
              node('out', 'TcpUdpConnector', {
                address: options.destAddress,
                port: Number(options.destPort),
                nodelay: true,
                'domain-strategy': strategy,
              }),
            ]),
          ),
        },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/tcp-udp.json': j(
            chainConfig('tcp-udp-foreign', [
              node('public', 'TcpUdpListener', { address: '0.0.0.0', port: Number(options.listenPort), nodelay: true }, 'out'),
              node('out', 'TcpUdpConnector', { address: options.destAddress, port: Number(options.destPort) }),
            ]),
          ),
        },
      },
      notes: ['TcpUdpListener wraps an internal TcpListener + UdpListener on the same port. It is not a protocol converter.'],
    };
  },
};

const encryptedTcp = {
  id: 'encrypted-tcp',
  title: 'Encrypted TCP Tunnel (AEAD)',
  titleFa: 'تونل رمزنگاری‌شده TCP (AEAD)',
  category: 'basic',
  categoryFa: 'پایه',
  icon: '🔐',
  sides: ['iran', 'foreign'],
  summary: 'EncryptionClient / EncryptionServer with a shared password — server-to-server AEAD framing, TLS-like records.',
  summaryFa: 'رمزنگاری AEAD با رمز مشترک بین دو سرور؛ ترافیک بین ایران و خارج برای دیگران خوانا نیست.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/EncryptionClient',
  tags: ['tcp', 'encrypted', 'aead'],
  clientHint: 'Any TCP client can use the Iran-side port; encryption happens server-to-server.',
  fields: [
    { key: 'listenAddress', group: 'listen', label: 'Iran listen address', labelFa: 'آدرس شنود ایران', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'listen', label: 'Iran listen port', labelFa: 'پورت شنود ایران', type: 'number', default: 8080, min: 1, max: 65535, required: true },
    { key: 'publicPort', group: 'listen', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
    ...destFields({ destAddress: 'example.com', destPort: 80 }),
    {
      key: 'algorithm',
      group: 'crypto',
      label: 'Algorithm',
      labelFa: 'الگوریتم',
      type: 'select',
      default: 'chacha20-poly1305',
      options: ['chacha20-poly1305', 'chacha20poly1305', 'chacha20', 'aes-256-gcm', 'aes-128-gcm', 'aes256gcm'],
    },
    { key: 'password', group: 'crypto', label: 'Shared password', labelFa: 'رمز مشترک', type: 'password', default: 'auto:password', required: true },
    { key: 'salt', group: 'crypto', label: 'Salt', labelFa: 'Salt', type: 'text', default: 'ww-panel', help: 'Default in WaterWall is "waterwall-encryption". Must be identical on both sides.' },
    { key: 'kdfIterations', group: 'crypto', label: 'KDF iterations', labelFa: 'تکرار KDF', type: 'number', default: 12000, min: 1, max: 1000000 },
    { key: 'maxFrameSize', group: 'crypto', label: 'Max frame size', labelFa: 'حداکثر اندازه فریم', type: 'number', default: 16356, min: 1, max: 16356 },
    ...coreFields(),
  ],
  build({ options }) {
    const crypto = {
      password: options.password,
      algorithm: options.algorithm,
      salt: options.salt,
      'kdf-iterations': Number(options.kdfIterations) || 12000,
      'max-frame-size': Number(options.maxFrameSize) || 16356,
    };
    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: {
          'configs/encrypted.json': j(
            chainConfig('encrypted-tcp-iran', [
              node('entry', 'TcpListener', { address: options.listenAddress, port: Number(options.listenPort), nodelay: true }, 'crypt'),
              node('crypt', 'EncryptionClient', crypto, 'out'),
              node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }),
            ]),
          ),
        },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/encrypted.json': j(
            chainConfig('encrypted-tcp-foreign', [
              node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, 'decrypt'),
              node('decrypt', 'EncryptionServer', crypto, 'out'),
              node('out', 'TcpConnector', { address: options.destAddress, port: Number(options.destPort), nodelay: true }),
            ]),
          ),
        },
      },
      warnings: ['EncryptionClient and EncryptionServer settings must match exactly: algorithm, password, salt and kdf-iterations.'],
      notes: [
        `Iran listens on ${options.listenAddress}:${options.listenPort}`,
        `Foreign listens on 0.0.0.0:${options.publicPort} → ${options.destAddress}:${options.destPort}`,
        'Record format: 5-byte TLS-like header, 12-byte nonce, 16-byte tag, max 16356 bytes plaintext.',
      ],
    };
  },
};

const xorObfuscated = {
  id: 'xor-obfuscated',
  title: 'XOR Obfuscated TCP',
  titleFa: 'تونل مبهم‌سازی‌شده XOR',
  category: 'basic',
  categoryFa: 'پایه',
  icon: '🫥',
  sides: ['iran', 'foreign'],
  summary: 'ObfuscatorClient / ObfuscatorServer with method "xor" — lightweight obfuscation, NOT encryption.',
  summaryFa: 'لایه Obfuscator با متد xor؛ فقط الگوها را مبهم می‌کند و رمزنگاری واقعی نیست.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/ObfuscatorClient',
  tags: ['tcp', 'obfuscation'],
  clientHint: 'Any TCP client can use the Iran-side port.',
  fields: [
    { key: 'listenAddress', group: 'listen', label: 'Iran listen address', labelFa: 'آدرس شنود ایران', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'listen', label: 'Iran listen port', labelFa: 'پورت شنود ایران', type: 'number', default: 8080, min: 1, max: 65535, required: true },
    { key: 'publicPort', group: 'listen', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
    ...destFields({ destAddress: 'example.com', destPort: 80 }),
    { key: 'xorKey', group: 'crypto', label: 'XOR key (0-255)', labelFa: 'کلید XOR', type: 'number', default: 173, min: 0, max: 255, required: true },
    {
      key: 'skip',
      group: 'crypto',
      label: 'Skip mode',
      labelFa: 'حالت skip',
      type: 'select',
      default: 'none',
      options: ['none', 'ipv4', 'transport'],
    },
    { key: 'tlsRecordHeader', group: 'crypto', label: 'Fake TLS record header', labelFa: 'هدر جعلی TLS', type: 'boolean', default: true },
    ...coreFields(),
  ],
  build({ options }) {
    const obfs = {
      method: 'xor',
      xor_key: Number(options.xorKey) || 0,
      skip: options.skip || 'none',
      tls_record_header: options.tlsRecordHeader !== false,
    };
    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: {
          'configs/obfs.json': j(
            chainConfig('xor-obfs-iran', [
              node('entry', 'TcpListener', { address: options.listenAddress, port: Number(options.listenPort), nodelay: true }, 'obfs'),
              node('obfs', 'ObfuscatorClient', obfs, 'out'),
              node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }),
            ]),
          ),
        },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/obfs.json': j(
            chainConfig('xor-obfs-foreign', [
              node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, 'deobfs'),
              node('deobfs', 'ObfuscatorServer', obfs, 'out'),
              node('out', 'TcpConnector', { address: options.destAddress, port: Number(options.destPort), nodelay: true }),
            ]),
          ),
        },
      },
      warnings: ['Obfuscation hides patterns but does not encrypt. Add Encryption* or Tls* for real protection.'],
    };
  },
};

module.exports = [tcpForward, udpForward, tcpUdpForward, encryptedTcp, xorObfuscated];
