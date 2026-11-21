'use strict';

const {coreFields, coreOpts, listenPorts, node} = require('./common');
const {emitConfig} = require('../generator');

/**
 * SOCKS5 proxy with striped RTMP upload and Reality download.
 *
 * Official example (WaterWall 1.6.0):
 *   https://radkesvat.github.io/WaterWall-Docs/docs/examples/proxies/socks5-rtmp-reality
 *
 *   Client (Iran)
 *     TcpUdpListener -> Socks5Server -> TrojanClient -> MuxClient -> HalfDuplexClient
 *       up   -> ConnectionStripeClient -> ObfuscatorClient -> RtmpClient -> TcpConnector (:1935)
 *       down -> RealityClient -> TcpConnector (:443)
 *
 *   Server (foreign)
 *     TcpListener(:1935) -> RtmpServer -> ObfuscatorServer -> ConnectionStripeServer
 *       -> HalfDuplexServer(up) -> MuxServer -> TrojanServer -> TcpUdpConnector
 *     TcpListener(:443) -> RealityServer -> HalfDuplexServer(down, pair: up)
 *     Reality cover -> TcpConnector($reality_sni$:443)
 *
 * Client-to-server payload travels over eight striped RTMP TCP sessions per Mux
 * parent; server-to-client returns over one Reality connection. Both carrier
 * paths must reach the same foreign box.
 *
 * The RTMP link carries recoverable XOR-obfuscated bytes (including the Trojan
 * credential digest), so it is meant for a trusted link — exactly what the
 * upstream notes say. Reality protects the download path.
 */

const emit = (config, options) => emitConfig(config, {useVariables: options.useVariables !== false});

// The two carrier ports the foreign side must listen on. 443 is used by the
// Reality download path and 1935 is the RTMP upload path; both are declared so
// the panel's port-conflict logic can move a clone tunnel off an occupied port.
const listenPortsMap = listenPorts({
  iran: ['socksPort'],
  foreign: ['rtmpPort', 'realityPort'],
  relay: [],
  pairs: [],
});

