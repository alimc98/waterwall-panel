#!/usr/bin/env python3
"""Live proof of the three-hop relay chain.

Topology, all on the harness bridge:

    wwiran      10.200.0.2   entry; users connect to :9443
    wwrelay     10.200.0.4   Iran leg :9443, exit backhaul :9444
    wwforeign   10.200.0.3   exit A -> 10.200.0.1:9001 (TCP echo)
    wwforeign2  10.200.0.5   exit B -> 10.200.0.1:9002 (HTTP)

What this proves:

  1. the forward Reality hop Iran -> relay comes up,
  2. each exit's reverse Reality link reaches the relay's backhaul,
  3. the relay's ReverseServer pool spreads user connections over both exits,
  4. killing exit A leaves exit B serving, killing both leaves the entry down,
  5. no core emits FATAL.

The production WaterWall, the panel and the live tunnel on the host are never
touched: everything runs in its own network namespace behind wwbr0.

    cd /root/wwrelay/remote && python3 relay.py
"""

import json
import os
import signal
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(ROOT)
OUT = os.path.join(BASE, "out-relay")
RUN = os.path.join(BASE, "run-relay")

import run  # the single-template harness: bridge, namespaces, start_core, ...

RELAY_NS = "wwrelay"
RELAY_IP = "10.200.0.4"
RELAY_MAC = "02:00:00:00:00:04"
RELAY_DEV = "wwvrelay"

EXIT2_NS = "wwforeign2"
EXIT2_IP = "10.200.0.5"
EXIT2_MAC = "02:00:00:00:00:05"
EXIT2_DEV = "wwvforeign2"

# The relay's RealityServer sends the pre-takeover TLS handshake to this local
# HTTPS decoy, so the test does not depend on outbound internet or DNS.
DECOY_PORT = 9445

with open(os.path.join(OUT, "plan.json"), encoding="utf-8") as f:
    PLAN = json.load(f)
ENTRY = PLAN["entry"]
RELAY = PLAN["relay"]
ENTRY_PORT = int(ENTRY["port"])
BACKHAUL_PORT = int(RELAY["backhaulPort"])
PROBES = int(PLAN.get("probes") or 24)

REQ = b"GET / HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n"
BAD = run.BAD


def cleanup_extras():
    for ns, dev, peer in (
        (EXIT2_NS, EXIT2_DEV, "wwpeerE"),
        (RELAY_NS, RELAY_DEV, "wwpeerR"),
    ):
        # Same safety rule as run.del_namespaces: never delete a namespace
        # that contains a real NIC.
        rc, out = run.sh(f"ip netns exec {ns} ip -d link show eth0 2>/dev/null")
        if rc == 0 and "veth" not in out:
            run.sh(f"ip netns exec {ns} ip link set eth0 netns 1")
        run.sh(f"ip netns del {ns} 2>/dev/null")
        run.sh(f"ip link del {dev} 2>/dev/null")
        run.sh(f"ip link del {peer} 2>/dev/null")


