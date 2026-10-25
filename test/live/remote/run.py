#!/usr/bin/env python3
"""Run every generated template against the real WaterWall core, both halves
at once, and drive traffic through it.

Layout on the box:

    host 10.200.0.1        svc.py   (tcp/udp echo, http)
    netns wwiran 10.200.0.2    the Iran side of every template
    netns wwforeign 10.200.0.3 the far side

Each template is a clean run: the namespaces are built from scratch, both
cores are started in their own namespace, the entry point is probed with real
traffic, and everything is torn down again. Running both halves on one machine
is safe here because a namespace has its own loopback, its own ports and its
own routing table, so no template can disturb the live tunnel or the host.

    python3 run.py [templateId ...]
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
# Bundles, logs and results live one level up, next to the uploaded scripts.
BASE = os.path.dirname(ROOT)
OUT = os.path.join(BASE, "out")
RUN = os.path.join(BASE, "run")
# The core to test against. The environment wins over the default so a box
# that keeps its binary somewhere else can be pointed at it without editing
# this file: `WATERWALL_CORE=/opt/waterwall-2/Waterwall python3 run.py`.
# A path that does not exist is caught here rather than as the core's own
# "exec of "" failed", which says nothing about what went wrong.
CORE = os.environ.get("WATERWALL_CORE", "").strip() or "/opt/waterwall/Waterwall"
IRAN_NS = "wwiran"
FOREIGN_NS = "wwforeign"
IRAN_IP = "10.200.0.2"
FOREIGN_IP = "10.200.0.3"
HOST_IP = "10.200.0.1"
# Pinned by setup_netns; see the comment there. Two ports of one bridge must
# never share a MAC address.
IRAN_MAC = "02:00:00:00:00:02"
FOREIGN_MAC = "02:00:00:00:00:03"
CERT_DIR = os.path.join(BASE, "cert")

BAD = re.compile(r"\b(FATAL|ERROR|CRITICAL)\b")


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60, **kw)


def sh(cmd):
    """Run a shell command, return (rc, stdout+stderr)."""
    try:
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "timeout"


BRIDGE = "wwbr0"
# Every rule the harness adds carries this comment so cleanup can find exactly
# what it added and nothing else.
NAT_TAG = "ww-harness"
# Masquerade every private source, not just the harness subnet: a full-tunnel
# template hands its TUN a 10.x address of its own (10.77.0.0/24 for the
# WireGuard one, 10.66.0.0/24 for the packets-over-TLS one) and those packets
# have to leave the box as the box's own address, or the reply has nowhere to
# go and the tunnel looks dead from the inside.
PRIVATE_SOURCES = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")


def nat_specs():
    out = []
    for src in PRIVATE_SOURCES:
        out.append(f"-t nat -A POSTROUTING -s {src} -m comment --comment {NAT_TAG} -j MASQUERADE")
        out.append(f"-A FORWARD -s {src} -m comment --comment {NAT_TAG} -j ACCEPT")
        out.append(f"-A FORWARD -d {src} -m comment --comment {NAT_TAG} -j ACCEPT")
    return out


def purge_nat():
    """Delete every rule this harness ever added, whatever version added it.

    Cleanup by exact spec leaves rules behind as soon as the specs change, and
    a stale masquerade rule from an older run silently changes what a template
    under test is actually allowed to do.
    """
    for table in ("", "-t nat"):
        rc, out = sh(f"iptables {table} -S 2>/dev/null")
        for line in out.splitlines():
            if NAT_TAG in line and line.startswith("-A"):
                sh(f"iptables {table} {line.replace('-A', '-D', 1)} 2>/dev/null")


def enable_nat():
    """Let the test namespaces reach the internet.

    Two reasons: templates that dial a DNS name (a Reality decoy, a CDN edge)
    cannot be exercised without name resolution, and the raw-socket family
    installs firewall rules of its own. Only private sources are masqueraded:
    nothing here touches the host's own traffic.
    """
    sh("sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1")
    purge_nat()
    for spec in nat_specs():
        check = spec.replace(" -A ", " -C ", 1)
        sh(f"iptables {check} 2>/dev/null || iptables {spec}")


def disable_nat():
    purge_nat()


def del_namespaces():
    for ns in (IRAN_NS, FOREIGN_NS):
        # A test namespace must only ever hold the veth we created. If a real
        # NIC somehow ended up inside it (an older harness used the host-side
        # peer name `eth0`), deleting the namespace would destroy that NIC.
        # Move it back to the root namespace first, then delete the namespace.
        rc, out = sh(f"ip netns exec {ns} ip -d link show eth0 2>/dev/null")
        if rc == 0 and "veth" not in out:
            sh(f"ip netns exec {ns} ip link set eth0 netns 1")
        # Removing a namespace takes its end of the veth pair with it.
        sh(f"ip netns del {ns} 2>/dev/null")


def del_bridge():
    sh(f"ip link del {BRIDGE} 2>/dev/null")
    for dev in ("wwviran", "wwvforeign", "wwpeer0", "wwpeer1"):
        sh(f"ip link del {dev} 2>/dev/null")


def ensure_bridge():
    """Create the shared segment once, before the service binds to it.

    Both halves are bridged rather than given overlapping /24s: with two host
    interfaces claiming the same subnet the kernel picks one arbitrarily and
    half the harness's own traffic lands in the wrong namespace. The bridge
    also holds the service address, so it has to exist before svc.py starts.
    """
    rc, _ = sh(f"ip link show {BRIDGE}")
    if rc != 0:
        sh(f"ip link add {BRIDGE} type bridge")
    sh(f"ip addr replace {HOST_IP}/24 dev {BRIDGE}")
    sh(f"ip link set {BRIDGE} up")


def del_host_veths():
    """Host-side leftovers of a namespace pair.

    Deleting a namespace normally takes its end of the veth with it, but a
    device that is still busy can survive, and then the next
    `ip link add ... type veth peer name wwpeer0` fails with "File exists" and
    the namespace ends up with no eth0 at all. That failure is invisible until a
    probe much later reports "Network is unreachable", so it is cleaned here
    and checked for below.
    """
    for dev in ("wwviran", "wwvforeign", "wwpeer0", "wwpeer1"):
        sh(f"ip link del {dev} 2>/dev/null")


def setup_netns():
    # The bridge is the shared segment; re-create it if anything ever removed
    # it. Without it the two namespaces are wired to nothing and every dial
    # between them times out, which reads as a broken template.
    ensure_bridge()
    del_namespaces()
    del_host_veths()
    for ns in (IRAN_NS, FOREIGN_NS):
        rc, out = sh(f"ip netns add {ns}")
        if rc != 0:
            return False, f"cannot create namespace {ns}: {out.strip()}"

    pairs = [
        (IRAN_NS, "wwviran", "wwpeer0", IRAN_IP, IRAN_MAC),
        (FOREIGN_NS, "wwvforeign", "wwpeer1", FOREIGN_IP, FOREIGN_MAC),
    ]
    for ns, hostdev, peerdev, ip, mac in pairs:
        out = ""
        for _ in range(3):
            # Never use `eth0` as the host-side peer name: on a normal VPS the
            # public NIC is already called eth0, and `ip link set eth0 netns`
            # would move the real NIC into the test namespace. The peer is
            # created under a unique name and renamed to eth0 *inside* the
            # namespace, where it cannot collide with the host.
            rc, out = sh(f"ip link add {hostdev} type veth peer name {peerdev}")
            if rc != 0:
                time.sleep(0.5)
                continue
            rc, out = sh(f"ip link set {peerdev} netns {ns}")
            if rc == 0:
                rc, out = sh(f"ip netns exec {ns} ip link set {peerdev} name eth0")
                if rc == 0:
                    break
            sh(f"ip link del {hostdev} 2>/dev/null")
            time.sleep(0.5)
        else:
            return False, f"cannot wire {ns}: {out.strip()[:200]}"
        sh(f"ip link set {hostdev} master {BRIDGE}")
        sh(f"ip link set {hostdev} up")
        rc, out = sh(f"ip -d link show {hostdev}")
        if f"master {BRIDGE}" not in out:
            return False, f"{hostdev} is not attached to {BRIDGE}: {out.strip()[:200]}"
        # A fresh veth pair can come up with the *same* address on both ends.
        # One bridge, two ports, one MAC: the forwarding database keeps
        # overwriting the entry and sends every frame to whichever port was
        # learned last, so one direction is blackholed and the link times out
        # at random. The addresses are pinned instead.
        sh(f"ip netns exec {ns} ip link set eth0 address {mac}")
        sh(f"ip netns exec {ns} ip addr add {ip}/24 dev eth0")
        # Kernel forwarding is off by default in a fresh namespace, and the
        # host's setting does not reach inside it. A template whose far side
        # forwards what arrives on its TUN (the full-tunnel ones) is silently
        # dead without this: the core decrypts, writes the packet into the TUN,
        # and the kernel drops it on the way out.
        sh(f"ip netns exec {ns} sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1")
        # ...and forwarding without a masquerade rule only half works. The
        # host's own masquerade sits one hop too far out: conntrack hands the
        # reply back as the inner address (10.77.0.1), which the host has no
        # route to, so it leaks out the default route and the tunnel looks dead
        # from the inside. A real server masquerades the tunnel subnet on its
        # own public interface; the harness does the same inside the namespace.
        sh(f"ip netns exec {ns} iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE >/dev/null 2>&1")
        sh(f"ip netns exec {ns} ip link set eth0 up")
        sh(f"ip netns exec {ns} ip link set lo up")
        # Default route out through the bridge, masqueraded by the host.
        sh(f"ip netns exec {ns} ip route add default via {HOST_IP}")
        # A namespace is its own network stack: forwarding has to be enabled
        # inside it for the tunnel to carry traffic out the far side.
        sh(f"ip netns exec {ns} sysctl -q -w net.ipv4.ip_forward=1")
        rc, out = sh(f"ip netns exec {ns} ip -4 addr show dev eth0")
        if ip not in out:
            return False, f"{ns} has no {ip} on eth0: {out.strip()[:200]}"

    # Pin the two MAC addresses into each other's neighbour table.
    #
    # A fresh namespace pair sometimes cannot resolve the other side: the first
    # frame the bridge should forward is lost, ARP never completes, and the
    # Iran core's very first dial fails with "No route to host". WaterWall
    # retries that dial on its own schedule — tens of seconds for an
    # authentication client — so one lost ARP looks exactly like a tunnel that
    # does not work. The MACs are known here, so ARP does not have to be part
    # of the test.
    mac = {}
    for ns in (IRAN_NS, FOREIGN_NS):
        rc, out = sh(f"ip netns exec {ns} cat /sys/class/net/eth0/address")
        mac[ns] = out.strip()
        if rc != 0 or not mac[ns]:
            return False, f"cannot read the MAC of {ns}: {out.strip()[:160]}"
    if mac[IRAN_NS] == mac[FOREIGN_NS]:
        # The bridge would send every frame to one port. Fail loudly instead of
        # letting the template blame the tunnel.
        return False, f"both namespaces share the MAC {mac[IRAN_NS]}; the bridge cannot separate them"
    sh(f"ip netns exec {IRAN_NS} ip neigh replace {FOREIGN_IP} lladdr {mac[FOREIGN_NS]} dev eth0")
    sh(f"ip netns exec {FOREIGN_NS} ip neigh replace {IRAN_IP} lladdr {mac[IRAN_NS]} dev eth0")
    return True, ""


def wait_for_service(timeout=15.0):
    """The service must be answering before any template is judged."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = probe("tcp", HOST_IP, 9001, "")
        if r.get("ok"):
            return True, ""
        time.sleep(0.5)
    return False, "the test service never came up on 10.200.0.1:9001"


