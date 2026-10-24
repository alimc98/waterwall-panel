'use strict';

const { CERT_PATH, KEY_PATH } = require('../certs');

const {coreFields, coreOpts, listenPorts, node, peerCidrs, realityFields} = require('./common');
const { emitConfig } = require('../generator');

/**
 * Reverse tunnel where the link between the two servers is protected with
 * Reality instead of a real certificate.
 *
 * The foreign box performs a genuine TLS handshake with a real website (the
 * camouflage destination) and only then does the Reality layer take over. The
 * Iran box therefore needs no certificate at all, and to a network observer the
 * inter-server link looks like an ordinary HTTPS visit to that website.
 *
 * Topology (same as reverse-tls, with Reality in place of TlsClient/TlsServer):
 *
 *   Iran     users_inbound ─┐
 *                           ├─ Bridge ⇄ Bridge ─ reverse_server ─ reality-server ─┐
 *   whitelisted inbound ────┘                                                   │
 *                                    dest-visitor ◄─────────────────────────────┘
 *
 *   Foreign  reverse_client ─ reality-client ─ tcp_to_iran
 *              └─ Bridge ⇄ Bridge ─ outbound_to_local_service
 */

const emit = (config, options) => emitConfig(config, { useVariables: options.useVariables !== false });

/** Replace concrete values with @name sentinels that emitConfig turns into $name$. */
function withVarSentinels(nodes, rules, enabled = true) {
  if (!enabled) return nodes;
  return nodes.map((n) => {
    const copy = JSON.parse(JSON.stringify(n));
    const fn = rules[copy.name];
    if (fn) fn(copy);
    return copy;
  });
}

