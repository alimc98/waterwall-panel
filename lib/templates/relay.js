'use strict';

const {CIPHERS, coreFields, coreOpts, csv, listenPorts, node, peerCidrs} = require('./common');
const { emitConfig } = require('../generator');

/**
 * Three-hop relay: users -> Iran -> relay -> exit.
 *
 * The first hop is an ordinary forward Reality tunnel from Iran to the relay.
 * The relay then acts as the entry of a *reverse* tunnel: exits dial its
 * backhaul port and join a ReverseServer pool, exactly like the two-server
 * reverse-reality template. That combination gives three useful properties at
 * once:
 *
 *   - the exit never accepts an inbound connection, so it can sit behind NAT
 *     and its IP is never visible from Iran;
 *   - the relay can front any number of exits (multi-exit), and the
 *     ReverseServer pairs each user with a free reverse link;
 *   - no certificates are needed on any hop, because both hops use Reality.
 *
 *   Iran    users_inbound -> reality-client -> tcp_to_relay
 *   Relay   relay_in -> reality_entry -> Bridge ⇄ Bridge -> reverse_server
 *           exit_in  -> reality_exit  -> reverse_server
 *   Exit    reverse_client -> reality-client -> tcp_to_relay
 *              └─ Bridge ⇄ Bridge -> local service
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

function checkRealitySecret(label, value, maxBytes = 32) {
  if (typeof value !== 'string' || !value.length) {
    throw new Error(`${label} نمی‌تواند خالی باشد`);
  }
  const bytes = Buffer.byteLength(value);
  if (bytes < 1 || bytes > maxBytes) {
    throw new Error(`${label} باید بین ۱ تا ${maxBytes} بایت UTF-8 باشد (${bytes} بایت داده شده)`);
  }
  return value;
}

const relayReality = {
  id: 'relay-reality',
  title: 'Three-hop relay over Reality (Iran → relay → exit)',
  titleFa: 'زنجیرهٔ سه‌سروری با Reality (ایران → رله → خارج)',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '🔀',
  sides: ['iran', 'relay', 'foreign'],
  listenPorts: listenPorts({
    iran: ['userPort'],
    foreign: [],
    relay: ['relayPort', 'backhaulPort'],
    pairs: [],
  }),
  summary:
    'Iran: TcpListener(users) -> RealityClient -> TcpConnector(relay). Relay: TcpListener(Iran) -> RealityServer -> Bridge ⇄ Bridge -> ReverseServer <- RealityServer <- TcpListener(exits), with one visitor branch per RealityServer. Exit: ReverseClient -> RealityClient -> TcpConnector(relay) -> Bridge ⇄ Bridge -> local service.',
  summaryFa:
    'ترافیک کاربران از ایران به یک سرور رله می‌رود و از آنجا به یک یا چند سرور خارج می‌رسد. سرور خارج هیچ پورت ورودی باز نمی‌کند و به رله وصل می‌شود؛ بنابراین IP سرور خارج هرگز به ایران نمی‌رسد و می‌توانید پشت NAT هم از آن استفاده کنید. هر دو پرش با Reality محافظت می‌شوند و به گواهی نیازی نیست.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/RealityServer',
  tags: ['relay', 'three-hop', 'reverse', 'reality', 'multi-exit', 'no-cert'],
  // The relay's ReverseServer pools any number of exits. Every exit runs the
  // same foreign bundle because it names the relay, not its own address.
  multiExit: true,
  clientHint:
    'کاربران به پورت سرور ایران وصل می‌شوند؛ ترافیک از رله عبور می‌کند و خروجی نهایی روی سرویس محلی سرور خارج است.',
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
      help: 'users_inbound — کاربران به این پورت روی سرور ایران وصل می‌شوند.',
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
      key: 'relayPort',
      group: 'relay',
      label: 'Iran → relay port (on relay)',
      labelFa: 'پورت لینک ایران → رله (روی رله)',
      type: 'number',
      default: 9443,
      min: 1,
      max: 65535,
      required: true,
      help: 'سرور ایران به این پورت روی سرور رله وصل می‌شود. فقط IP سرور ایران در whitelist آن قرار می‌گیرد.',
    },
    {
      key: 'backhaulPort',
      group: 'relay',
      label: 'Exit → relay backhaul port (on relay)',
      labelFa: 'پورت اتصال سرورهای خارج به رله',
      type: 'number',
      default: 9444,
      min: 1,
      max: 65535,
      required: true,
      help: 'سرورهای خارج برای ساخت لینک معکوس به این پورت روی رله وصل می‌شوند. فقط IP همان سرورها در whitelist قرار می‌گیرد.',
    },
    {
      key: 'relayListenAddress',
      group: 'relay',
      label: 'Bind address (relay)',
      labelFa: 'آدرس bind (رله)',
      type: 'text',
      default: '0.0.0.0',
    },
    {
      key: 'relayWhitelist',
      group: 'relay',
      label: 'Iran → relay whitelist',
      labelFa: 'لیست سفید لینک ایران',
      type: 'list',
      default: [],
      help: 'خالی بگذارید تا IP سرور ایران به‌صورت /32 خودکار استفاده شود. اگر سرور ایران از IP دیگری خارج می‌شود، همان را وارد کنید.',
    },
    {
      key: 'backhaulWhitelist',
      group: 'relay',
      label: 'Exit → relay whitelist',
      labelFa: 'لیست سفید لینک سرورهای خارج',
      type: 'list',
      default: [],
      help: 'خالی بگذارید تا IP همهٔ سرورهای خارج انتخاب‌شده خودکار whitelist شوند. برای NAT یا خروجی متفاوت، دستی وارد کنید.',
    },
    {
      key: 'entryPassword',
      group: 'reality',
      label: 'Reality password: Iran → relay',
      labelFa: 'رمز Reality: ایران → رله',
      type: 'password',
      default: 'auto:password16',
      required: true,
      help: 'RealityClient روی ایران و RealityServer ورودی رله باید همین رمز را داشته باشند. ۱ تا ۳۲ بایت UTF-8.',
    },
    {
      key: 'exitPassword',
      group: 'reality',
      label: 'Reality password: exit → relay',
      labelFa: 'رمز Reality: خارج → رله',
      type: 'password',
      default: 'auto:password16',
      required: true,
      help: 'RealityClient روی سرور خارج و RealityServer پشتی رله باید همین رمز را داشته باشند. جدا از رمز پرش اول است.',
    },
    {
      key: 'realitySalt',
      group: 'reality',
      label: 'Reality salt',
      labelFa: 'Salt Reality',
      type: 'text',
      default: 'waterwall-reality',
      help: 'هر دو پرش از همین salt استفاده می‌کنند. ۱ تا ۳۲ بایت UTF-8.',
    },
    {
      key: 'realityAlgorithm',
      group: 'reality',
      label: 'Reality algorithm',
      labelFa: 'الگوریتم Reality',
      type: 'select',
      default: 'chacha20-poly1305',
      options: CIPHERS,
    },
    {
      key: 'realityKdf',
      group: 'reality',
      label: 'Reality KDF iterations',
      labelFa: 'تکرار KDF Reality',
      type: 'number',
      default: 12000,
      min: 1,
      max: 1000000,
    },
    {
      key: 'camouflageHost',
      group: 'reality',
      label: 'Camouflage destination',
      labelFa: 'مقصد استتار',
      type: 'text',
      default: 'www.microsoft.com',
      required: true,
      help: 'RealityServer هر دو پرش، بازدیدکننده‌های غیرمجاز را به این سایت HTTPS واقعی می‌فرستد.',
    },
    {
      key: 'camouflagePort',
      group: 'reality',
      label: 'Camouflage port',
      labelFa: 'پورت استتار',
      type: 'number',
      default: 443,
      min: 1,
      max: 65535,
    },
    {
      key: 'realitySni',
      group: 'reality',
      label: 'Visitor SNI',
      labelFa: 'SNI بازدیدکننده',
      type: 'text',
      default: 'www.microsoft.com',
      required: true,
      help: 'RealityClient هر دو پرش این SNI را می‌فرستد. باید با گواهی سایت استتار بخواند.',
    },
    {
      key: 'camouflageIp',
      group: 'reality',
      label: 'Camouflage IP (if DNS is unreliable)',
      labelFa: 'IP استتار (اگر DNS مشکل دارد)',
      type: 'text',
      default: '',
      help: 'اختیاری. اگر DNS سرور رله یا خارج مشکل دارد، IP مقصد استتار را مستقیم بدهید.',
    },
    {
      key: 'sniffingAttempts',
      group: 'reality',
      label: 'Sniffing attempts',
      labelFa: 'تعداد تلاش sniffing',
      type: 'number',
      default: 8,
      min: 1,
      max: 1024,
    },
    {
      key: 'realityVerify',
      group: 'reality',
      label: 'Verify the camouflage certificate',
      labelFa: 'بررسی گواهی مقصد استتار',
      type: 'boolean',
      default: true,
      help: 'برای یک سایت واقعی باید true بماند.',
    },
    {
      key: 'minimumUnused',
      group: 'reverse',
      label: 'Minimum held reverse connections',
      labelFa: 'حداقل اتصال معکوس نگه‌داشته‌شده',
      type: 'number',
      default: 8,
      min: 1,
      required: true,
      help: 'ReverseClient روی هر سرور خارج چند لینک معکوس آماده نگه می‌دارد. بار بین لینک‌ها و سرورها تقسیم می‌شود.',
    },
    {
      key: 'reverseSecret',
      group: 'reverse',
      label: 'Shared reverse secret',
      labelFa: 'رمز مشترک لینک معکوس',
      type: 'password',
      default: '',
      help: 'اختیاری. اگر پر شود، ReverseClient و ReverseServer هر دو باید یکسان داشته باشند.',
    },
    {
      key: 'localServiceAddress',
      group: 'service',
      label: 'Local service address (exit)',
      labelFa: 'آدرس سرویس محلی (خارج)',
      type: 'text',
      default: '127.0.0.1',
    },
    {
      key: 'finalPort',
      group: 'service',
      label: 'Local service port (exit)',
      labelFa: 'پورت سرویس محلی (خارج)',
      type: 'number',
      default: 8080,
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
    },
    ...coreFields(),
  ],

  build({ options, tunnel, relayHost }) {
    const relayAddress = String(relayHost || options.relayHost || '').trim();
    if (!relayAddress) throw new Error('سرور رله انتخاب نشده است');

    const userPort = Number(options.userPort) || 443;
    const relayPort = Number(options.relayPort) || 9443;
    const backhaulPort = Number(options.backhaulPort) || 9444;
    if (relayPort === backhaulPort) {
      throw new Error('پورت لینک ایران و پورت backhaul باید متفاوت باشند');
    }

    const entryPassword = checkRealitySecret('رمز Reality ایران→رله', options.entryPassword);
    const exitPassword = checkRealitySecret('رمز Reality خارج→رله', options.exitPassword);
    const salt = checkRealitySecret('Salt Reality', options.realitySalt || 'waterwall-reality');

    const relayCidr = csv(options.relayWhitelist);
    if (!relayCidr.length) relayCidr.push(`${options.iranHost}/32`);
    // The exit backhaul has its own manual list. Only when it is empty do we
    // fall back to the selected exit hosts; otherwise a NAT address or a
    // different egress IP entered in the form would be silently ignored.
    const exitCidr = csv(options.backhaulWhitelist);
    if (!exitCidr.length) exitCidr.push(...peerCidrs(options));
    if (!exitCidr.length) throw new Error('هیچ سرور خارجی برای whitelist لینک معکوس پیدا نشد');

    const relayCidrVars = relayCidr.map((_, i) => (i === 0 ? 'ip_server_iran' : `ip_server_iran_${i + 1}`));
    const exitCidrVars = exitCidr.map((_, i) => (i === 0 ? 'ip_server_kharej' : `ip_server_kharej_${i + 1}`));

    const useVars = options.useVariables !== false;
    const camouflageAddress = String(options.camouflageIp || '').trim() || options.camouflageHost;
    const camouflagePort = Number(options.camouflagePort) || 443;
    const sniffingAttempts = Number(options.sniffingAttempts) || 8;

    const realityBase = {
      salt,
      algorithm: options.realityAlgorithm || 'chacha20-poly1305',
      'kdf-iterations': Number(options.realityKdf) || 12000,
    };
    const realityEntry = { ...realityBase, password: entryPassword };
    const realityExit = { ...realityBase, password: exitPassword };

    const clientReverse = { 'minimum-unused': Number(options.minimumUnused) || 8 };
    const serverReverse = {};
    if (options.reverseSecret) {
      const len = Math.max(1, Math.min(1024, Buffer.byteLength(options.reverseSecret)));
      clientReverse['reverse-secret'] = options.reverseSecret;
      clientReverse['reverse-secret-length'] = len;
      serverReverse['reverse-secret'] = options.reverseSecret;
      serverReverse['reverse-secret-length'] = len;
    }

    // ----------------------------------------------------------- Iran side
    const iranNodes = [
      node(
        'users_inbound',
        'TcpListener',
        { address: options.listenAddress, port: userPort, nodelay: true },
        'reality-client',
      ),
      node(
        'reality-client',
        'RealityClient',
        { sni: options.realitySni, verify: options.realityVerify !== false, ...realityEntry },
        'tcp_to_relay',
      ),
      node('tcp_to_relay', 'TcpConnector', { address: relayAddress, port: relayPort, nodelay: true }),
    ];

    const iranConfig = {
      name: 'iran-relay-entry',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              relay_ip: relayAddress,
              relay_port: relayPort,
              users_inbound_port: userPort,
              domain_to_handshake_reality: options.realitySni,
              password: entryPassword,
            },
          }
        : {}),
      nodes: withVarSentinels(iranNodes, {
        users_inbound: (n) => {
          n.settings.port = '@users_inbound_port';
        },
        'reality-client': (n) => {
          n.settings.sni = '@domain_to_handshake_reality';
          n.settings.password = '@password';
        },
        tcp_to_relay: (n) => {
          n.settings.address = '@relay_ip';
          n.settings.port = '@relay_port';
        },
      }, useVars),
    };

    // ---------------------------------------------------------- Relay side
    const relayNodes = [
      node(
        'relay_in',
        'TcpListener',
        {
          address: options.relayListenAddress || '0.0.0.0',
          port: relayPort,
          nodelay: true,
          whitelist: relayCidr,
        },
        'reality_entry',
      ),
      node(
        'reality_entry',
        'RealityServer',
        {
          destination: 'dest-visitor-entry',
          'sniffing-attempts': sniffingAttempts,
          ...realityEntry,
        },
        'bridge_user_side',
      ),
      node('dest-visitor-entry', 'TcpConnector', {
        address: camouflageAddress,
        port: camouflagePort,
        nodelay: true,
      }),
      // The user side of the relay is the bridge pair the ReverseServer pairs
      // with the exits' reverse links.
      node('bridge_user_side', 'Bridge', { pair: 'bridge_reverse_side' }),
      node('bridge_reverse_side', 'Bridge', { pair: 'bridge_user_side' }),
      node('reverse_server', 'ReverseServer', serverReverse, 'bridge_reverse_side'),
      node(
        'reality_exit',
        'RealityServer',
        {
          destination: 'dest-visitor-exit',
          'sniffing-attempts': sniffingAttempts,
          ...realityExit,
        },
        'reverse_server',
      ),
      node('dest-visitor-exit', 'TcpConnector', {
        address: camouflageAddress,
        port: camouflagePort,
        nodelay: true,
      }),
      node(
        'exit_in',
        'TcpListener',
        {
          address: options.relayListenAddress || '0.0.0.0',
          port: backhaulPort,
          nodelay: true,
          whitelist: exitCidr,
        },
        'reality_exit',
      ),
    ];

    const relayConfig = {
      name: 'relay-reverse-entry',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              relay_entry_port: relayPort,
              backhaul_port: backhaulPort,
              domain_white: options.camouflageHost,
              ip_behind_domain_white: camouflageAddress,
              password_entry: entryPassword,
              password_exit: exitPassword,
              ...Object.fromEntries(relayCidrVars.map((key, i) => [key, relayCidr[i]])),
              ...Object.fromEntries(exitCidrVars.map((key, i) => [key, exitCidr[i]])),
            },
          }
        : {}),
      nodes: withVarSentinels(relayNodes, {
        relay_in: (n) => {
          n.settings.port = '@relay_entry_port';
          n.settings.whitelist = relayCidrVars.map((key) => `@${key}`);
        },
        reality_entry: (n) => {
          n.settings.password = '@password_entry';
        },
        'dest-visitor-entry': (n) => {
          n.settings.address = '@ip_behind_domain_white';
        },
        reality_exit: (n) => {
          n.settings.password = '@password_exit';
        },
        'dest-visitor-exit': (n) => {
          n.settings.address = '@ip_behind_domain_white';
        },
        exit_in: (n) => {
          n.settings.port = '@backhaul_port';
          n.settings.whitelist = exitCidrVars.map((key) => `@${key}`);
        },
      }, useVars),
    };

    // -------------------------------------------------------- Foreign side
    const foreignNodes = [
      node('outbound_to_local_service', 'TcpConnector', {
        address: options.localServiceAddress || '127.0.0.1',
        port: Number(options.finalPort) || 8080,
        nodelay: true,
      }),
      node('bridge_local_side', 'Bridge', { pair: 'bridge_reverse_client_side' }, 'outbound_to_local_service'),
      node('bridge_reverse_client_side', 'Bridge', { pair: 'bridge_local_side' }, 'reverse_client'),
      node('reverse_client', 'ReverseClient', clientReverse, 'reality-client'),
      node(
        'reality-client',
        'RealityClient',
        { sni: options.realitySni, verify: options.realityVerify !== false, ...realityExit },
        'tcp_to_relay',
      ),
      node('tcp_to_relay', 'TcpConnector', { address: relayAddress, port: backhaulPort, nodelay: true }),
    ];

    const foreignConfig = {
      name: 'foreign-relay-exit',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              relay_ip: relayAddress,
              backhaul_port: backhaulPort,
              domain_to_handshake_reality: options.realitySni,
              password: exitPassword,
              final_port: Number(options.finalPort) || 8080,
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
        tcp_to_relay: (n) => {
          n.settings.address = '@relay_ip';
          n.settings.port = '@backhaul_port';
        },
        outbound_to_local_service: (n) => {
          n.settings.port = '@final_port';
        },
      }, useVars),
    };

    const file = `configs/relay-reality-${String(tunnel?.id || 'tunnel').slice(0, 8)}.json`;

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: { [file]: emit(iranConfig, options) },
      },
      relay: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: { [file]: emit(relayConfig, options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: { [file]: emit(foreignConfig, options) },
      },
      client: {
        links: [
          {
            label: 'نقطه ورود کاربران (ایران)',
            url: `${options.listenAddress === '0.0.0.0' ? options.iranHost : options.listenAddress}:${userPort}`,
            hint: 'هر سرویسی که روی این پورت گوش می‌دهد می‌تواند جلوی سرویس محلی سرور خارج قرار بگیرد.',
          },
        ],
        instructions: [
          `کاربران به ${options.iranHost}:${userPort} وصل می‌شوند؛ مسیر ایران → رله (${relayAddress}:${relayPort}) → سرور خارج است و خروجی نهایی ${options.localServiceAddress}:${options.finalPort} روی سرور خارج.`,
          `سرورهای خارج به پورت backhaul رله (${relayAddress}:${backhaulPort}) وصل می‌شوند و هیچ پورت ورودی روی خودشان باز نمی‌کنند.`,
          `برای ناظر شبکه، هر دو پرش شبیه بازدید HTTPS از ${options.camouflageHost} است.`,
        ],
      },
      notes: [
        `جریان کاربر: ${options.iranHost}:${userPort} → reality-client → رله:${relayPort} → reality_entry → Bridge ⇄ Bridge → ReverseServer ⇄ لینک معکوس → سرور خارج → ${options.localServiceAddress}:${options.finalPort}`,
        'پرش اول یک تونل مستقیم (ایران کلاینت است) و پرش دوم یک تونل معکوس (سرور خارج کلاینت است). روی رله، RealityServer ورودی و RealityServer پشتی هر دو به ReverseServer/Bridge متصل می‌شوند.',
        'ReverseServer در رله هر کاربر را با یک لینک معکوس آزاد جفت می‌کند؛ بنابراین چند سرور خارج به‌صورت خودکار بار را تقسیم می‌کنند و با قطع شدن یکی، بقیه در مدار می‌مانند.',
        'هر دو پرش با Reality کار می‌کنند، پس هیچ گواهی TLS و هیچ دامنه‌ای روی سرورهای ایران، رله یا خارج لازم نیست.',
        'پورت‌های رله را فقط برای IP سرور ایران و IP سرورهای خارج باز کنید؛ whitelist همین کار را در خود WaterWall هم انجام می‌دهد.',
      ],
      warnings: [
        `مقصد استتار (${camouflageAddress}:${camouflagePort}) باید یک سایت HTTPS واقعی و در دسترس از رله و سرورهای خارج باشد.`,
        `SNI (${options.realitySni}) باید با گواهی مقصد استتار بخواند، وگرنه verify=true دست‌دادن را رد می‌کند.`,
        `اگر سرور ایران از IP دیگری به رله وصل می‌شود، فیلد «لیست سفید لینک ایران» را دستی پر کنید؛ وگرنه ${options.iranHost}/32 استفاده می‌شود.`,
        'سرور رله نقطهٔ شکست است: اگر رله قطع شود، همهٔ مسیرها قطع می‌شوند. برای دسترس‌پذیری بالا می‌توانید پرش اول را از طریق CDN ببرید و چند رله نگه دارید.',
        'رمزهای Reality و رمز لینک معکوس را در جای عمومی نگه ندارید.',
        'خروجی روی هر سرور خارج به سرویس محلی همان سرور اشاره می‌کند؛ مطمئن شوید آن سرویس واقعاً گوش می‌دهد.',
      ],
    };
  },
};

module.exports = [relayReality];
