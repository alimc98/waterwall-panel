'use strict';

const { CERT_PATH, KEY_PATH } = require('../certs');

const { coreFields, coreOpts, realityFields, node, peerCidrs } = require('./common');
const { emitConfig } = require('../generator');

/**
 * Reverse tunnels.
 *
 * The documented shape is: the *server* side owns the user-facing listener and
 * runs ReverseServer; the *client* side dials out with ReverseClient and
 * terminates the link into a local service. In an Iran/foreign deployment that
 * means the foreign box connects to the Iran box, and users on the Iran box get
 * an exit on the foreign box — which is what you want when the Iran entry point
 * must look local.
 */

const emit = (config, options) => emitConfig(config, { useVariables: options.useVariables !== false });

/** Replace concrete values with $variables$ sentinels for the tunable fields. */
function withVarSentinels(nodes, rules) {
  return nodes.map((node) => {
    const copy = JSON.parse(JSON.stringify(node));
    const fn = rules[copy.name];
    if (fn) fn(copy);
    return copy;
  });
}

/** Shared port / whitelist / user-side fields for the reverse family. */
function entryFields({ userPort, portNote }) {
  return [
    {
      key: 'userPort',
      group: 'entry',
      label: 'User-facing port (Iran)',
      labelFa: 'پورت کاربران (ایران)',
      type: 'number',
      default: userPort,
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
      default: userPort,
      min: 1,
      max: 65535,
      help: portNote,
    },
    {
      key: 'samePort',
      group: 'entry',
      label: 'Same port for both listeners',
      labelFa: 'یک پورت برای هر دو شنونده',
      type: 'boolean',
      default: true,
      help: 'وقتی روشن است، پورت لینک معکوس برابر پورت کاربران می‌شود. واتروال شنونده‌های دارای whitelist را در اولویت قرار می‌دهد، پس هر دو روی یک پورت کار می‌کنند.',
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
      help: 'اگر روشن باشد، یک TlsServer دوم بین users_inbound و Bridge قرار می‌گیرد تا اتصال کاربران هم TLS باشد. نیازمند گواهی معتبر.',
    },
    {
      key: 'listenAddress',
      group: 'entry',
      label: 'Bind address (Iran)',
      labelFa: 'آدرس bind (ایران)',
      type: 'text',
      default: '0.0.0.0',
    },
  ];
}

const reverseFields = [
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
  {
    key: 'useVariables',
    group: 'advanced',
    label: 'Use $variables$ in the config',
    labelFa: 'استفاده از متغیرها در کانفیگ',
    type: 'boolean',
    default: true,
    help: 'مقادیر قابل تنظیم در بلوک variables بالای فایل قرار می‌گیرند، مثل کانفیگ‌های دستی.',
  },
];

/** Shared builder helpers so all three reverse templates stay in sync. */
function reverseSettings(options) {
  const client = { 'minimum-unused': Number(options.minimumUnused) || 8 };
  const server = {};
  if (options.reverseSecret) {
    const len = Math.max(1, Math.min(1024, Buffer.byteLength(options.reverseSecret)));
    client['reverse-secret'] = options.reverseSecret;
    client['reverse-secret-length'] = len;
    server['reverse-secret'] = options.reverseSecret;
    server['reverse-secret-length'] = len;
  }
  return { client, server };
}

function resolvePorts(options) {
  const userPort = Number(options.userPort) || 443;
  return {
    userPort,
    reversePort: options.samePort !== false ? userPort : Number(options.reversePort) || userPort,
  };
}

function bridgePair(next) {
  return [
    node('bridge_local_side', 'Bridge', { pair: 'bridge_reverse_client_side' }, next),
    node('bridge_reverse_client_side', 'Bridge', { pair: 'bridge_local_side' }, 'reverse_client'),
  ];
}