const reverseReality = {
  id: 'reverse-reality',
  title: 'Reverse Tunnel over Reality',
  titleFa: 'تونل معکوس با Reality',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '👻',
  sides: ['iran', 'foreign'],
  listenPorts: listenPorts({
    iran: ['userPort', 'reversePort'],
    foreign: [],
    relay: [],
    pairs: [['userPort', 'reversePort']],
  }),
  summary:
    'Iran: TcpListener(whitelist) -> RealityServer -> ReverseServer -> Bridge ⇄ Bridge <- TcpListener(users), plus a visitor branch to a real site. Foreign: TcpConnector -> RealityClient -> ReverseClient -> Bridge ⇄ Bridge -> TcpConnector(local service).',
  summaryFa:
    'همان تونل معکوس، ولی لینک بین دو سرور با Reality محافظت می‌شود. سرور خارج یک دست‌دادن TLS واقعی با یک سایت واقعی انجام می‌دهد و لایه Reality فقط بعد از آن فعال می‌شود؛ بنابراین روی سرور ایران هیچ گواهی لازم نیست و برای ناظر شبکه، لینک شبیه یک بازدید HTTPS عادی از آن سایت به نظر می‌رسد.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/RealityServer',
  tags: ['reverse', 'reality', 'bridge', 'stealth', 'no-cert'],
  // Reverse entries accept any number of exits; each one runs this same
  // foreign config and joins the ReverseServer pool.
  multiExit: true,
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی ترافیک آن‌ها سرویس محلی روی سرور خارج است.',
  fields: [
    {
      key: 'userPort',
      group: 'entry',
      label: 'User-facing port (Iran)',
      labelFa: 'پورت کاربران (ایران)',
      type: 'number',
      default: 443,
      min: 1,
      max: 65535,
      required: true,
      help: 'users_inbound — کاربران به این پورت وصل می‌شوند.',
    },
    {
      key: 'reversePort',
      group: 'entry',
      label: 'Reverse link port (Iran)',
      labelFa: 'پورت لینک معکوس (ایران)',
      type: 'number',
      default: 443,
      min: 1,
      max: 65535,
      help: 'germany_reverse_tls_inbound — سرور خارج به این پورت وصل می‌شود.',
    },
    {
      key: 'samePort',
      group: 'entry',
      label: 'Same port for both listeners',
      labelFa: 'یک پورت برای هر دو شنونده',
      type: 'boolean',
      default: true,
      help: 'وقتی روشن است، پورت لینک معکوس برابر پورت کاربران می‌شود. واتروال شنونده‌های دارای whitelist را اولویت قرار می‌دهد، پس هر دو روی یک پورت کار می‌کنند.',
    },
    {
      key: 'whitelist',
      group: 'entry',
      label: 'Reverse-link whitelist',
      labelFa: 'لیست سفید لینک معکوس',
      type: 'list',
      default: [],
      help: 'فقط این IPها/CIDRها اجازه ورود به لینک معکوس را دارند. خالی بگذارید تا IP سرور خارج به‌صورت /32 خودکار استفاده شود.',
    },
    {
      key: 'userTlsTermination',
      group: 'entry',
      label: 'Terminate TLS for users too',
      labelFa: 'خاتمه TLS برای کاربران',
      type: 'boolean',
      default: false,
      help: 'اگر روشن باشد یک TlsServer دوم بین users_inbound و Bridge قرار می‌گیرد تا اتصال کاربران هم TLS باشد. برای خود لینک بین سرورها لازم نیست.',
    },
    {
      key: 'listenAddress',
      group: 'entry',
      label: 'Bind address (Iran)',
      labelFa: 'آدرس bind (ایران)',
      type: 'text',
      default: '0.0.0.0',
    },
    {
      key: 'minimumUnused',
      group: 'reverse',
      label: 'Minimum held connections',
      labelFa: 'حداقل اتصال نگه‌داشته‌شده',
      type: 'number',
      default: 8,
      min: 1,
      required: true,
      help: 'ReverseClient.minimum-unused — تعداد اتصال زنده‌ای که سرور خارج برای لینک معکوس نگه می‌دارد. ۸ مقدار خوبی است.',
    },
    {
      key: 'reverseSecret',
      group: 'reverse',
      label: 'Shared reverse secret',
      labelFa: 'رمز مشترک لینک',
      type: 'password',
      default: '',
      help: 'اختیاری. اگر پر شود، در ReverseClient و ReverseServer هر دو قرار می‌گیرد و باید یکسان باشد.',
    },
    {
      key: 'localServiceAddress',
      group: 'service',
      label: 'Local service address (foreign)',
      labelFa: 'آدرس سرویس محلی (خارج)',
      type: 'text',
      default: '127.0.0.1',
      help: 'خروجی ترافیک کاربران به این آدرس روی سرور خارج می‌رود (مثلاً یک xray محلی).',
    },
    {
      key: 'finalPort',
      group: 'service',
      label: 'Local service port (foreign)',
      labelFa: 'پورت سرویس محلی (خارج)',
      type: 'number',
      default: 80,
      min: 1,
      max: 65535,
      required: true,
    },
    // The camouflage host is resolved and dialled by the Iran side for every
    // visitor whose traffic is not Reality, and the foreign side verifies its
    // certificate, so it has to be a real TLS 1.3 site that both servers can
    // reach. A made-up name (example.ir resolves to nothing) fails the whole
    // handshake: `DomainResolver: async dns resolve failed`.
    ...realityFields(),
    {
      key: 'camouflageIp',
      group: 'reality',
      label: 'Camouflage IP (if DNS is unreliable)',
      labelFa: 'IP استتار (اگر DNS مشکل دارد)',
      type: 'text',
      default: '',
      help: 'اختیاری. اگر DNS روی سرور ایران خراب است، IP مقصد استتار را مستقیم بدهید. خالی بگذارید تا خود دامنه استفاده شود.',
    },
    {
      key: 'realityVerify',
      group: 'reality',
      label: 'Verify the camouflage certificate',
      labelFa: 'بررسی گواهی مقصد استتار',
      type: 'boolean',
      default: true,
      help: 'RealityClient.verify — دست‌دادن اولیه به سایت استتار را بررسی می‌کند. برای یک سایت واقعی باید true بماند.',
    },
    {
      key: 'useVariables',
      group: 'advanced',
      label: 'Use $variables$ in the config',
      labelFa: 'استفاده از متغیرها در کانفیگ',
      type: 'boolean',
      default: true,
      help: 'مقادیر قابل تنظیم در بلوک variables بالای فایل قرار می‌گیرند، مثل کانفیگ‌های دستی.',
    },
    ...coreFields(),
  ],

  build({ options }) {
    const userPort = Number(options.userPort) || 443;
    const reversePort = options.samePort !== false ? userPort : Number(options.reversePort) || userPort;
    const foreignCidr = peerCidrs(options);
    // One variable per exit: the readable `$variables$` form has to carry every
    // whitelisted server, not just the first one.
    const foreignCidrVars = foreignCidr.map((_, i) => (i === 0 ? 'ip_server_kharej' : `ip_server_kharej_${i + 1}`));
    const useVars = options.useVariables !== false;
    const camouflageAddress = options.camouflageIp || options.camouflageHost;
    const camouflagePort = Number(options.camouflagePort) || 443;

    // ReverseClient takes "minimum-unused"; ReverseServer does not.
    const clientReverse = { 'minimum-unused': Number(options.minimumUnused) || 8 };
    const serverReverse = {};
    if (options.reverseSecret) {
      const len = Math.max(1, Math.min(1024, Buffer.byteLength(options.reverseSecret)));
      clientReverse['reverse-secret'] = options.reverseSecret;
      clientReverse['reverse-secret-length'] = len;
      serverReverse['reverse-secret'] = options.reverseSecret;
      serverReverse['reverse-secret-length'] = len;
    }

    // Reality is password-based, not key-based, so both sides share these.
    const realityShared = {
      password: options.realityPassword,
      salt: options.realitySalt,
      algorithm: options.realityAlgorithm,
      'kdf-iterations': Number(options.realityKdf) || 12000,
    };

    // ----------------------------------------------------------- Iran side
    const iranNodes = [
      node(
        'users_inbound',
        'TcpListener',
        { address: options.listenAddress, port: userPort, nodelay: true },
        options.userTlsTermination ? 'tls_user_side' : 'bridge_user_side',
      ),
    ];
    if (options.userTlsTermination) {
      iranNodes.push(
        node(
          'tls_user_side',
          'TlsServer',
          {
            'cert-file': CERT_PATH,
            'key-file': KEY_PATH,
            'min-version': 'TLSv1.2',
            'max-version': 'TLSv1.3',
            ciphers: 'HIGH:!aNULL:!MD5',
            'session-cache': 'none',
            'session-tickets': true,
          },
          'bridge_user_side',
        ),
      );
    }
    iranNodes.push(node('bridge_user_side', 'Bridge', { pair: 'bridge_reverse_side' }));
    iranNodes.push(node('bridge_reverse_side', 'Bridge', { pair: 'bridge_user_side' }));
    iranNodes.push(node('reverse_server', 'ReverseServer', serverReverse, 'bridge_reverse_side'));
    iranNodes.push(
      node(
        'reality-server',
        'RealityServer',
        {
          destination: 'dest-visitor',
          'sniffing-attempts': Number(options.sniffingAttempts) || 8,
          ...realityShared,
        },
        'reverse_server',
      ),
    );
    iranNodes.push(
      node('dest-visitor', 'TcpConnector', { address: camouflageAddress, port: camouflagePort, nodelay: true }),
    );
    iranNodes.push(
      node(
        'germany_reverse_tls_inbound',
        'TcpListener',
        { address: options.listenAddress, port: reversePort, nodelay: true, whitelist: foreignCidr },
        'reality-server',
      ),
    );

    const iranConfig = {
      name: 'iran-reverse-reality-server',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              domain_white: options.camouflageHost,
              ip_behind_domain_white: camouflageAddress,
              ...Object.fromEntries(foreignCidrVars.map((key, i) => [key, foreignCidr[i]])),
              user_and_server_kharej_port: reversePort,
              users_inbound_port: userPort,
              password: options.realityPassword,
              ...(options.userTlsTermination
                ? { certificate_path: CERT_PATH, key_path: KEY_PATH }
                : {}),
            },
          }
        : {}),
      nodes: withVarSentinels(iranNodes, {
        'reality-server': (n) => {
          n.settings.password = '@password';
        },
        'dest-visitor': (n) => {
          n.settings.address = '@ip_behind_domain_white';
        },
        germany_reverse_tls_inbound: (n) => {
          n.settings.port = '@user_and_server_kharej_port';
          n.settings.whitelist = foreignCidrVars.map((key) => `@${key}`);
        },
        users_inbound: (n) => {
          n.settings.port = '@users_inbound_port';
        },
        tls_user_side: (n) => {
          n.settings['cert-file'] = '@certificate_path';
          n.settings['key-file'] = '@key_path';
        },
      }, useVars),
    };

    // -------------------------------------------------------- Foreign side
    const foreignNodes = [
      node('outbound_to_local_service', 'TcpConnector', {
        address: options.localServiceAddress || '127.0.0.1',
        port: Number(options.finalPort) || 80,
        nodelay: true,
      }),
      node('bridge_local_side', 'Bridge', { pair: 'bridge_reverse_client_side' }, 'outbound_to_local_service'),
      node('bridge_reverse_client_side', 'Bridge', { pair: 'bridge_local_side' }, 'reverse_client'),
      node('reverse_client', 'ReverseClient', clientReverse, 'reality-client'),
      node(
        'reality-client',
        'RealityClient',
        { sni: options.realitySni, verify: options.realityVerify !== false, ...realityShared },
        'tcp_to_iran',
      ),
      node('tcp_to_iran', 'TcpConnector', { address: options.iranHost, port: reversePort, nodelay: true }),
    ];

    const foreignConfig = {
      name: 'foreign-reverse-reality-client',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              ip_server_iran: options.iranHost,
              connect_to_iran_port: reversePort,
              domain_to_handshake_reality: options.realitySni,
              password: options.realityPassword,
              final_port: Number(options.finalPort) || 80,
              min_held_connections: Number(options.minimumUnused) || 8,
            },
          }
        : {}),
      nodes: withVarSentinels(foreignNodes, {
        'reality-client': (n) => {
          n.settings.sni = '@domain_to_handshake_reality';
          n.settings.password = '@password';
        },
        reverse_client: (n) => {
          n.settings['minimum-unused'] = '@min_held_connections';
        },
        tcp_to_iran: (n) => {
          n.settings.address = '@ip_server_iran';
          n.settings.port = '@connect_to_iran_port';
        },
        outbound_to_local_service: (n) => {
          n.settings.port = '@final_port';
        },
      }, useVars),
    };

    const samePortNote =
      reversePort === userPort
        ? `هر دو شنونده روی پورت ${userPort} هستند. واتروال شنونده‌دارای-whitelist را اولویت می‌دهد، پس IP سرور خارج به Reality می‌رسد و بقیه به کاربران.`
        : `کاربران روی پورت ${userPort} و لینک معکوس روی پورت ${reversePort}.`;

    return {
      iran: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/reverse-reality.json': emit(iranConfig, options) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/reverse-reality.json': emit(foreignConfig, options) } },
      client: {
        links: [
          {
            label: 'نقطه ورود کاربران (ایران)',
            url: `${options.listenAddress === '0.0.0.0' ? options.iranHost : options.listenAddress}:${userPort}`,
            hint: 'هر سرویسی که روی این پورت گوش می‌دهد می‌تواند جلوی سرویس محلی سرور خارج قرار بگیرد.',
          },
        ],
        instructions: [
          `کاربران به ${options.iranHost}:${userPort} وصل می‌شوند و خروجی‌شان ${options.localServiceAddress}:${options.finalPort} روی سرور خارج است.`,
          `برای ناظر شبکه، لینک بین دو سرور شبیه یک بازدید HTTPS عادی از ${options.camouflageHost} به نظر می‌رسد.`,
        ],
      },
      notes: [
        `جریان ترافیک: کاربر → ${options.iranHost}:${userPort} → users_inbound → Bridge ⇄ Bridge → reverse_server → reality-server → لینک → reality-client → reverse_client → Bridge ⇄ Bridge → ${options.localServiceAddress}:${options.finalPort}`,
        samePortNote,
        'RealityClient ابتدا یک دست‌دادن TLS واقعی با مقصد استتار انجام می‌دهد و تنها پس از موفقیت، لایه Reality فعال می‌شود. به همین دلیل روی سرور ایران هیچ گواهی لازم نیست.',
        'شاخه dest-visitor همان نودی است که RealityServer.settings.destination به آن اشاره می‌کند: بازدیدکننده‌های غیرمجاز از آنجا به سایت واقعی می‌روند.',
        'next در ReverseServer مستقیماً به Bridge مجاور اشاره می‌کند، بدون نود واسط.',
        'ReverseClient.minimum-unused فقط سمت کلاینت است؛ ReverseServer آن را نمی‌پذیرد.',
      ],
      warnings: [
        `مقصد استتار (${camouflageAddress}:${camouflagePort}) باید یک سایت HTTPS واقعی و در دسترس باشد، وگرنه بازدیدکننده‌های عادی خطای اتصال می‌گیرند.`,
        `SNI روی سرور خارج (${options.realitySni}) باید همان دامنه‌ای باشد که گواهی مقصد استتار پوشش می‌دهد، وگرنه verify=true دست‌دادن شکست می‌خورد.`,
        options.camouflageIp
          ? `چون IP استتار پر شده، تغییرات DNS دامنه ${options.camouflageHost} روی این تونل اثری ندارد.`
          : 'اگر DNS روی سرور ایران خراب است، فیلد «IP استتار» را پر کنید تا مستقیم به IP وصل شود.',
        'رمز Reality بین دو سرور یکسان است؛ آن را در جای عمومی نگه ندارید.',
        'پورت لینک معکوس را در فایروال سرور ایران فقط برای IP سرور خارج باز کنید.',
        'خروجی روی سرور خارج به سرویس محلی اشاره می‌کند؛ مطمئن شوید آن سرویس واقعاً گوش می‌دهد وگرنه اتصال‌ها بی‌صدا بسته می‌شوند.',
      ],
    };
  },
};

module.exports = [reverseReality];
