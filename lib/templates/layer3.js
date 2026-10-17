'use strict';

const { coreFields, coreOpts, tlsFields, wgKeypair, node, chainConfig, csv } = require('./common');

/**
 * Layer 3 scenarios: TUN devices, in-chain WireGuard, packet<->stream bridges.
 * These carry raw IPv4 packets instead of byte streams.
 */

const j = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

const PACKET_CORE = { mtu: 1280, ramProfile: 'client' };

const tunFields = [
  { key: 'deviceName', group: 'tun', label: 'TUN device name', labelFa: 'نام اینترفیس TUN', type: 'text', default: 'wwtun0', required: true, help: 'TunDevice.settings.device-name — must not collide with an existing interface.' },
  { key: 'deviceIp', group: 'tun', label: 'TUN device IPv4 (CIDR)', labelFa: 'آدرس TUN', type: 'text', default: '10.77.0.1/24', required: true, help: 'TunDevice.settings.device-ip — IPv4 only; IPv6 is rejected.' },
  { key: 'deviceMtu', group: 'tun', label: 'Device MTU', labelFa: 'MTU دستگاه', type: 'number', default: 1280, min: 68, max: 65535, help: 'TunDevice.settings.device-mtu — keep small (1280-1420) for packet tunnels to avoid fragmentation.' },
  { key: 'fragmentPolicy', group: 'tun', label: 'Fragment policy', labelFa: 'سیاست fragmentation', type: 'select', default: 'reassemble', options: ['reassemble', 'preserve-fragments'] },
  {
    key: 'systemRoute',
    group: 'tun',
    label: 'Install system routes (make this a full tunnel)',
    labelFa: 'نصب مسیر سیستمی (تبدیل به تونل کامل)',
    type: 'boolean',
    default: false,
    help:
      'TunDevice.settings.system-route — به‌صورت پیش‌فرض خاموش است، یعنی فقط رابط TUN ساخته می‌شود و جدول مسیریابی سرور دست‌نخورده می‌ماند. با روشن کردن آن، مسیر پیش‌فرض سرور به داخل تونل می‌رود: اگر تونل درست کار نکند، سرور اینترنت و حتی SSH خودش را از دست می‌دهد. آدرس هر دو سرور همیشه و به‌صورت خودکار از این مسیرها مستثنا می‌شود.',
  },
  { key: 'routeCidrs', group: 'tun', label: 'Routed CIDRs', labelFa: 'مسیرهای تونل', type: 'list', default: ['0.0.0.0/0'], help: 'TunDevice.settings.route-cidrs — فقط وقتی «مسیر سیستمی» روشن باشد اعمال می‌شود. مسیر پیش‌فرض به‌صورت دو مسیر /1 نصب می‌شود تا مسیر پیش‌فرض فعلی سرور پاک نشود.' },
  { key: 'routeExcludeCidrs', group: 'tun', label: 'Excluded CIDRs', labelFa: 'مسیرهای مستثنا', type: 'list', default: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], help: 'TunDevice.settings.route-exclude-cidrs — این محدوده‌ها از مسیرهای تونل کنار گذاشته می‌شوند تا مدیریت سرور قطع نشود. آدرس IP هر دو سرور همیشه خودکار اضافه می‌شود.' },
  {
    key: 'tunDns',
    group: 'tun',
    label: 'TUN DNS servers (needs systemd-resolved)',
    labelFa: 'سرورهای DNS روی TUN',
    type: 'list',
    default: [],
    help:
      'TunDevice.settings.dns — روی لینوکس به systemd-resolved و دستور resolvectl نیاز دارد. اگر نصب نباشد هسته با «FATAL TunDevice: could not configure DNS servers» بالا نمی‌آید، پس تا وقتی مطمئن نیستید خالی بگذارید. حداکثر دو آدرس IPv4.',
  },
  { key: 'tunGso', group: 'tun', label: 'GSO (Linux TCPv4)', labelFa: 'GSO', type: 'boolean', default: true, help: 'TunDevice.settings.gso — set false for a pre-created Linux interface.' },
];