def setup_extra(ns, hostdev, peerdev, ip, mac):
    """Wire one more namespace into the shared bridge, with a pinned MAC."""
    run.sh(f"ip netns del {ns} 2>/dev/null")
    run.sh(f"ip link del {hostdev} 2>/dev/null")
    rc, out = run.sh(f"ip netns add {ns}")
    if rc != 0:
        return False, f"cannot create {ns}: {out.strip()}"
    # Do not call the host-side peer `eth0`: on a normal VPS that is the public
    # NIC, and `ip link set eth0 netns` would move the real NIC into the test
    # namespace. Create a uniquely named peer and rename it inside the netns.
    rc, out = run.sh(f"ip link add {hostdev} type veth peer name {peerdev}")
    if rc != 0:
        return False, f"cannot create veth for {ns}: {out.strip()}"
    rc, out = run.sh(f"ip link set {peerdev} netns {ns}")
    if rc != 0:
        return False, f"cannot move {peerdev} into {ns}: {out.strip()}"
    rc, out = run.sh(f"ip netns exec {ns} ip link set {peerdev} name eth0")
    if rc != 0:
        return False, f"cannot rename the peer in {ns}: {out.strip()}"
    run.sh(f"ip link set {hostdev} master {run.BRIDGE}")
    run.sh(f"ip link set {hostdev} up")
    rc, out = run.sh(f"ip -d link show {hostdev}")
    if f"master {run.BRIDGE}" not in out:
        return False, f"{hostdev} is not attached to {run.BRIDGE}: {out.strip()[:200]}"
    run.sh(f"ip netns exec {ns} ip link set eth0 address {mac}")
    run.sh(f"ip netns exec {ns} ip addr add {ip}/24 dev eth0")
    run.sh(f"ip netns exec {ns} ip link set eth0 up")
    run.sh(f"ip netns exec {ns} ip link set lo up")
    run.sh(f"ip netns exec {ns} ip route add default via {run.HOST_IP}")
    run.sh(f"ip netns exec {ns} sysctl -q -w net.ipv4.ip_forward=1")
    run.sh(f"ip netns exec {ns} iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE >/dev/null 2>&1")
    rc, out = run.sh(f"ip netns exec {ns} ip -4 addr show dev eth0")
    if ip not in out:
        return False, f"{ns} has no {ip}: {out.strip()[:200]}"
    return True, ""


def pin_all_neighbours():
    """Pin every namespace pair, not just the two that were originally paired.

    A bridge occasionally loses the first frame of a fresh port's ARP exchange;
    since both hops dial each other at startup, that loss looks like a broken
    template. Every MAC is known here, so ARP never has to be part of the test.
    """
    nodes = [
        (run.IRAN_NS, run.IRAN_IP, run.IRAN_MAC),
        (run.FOREIGN_NS, run.FOREIGN_IP, run.FOREIGN_MAC),
        (RELAY_NS, RELAY_IP, RELAY_MAC),
        (EXIT2_NS, EXIT2_IP, EXIT2_MAC),
    ]
    for ns, _ip, _mac in nodes:
        for peer_ns, peer_ip, peer_mac in nodes:
            if peer_ns == ns:
                continue
            run.sh(f"ip netns exec {ns} ip neigh replace {peer_ip} lladdr {peer_mac} dev eth0")


def deploy(name):
    src = os.path.join(OUT, name)
    dst = os.path.join(RUN, name)
    import shutil

    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst)
    os.makedirs(os.path.join(dst, "log"), exist_ok=True)
    return dst


def probe_once(timeout=6.0):
    """One user connection. Returns ('A'|'B'|'fail'|'?', detail)."""
    try:
        s = socket.create_connection((ENTRY["host"], ENTRY_PORT), timeout=timeout)
    except OSError as e:
        return "fail", str(e)
    try:
        s.settimeout(timeout)
        s.sendall(REQ)
        data = b""
        deadline = time.time() + timeout
        while time.time() < deadline and len(data) < 8192:
            try:
                chunk = s.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            data += chunk
            if data.startswith(b"HTTP/1.1") and b"HARNESS-OK" in data:
                break
            if data == REQ:
                break
        if data.startswith(b"HTTP/1.1"):
            return "B", data.split(b"\r\n", 1)[0].decode("latin-1")
        if data == REQ:
            return "A", "echo"
        return "?", data[:60].decode("latin-1", "replace")
    except OSError as e:
        return "fail", str(e)
    finally:
        try:
            s.close()
        except OSError:
            pass