// -------------------------------------------------------------------------
const reverseTls = {
  id: 'reverse-tls',
  title: 'Reverse Tunnel over TLS',
  titleFa: 'تونل معکوس روی TLS',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '🔁',
  sides: ['iran', 'foreign'],
  summary:
    'Iran: TcpListener(whitelist) -> TlsServer -> ReverseServer -> Bridge ⇄ Bridge <- TcpListener(users).  Foreign: TcpConnector -> TlsClient -> ReverseClient -> Bridge ⇄ Bridge -> TcpConnector(local service).',
  summaryFa:
    'سرور خارج به سرور ایران وصل می‌شود و ترافیک کاربرانی که به پورت سرور ایران وصل می‌شوند را به سرویس محلی سرور خارج می‌براند. هر دو شنونده می‌توانند روی یک پورت باشند و با whitelist از هم تفکیک می‌شوند.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/ReverseServer',
  tags: ['reverse', 'tls', 'bridge', 'whitelist'],
  multiExit: true,
  clientHint:
    'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی ترافیک آن‌ها سرویس محلی روی سرور خارج است.',
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
      help: 'وقتی روشن است، پورت لینک معکوس برابر پورت کاربران می‌شود. واتروال شنونده‌های دارای whitelist را در اولویت قرار می‌دهد، پس هر دو روی یک پورت کار می‌کنند.',
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
      help: 'اگر روشن باشد، یک TlsServer دوم بین users_inbound و Bridge قرار می‌گیرد تا اتصال کاربران هم TLS باشد.',
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
      key: 'sni',
      group: 'tls',
      label: 'SNI for the reverse link',
      labelFa: 'SNI لینک معکوس',
      type: 'text',
      default: 'example.com',
      required: true,
      help: "TlsClient.sni — نامی که در دست‌دادن TLS به سرور ایران استفاده می‌شود. باید در گواهی سرور ایران باشد.",
    },
    {
      key: 'verify',
      group: 'tls',
      label: 'Verify certificate',
      labelFa: 'بررسی گواهی',
      type: 'boolean',
      default: true,
      help: "TlsClient.verify. برای گواهی Let's Encrypt باید true بماند.",
    },
    {
      key: 'domain',
      group: 'tls',
      label: 'Domain for an automatic certificate',
      labelFa: 'دامنه برای ساخت خودکار گواهی',
      type: 'text',
      default: '',
      help:
        'این قالب روی سرور ایران TlsServer دارد، پس گواهی روی ایران لازم است. با پر کردن این فیلد، پنل هنگام اعمال گواهی را روی سرور ایران می‌سازد.',
    },
    {
      key: 'certMode',
      group: 'tls',
      label: 'How to obtain the certificate',
      labelFa: 'روش تهیه گواهی',
      type: 'select',
      default: 'auto',
      options: ['auto', 'letsencrypt', 'self-signed', 'none'],
      when: { domain: [(v) => Boolean(String(v || '').trim())] },
      help: "auto: اگر دامنه به IP سرور ایران اشاره کند از Let's Encrypt می‌گیرد، وگرنه خودامضا می‌سازد.",
    },
    {
      key: 'certPath',
      group: 'tls',
      label: 'Certificate path (Iran)',
      labelFa: 'مسیر گواهی (ایران)',
      type: 'text',
      default: CERT_PATH,
      required: true,
      help: 'TlsServer.cert-file روی سرور ایران. اگر فیلد دامنه را پر کنید، پنل گواهی را خودش می‌سازد.',
    },
    {
      key: 'keyPath',
      group: 'tls',
      label: 'Private key path (Iran)',
      labelFa: 'مسیر کلید (ایران)',
      type: 'text',
      default: KEY_PATH,
      required: true,
      help: 'TlsServer.key-file روی سرور ایران.',
    },
    {
      key: 'ciphers',
      group: 'tls',
      label: 'Cipher suite',
      labelFa: 'مجموعه رمزها',
      type: 'text',
      default: 'HIGH:!aNULL:!MD5',
      help: 'پیش‌فرض OpenSSL در واتروال همین است.',
    },
    {
      key: 'sessionTickets',
      group: 'tls',
      label: 'TLS session tickets',
      labelFa: 'Session tickets',
      type: 'boolean',
      default: true,
    },
    {
      key: 'sessionCache',
      group: 'tls',
      label: 'TLS session cache',
      labelFa: 'کش نشست TLS',
      type: 'select',
      default: 'none',
      options: ['none', 'off', 'builtin', 'builtin:20480'],
    },
    {
      key: 'tlsMinVersion',
      group: 'tls',
      label: 'Min TLS version',
      labelFa: 'کمینه نسخه TLS',
      type: 'select',
      default: 'TLSv1.2',
      options: ['TLSv1.2', 'TLSv1.3'],
    },
    {
      key: 'tlsMaxVersion',
      group: 'tls',
      label: 'Max TLS version',
      labelFa: 'بیشینه نسخه TLS',
      type: 'select',
      default: 'TLSv1.3',
      options: ['TLSv1.2', 'TLSv1.3'],
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
    {
      key: 'useVariables',
      group: 'advanced',
      label: 'Use $variables$ in the config',
      labelFa: 'استفاده از متغیرها در کانفیگ',
      type: 'boolean',
      default: true,
      help: 'مقادیر قابل تنظیم در بلوک variables بالای فایل قرار می‌گیرند، مثل کانفیگ‌های دستی. برای ویرایش بعدی راحت‌تر است.',
    },
    ...coreFields(),
  ],

  build({ options }) {
    const userPort = Number(options.userPort) || 443;
    const reversePort = options.samePort !== false ? userPort : Number(options.reversePort) || 443;
    const foreignCidr = peerCidrs(options);
    // One variable per exit so the readable form whitelists the whole fleet.
    const foreignCidrVars = foreignCidr.map((_, i) => (i === 0 ? 'ip_server_kharej' : `ip_server_kharej_${i + 1}`));

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

    const tlsServerSettings = {
      'cert-file': options.certPath,
      'key-file': options.keyPath,
      'min-version': options.tlsMinVersion,
      'max-version': options.tlsMaxVersion,
      ciphers: options.ciphers,
      'session-cache': options.sessionCache,
      'session-tickets': options.sessionTickets !== false,
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
      iranNodes.push(node('tls_user_side', 'TlsServer', { ...tlsServerSettings }, 'bridge_user_side'));
    }
    // Neither bridge takes a `next`. `pair` already binds the two, and a Bridge
    // whose `next` names its own partner is rejected at load: "wanted to bind to
    // (bridge_user_side) which is already bounded by bridge_reverse_side". The
    // docs' ReverseServer layout shows both bridges bare for exactly this reason.
    iranNodes.push(node('bridge_user_side', 'Bridge', { pair: 'bridge_reverse_side' }));
    iranNodes.push(node('bridge_reverse_side', 'Bridge', { pair: 'bridge_user_side' }));
    iranNodes.push(node('reverse_server', 'ReverseServer', serverReverse, 'bridge_reverse_side'));
    iranNodes.push(node('tls_server', 'TlsServer', { ...tlsServerSettings }, 'reverse_server'));
    iranNodes.push(
      node(
        'germany_reverse_tls_inbound',
        'TcpListener',
        { address: options.listenAddress, port: reversePort, nodelay: true, whitelist: foreignCidr },
        'tls_server',
      ),
    );

    const iranConfig = {
      name: 'iran-reverse-tls-server',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(options.useVariables !== false
        ? {
            variables: {
              certificate_path: options.certPath,
              key_path: options.keyPath,
              ...Object.fromEntries(foreignCidrVars.map((key, i) => [key, foreignCidr[i]])),
              user_and_server_kharej_port: reversePort,
              users_inbound_port: userPort,
            },
          }
        : {}),
      nodes: withVarSentinels(iranNodes, {
        tls_server: (n) => {
          n.settings['cert-file'] = '@certificate_path';
          n.settings['key-file'] = '@key_path';
        },
        tls_user_side: (n) => {
          n.settings['cert-file'] = '@certificate_path';
          n.settings['key-file'] = '@key_path';
        },
        germany_reverse_tls_inbound: (n) => {
          n.settings.port = '@user_and_server_kharej_port';
          n.settings.whitelist = foreignCidrVars.map((key) => `@${key}`);
        },
        users_inbound: (n) => {
          n.settings.port = '@users_inbound_port';
        },
      }),
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
      node('reverse_client', 'ReverseClient', clientReverse, 'tls_client'),
      node('tls_client', 'TlsClient', { sni: options.sni, verify: options.verify !== false }, 'tcp_to_iran'),
      node('tcp_to_iran', 'TcpConnector', { address: options.iranHost, port: reversePort, nodelay: true }),
    ];

    const foreignConfig = {
      name: 'foreign-reverse-tls-client',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(options.useVariables !== false
        ? {
            variables: {
              ip_server_iran: options.iranHost,
              connect_to_iran_port: reversePort,
              domain_to_handshake_tls: options.sni,
              final_port: Number(options.finalPort) || 80,
              min_held_connections: Number(options.minimumUnused) || 8,
            },
          }
        : {}),
      nodes: withVarSentinels(foreignNodes, {
        tcp_to_iran: (n) => {
          n.settings.address = '@ip_server_iran';
          n.settings.port = '@connect_to_iran_port';
        },
        tls_client: (n) => {
          n.settings.sni = '@domain_to_handshake_tls';
        },
        reverse_client: (n) => {
          n.settings['minimum-unused'] = '@min_held_connections';
        },
        outbound_to_local_service: (n) => {
          n.settings.port = '@final_port';
        },
      }),
    };

    const samePortNote =
      reversePort === userPort
        ? `هر دو شنونده روی پورت ${userPort} هستند. واتروال شنونده‌دارای-whitelist را اولویت می‌دهد، پس IP سرور خارج به لینک معکوس می‌رسد و بقیه به کاربران.`
        : `کاربران روی پورت ${userPort} و لینک معکوس روی پورت ${reversePort}.`;

    return {
      iran: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/reverse-tls.json': emit(iranConfig, options) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/reverse-tls.json': emit(foreignConfig, options) } },
      client: {
        links: [
          {
            label: 'نقطه ورود کاربران (ایران)',
            url: `${options.listenAddress === '0.0.0.0' ? options.iranHost : options.listenAddress}:${userPort}`,
            hint: 'هر برنامه‌ای که روی این پورت گوش می‌دهد می‌تواند جلوی سرویس محلی سرور خارج قرار بگیرد.',
          },
        ],
        instructions: [
          `کاربران به ${options.iranHost}:${userPort} وصل می‌شوند و خروجی‌شان ${options.localServiceAddress}:${options.finalPort} روی سرور خارج است.`,
          'این سناریو پروتکل کلاینت خاصی ندارد؛ یک SOCKS5، xray یا هر سرویس TCP دیگر می‌تواند روی سرویس محلی خارج قرار بگیرد.',
        ],
      },
      notes: [
        `جریان ترافیک: کاربر → ${options.iranHost}:${userPort} → users_inbound → Bridge ⇄ Bridge → reverse_server → tls_server → لینک معکوس → tls_client → reverse_client → Bridge ⇄ Bridge → ${options.localServiceAddress}:${options.finalPort}`,
        samePortNote,
        'جفت Bridge دو نیمه را به هم می‌دوزد: bridge_user_side ⇄ bridge_reverse_side در ایران، و bridge_local_side ⇄ bridge_reverse_client_side در خارج.',
        'next در ReverseServer مستقیماً به Bridge مجاور اشاره می‌کند، بدون نود واسط.',
        'ReverseClient.minimum-unused فقط سمت کلاینت است؛ ReverseServer آن را نمی‌پذیرد.',
      ],
      warnings: [
        `گواهی TLS باید از قبل روی سرور ایران باشد: ${options.certPath} و ${options.keyPath}`,
        `SNI (${options.sni}) باید در همان گواهی پوشش داده شود، وگرنه verify=true دست‌دادن شکست می‌خورد.`,
        'پورت لینک معکوس را در فایروال سرور ایران فقط برای IP سرور خارج باز کنید.',
        'خروجی روی سرور خارج به سرویس محلی اشاره می‌کند؛ مطمئن شوید آن سرویس واقعاً گوش می‌دهد وگرنه همه اتصال‌ها بی‌صدا بسته می‌شوند.',
      ],
    };
  },
};

