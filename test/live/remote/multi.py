#!/usr/bin/env python3
"""Live proof of a multi-exit reverse tunnel.

One Iran entry, two exits on the same bridge. The exits run the same template
but forward to different local services, so every connection can be attributed:

    wwiran      10.200.0.2   entry; users connect to :9443
    wwforeign   10.200.0.3   exit A -> 10.200.0.1:9001 (TCP echo)
    wwforeign2  10.200.0.4   exit B -> 10.200.0.1:9002 (HTTP)

What this proves:

  1. the ReverseServer pool pairs users with *both* clients (load sharing),
  2. killing exit A does not stop the tunnel — exit B keeps serving,
  3. killing exit B too does stop it (so (2) cannot be a false positive).

The production WaterWall, the panel and the live tunnel on the host are never
touched: everything runs in its own network namespace behind wwbr0.

    cd /root/wwmulti/remote && python3 multi.py
"""

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(ROOT)
OUT = os.path.join(BASE, "out-multi")
RUN = os.path.join(BASE, "run-multi")

import run  # the single-template harness: bridge, namespaces, start_core, ...

THIRD_NS = "wwforeign2"
THIRD_IP = "10.200.0.4"
THIRD_MAC = "02:00:00:00:00:04"
THIRD_DEV = "wwvforeign2"

with open(os.path.join(OUT, "plan.json"), encoding="utf-8") as f:
    PLAN = json.load(f)
ENTRY = PLAN["entry"]
ENTRY_PORT = int(ENTRY["port"])
PROBES = int(PLAN.get("probes") or 24)

REQ = b"GET / HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n"
BAD = run.BAD


def cleanup_third():
    run.sh(f"ip netns del {THIRD_NS} 2>/dev/null")
    run.sh(f"ip link del {THIRD_DEV} 2>/dev/null")


def setup_third():
    """Wire the second exit into the same bridge, with its own MAC.

    run.setup_netns() builds wwiran and wwforeign; this mirrors the per-port
    setup it does (address, default route, MAC pinning) for wwforeign2.
    """
    rc, out = run.sh(f"ip netns add {THIRD_NS}")
    if rc != 0:
        return False, f"cannot create {THIRD_NS}: {out.strip()}"
    run.sh(f"ip link add {THIRD_DEV} type veth peer name eth0")
    rc, out = run.sh(f"ip link set eth0 netns {THIRD_NS}")
    if rc != 0:
        return False, f"cannot move eth0 into {THIRD_NS}: {out.strip()}"
    run.sh(f"ip link set {THIRD_DEV} master {run.BRIDGE}")
    run.sh(f"ip link set {THIRD_DEV} up")
    rc, out = run.sh(f"ip -d link show {THIRD_DEV}")
    if f"master {run.BRIDGE}" not in out:
        return False, f"{THIRD_DEV} is not attached to {run.BRIDGE}: {out.strip()[:200]}"
    run.sh(f"ip netns exec {THIRD_NS} ip link set eth0 address {THIRD_MAC}")
    run.sh(f"ip netns exec {THIRD_NS} ip addr add {THIRD_IP}/24 dev eth0")
    run.sh(f"ip netns exec {THIRD_NS} ip link set eth0 up")
    run.sh(f"ip netns exec {THIRD_NS} ip link set lo up")
    run.sh(f"ip netns exec {THIRD_NS} ip route add default via {run.HOST_IP}")
    run.sh(f"ip netns exec {THIRD_NS} sysctl -q -w net.ipv4.ip_forward=1")
    run.sh(f"ip netns exec {THIRD_NS} iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE >/dev/null 2>&1")
    # Pin ARP both ways, for the same reason run.setup_netns does: the first
    # frame through a fresh bridge port is sometimes lost, and a template is
    # then blamed for an ARP problem.
    run.sh(f"ip netns exec {THIRD_NS} ip neigh replace {run.IRAN_IP} lladdr {run.IRAN_MAC} dev eth0")
    run.sh(f"ip netns exec {run.IRAN_NS} ip neigh replace {THIRD_IP} lladdr {THIRD_MAC} dev eth0")
    rc, out = run.sh(f"ip netns exec {THIRD_NS} ip -4 addr show dev eth0")
    if THIRD_IP not in out:
        return False, f"{THIRD_NS} has no {THIRD_IP}: {out.strip()[:200]}"
    return True, ""


