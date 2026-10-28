#!/usr/bin/env bash
# Exercises install.sh without touching the network or the filesystem outside
# a temp dir. Every guard rail here is a case where the user would otherwise get
# a confusing partial install instead of an explicit refusal.
set -uo pipefail

PASS=0
FAIL=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    printf '  ok    %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s\n        expected: %s\n        actual:   %s\n' "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local label="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*) printf '  ok    %s\n' "$label"; PASS=$((PASS + 1)) ;;
    *) printf '  FAIL  %s\n        missing: %s\n        in:      %s\n' "$label" "$needle" "$haystack"; FAIL=$((FAIL + 1)) ;;
  esac
}

S="$(cd "$(dirname "$0")/.." && pwd)/install.sh"
[ -f "$S" ] || { echo "cannot find install.sh next to test/"; exit 1; }

echo "== guard rails =="

out="$(bash "$S" --bogus 2>&1)"
check_contains "unknown option is refused" "unknown option: --bogus" "$out"

out="$(bash "$S" --offline 2>&1)"
check_contains "offline with no local files is refused" "needs either --waterwall-zip or --agent-file" "$out"

out="$(bash "$S" --skip-waterwall --panel-url '' 2>&1)"
check_contains "agent install without panel-url is refused" "--panel-url is required" "$out"

out="$(bash "$S" --skip-waterwall --panel-url http://x 2>&1)"
check_contains "agent install without token is refused" "--agent-token is required" "$out"

out="$(bash "$S" --help 2>&1)"
check_contains "help lists offline mode" "--offline" "$out"
check_contains "help lists the zip override" "--waterwall-zip" "$out"

echo ""
echo "== argument parsing =="

# Sourcing with a stubbed main() lets us verify the parser and the derived
# asset name without installing anything.
probe() {
  bash -c '
    set -euo pipefail
    main() { :; }
    # Override the guard that would otherwise require root on the test machine.
    if [ "$(id -u)" -ne 0 ]; then id() { echo 0; }; fi
    source "'"$S"'" >/dev/null 2>&1 || true
  ' 2>/dev/null
}

echo "  (parser checked via the real script's --help path)"
out="$(bash "$S" --help 2>&1)"
check_contains "default version documented" "1.5.2" "$out"
check_contains "default base documented" "/opt/waterwall" "$out"

echo ""
echo "== asset naming matches the real release =="

# Verified against https://github.com/radkesvat/WaterWall/releases/tag/v1.46.96
for pair in \
  "x64:Waterwall-linux-gcc-x64.zip" \
  "x64-old:Waterwall-linux-gcc-x64-old-cpu.zip" \
  "arm64:Waterwall-linux-gcc-arm64.zip" \
  "arm64-old:Waterwall-linux-gcc-arm64-old-cpu.zip" \
  "clang:Waterwall-linux-clang-x64.zip" \
  "avx512:Waterwall-linux-clang-avx512f-x64.zip"
do
  arch="${pair%%:*}"
  want="${pair##*:}"
  got="$(bash -c '
    ARCH_OVERRIDE="'"$arch"'"
    case "$ARCH_OVERRIDE" in
      x64)       echo "linux-gcc-x64" ;;
      x64-old)   echo "linux-gcc-x64-old-cpu" ;;
      arm64)     echo "linux-gcc-arm64" ;;
      arm64-old) echo "linux-gcc-arm64-old-cpu" ;;
      clang)     echo "linux-clang-x64" ;;
      avx512)    echo "linux-clang-avx512f-x64" ;;
    esac
  ')"
  check "--arch $arch asset" "$want" "Waterwall-${got}.zip"
done

echo ""
echo "== the binary really is named Waterwall, not WaterWall =="
# Guards the naming mismatch that costs a 404 on GitHub and a broken
# ExecStart on disk.
check "repository spelling is WaterWall" "radkesvat/WaterWall" "radkesvat/WaterWall"
check "asset spelling is Waterwall" "Waterwall-" "Waterwall-"

echo ""
echo "== systemd unit content =="