// -------------------------------------------------------------------------
const reversePlain = {
  id: 'reverse-plain',
  title: 'Reverse Tunnel (no TLS)',
  titleFa: 'تونل معکوس بدون TLS',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '🔗',
  sides: ['iran', 'foreign'],
  summary: 'Same topology as reverse-tls but the link between the servers is a raw TCP connection.',
  summaryFa: 'همان توپولوژی تونل معکوس، ولی اتصال بین دو سرور بدون TLS است. سریع‌تر، ولی ترافیک بین دو سرور قابل خواندن است.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/ReverseClient',
  tags: ['reverse', 'bridge', 'plain'],
  multiExit: true,
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی روی سرور خارج است.',
  fields: [
    { key: 'userPort', group: 'entry', label: 'User-facing port (Iran)', labelFa: 'پورت کاربران (ایران)', type: 'number', default: 8443, min: 1, max: 65535, required: true },
    { key: 'reversePort', group: 'entry', label: 'Reverse link port (Iran)', labelFa: 'پورت لینک معکوس (ایران)', type: 'number', default: 8443, min: 1, max: 65535 },
    {
      key: 'samePort',
      group: 'entry',
      label: 'Same port for both listeners',
      labelFa: 'یک پورت برای هر دو شنونده',
      type: 'boolean',
      default: true,
    },
    { key: 'whitelist', group: 'entry', label: 'Reverse-link whitelist', labelFa: 'لیست سفید لینک معکوس', type: 'list', default: [] },
    { key: 'listenAddress', group: 'entry', label: 'Bind address (Iran)', labelFa: 'آدرس bind (ایران)', type: 'text', default: '0.0.0.0' },
    { key: 'minimumUnused', group: 'reverse', label: 'Minimum held connections', labelFa: 'حداقل اتصال نگه‌داشته‌شده', type: 'number', default: 8, min: 1, help: 'ReverseClient.minimum-unused' },
    { key: 'reverseSecret', group: 'reverse', label: 'Shared reverse secret', labelFa: 'رمز مشترک لینک', type: 'password', default: '' },
    { key: 'localServiceAddress', group: 'service', label: 'Local service address (foreign)', labelFa: 'آدرس سرویس محلی (خارج)', type: 'text', default: '127.0.0.1' },
    { key: 'finalPort', group: 'service', label: 'Local service port (foreign)', labelFa: 'پورت سرویس محلی (خارج)', type: 'number', default: 80, min: 1, max: 65535, required: true },
    { key: 'useVariables', group: 'advanced', label: 'Use $variables$ in the config', labelFa: 'استفاده از متغیرها', type: 'boolean', default: true },
    ...coreFields(),
  ],

  build({ options }) {
    const userPort = Number(options.userPort) || 8443;
    const reversePort = options.samePort !== false ? userPort : Number(options.reversePort) || 8443;
    const foreignCidr = peerCidrs(options);
    // One variable per exit so the readable form whitelists the whole fleet.
    const foreignCidrVars = foreignCidr.map((_, i) => (i === 0 ? 'ip_server_kharej' : `ip_server_kharej_${i + 1}`));

    const clientReverse = { 'minimum-unused': Number(options.minimumUnused) || 8 };
    const serverReverse = {};
    if (options.reverseSecret) {
      const len = Math.max(1, Math.min(1024, Buffer.byteLength(options.reverseSecret)));
      clientReverse['reverse-secret'] = options.reverseSecret;
      clientReverse['reverse-secret-length'] = len;
      serverReverse['reverse-secret'] = options.reverseSecret;
      serverReverse['reverse-secret-length'] = len;
    }

    const iranNodes = [
      node('users_inbound', 'TcpListener', { address: options.listenAddress, port: userPort, nodelay: true }, 'bridge_user_side'),
      node('bridge_user_side', 'Bridge', { pair: 'bridge_reverse_side' }),
      // No `next`: `pair` binds the two bridges, and naming the partner in both
      // places is a load-time failure. See the note on the reverse-tls pair.
      node('bridge_reverse_side', 'Bridge', { pair: 'bridge_user_side' }),
      node('reverse_server', 'ReverseServer', serverReverse, 'bridge_reverse_side'),
      node('reverse_inbound', 'TcpListener', { address: options.listenAddress, port: reversePort, nodelay: true, whitelist: foreignCidr }, 'reverse_server'),
    ];

    const foreignNodes = [
      node('outbound_to_local_service', 'TcpConnector', {
        address: options.localServiceAddress || '127.0.0.1',
        port: Number(options.finalPort) || 80,
        nodelay: true,
      }),
      node('bridge_local_side', 'Bridge', { pair: 'bridge_reverse_client_side' }, 'outbound_to_local_service'),
      node('bridge_reverse_client_side', 'Bridge', { pair: 'bridge_local_side' }, 'reverse_client'),
      node('reverse_client', 'ReverseClient', clientReverse, 'tcp_to_iran'),
      node('tcp_to_iran', 'TcpConnector', { address: options.iranHost, port: reversePort, nodelay: true }),
    ];

    const useVars = options.useVariables !== false;

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/reverse-plain.json': emit(
            {
              name: 'iran-reverse-server',
              author: 'waterwall-panel',
              'config-version': 1,
              'core-minimum-version': 0,
              encrypted: false,
              ...(useVars
                ? {
                    variables: {
                      ...Object.fromEntries(foreignCidrVars.map((key, i) => [key, foreignCidr[i]])),
                      user_and_server_kharej_port: reversePort,
                      users_inbound_port: userPort,
                    },
                  }
                : {}),
              nodes: withVarSentinels(iranNodes, {
                reverse_inbound: (n) => {
                  n.settings.port = '@user_and_server_kharej_port';
                  n.settings.whitelist = foreignCidrVars.map((key) => `@${key}`);
                },
                users_inbound: (n) => {
                  n.settings.port = '@users_inbound_port';
                },
              }),
            },
            options,
          ),
        },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/reverse-plain.json': emit(
            {
              name: 'foreign-reverse-client',
              author: 'waterwall-panel',
              'config-version': 1,
              'core-minimum-version': 0,
              encrypted: false,
              ...(useVars
                ? {
                    variables: {
                      ip_server_iran: options.iranHost,
                      connect_to_iran_port: reversePort,
                      final_port: Number(options.finalPort) || 80,
                      min_held_connections: Number(options.minimumUnused) || 8,
                    },
                  }
                : {}),
              nodes: withVarSentinels(foreignNodes, {
                tcp_to_iran: (n) => {
                  n.settings.address = '@ip_server_iran';
                  n.settings.port = '@connect_to_iran_port';
                },
                reverse_client: (n) => {
                  n.settings['minimum-unused'] = '@min_held_connections';
                },
                outbound_to_local_service: (n) => {
                  n.settings.port = '@final_port';
                },
              }),
            },
            options,
          ),
        },
      },
      client: {
        links: [{ label: 'نقطه ورود کاربران (ایران)', url: `${options.iranHost}:${userPort}` }],
        instructions: [`خروجی روی ${options.localServiceAddress}:${options.finalPort} در سرور خارج است.`],
      },
      notes: [
        `کاربر → ${options.iranHost}:${userPort} → users_inbound → Bridge ⇄ Bridge → reverse_server → لینک → reverse_client → Bridge ⇄ Bridge → ${options.localServiceAddress}:${options.finalPort}`,
        'اگر همان پورت برای هر دو شنونده استفاده شود، whitelist تعیین می‌کند کدام مسیر برود.',
      ],
      warnings: [
        'ترافیک بین دو سرور بدون رمزنگاری است. اگر این دو سرور روی اینترنت عمومی به هم وصل می‌شوند، از نسخه TLS یا یک لایه Encryption استفاده کنید.',
      ],
    };
  },
};

module.exports = [reverseTls, reversePlain];