def wait_ready(timeout=50.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        side, detail = probe_once()
        if side in ("A", "B"):
            return True, side
        last = f"{side}: {detail}"
        time.sleep(1)
    return False, last


def start_service():
    try:
        s = socket.create_connection((run.HOST_IP, 9001), timeout=1)
        s.close()
        return None, True
    except OSError:
        pass
    log = open(os.path.join(BASE, "svc-relay.log"), "w")
    p = subprocess.Popen(
        ["python3", os.path.join(ROOT, "svc.py")],
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    ok, why = run.wait_for_service()
    if not ok:
        stop_service(p)
        return None, why
    return p, "started"


def start_decoy():
    """Start the local HTTPS camouflage server on the bridge address."""
    log = open(os.path.join(BASE, "decoy.log"), "w")
    p = subprocess.Popen(
        [
            "python3",
            os.path.join(ROOT, "tlsdecoy.py"),
            os.path.join(run.CERT_DIR, "fullchain.pem"),
            os.path.join(run.CERT_DIR, "privkey.pem"),
            run.HOST_IP,
            str(DECOY_PORT),
        ],
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.time() + 8
    while time.time() < deadline:
        try:
            s = socket.create_connection((run.HOST_IP, DECOY_PORT), timeout=1)
            s.close()
            return p
        except OSError:
            time.sleep(0.3)
    stop_service(p)
    return None


def stop_service(p):
    if not p:
        return
    try:
        os.killpg(os.getpgid(p.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass


def fatal_lines(side_dir):
    text = run.read_console(side_dir)
    return [ln.strip() for ln in text.splitlines() if BAD.search(ln)]


def main():
    result = {"id": PLAN["id"], "steps": [], "ok": False}
    procs = {}
    dirs = {}
    svc = None
    decoy = None

    try:
        run.ensure_cert()
        os.makedirs(RUN, exist_ok=True)
        cleanup_extras()
        run.del_namespaces()
        run.del_bridge()
        run.ensure_bridge()
        run.enable_nat()

        decoy = start_decoy()
        if not decoy:
            result["error"] = f"the HTTPS decoy never came up on {run.HOST_IP}:{DECOY_PORT}"
            return result

        svc, svc_state = start_service()
        if not svc and svc_state is not True:
            result["error"] = f"test service: {svc_state}"
            return result
        result["service"] = svc_state

        ok, err = run.setup_netns()
        if not ok:
            result["error"] = err
            return result
        ok, err = setup_extra(RELAY_NS, RELAY_DEV, "wwpeerR", RELAY_IP, RELAY_MAC)
        if not ok:
            result["error"] = err
            return result
        ok, err = setup_extra(EXIT2_NS, EXIT2_DEV, "wwpeerE", EXIT2_IP, EXIT2_MAC)
        if not ok:
            result["error"] = err
            return result
        pin_all_neighbours()

        dirs["iran"] = deploy("iran")
        dirs["relay"] = deploy("relay")
        dirs["a"] = deploy("exit-a")
        dirs["b"] = deploy("exit-b")

        # The relay listens on both ports before either side dials it. Starting
        # the dialers first loses the first connection for tens of seconds.
        procs["relay"] = run.start_core(RELAY_NS, dirs["relay"])
        run.wait_for_config_load(dirs["relay"])
        time.sleep(1.0)
        result["relayListeners"] = run.listeners_in(RELAY_NS)
        if ENTRY_PORT not in result["relayListeners"] or BACKHAUL_PORT not in result["relayListeners"]:
            result["error"] = (
                f"the relay never bound :{ENTRY_PORT} and :{BACKHAUL_PORT}; "
                f"listeners={result['relayListeners']}"
            )
            return result

        procs["iran"] = run.start_core(run.IRAN_NS, dirs["iran"])
        run.wait_for_config_load(dirs["iran"])
        time.sleep(1.0)
        result["entryListeners"] = run.listeners_in(run.IRAN_NS)
        if ENTRY_PORT not in result["entryListeners"]:
            result["error"] = f"the entry never bound :{ENTRY_PORT}; listeners={result['entryListeners']}"
            return result

        # Start exit A alone first. This proves the forward hop and the reverse
        # backhaul with one exit before the second one can influence the pool.
        procs["a"] = run.start_core(run.FOREIGN_NS, dirs["a"])
        run.wait_for_config_load(dirs["a"])
        time.sleep(1.0)

        ready, detail = wait_ready()
        result["steps"].append({"step": "three-hop tunnel up with exit A", "ok": ready, "detail": detail})
        if not ready:
            result["error"] = f"exit A never served a connection: {detail}"
            return result

        alone = {"A": 0, "B": 0, "fail": 0, "?": 0}
        for _ in range(6):
            side, detail = probe_once()
            if side == "?":
                side, detail = probe_once(timeout=10.0)
            alone[side] = alone.get(side, 0) + 1
            time.sleep(0.15)
        result["exitAlone"] = alone
        result["steps"].append(
            {
                "step": "exit A alone serves users through the relay",
                "ok": alone["A"] > 0 and alone["fail"] == 0 and alone["?"] == 0,
                "detail": json.dumps(alone),
            }
        )

        # Now add exit B. Both exits are in the relay's ReverseServer pool.
        procs["b"] = run.start_core(EXIT2_NS, dirs["b"])
        run.wait_for_config_load(dirs["b"])
        time.sleep(2.0)

        counts = {"A": 0, "B": 0, "fail": 0, "?": 0}
        unknown = []
        for _ in range(PROBES):
            side, detail = probe_once()
            if side == "?":
                # A new reverse link can be accepted a moment before its local
                # side is ready. A real client retries; do the same once before
                # calling the tunnel broken.
                side, detail = probe_once(timeout=10.0)
                if side == "?":
                    unknown.append(detail)
            counts[side] = counts.get(side, 0) + 1
            time.sleep(0.15)
        spread = counts["A"] > 0 and counts["B"] > 0
        result["spread"] = counts
        result["unknown"] = unknown
        result["steps"].append(
            {
                "step": f"{PROBES} user connections reach both exits through the relay",
                "ok": spread and counts["fail"] == 0 and not unknown,
                "detail": json.dumps(counts) + (f" unknown={unknown}" if unknown else ""),
            }
        )

        # ---- failover: kill exit A ----------------------------------------
        run.stop_core(*procs.pop("a"))
        time.sleep(2)
        a_after = {"A": 0, "B": 0, "fail": 0, "?": 0}
        served = 0
        deadline = time.time() + 25
        while time.time() < deadline and served < 5:
            side, _d = probe_once()
            if side == "?":
                side, _d = probe_once(timeout=10.0)
            a_after[side] = a_after.get(side, 0) + 1
            if side in ("A", "B"):
                served += 1
            else:
                time.sleep(1)
        result["afterExitA"] = a_after
        result["steps"].append(
            {
                "step": "relay failover: exit A killed, exit B keeps serving",
                "ok": served >= 5 and a_after["A"] == 0,
                "detail": json.dumps(a_after),
            }
        )

        # ---- negative check: kill exit B too ------------------------------
        run.stop_core(*procs.pop("b"))
        time.sleep(3)
        after = {"A": 0, "B": 0, "fail": 0, "?": 0}
        for _ in range(3):
            side, _d = probe_once(timeout=5.0)
            after[side] = after.get(side, 0) + 1
            time.sleep(1)
        down = after["fail"] + after["?"]
        result["afterBoth"] = after
        result["steps"].append(
            {
                "step": "both exits killed: the three-hop path is down (no false positive)",
                "ok": down == 3,
                "detail": json.dumps(after),
            }
        )

        # ---- logs ----------------------------------------------------------
        result["fatal"] = {}
        for name, d in dirs.items():
            bad = [ln for ln in fatal_lines(d) if "FATAL" in ln]
            if bad:
                result["fatal"][name] = bad[:5]
        result["steps"].append(
            {
                "step": "no FATAL in any of the four cores",
                "ok": not result["fatal"],
                "detail": json.dumps(result["fatal"]),
            }
        )

        result["ok"] = all(s["ok"] for s in result["steps"])
        return result
    finally:
        for p in list(procs.values()):
            try:
                run.stop_core(*p)
            except Exception:  # noqa: BLE001
                pass
        cleanup_extras()
        run.del_namespaces()
        run.del_bridge()
        stop_service(svc)
        stop_service(decoy)
        run.disable_nat()


if __name__ == "__main__":
    res = main()
    out = os.path.join(BASE, "relay-result.json")
    try:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=2, ensure_ascii=False)
    except OSError:
        pass
    for step in res.get("steps", []):
        print(f"[{'OK  ' if step['ok'] else 'FAIL'}] {step['step']}: {step['detail']}")
    if res.get("error"):
        print(f"ERROR: {res['error']}")
    print(json.dumps(res, ensure_ascii=False))
    print(f"\nwrote {out}")
    sys.exit(0 if res.get("ok") else 1)