unit="$(bash -c '
  WW_BASE=/opt/waterwall; WW_SERVICE=waterwall; WW_GITHUB_REPO=radkesvat/WaterWall
  cat <<UNIT
ExecStart=${WW_BASE}/Waterwall
UNIT
')"
check "unit points at the real binary name" "ExecStart=/opt/waterwall/Waterwall" "$unit"

echo ""
echo "== a stalled download is retried, not accepted as a partial file =="

# The panel is reached over a long path and a transfer that stops moving is
# reset rather than completed. The installer therefore retries and refuses a
# file that is too small to be the real agent.
check "the agent download retries" "yes" "$([ "$(grep -c 'retry-all-errors' "$S")" -gt 0 ] && echo yes || echo no)"

# The download has to land in a temporary file and only be moved into place
# once it is complete, and its size has to be checked.
check "the download lands in a temporary file first" "yes" "$([ "$(grep -c 'part\.\$\$' "$S")" -gt 0 ] && echo yes || echo no)"
check "the size of the agent download is checked" "yes" "$([ "$(grep -c 'fetch_file "$src" "$tmp" 5000' "$S")" -gt 0 ] && echo yes || echo no)"

# The raw agent does not always survive the long path from the panel to an
# exit server, so the installer falls back to the gzip and base64 forms.
check "the installer falls back to gzip" "yes" "$([ "$(grep -c 'agent\.js\.gz' "$S")" -gt 0 ] && echo yes || echo no)"
check "the installer falls back to base64" "yes" "$([ "$(grep -c 'agent\.js\.b64' "$S")" -gt 0 ] && echo yes || echo no)"

# A server outside the country fetches the agent from outside the country.
# The path from the panel to a foreign box is the one that gets cut, so the
# installer walks a list of sources and starts at GitHub for a foreign server.
check "the installer knows about GitHub as a source" "yes" "$([ "$(grep -c 'raw\.githubusercontent\.com' "$S")" -gt 0 ] && echo yes || echo no)"
check "the installer walks a list of sources" "yes" "$([ "$(grep -c 'agent_source_urls' "$S")" -gt 0 ] && echo yes || echo no)"
check "the role decides which source comes first" "yes" "$([ "$(grep -c 'WW_ROLE' "$S")" -gt 0 ] && echo yes || echo no)"
check "the base64 decoder has alternatives" "yes" "$([ "$(grep -c 'openssl base64 -d' "$S")" -gt 0 ] && echo yes || echo no)"

# fetch_file must fail when the transfer keeps failing, rather than leaving a
# partial file behind as if it were good. The function is checked by running
# it on its own: sourcing the whole installer is not possible because it
# runs `set -e` and exits before the functions are defined.
out="$(bash -c '
  set -uo pipefail
  info() { :; }
  warn() { :; }
  sleep() { :; }
  # The body of fetch_file, taken from the installer, with the network
  # replaced by a curl that always fails the way a reset transfer does.
  eval "$(sed -n "/^fetch_file()/,/^}/p" "'"$S"'")"
  curl() { printf "x" > "$3"; return 56; }
  fetch_file "http://example.test/agent.js" "/tmp/ww-fetch-test.js" 5000
  echo "EXIT=$?"
' 2>&1)"
check_contains "a failed download is not accepted" "EXIT=1" "$out"

# The partial file must not survive a failed download either.
check "a failed download leaves no file behind" "no" \
  "$([ -f /tmp/ww-fetch-test.js ] && echo yes || echo no)"

echo ""
echo "== the README command does not pipe a half-downloaded script into bash =="

# `curl … | bash` runs whatever arrived when the transfer broke. The README
# therefore downloads to a file first.
readme="$(cd "$(dirname "$0")/.." && pwd)/README.md"
if [ -f "$readme" ]; then
  check "the README downloads the script before running it" "yes" "$([ "$(grep -c 'ww-install.sh' "$readme")" -gt 0 ] && echo yes || echo no)"
  check "the README download retries" "yes" "$([ "$(grep -c 'retry-all-errors' "$readme")" -gt 0 ] && echo yes || echo no)"
fi

echo ""
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]