/**
 * CIDRs a full-tunnel route must never swallow.
 *
 * A TUN route of 0.0.0.0/0 takes the machine's own traffic with it, including
 * the SSH session being used to manage the box and the WaterWall core's own
 * path to its peer. WaterWall can only pin its own sockets when it installed
 * the route itself, so the operator-visible addresses are excluded here as
 * well, whatever the field happens to say.
 */
function routeExcludes(options) {
  const set = new Set(csv(options.routeExcludeCidrs).filter(Boolean));
  for (const host of [options.iranHost, options.foreignHost]) {
    if (host && /^\d{1,3}(\.\d{1,3}){3}$/.test(String(host))) set.add(`${host}/32`);
  }
  return [...set];
}

function tunNode(options, next) {
  const systemRoute = options.systemRoute === true;
  const dns = csv(options.tunDns).filter(Boolean);
  const settings = {
    'device-name': options.deviceName,
    'device-ip': options.deviceIp,
    'device-mtu': Number(options.deviceMtu) || 1280,
    'fragment-policy': options.fragmentPolicy || 'reassemble',
    gso: options.tunGso !== false,
    'system-route': systemRoute,
  };
  if (systemRoute) {
    settings['route-cidrs'] = csv(options.routeCidrs).filter(Boolean).length ? csv(options.routeCidrs).filter(Boolean) : ['0.0.0.0/0'];
    settings['route-exclude-cidrs'] = routeExcludes(options);
  }
  // Only sent when the operator asked for it: a missing systemd-resolved turns
  // the whole core into a startup failure.
  if (dns.length) settings.dns = dns;
  return node('tun', 'TunDevice', settings, next);
}