def ensure_cert():
    """Put the throwaway certificate where the generated configs look for it.

    The configs name their certificate file in one of two ways: the generator
    overrides it with a throwaway path, while some templates keep the
    template's own default. Both paths have to hold a certificate, or the
    core refuses to start with "ssl certificate file error" and the template
    is reported as broken when only the path was wrong.

    The paths are read out of the generated configs themselves rather than
    hard-coded here, so a new template that names a different path works
    without touching this file.
    """
    os.makedirs(CERT_DIR, exist_ok=True)
    full, key = os.path.join(CERT_DIR, "fullchain.pem"), os.path.join(CERT_DIR, "privkey.pem")
    if not (os.path.exists(full) and os.path.exists(key)):
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
                "-keyout", key, "-out", full,
                "-subj", "/CN=example.com",
                "-addext", "subjectAltName=DNS:example.com",
            ],
            capture_output=True,
            check=True,
        )
    for cert_path, key_path in cert_paths_in_configs():
        for src, dst in ((full, cert_path), (key, key_path)):
            if os.path.abspath(src) == os.path.abspath(dst):
                continue
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copyfile(src, dst)
            except OSError as exc:
                print(f"WARN: cannot place the certificate at {dst}: {exc}", flush=True)


def cert_paths_in_configs():
    """Every (cert, key) pair the generated configs name.

    The keys are the ones WaterWall reads: "cert-file" and "key-file" in the
    node settings. A pair is only used when both halves are present, so a
    config that names only a certificate does not send the harness looking for
    a key that was never mentioned.
    """
    pairs = set()
    for tpl in sorted(os.listdir(OUT)):
        cfg_root = os.path.join(OUT, tpl)
        if not os.path.isdir(cfg_root):
            continue
        for side in ("iran", "foreign"):
            cfg_dir = os.path.join(cfg_root, side, "configs")
            if not os.path.isdir(cfg_dir):
                continue
            for fn in os.listdir(cfg_dir):
                if not fn.endswith(".json"):
                    continue
                text = open(os.path.join(cfg_dir, fn), encoding="utf-8", errors="replace").read()
                cert = re.search(r'"cert-file"\s*:\s*"([^"]+)"', text)
                key = re.search(r'"key-file"\s*:\s*"([^"]+)"', text)
                if cert and key:
                    pairs.add((cert.group(1), key.group(1)))
    return sorted(pairs)


