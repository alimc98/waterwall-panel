# Live template proof

Every template in this project is generated for two sides (Iran, foreign).
This directory turns those two sides into a real test: both halves are run at
once against the real WaterWall core, and traffic is pushed through the tunnel
for real.

Everything happens inside two network namespaces on **one** Linux box, so no
live tunnel is ever touched:

```
host 10.200.0.1        svc.py — TCP/UDP echo and a tiny HTTP server
netns wwiran  10.200.0.2    the Iran side of the template
netns wwforeign 10.200.0.3  the far side
```

    +---------- wwbr0 ----------+
    |            |              |
  wwviran     wwvforeign    (host service)
  10.200.0.2  10.200.0.3    10.200.0.1

Each template gets a fresh pair of namespaces, so no two runs can disturb each
other, and the namespaces are torn down afterwards. The two MAC addresses are
pinned to distinct values on purpose: a fresh veth pair can come up with the
same address on both ends, and two ports of one bridge that share a MAC make the
forwarding database flap, which blackholes half of every conversation and looks
exactly like a broken template.

## What a run checks

1. the Iran -> foreign link itself (one plain TCP connection, before any core
   starts — WaterWall does not retry a failed dial for up to a minute)
2. `core.json` and every config file load (a `FATAL` line fails the run)
3. the far side is started first and waited for, then the near side
4. the entry point is probed with real traffic:
   `tcp`, `udp`, `socks5`, `socks5-auth`, `http proxy`, `tun-web` (everything
   in the namespace has to leave through the tunnel), or a log line for
   templates that drive themselves (`SpeedTestClient`, `TesterClient`)
5. no template may install a default route through its own TUN: that is what
   takes a live server off the internet, so the harness fails a run that does
6. the tail of both cores' logs is kept for any failure

## Running it

Build the bundles anywhere Node is available:

    node test/live/generate.js

That writes `test/live/out/<template>/{iran,foreign}` plus a `plan.json` per
template (entry point, probe, budgets, log pattern).

Then, on a Linux box with root, `python3` and WaterWall installed
(`/opt/waterwall`, or override with the `CORE` constant):

    cd test/live/remote
    python3 run.py                     # every template
    python3 run.py tcp-forward,vless-tls   # just these
    python3 run.py --verbose tcp-forward   # core debug logs too

Results land in `test/live/results.json`. Exit status is 0 only if every
tried template passed.

## Files

- `spec.js` — per-template test plan: where the entry is, which probe, how long
  to wait, which log line means success
- `generate.js` — builds the two bundles per template and the plan
- `remote/svc.py` — the destination service on the host
- `remote/probe.py` — one traffic probe, JSON on stdout
- `remote/warm.py` — the link proof (listener + connector halves)
- `remote/run.py` — the harness itself
- `remote/inspect.py` — prints a resolved config's node chain (debugging)