// -------------------------------------------------------------------------
const tunWireguard = {
  id: 'tun-wireguard',
  title: 'TUN + WireGuard over UDP',
  titleFa: 'TUN + WireGuard روی UDP',
  category: 'l3',
  categoryFa: 'لایه ۳',
  icon: '🛡️',
  sides: ['iran', 'foreign'],
  summary: 'TunDevice -> WireGuardDevice -> UdpStatelessSocket on both sides — a real IP tunnel, keys and peer state handled in-chain.',
  summaryFa: 'تونل IP واقعی: TUN روی ایران، کریپتوی WireWall داخل چین و UDP استاتیک روی UDP. بدون نیاز به نصب wg-quick.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/WireGuardDevice',
  tags: ['vpn', 'tun', 'wireguard', 'udp'],
  clientHint: 'Configure the Iran box as the default gateway, or use a TUN on your own machine with the foreign settings.',
  ensureOptions(options) {
    const patch = {};
    if (!options.wgIran && !options.wgForeign) {
      const iran = wgKeypair();
      const foreign = wgKeypair();
      patch.wgIran = iran;
      patch.wgForeign = foreign;
    } else if (!options.wgIran) {
      patch.wgIran = wgKeypair();
    } else if (!options.wgForeign) {
      patch.wgForeign = wgKeypair();
    }
    return patch;
  },
  fields: [
    ...tunFields,
    { key: 'publicPort', group: 'wg', label: 'Foreign UDP port', labelFa: 'پورت UDP خارج', type: 'number', default: 51820, min: 1, max: 65535, required: true },
    { key: 'listenAddress', group: 'wg', label: 'UDP bind address (Iran)', labelFa: 'آدرس bind ایران', type: 'text', default: '0.0.0.0' },
    { key: 'iranWgIp', group: 'wg', label: 'Iran WireGuard address', labelFa: 'آدرس وایرگارد ایران', type: 'text', default: '10.77.0.1/32' },
    { key: 'foreignWgIp', group: 'wg', label: 'Foreign WireGuard address', labelFa: 'آدرس وایرگارد خارج', type: 'text', default: '10.77.0.2/32', help: 'TunDevice device-ip on the foreign side. The mask is forced to /24 so the inner subnet stays on-link for reply routing.' },
    { key: 'iranAllowedIps', group: 'wg', label: 'Allowed IPs (Iran side peer)', labelFa: 'Allowed IPs سمت ایران', type: 'text', default: '0.0.0.0/0' },
    { key: 'keepalive', group: 'wg', label: 'Persistent keepalive (s)', labelFa: 'Keepalive', type: 'number', default: 25, min: 0, max: 65535, help: 'WireGuardDevice peers[].persistentkeepalive — 25s is a good value behind NAT.' },
    { key: 'showWgKeys', group: 'wg', label: 'Show generated keys in the preview', labelFa: 'نمایش کلیدها', type: 'boolean', default: true },
    ...coreFields(),
  ],
  build({ options }) {
    const iranWg = options.wgIran;
    const foreignWg = options.wgForeign;
    const iranNodes = [
      // UdpStatelessSocket owns the UDP socket and pushes received datagrams
      // down the chain, so it must be the chain head *and* must have a next:
      //   FATAL UdpStatelessSocket: requires a next node; only chain-head
      //   placement is supported
      // Placing it at the tail (as this template used to) aborts startup.
      node('udp', 'UdpStatelessSocket', { 'listen-address': options.listenAddress || '0.0.0.0', 'listen-port': 0, 'large-send-buffer': true, 'large-recv-buffer': true }, 'wg'),
      node('wg', 'WireGuardDevice', {
        privatekey: iranWg.privateKey,
        peers: [
          {
            publickey: foreignWg.publicKey,
            // Peer selection for outbound packets is a longest-prefix match on
            // the inner destination, and the same list validates the source of
            // inbound decrypted packets. This side carries a whole tunnel, so
            // both directions carry arbitrary addresses: listing the far side's
            // own tunnel IP here silently drops every packet that is not aimed
            // at the far box itself.
            allowedips: options.iranAllowedIps || '0.0.0.0/0',
            endpoint: `${options.foreignHost}:${Number(options.publicPort)}`,
            persistentkeepalive: Number(options.keepalive) || 0,
          },
        ],
      }, 'tun'),
      // TunDevice is both a chain head and a chain end, so it closes the chain.
      tunNode(options),
    ];

    const foreignNodes = [
      node('udp', 'UdpStatelessSocket', { 'listen-address': '0.0.0.0', 'listen-port': Number(options.publicPort), 'large-send-buffer': true, 'large-recv-buffer': true }, 'wg'),
      node('wg', 'WireGuardDevice', {
        privatekey: foreignWg.privateKey,
        peers: [
          {
            publickey: iranWg.publicKey,
            // Inbound validation: the inner source of everything this side
            // decrypts is the Iran TUN address.
            allowedips: `${String(options.deviceIp || options.iranWgIp).split('/')[0]}/32`,
            // The Iran side dials from an ephemeral port and this device
            // replaces the endpoint with the real source of the first
            // authenticated packet; this value only matters for a cold start
            // from this side.
            endpoint: `${options.iranHost}:51820`,
            persistentkeepalive: 0,
          },
        ],
      }, 'tun'),
      node('tun', 'TunDevice', {
        'device-name': 'wwtun0',
        // The mask is pinned to /24: the far kernel needs the inner subnet
        // on-link, otherwise the replies it forwards for the Iran side leave
        // through its default route instead of back into the tunnel.
        'device-ip': `${String(options.foreignWgIp || '10.77.0.2/32').split('/')[0]}/24`,
        'device-mtu': Number(options.deviceMtu) || 1280,
        'system-route': false,
        gso: options.tunGso !== false,
      }),
    ];

    return {
      iran: { core: coreOpts(options, { ...PACKET_CORE, ramProfile: 'client' }), files: { 'configs/tun-wg.json': j(chainConfig('tun-wg-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ...PACKET_CORE, ramProfile: 'server' }), files: { 'configs/tun-wg.json': j(chainConfig('tun-wg-foreign', foreignNodes)) } },
      notes: [
        'UdpStatelessSocket must be a chain head: it cannot have a previous node and must not end with a connector.',
        'WireGuardDevice does the crypto and peer bookkeeping in-process; the OS never sees a wg interface.',
        'Iran peer endpoint is the foreign UDP port; the foreign peer endpoint is only used for reply routing.',
        'The foreign TUN address and the Iran TUN address share one /24 so the far side keeps the return route on-link.',
      ],
      warnings: [
        'UDP must be reachable between the two servers. If UDP is filtered, use the "UDP over TLS" or "TUN over TCP" template instead.',
        'The foreign server has to forward and NAT what comes out of the tunnel, or every connection stalls after the handshake: sysctl -w net.ipv4.ip_forward=1 and a masquerade rule on its public interface. A fresh kernel has forwarding off, and the panel cannot change that for you.',
        'WaterWall forces rp_filter=0 on Linux and does not restore it after exit.',
      ],
      client: options.showWgKeys
        ? {
            links: [{ label: 'Foreign WireGuard config', url: null, text: null }],
            text: `# WaterWall in-chain WireGuard (no wg-quick needed)
# Iran side device: ${options.deviceIp}
[Interface]
PrivateKey = <see configs/tun-wg.json on the Iran server>
Address = ${options.iranWgIp}

[Peer]
PublicKey = ${foreignWg.publicKey}
AllowedIPs = 0.0.0.0/0
Endpoint = ${options.foreignHost}:${options.publicPort}
PersistentKeepalive = ${options.keepalive}`,
            instructions: [
              'The panel generates a fresh key pair per tunnel; re-check the preview after changing anything.',
              'روی سرور خارج یک بار اجرا کنید: sysctl -w net.ipv4.ip_forward=1 و قانون masquerade روی اینترفیس عمومی. بدون آن، تونل وصل می‌شود ولی داده برنمی‌گردد.',
            ],
          }
        : null,
    };
  },
};

// -------------------------------------------------------------------------
const rootlessSocksTcp = {
  id: 'rootless-socks-tcp',
  title: 'Rootless SOCKS5 over TLS (no TUN)',
  titleFa: 'SOCKS5 بدون TUN روی TLS',
  category: 'l3',
  categoryFa: 'لایه ۳',
  icon: '🪶',
  sides: ['iran', 'foreign'],
  summary: 'TcpUdpListener -> Socks5Server -> ConnectionToPackets -> PacketsToStream -> TlsClient -> TcpConnector / TlsServer -> StreamToPackets -> PacketsToConnection -> TcpUdpConnector. A SOCKS5 proxy on the Iran server, no TUN and no root on either side.',
  summaryFa: 'یک SOCKS5 معمولی روی سرور ایران؛ نه TUN لازم است نه root. داخل تونل به بسته‌های IP تبدیل می‌شود و روی TCP/TLS می‌رود، پس فیلتر بودن UDP هم مشکلی ایجاد نمی‌کند.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/ConnectionToPackets',
  tags: ['socks5', 'tcp', 'tls', 'rootless'],
  clientHint: 'Point the client app at socks5://<iran-ip>:<port>; it needs no admin rights and no TUN device.',
  fields: [
    { key: 'listenAddress', group: 'entry', label: 'Iran listen address', labelFa: 'آدرس شنود ایران', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'entry', label: 'SOCKS5 port', labelFa: 'پورت SOCKS5', type: 'number', default: 1080, min: 1, max: 65535, required: true },
    { key: 'socksUdp', group: 'entry', label: 'Enable UDP', labelFa: 'فعال بودن UDP', type: 'boolean', default: true },
    { key: 'socksAdvertiseIp', group: 'entry', label: 'UDP advertise IPv4', labelFa: 'آدرس اعلامی UDP', type: 'text', default: '' },
    { key: 'sourceIp', group: 'advanced', label: 'ConnectionToPackets source IPv4', labelFa: 'آدرس مجازی lwIP', type: 'text', default: '172.19.0.1', required: true, help: 'ConnectionToPackets.settings.source-ipv4 — must not be 0.0.0.0, loopback, multicast or broadcast.' },
    { key: 'tunnelMtu', group: 'advanced', label: 'Tunnel MTU', labelFa: 'MTU تونل', type: 'number', default: 1280, min: 576, max: 65535, help: 'ConnectionToPackets/StreamToPackets recover packet boundaries from the IPv4 total-length field, so keep it conservative.' },
    { key: 'transport', group: 'transport', label: 'Transport security', labelFa: 'لایه انتقال', type: 'select', default: 'tls', options: ['tls', 'encryption'] },
    ...tlsFields({ sni: 'example.com' }),
    { key: 'encryptionPassword', group: 'transport', label: 'Encryption password', labelFa: 'رمز انتقال', type: 'password', default: 'auto:password', when: { transport: 'encryption' } },
    { key: 'encryptionSalt', group: 'transport', label: 'Encryption salt', labelFa: 'Salt انتقال', type: 'text', default: 'ww-panel', when: { transport: 'encryption' } },
    { key: 'publicPort', group: 'transport', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
    { key: 'fakeDns', group: 'dns', label: 'Enable Fake DNS', labelFa: 'فعال بودن Fake DNS', type: 'boolean', default: true },
    { key: 'fakeDnsAddress', group: 'dns', label: 'Fake DNS address', labelFa: 'آدرس Fake DNS', type: 'text', default: '198.18.0.2', when: { fakeDns: true } },
    { key: 'fakeDnsNetwork', group: 'dns', label: 'Fake DNS network', labelFa: 'شبکه Fake DNS', type: 'text', default: '100.64.0.0', when: { fakeDns: true } },
    { key: 'fakeDnsNetmask', group: 'dns', label: 'Fake DNS netmask', labelFa: 'ماسک Fake DNS', type: 'text', default: '255.192.0.0', when: { fakeDns: true } },
    { key: 'validationLevel', group: 'dns', label: 'Packet validation', labelFa: 'اعتبارسنجی پکت', type: 'select', default: 'loose', options: ['none', 'loose', 'hard'], help: 'PacketsToStream/StreamToPackets packet-validation-level. "hard" also verifies IPv4/TCP/UDP checksums.' },
    ...coreFields(),
  ],
  build({ options }) {
    const useTls = options.transport !== 'encryption';
    const socksSettings = { connect: true, udp: options.socksUdp !== false };
    // Inline `users` was removed from Socks5Server in WaterWall 1.46.96 and
    // leaving the node without an explicit auth decision is a startup FATAL.
    // See entrySocks in stream.js; use the `auth-users` template when users
    // really need username/password.
    socksSettings['no-auth'] = true;
    if (options.socksUdp !== false) socksSettings['udp-ipv4'] = options.socksAdvertiseIp || options.iranHost || '127.0.0.1';

    const iranNodes = [
      // With UDP enabled the Socks5Server resolves its dynamic UDP relay from
      // the node in front of it, so the chain head has to be UDP-capable:
      //   FATAL Socks5Server: could not resolve dynamic UDP provider from
      //   preceding UdpListener / TcpUdpListener in chain
      // It never resolves a TCP-side provider beyond its own line, so with UDP
      // off a plain TcpListener is still enough.
      node(
        'local',
        options.socksUdp !== false ? 'TcpUdpListener' : 'TcpListener',
        { address: options.listenAddress, port: Number(options.listenPort), nodelay: true },
        'socks',
      ),
      node('socks', 'Socks5Server', socksSettings, 'bridge'),
      node('bridge', 'ConnectionToPackets', { 'source-ipv4': options.sourceIp, mtu: Number(options.tunnelMtu) || 1280, 'domain-strategy': 'only-ipv4', 'max-pending-bytes': 262144 }, 'p2s'),
      // ConnectionToPackets produces whole IPv4 datagrams; a normal line cannot
      // carry those, so PacketsToStream is the documented bridge to the stream
      // world (and StreamToPackets on the far side brings them back).
      node('p2s', 'PacketsToStream', { 'packet-validation-level': options.validationLevel || 'loose' }, useTls ? 'tls' : 'crypt'),
      node(useTls ? 'tls' : 'crypt', useTls ? 'TlsClient' : 'EncryptionClient', useTls
        ? { sni: options.sni, verify: options.verify !== false, alpns: csv(options.alpns) }
        : { password: options.encryptionPassword, algorithm: 'chacha20-poly1305', salt: options.encryptionSalt, 'kdf-iterations': 12000 }, 'out'),
      node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }),
    ];

    const fakeDns = options.fakeDns !== false
      ? {
          enabled: true,
          address: options.fakeDnsAddress,
          port: 53,
          network: options.fakeDnsNetwork,
          netmask: options.fakeDnsNetmask,
          'cache-size': 10000,
          ttl: 1,
        }
      : false;

    const foreignNodes = [
      node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, useTls ? 'tls' : 'crypt'),
      node(useTls ? 'tls' : 'crypt', useTls ? 'TlsServer' : 'EncryptionServer', useTls
        ? { 'cert-file': options.certPath, 'key-file': options.keyPath, sni: options.sni, 'min-version': options.tlsMinVersion, 'max-version': options.tlsMaxVersion }
        : { password: options.encryptionPassword, algorithm: 'chacha20-poly1305', salt: options.encryptionSalt, 'kdf-iterations': 12000 }, 's2p'),
      node('s2p', 'StreamToPackets', { 'packet-validation-level': options.validationLevel || 'loose' }, 'ptc'),
      node('ptc', 'PacketsToConnection', { 'udp-idle-timeout-ms': 300000, 'max-pending-bytes': 262144, 'fake-dns': fakeDns }, 'out'),
      node('out', 'TcpUdpConnector', { address: 'dest_context->address', port: 'dest_context->port', nodelay: true, 'domain-strategy': 'prefer-ipv4' }),
    ];

    return {
      iran: { core: coreOpts(options, { mtu: Number(options.tunnelMtu) || 1280, ramProfile: 'client' }), files: { 'configs/rootless-tcp.json': j(chainConfig('rootless-tcp-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { mtu: Number(options.tunnelMtu) || 1280, ramProfile: 'server' }), files: { 'configs/rootless-tcp.json': j(chainConfig('rootless-tcp-foreign', foreignNodes)) } },
      client: {
        links: [{ label: 'SOCKS5 (روی سرور ایران)', url: `socks5://${options.iranHost}:${options.listenPort}` }],
        instructions: [
          'نرم‌افزار خود را روی SOCKS5 تنظیم کنید؛ نیازی به TUN یا دسترسی root نیست.',
          'Fake-DNS روی سرور خارج فعال است تا DNS داخل تونل ر resolving اشتباه نداشته باشد.',
        ],
      },
      warnings: [
        'ConnectionToPackets and PacketsToConnection require complete IPv4 datagrams — IP fragmentation is a fatal exit. Keep MTU at 1280.',
        'This pair does not install any OS route on the Iran side; it is a per-connection tunnel.',
        'TCP-based tunnels suffer from head-of-line blocking; upload and download share one connection.',
        ...(useTls ? [`A TLS certificate must already exist on the foreign server at ${options.certPath} / ${options.keyPath}.`] : []),
      ],
      notes: [
        'ConnectionToPackets turns each SOCKS connection into IPv4 packets, and PacketsToStream frames them onto one ordinary TCP/TLS line; the far side reverses that with StreamToPackets.',
        'fake-dns is configured on PacketsToConnection (foreign side).',
      ],
    };
  },
};

// -------------------------------------------------------------------------
const tunTcpTunnel = {
  id: 'tun-tcp-tunnel',
  title: 'Full IP tunnel over TCP (TUN → TLS)',
  titleFa: 'تونل کامل IP روی TCP (TUN → TLS)',
  category: 'l3',
  categoryFa: 'لایه ۳',
  icon: '🛣️',
  sides: ['iran', 'foreign'],
  summary: 'TunDevice -> PacketsToStream -> TlsClient -> TcpConnector  /  TlsServer -> StreamToPackets -> PacketsToConnection -> TcpUdpConnector',
  summaryFa: 'تونل کامل IP روی یک اتصال TCP/TLS؛ وقتی UDP بین دو سرور فیلتر است به کار می‌آید. روی سرور خارج Fake-DNS فعال می‌شود.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/PacketsToStream',
  tags: ['vpn', 'tun', 'tcp', 'tls'],
  fields: [
    { key: 'deviceName', group: 'tun', label: 'TUN device name', labelFa: 'نام TUN', type: 'text', default: 'wwtun0', required: true },
    { key: 'deviceIp', group: 'tun', label: 'TUN IPv4 (CIDR)', labelFa: 'آدرس TUN', type: 'text', default: '10.66.0.1/24', required: true },
    { key: 'deviceMtu', group: 'tun', label: 'MTU', labelFa: 'MTU', type: 'number', default: 1280, min: 576, max: 65535, help: 'PacketsToStream recovers boundaries from the IPv4 total-length field, so keep MTU conservative.' },
    { key: 'transport', group: 'transport', label: 'Transport security', labelFa: 'لایه انتقال', type: 'select', default: 'tls', options: ['tls', 'encryption'] },
    ...tlsFields({ sni: 'example.com' }),
    { key: 'encryptionPassword', group: 'transport', label: 'Encryption password', labelFa: 'رمز انتقال', type: 'password', default: 'auto:password', when: { transport: 'encryption' } },
    { key: 'encryptionSalt', group: 'transport', label: 'Encryption salt', labelFa: 'Salt انتقال', type: 'text', default: 'ww-panel', when: { transport: 'encryption' } },
    { key: 'publicPort', group: 'transport', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
    { key: 'fakeDns', group: 'dns', label: 'Enable Fake DNS', labelFa: 'فعال بودن Fake DNS', type: 'boolean', default: true },
    { key: 'fakeDnsAddress', group: 'dns', label: 'Fake DNS address', labelFa: 'آدرس Fake DNS', type: 'text', default: '198.18.0.2', when: { fakeDns: true } },
    { key: 'fakeDnsNetwork', group: 'dns', label: 'Fake DNS network', labelFa: 'شبکه Fake DNS', type: 'text', default: '100.64.0.0', when: { fakeDns: true } },
    { key: 'fakeDnsNetmask', group: 'dns', label: 'Fake DNS netmask', labelFa: 'ماسک Fake DNS', type: 'text', default: '255.192.0.0', when: { fakeDns: true } },
    { key: 'validationLevel', group: 'dns', label: 'Packet validation', labelFa: 'اعتبارسنجی پکت', type: 'select', default: 'loose', options: ['none', 'loose', 'hard'], help: 'PacketsToStream/StreamToPackets packet-validation-level. "hard" also verifies IPv4/TCP/UDP checksums.' },
    {
      key: 'routeAllTraffic',
      group: 'tun',
      label: 'Route all server traffic through the tunnel',
      labelFa: 'عبور همه ترافیک سرور از تونل',
      type: 'boolean',
      default: false,
      help:
        'به‌صورت پیش‌فرض خاموش است: رابط TUN و تونل ساخته می‌شوند ولی جدول مسیریابی سرور تغییر نمی‌کند (TunDevice پیش‌فرض system-route=false). با روشن کردن آن مسیر پیش‌فرض سرور به داخل تونل می‌رود؛ اگر تونل قطع یا اشتباه تنظیم شود، سرور اینترنت و SSH خودش را از دست می‌دهد. آدرس هر دو سرور خودکار مستثنا می‌شود، ولی همچنان ریسک دارد.',
    },
    {
      key: 'tunDns',
      group: 'tun',
      label: 'TUN DNS servers (needs systemd-resolved)',
      labelFa: 'سرورهای DNS روی TUN',
      type: 'list',
      default: [],
      when: { routeAllTraffic: true },
      help: 'TunDevice.settings.dns — روی لینوکس به systemd-resolved و resolvectl نیاز دارد؛ در غیر این صورت هسته بالا نمی‌آید. خالی بگذارید تا از DNS فعلی سرور استفاده شود.',
    },
    ...coreFields(),
  ],
  build({ options }) {
    const useTls = options.transport !== 'encryption';
    const security = {
      settings: {
        ...(useTls
          ? { sni: options.sni, verify: options.verify !== false, alpns: csv(options.alpns) }
          : { password: options.encryptionPassword, algorithm: 'chacha20-poly1305', salt: options.encryptionSalt, 'kdf-iterations': 12000 }),
      },
    };

    // The template used to hardcode `system-route: true` with a 0.0.0.0/0 route
    // and only the RFC1918 ranges excluded. That silently redirects *all*
    // server traffic into the tunnel — including the SSH session in use — and
    // if the tunnel then fails the box is unreachable until the service is
    // stopped. Routing is therefore opt-in, and the two server addresses are
    // always excluded when it is on.
    const routeAll = options.routeAllTraffic === true;
    const tunSettings = {
      'device-name': options.deviceName,
      'device-ip': options.deviceIp,
      'device-mtu': Number(options.deviceMtu) || 1280,
      'fragment-policy': 'reassemble',
      gso: true,
      'system-route': routeAll,
    };
    if (routeAll) {
      tunSettings['route-cidrs'] = ['0.0.0.0/0'];
      tunSettings['route-exclude-cidrs'] = routeExcludes(options);
    }
    const tunDns = csv(options.tunDns).filter(Boolean);
    if (routeAll && tunDns.length) tunSettings.dns = tunDns;

    const iranNodes = [
      node('tun', 'TunDevice', tunSettings, 'p2s'),
      node('p2s', 'PacketsToStream', { 'packet-validation-level': options.validationLevel || 'loose' }, useTls ? 'tls' : 'crypt'),
      node(useTls ? 'tls' : 'crypt', useTls ? 'TlsClient' : 'EncryptionClient', security.settings, 'out'),
      node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }),
    ];

    const foreignNodes = [
      node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, useTls ? 'tls' : 'crypt'),
      node(useTls ? 'tls' : 'crypt', useTls ? 'TlsServer' : 'EncryptionServer', useTls
        ? { 'cert-file': options.certPath, 'key-file': options.keyPath, sni: options.sni, 'min-version': options.tlsMinVersion, 'max-version': options.tlsMaxVersion }
        : security.settings, 's2p'),
      node('s2p', 'StreamToPackets', { 'packet-validation-level': options.validationLevel || 'loose' }, 'ptc'),
      node('ptc', 'PacketsToConnection', {
        'udp-idle-timeout-ms': 300000,
        'max-pending-bytes': 262144,
        'fake-dns': options.fakeDns !== false
          ? { enabled: true, address: options.fakeDnsAddress, port: 53, network: options.fakeDnsNetwork, netmask: options.fakeDnsNetmask, 'cache-size': 10000, ttl: 1 }
          : false,
      }, 'out'),
      node('out', 'TcpUdpConnector', { address: 'dest_context->address', port: 'dest_context->port', nodelay: true, 'domain-strategy': 'prefer-ipv4' }),
    ];

    return {
      iran: { core: coreOpts(options, { mtu: Number(options.deviceMtu) || 1280, ramProfile: 'client' }), files: { 'configs/tun-tcp.json': j(chainConfig('tun-tcp-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { mtu: Number(options.deviceMtu) || 1280, ramProfile: 'server' }), files: { 'configs/tun-tcp.json': j(chainConfig('tun-tcp-foreign', foreignNodes)) } },
      warnings: [
        'TCP-based IP tunnels suffer from head-of-line blocking; the same throughput path is used for upload and download.',
        'Set the TUN MTU to 1280-1400 because TCP adds its own headers on top of the tunnel.',
      ],
      notes: [
        'PacketsToStream reads the IPv4 total-length field to recover packet boundaries.',
        'The foreign side terminates packets into normal connection lines with PacketsToConnection, then TcpUdpConnector honours dest_context.',
      ],
    };
  },
};

module.exports = [tunWireguard, rootlessSocksTcp, tunTcpTunnel];