def start_core(ns, side_dir, verbose=False):
    log = open(os.path.join(side_dir, "console.log"), "w")
    args = [CORE, "--config:core.json"]
    if verbose:
        # The core reports many data-path problems only at this level, and a
        # tunnel that silently carries nothing is otherwise unexplained.
        args.append("--verbose")
    p = subprocess.Popen(
        ["ip", "netns", "exec", ns] + args,
        cwd=side_dir,
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    return p, log


def stop_core(p, log):
    if p is None:
        return
    try:
        os.killpg(os.getpgid(p.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        p.wait(timeout=6)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            p.wait(timeout=4)
        except subprocess.TimeoutExpired:
            pass
    try:
        log.close()
    except Exception:  # noqa: BLE001
        pass


def read_console(side_dir):
    """Everything the core said: its stdout plus the log files it writes.

    stdout alone is not enough — the core block-buffers it when it is not a
    terminal, so the interesting lines sit in the buffer while the process is
    still running.
    """
    parts = []
    try:
        with open(os.path.join(side_dir, "console.log"), encoding="utf-8", errors="replace") as f:
            parts.append(f.read())
    except OSError:
        pass
    logdir = os.path.join(side_dir, "log")
    if os.path.isdir(logdir):
        for name in sorted(os.listdir(logdir)):
            try:
                with open(os.path.join(logdir, name), encoding="utf-8", errors="replace") as f:
                    parts.append(f.read())
            except OSError:
                continue
    return "\n".join(parts)


def routes_in(ns):
    rc, out = sh(f"ip netns exec {ns} ip route show")
    return out.strip().splitlines() if rc == 0 else []


def listeners_in(ns):
    rc, out = sh(f"ip netns exec {ns} ss -lntuH 2>/dev/null || ip netns exec {ns} ss -lntu")
    ports = set()
    for line in out.splitlines():
        parts = line.split()
        for token in parts:
            if ":" in token and any(c.isdigit() for c in token):
                port = token.rsplit(":", 1)[-1]
                if port.isdigit():
                    ports.add(int(port))
    return sorted(ports)


def tun_device_in(ns):
    """The TUN interface the core created, if any.

    Read from the live namespace rather than from the plan: device names are
    per-template overrides and one template may create more than one device.
    """
    rc, out = sh(f"ip netns exec {ns} ip -o link show")
    if rc != 0:
        return None
    for line in out.splitlines():
        fields = line.split(":")
        if len(fields) < 3:
            continue
        name = fields[1].strip().split("@")[0]
        if name in ("lo", "eth0"):
            continue
        if "POINTOPOINT" in line or name.startswith(("wt", "wwtun", "tun")):
            return name
    return None


def probe(proto, host, port, extra, in_ns=None):
    cmd = ["python3", os.path.join(ROOT, "probe.py"), proto, str(host), str(port)]
    if extra:
        cmd.append(extra)
    if in_ns:
        cmd = ["ip", "netns", "exec", in_ns] + cmd
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return {"ok": False, "detail": f"{proto} probe timed out"}
    for line in reversed((p.stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return {"ok": False, "detail": f"{proto} probe produced no result: {(p.stderr or '').strip()[:200]}"}


TUN_NAMES = re.compile(r"\b(wtun\d+|wwtun\d+|wt\d+)\b")


def wait_for_config_load(side_dir, timeout=8.0):
    """Wait until this side has loaded its config and bound its listeners.

    The far side starts first because it is the side that gets dialled — not
    only per connection but at start-up (an authentication client pulls its
    user table, a reverse server is called back to). Started the other way
    round the first dial lands before the listener exists, and WaterWall does
    not dial again for up to a minute, which reads exactly like a dead tunnel.
    A client-only side has no listener line to wait for and does not need one.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = read_console(side_dir)
        if "parsing config file" in text and "complete" in text:
            time.sleep(0.4)  # listeners bind right after the parse line
            return True
        if BAD.search(text):
            return True  # it already failed, there is nothing to wait for
        time.sleep(0.15)
    return False


WARM_PORT = 19999


def warm_link(timeout=6.0):
    """Open one plain TCP connection from the Iran namespace to the foreign one.

    Both namespaces are brand new, and the first connection between them can
    fail while ARP and the bridge settle. Nothing in a template retries that
    fast, so one lost handshake at start-up would otherwise be reported as a
    broken template. Never raises: the outcome is recorded on the result.
    """
    script = os.path.join(ROOT, "warm.py")
    listener = subprocess.Popen(
        ["ip", "netns", "exec", FOREIGN_NS, "python3", script, "listen", str(WARM_PORT), str(timeout + 2)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    time.sleep(0.4)  # the listener has to be bound before the first attempt
    _, out = sh(f"ip netns exec {IRAN_NS} python3 {script} connect {FOREIGN_IP} {WARM_PORT} {timeout}")
    listener.terminate()
    try:
        listener.wait(timeout=5)
    except subprocess.TimeoutExpired:
        listener.kill()
    for line in reversed(out.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if data.get("ok"):
            return True, f"up after {data.get('ms')} ms ({data.get('attempts')} attempt(s))"
        return False, f"no connection in {data.get('attempts')} attempts: {data.get('error')}"
    return False, f"warm-up produced no result: {out.strip()[:120]}"


def run_template(tpl_id, plan, only_probe=False, verbose=False):
    src = os.path.join(OUT, tpl_id)
    result = {"id": tpl_id, "startup": {}, "routes": {}, "probes": [], "errors": [], "ok": False}

    # Log-reading plans need the debug lines the core only prints with -v.
    verbose = verbose or bool(plan.get("logPattern"))

    ok, err = setup_netns()
    if not ok:
        result["errors"].append(err)
        return result

    warm_ok, warm_detail = warm_link()
    if not warm_ok:
        # A fresh namespace pair occasionally comes up unable to reach its peer
        # (a lost first frame, a bridge port the bridge has not learned yet).
        # Rebuilding is seconds; a template judged against a dead link is a
        # false failure that reads exactly like a tunnel bug.
        result["errors"].append(f"harness link not up, rebuilding: {warm_detail}")
        _, neigh = sh(f"ip netns exec {IRAN_NS} ip neigh show dev eth0")
        _, routes = sh(f"ip netns exec {IRAN_NS} ip route show")
        result["linkDiag"] = f"neigh: {neigh.strip()[:160]} | routes: {routes.strip()[:200]}"
        ok, err = setup_netns()
        if ok:
            warm_ok, warm_detail = warm_link(timeout=10.0)
    result["link"] = warm_detail
    if not warm_ok:
        result["errors"].append(f"harness link not up: {warm_detail}")

    procs = {}
    dirs = {}
    for side in ("foreign", "iran"):
        side_src = os.path.join(src, side)
        if not os.path.isdir(side_src):
            continue
        side_dir = os.path.join(RUN, tpl_id, side)
        shutil.rmtree(side_dir, ignore_errors=True)
        shutil.copytree(side_src, side_dir)
        os.makedirs(os.path.join(side_dir, "log"), exist_ok=True)
        ns = IRAN_NS if side == "iran" else FOREIGN_NS
        procs[side] = start_core(ns, side_dir, verbose=verbose)
        dirs[side] = side_dir
        wait_for_config_load(side_dir)

    time.sleep(1.5)

    for side, (p, log) in procs.items():
        exited = p.poll() is not None
        text = read_console(dirs[side])
        bad = [ln.strip() for ln in text.splitlines() if BAD.search(ln)]
        ns = IRAN_NS if side == "iran" else FOREIGN_NS
        result["startup"][side] = {
            "exitedEarly": bool(exited),
            "exitCode": p.returncode if exited else None,
            "listeners": listeners_in(ns),
            "badLines": bad[:8],
        }
        result["errors"].extend(f"{side}: {b}" for b in bad[:8])
        result["routes"][side] = routes_in(ns)

    # A template that installs a default route through its own TUN takes the
    # whole server off the internet when the tunnel stops working.
    for side, lines in result["routes"].items():
        for ln in lines:
            low = ln.lower()
            if low.startswith("default") and TUN_NAMES.search(low):
                result["errors"].append(
                    f"{side}: INSTALLED A DEFAULT ROUTE THROUGH THE TUNNEL -> {ln.strip()}"
                )

    # A full-tunnel template must not move the namespace's default route on its
    # own (that is what takes a live server off the internet), so the harness
    # does not rely on one either: it points the probe's traffic at the TUN
    # itself and removes the other way out. A pass now means the packet really
    # travelled through the tunnel.
    if any(t["proto"] == "tun-web" for t in plan.get("tests", [])):
        dev = tun_device_in(IRAN_NS)
        if dev:
            sh(f"ip netns exec {IRAN_NS} ip route del default 2>/dev/null")
            rc, out = sh(f"ip netns exec {IRAN_NS} ip route replace default dev {dev}")
            result["tunRoute"] = f"default dev {dev}" if rc == 0 else f"unusable: {out.strip()[:120]}"
            if rc != 0:
                result["errors"].append(f"iran: cannot route through {dev}: {out.strip()[:120]}")
        else:
            result["tunRoute"] = "no TUN interface"
            result["errors"].append("iran: the core started but created no TUN interface")

    for t in plan.get("tests", []):
        # A dual-stack listener needs driving twice, once per protocol.
        protos = ["tcp", "udp"] if t["proto"] == "tcp+udp" else [t["proto"]]
        for proto in protos:
            extra = ""
            if proto in ("socks5", "socks5-auth"):
                creds = ""
                if proto == "socks5-auth":
                    creds = t.get("creds", "user:CHANGEME")
                extra = f"{plan['target']} {creds}".strip()
            elif proto == "http":
                extra = f"http://{plan['httpTarget']}/"
            elif proto == "tun-web":
                extra = t.get("target", "1.1.1.1:80")

            # Keep hammering until the deadline rather than a fixed number of
            # tries: a template whose far side retries on its own schedule (an
            # authentication client, a reverse server) can legitimately need
            # tens of seconds, and that budget belongs to the plan.
            deadline = time.time() + float(plan.get("probeSeconds") or 12)
            attempt = 0
            got = None
            while True:
                attempt += 1
                got = probe(proto, t["host"], t["port"], extra, in_ns=IRAN_NS if t.get("inNamespace") else None)
                if got.get("ok") or time.time() >= deadline:
                    break
                time.sleep(2)
            got["proto"] = proto
            got["side"] = t["side"]
            got["port"] = t["port"]
            got["attempts"] = attempt
            result["probes"].append(got)

    if plan.get("logPattern"):
        # A log line can arrive well after the data path is up: a speed test
        # reports when its run finishes, not when it starts. Wait for the line
        # instead of sampling the log once and calling that a failure.
        pat = re.compile(plan["logPattern"])
        deadline = time.time() + float(plan.get("logSeconds") or 25)
        matched = False
        while not matched and time.time() < deadline:
            for side in ("iran", "foreign"):
                text = read_console(dirs.get(side, ""))
                # Only a clean line counts: a plan names the node that has to
                # report success, and half of what that node logs is the
                # failure it exists to detect ("TesterClient: worker 0 failed").
                hits = [ln.strip() for ln in text.splitlines() if pat.search(ln) and not BAD.search(ln)]
                if hits:
                    result["probes"].append(
                        {"proto": "log", "side": side, "ok": True, "detail": f"{len(hits)} lines matched {plan['logPattern']}: {hits[-1][:160]}"}
                    )
                    matched = True
                    break
            if not matched:
                time.sleep(1)
        if not matched:
            result["probes"].append({"proto": "log", "side": "-", "ok": False, "detail": f"nothing in the logs matched {plan['logPattern']}"})

    for side in procs:
        stop_core(*procs[side])

    fatal = [e for e in result["errors"] if "FATAL" in e]
    probes_ok = all(p.get("ok") for p in result["probes"]) if result["probes"] else True
    # A core that exits with 0 finished on purpose: TesterClient and
    # SpeedTestClient are their own driver and end the process once the
    # measurement is done. Only a non-zero exit is a failure.
    started = (
        all((not v["exitedEarly"]) or v["exitCode"] == 0 for v in result["startup"].values())
        if result["startup"]
        else False
    )
    if probes_ok and not fatal and started:
        result["ok"] = True
    result["probeResult"] = probes_ok
    result["startupResult"] = started
    if not result["ok"]:
        # A tunnel that carries nothing is the least diagnosable failure there
        # is: nothing FATAL, every listener bound. Keep the tail of both cores'
        # logs so the reason is in the report instead of only in this run.
        result["tail"] = {}
        for side in procs:
            text = read_console(dirs[side])
            result["tail"][side] = "\n".join(text.splitlines()[-120:])
    return result


def main(argv):
    # Accept "a,b,c" as well as "a b c": the Windows driver passes one string.
    args = [x for chunk in argv[1:] for x in chunk.split(",") if x]
    # A flag rather than a template id: `--verbose` matches no directory, so it
    # can travel through the same comma list.
    verbose = "--verbose" in args
    ids = [x for x in args if not x.startswith("-")]
    # The core is what every template is judged against. A wrong or empty
    # path makes all of them fail with "Connection refused", which reads as a
    # broken template rather than a broken setup — so it is checked first and
    # said plainly.
    if not (os.path.isfile(CORE) and os.access(CORE, os.X_OK)):
        print(f"FATAL: the WaterWall core is not runnable at {CORE}", flush=True)
        return 2
    ensure_cert()
    os.makedirs(RUN, exist_ok=True)
    del_bridge()
    del_namespaces()
    ensure_bridge()
    enable_nat()

    svc = subprocess.Popen(
        ["python3", os.path.join(ROOT, "svc.py")],
        stdout=open(os.path.join(BASE, "svc.log"), "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    ready, why = wait_for_service()
    if not ready:
        print(f"FATAL: {why}", flush=True)
        try:
            os.killpg(os.getpgid(svc.pid), signal.SIGTERM)
        except Exception:  # noqa: BLE001
            pass
        return 1

    templates = sorted(os.listdir(OUT))
    if ids:
        templates = [t for t in templates if t in ids]

    results = []
    try:
        for tpl in templates:
            with open(os.path.join(OUT, tpl, "plan.json"), encoding="utf-8") as f:
                plan = json.load(f)
            r = run_template(tpl, plan, verbose=verbose)
            r["titleFa"] = plan.get("titleFa")
            r["loadOnly"] = plan.get("loadOnly")
            r["reason"] = plan.get("reason")
            results.append(r)
            flag = "OK  " if r["ok"] else ("LOAD" if r["loadOnly"] else "FAIL")
            detail = "; ".join(p["detail"] for p in r["probes"]) or (r["reason"] or "")
            print(f"[{flag}] {tpl:26} {detail[:110]}", flush=True)
            for e in r["errors"][:3]:
                print(f"        ! {e[:150]}", flush=True)
            with open(os.path.join(BASE, "results.json"), "w", encoding="utf-8") as f:
                json.dump(results, f, indent=2, ensure_ascii=False)
    finally:
        try:
            os.killpg(os.getpgid(svc.pid), signal.SIGTERM)
        except Exception:  # noqa: BLE001
            pass
        del_namespaces()
        del_bridge()
        disable_nat()

    ok = sum(1 for r in results if r["ok"])
    print(f"\n{ok}/{len(results)} templates passed\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))