const socks5RtmpReality = {
  id: 'socks5-rtmp-reality',
  title: 'SOCKS5 + striped RTMP upload / Reality download',
  titleFa: 'SOCKS5 + آپلود RTMP استریپشده / دانلود Reality',
  category: 'stream',
  categoryFa: 'پروتکل',
  icon: '🎬',
  sides: ['iran', 'foreign'],
  listenPorts: listenPortsMap,
  // The node set (ConnectionStripe, HalfDuplex, Rtmp) only exists in 1.6.0.
  minVersion: '1.6.0',
  summary:
    'Socks5Server -> TrojanClient -> MuxClient -> HalfDuplexClient, upload over 8 striped RTMP sessions and download over one Reality connection.',
  summaryFa:
    'یک پروکسی SOCKS5 روی سرور ایران. آپلود روی ۸ اتصال RTMP مستقل پخش میشود (برای دورزدن محدودیت پهنای آپلود) و دانلود از طریق Reality برمیگردد که شبیه بازدید HTTPS عادی از یک سایت پوشش است.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/examples/proxies/socks5-rtmp-reality',
  tags: ['socks5', 'rtmp', 'reality', 'striping', 'upload', 'proxy', 'mux', 'half-duplex'],
  clientHint:
    'پروکسی SOCKS5 روی آدرس شنود محلی (پیشفرض 127.0.0.1:1080) در دسترس است؛ تمام ترافیک TCP و UDP را از سرور خارج عبور میدهد.',
  fields: [
    { key: 'socksAddress', group: 'entry', label: 'SOCKS5 listen address', labelFa: 'آدرس شنود SOCKS5', type: 'text', default: '127.0.0.1' },
    { key: 'socksPort', group: 'entry', label: 'SOCKS5 listen port', labelFa: 'پورت SOCKS5', type: 'number', default: 1080, min: 1, max: 65535, required: true },
    {
      key: 'rtmpPort',
      group: 'carriers',
      label: 'RTMP port (foreign, TCP)',
      labelFa: 'پورت RTMP (خارج، TCP)',
      type: 'number',
      default: 1935,
      min: 1,
      max: 65535,
      required: true,
      help: 'پورت شنود RTMP روی سرور خارج. باید TCP باز باشد.',
    },
    {
      key: 'realityPort',
      group: 'carriers',
      label: 'Reality port (foreign, TCP)',
      labelFa: 'پورت Reality (خارج، TCP)',
      type: 'number',
      default: 443,
      min: 1,
      max: 65535,
      required: true,
      help: 'پورت شنود Reality روی سرور خارج.client به این پورت وصل میشود.',
    },
    { key: 'listenAddress', group: 'carriers', label: 'Carrier bind address (foreign)', labelFa: 'آدرس شنود حاملها (خارج)', type: 'text', default: '0.0.0.0' },
    {
      key: 'rtmpUrl',
      group: 'carriers',
      label: 'RTMP announce URL (tc-url)',
      labelFa: 'آدرس اعلامی RTMP (tc-url)',
      type: 'text',
      default: 'rtmp://live.restream.io:1935/waterwall',
      required: true,
      help:
        'فقط رشتهٔ handshake RTMP است، نه مقصد شبکه: اتصال واقعی با server_address و rtmp_port برقرار میشود. میتوانید نام میزبان یک سرویس RTMP شناختهشده (مثل restream یا آپارات) بگذارید و مسیر /waterwall را حفظ کنید.',
    },
    {
      key: 'realitySni',
      group: 'reality',
      label: 'Reality cover SNI',
      labelFa: 'SNI سایت پوشش Reality',
      type: 'text',
      default: 'www.wikipedia.org',
      required: true,
      help:
        'یک دامنهٔ معمولی و واقعی (نهgoogle) که گواهی معتبر دارد و سرور خارج بتواند آن را روی 443 resolve و dial کند. همان مقدار باید روی دو سمت یکسان باشد.',
    },
    { key: 'realityVerify', group: 'reality', label: 'Verify cover certificate', labelFa: 'بررسی گواهی سایت پوشش', type: 'boolean', default: true, help: 'RealityClient.verify — سایت پوشش باید گواهی معتبر برای reality_sni داشته باشد.' },
    {
      key: 'realityPassword',
      group: 'reality',
      label: 'Reality password',
      labelFa: 'رمز Reality',
      type: 'password',
      default: 'auto:hex:16',
      required: true,
      help: 'RealityClient/RealityServer password — حداکثر ۳۲ بایت UTF-8. هر دو سمت باید یکسان باشند.',
    },
    {
      key: 'trojanPassword',
      group: 'secret',
      label: 'Trojan password',
      labelFa: 'رمز Trojan',
      type: 'password',
      default: 'auto:hex:24',
      required: true,
      help: 'رمز TrojanClient/TrojanServer — هر دو سمت باید یکسان باشند.',
    },
    { key: 'stripeConnections', group: 'carriers', label: 'RTMP stripe connections', labelFa: 'تعداد اتصالات استریپ RTMP', type: 'number', default: 8, min: 1, max: 64, required: true, help: 'تعداد جلسات RTMP مستقل در هر Mux parent (پیشفرض ۸).' },
    { key: 'muxConnectionsPerWorker', group: 'carriers', label: 'Mux parents per worker', labelFa: 'تعداد Mux parent هر ورکر', type: 'number', default: 1, min: 1, max: 32 },
    { key: 'obfuscatorKey', group: 'carriers', label: 'XOR key (0-255)', labelFa: 'کلید XOR', type: 'number', default: 90, min: 0, max: 255 },
    { key: 'useVariables', group: 'advanced', label: 'Use $variables$ in the config', labelFa: 'استفاده از متغیرها در کانفیگ', type: 'boolean', default: true },
    ...coreFields(),
  ],

  build({options}) {
    const socksPort = Number(options.socksPort) || 1080;
    const rtmpPort = Number(options.rtmpPort) || 1935;
    const realityPort = Number(options.realityPort) || 443;
    const stripes = Math.max(1, Number(options.stripeConnections) || 8);
    const muxPerWorker = Math.max(1, Number(options.muxConnectionsPerWorker) || 1);
    const xorKey = Number(options.obfuscatorKey) || 0;
    const rtmpUrl = options.rtmpUrl || 'rtmp://live.restream.io:1935/waterwall';
    const realitySni = options.realitySni || 'www.wikipedia.org';
    const serverAddress = options.foreignHost; // the panel's target server address
    const useVars = options.useVariables !== false;
    // With variables off, write the real values into the nodes instead; an
    // '@name' left in a config with no variables block is a startup error.
    const v = (name, value) => (useVars ? `@${name}` : value);
    const socksAddress = options.socksAddress || '127.0.0.1';

    // ---------------------------------------------------------------- client
    const iranNodes = [
      node(
        'socks-listener',
        'TcpUdpListener',
        {
          address: v('socks_address', socksAddress),
          port: v('socks_port', socksPort),
          nodelay: true,
          'large-send-buffer': true,
          'large-recv-buffer': true,
        },
        'socks',
      ),
      node('socks', 'Socks5Server', {'no-auth': true, connect: true, udp: true, ipv4: v('socks_address', socksAddress)}, 'trojan'),
      node(
        'trojan',
        'TrojanClient',
        {
          password: v('trojan_password', options.trojanPassword),
          address: 'dest_context->address',
          port: 'dest_context->port',
          protocol: 'dest_context->protocol',
        },
        'mux',
      ),
      node('mux', 'MuxClient', {mode: 'fixed-connections-count', 'per-worker-connections-count': v('mux_connections_per_worker', muxPerWorker)}, 'half-duplex'),
      node('half-duplex', 'HalfDuplexClient', {upload: 'up', download: 'down'}),
      node('up', 'ConnectionStripeClient', {connections: v('stripe_connections', stripes)}, 'obfuscator'),
      node('obfuscator', 'ObfuscatorClient', {method: 'xor', xor_key: v('obfuscator_key', xorKey)}, 'rtmp'),
      node('rtmp', 'RtmpClient', {'tc-url': v('rtmp_url', rtmpUrl), app: 'waterwall', stream: 'tunnel'}, 'rtmp-connector'),
      node('rtmp-connector', 'TcpConnector', {address: v('server_address', serverAddress), port: v('rtmp_port', rtmpPort), nodelay: true, fastopen: false}),
      node('down', 'RealityClient', {sni: v('reality_sni', realitySni), password: v('reality_password', options.realityPassword), verify: options.realityVerify !== false}, 'reality-connector'),
      node('reality-connector', 'TcpConnector', {address: v('server_address', serverAddress), port: v('reality_port', realityPort), nodelay: true, fastopen: false}),
    ];

    const iranConfig = {
      name: 'socks5-rtmp-reality-client',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(options.useVariables !== false
        ? {
            variables: {
              socks_address: options.socksAddress || '127.0.0.1',
              socks_port: socksPort,
              server_address: serverAddress,
              rtmp_port: rtmpPort,
              rtmp_url: rtmpUrl,
              reality_port: realityPort,
              reality_sni: realitySni,
              reality_password: options.realityPassword,
              trojan_password: options.trojanPassword,
              mux_connections_per_worker: muxPerWorker,
              stripe_connections: stripes,
              obfuscator_key: xorKey,
            },
          }
        : {}),
      nodes: iranNodes,
    };

    // --------------------------------------------------------------- server
    const listenAddress = options.listenAddress || '0.0.0.0';
    const foreignNodes = [
      node('rtmp-listener', 'TcpListener', {address: v('listen_address', listenAddress), port: v('rtmp_port', rtmpPort), nodelay: true}, 'rtmp'),
      node('rtmp', 'RtmpServer', {app: 'waterwall', stream: 'tunnel'}, 'obfuscator'),
      node('obfuscator', 'ObfuscatorServer', {method: 'xor', xor_key: v('obfuscator_key', xorKey)}, 'stripe'),
      node('stripe', 'ConnectionStripeServer', {'max-connections': v('stripe_connections', stripes)}, 'up'),
      node('up', 'HalfDuplexServer', {}, 'mux'),
      node('reality-listener', 'TcpListener', {address: v('listen_address', listenAddress), port: v('reality_port', realityPort), nodelay: true}, 'reality'),
      node('reality', 'RealityServer', {destination: 'cover-connector', password: v('reality_password', options.realityPassword)}, 'down'),
      node('down', 'HalfDuplexServer', {pair: 'up'}),
      node('mux', 'MuxServer', {}, 'trojan'),
      node('trojan', 'TrojanServer', {password: v('trojan_password', options.trojanPassword), connect: true, udp: true}, 'outbound'),
      node('outbound', 'TcpUdpConnector', {address: 'dest_context->address', port: 'dest_context->port', nodelay: true, fastopen: false}),
      node('cover-connector', 'TcpConnector', {address: v('reality_sni', realitySni), port: 443, nodelay: true, fastopen: false}),
    ];

    const foreignConfig = {
      name: 'socks5-rtmp-reality-server',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(options.useVariables !== false
        ? {
            variables: {
              listen_address: options.listenAddress || '0.0.0.0',
              rtmp_port: rtmpPort,
              reality_port: realityPort,
              reality_sni: realitySni,
              reality_password: options.realityPassword,
              trojan_password: options.trojanPassword,
              stripe_connections: stripes,
              obfuscator_key: xorKey,
            },
          }
        : {}),
      nodes: foreignNodes,
    };

    return {
      iran: {
        core: coreOpts(options, {ramProfile: 'client'}),
        files: {'configs/socks5-rtmp-reality.json': emit(iranConfig, options)},
      },
      foreign: {
        core: coreOpts(options, {ramProfile: 'server'}),
        files: {'configs/socks5-rtmp-reality.json': emit(foreignConfig, options)},
      },
      client: {
        links: [{label: 'SOCKS5 (ایران)', url: `${options.socksAddress || '127.0.0.1'}:${socksPort}`}],
        instructions: [
          `پروکسی SOCKS5 روی ${options.socksAddress || '127.0.0.1'}:${socksPort} در سرور ایران در دسترس است (هم TCP و هم UDP).`,
          'برای تست: curl --socks5-hostname 127.0.0.1:1080 https://example.com',
          'اگر در ویندوز میخواهید TUN mode بسازید، از TunDevice + PacketsToConnection در زنجیرهٔ کلاینت استفاده کنید؛ مسیریابی سیستم توسط نود تنظیم میشود.',
        ],
      },
      notes: [
        'آپلود از ۸ اتصال RTMP مستقل تشکیل شده تا در صورت محدودیت پهنای تکاتصال، تا ۸ برابر پهنا بدست آید.',
        'دانلود از طریق Reality و با SNI یک سایت پوشش واقعی برمیگردد؛ گواهی آن سایت باید توسط کلاینت معتبر شناخته شود.',
        'rtmp_url تنها رشتهٔ handshake است؛ مقصد شبکه همیشه server_address:rtmp_port است.',
        'هر دو حامل (RTMP و Reality) باید به همان سرور خارج برسند و رمزها روی دو سمت یکسان باشند.',
      ],
      warnings: [
        'مسیر RTMP قابل بازیابی است و شامل digest رمز Trojan میشود؛ طبق توصیهٔ مستندات فقط روی لینک مطمئن استفاده کنید.',
        'پورت ۱۹۳۵ و پورت Reality روی سرور خارج باید TCP باز باشند.',
        `سایت پوشش (${realitySni}) باید از سرور خارج قابل resolve و dial روی 443 باشد و گواهی معتبر داشته باشد.`,
        'نسخهٔ ۱.۶.۰ یا بالاتر روی هر دو سمت لازم است؛ نودهای ConnectionStripe و Rtmp در نسخههای قدیمی وجود ندارند.',
      ],
    };
  },
};

module.exports = [socks5RtmpReality];