def deploy(name):
    src = os.path.join(OUT, name)
    dst = os.path.join(RUN, name)
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


def wait_ready(timeout=40.0):
    """Wait until a user connection is served at all."""
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
    """svc.py on 10.200.0.1:9001/9002, unless the harness already started it."""
    try:
        s = socket.create_connection((run.HOST_IP, 9001), timeout=1)
        s.close()
        return None, True
    except OSError:
        pass
    log = open(os.path.join(BASE, "svc-multi.log"), "w")
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

    try:
        run.ensure_cert()
        os.makedirs(RUN, exist_ok=True)
        cleanup_third()
        run.del_namespaces()
        run.del_bridge()
        run.ensure_bridge()
        run.enable_nat()

        svc, svc_state = start_service()
        if not svc and svc_state is not True:
            result["error"] = f"test service: {svc_state}"
            return result
        result["service"] = svc_state

        ok, err = run.setup_netns()
        if not ok:
            result["error"] = err
            return result
        ok, err = setup_third()
        if not ok:
            result["error"] = err
            return result

        dirs["iran"] = deploy("iran")
        dirs["a"] = deploy("exit-a")
        dirs["b"] = deploy("exit-b")

        # The entry first: the exits dial it, and a listener that appears after
        # the first dial is not retried for a long time.
        procs["iran"] = run.start_core(run.IRAN_NS, dirs["iran"])
        run.wait_for_config_load(dirs["iran"])
        time.sleep(1.5)
        result["entryListeners"] = run.listeners_in(run.IRAN_NS)
        if ENTRY_PORT not in result["entryListeners"]:
            result["error"] = f"the entry never bound :{ENTRY_PORT}"
            return result

        procs["a"] = run.start_core(run.FOREIGN_NS, dirs["a"])
        run.wait_for_config_load(dirs["a"])
        procs["b"] = run.start_core(THIRD_NS, dirs["b"])
        run.wait_for_config_load(dirs["b"])

        ready, detail = wait_ready()
        result["steps"].append({"step": "tunnel up", "ok": ready, "detail": detail})
        if not ready:
            result["error"] = f"no exit ever served a connection: {detail}"
            return result

        # ---- load sharing -------------------------------------------------
        counts = {"A": 0, "B": 0, "fail": 0, "?": 0}
        for _ in range(PROBES):
            side, _d = probe_once()
            counts[side] = counts.get(side, 0) + 1
            time.sleep(0.15)
        spread = counts["A"] > 0 and counts["B"] > 0
        result["spread"] = counts
        result["steps"].append(
            {
                "step": f"{PROBES} user connections reach both exits",
                "ok": spread and counts["fail"] == 0,
                "detail": json.dumps(counts),
            }
        )

        # ---- failover: kill exit A ----------------------------------------
        run.stop_core(*procs.pop("a"))
        time.sleep(2)
        a_after = {"A": 0, "B": 0, "fail": 0, "?": 0}
        served = 0
        deadline = time.time() + 20
        while time.time() < deadline and served < 5:
            side, _d = probe_once()
            a_after[side] = a_after.get(side, 0) + 1
            if side in ("A", "B"):
                served += 1
            else:
                time.sleep(1)
        result["afterExitA"] = a_after
        result["steps"].append(
            {
                "step": "exit A killed: exit B keeps serving",
                "ok": served >= 5 and a_after["A"] == 0,
                "detail": json.dumps(a_after),
            }
        )

        # ---- negative check: kill exit B too ------------------------------
        run.stop_core(*procs.pop("b"))
        time.sleep(2)
        dead = 0
        for _ in range(3):
            side, _d = probe_once(timeout=4.0)
            if side == "fail":
                dead += 1
            time.sleep(1)
        result["afterBoth"] = {"failed": dead, "of": 3}
        result["steps"].append(
            {
                "step": "both exits killed: the tunnel is down (no false positive)",
                "ok": dead == 3,
                "detail": f"{dead}/3 connections failed",
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
                "step": "no FATAL in any of the three cores",
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
        cleanup_third()
        run.del_namespaces()
        run.del_bridge()
        stop_service(svc)
        run.disable_nat()


if __name__ == "__main__":
    res = main()
    out = os.path.join(BASE, "multi-result.json")
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
