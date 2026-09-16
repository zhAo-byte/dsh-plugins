#!/usr/bin/env bash
#
# One-shot bootstrap for a fresh Ubuntu host that will run the relay.
#
# Written to be safe to re-run: every step checks its own precondition, so a
# second pass repairs a half-finished install instead of duplicating it.
#
# Why it installs Node itself instead of using apt: this host may be running an
# unrelated production site, and a Node 22 install only exists in NodeSource's
# repository on older Ubuntu releases. Dropping the official static build into
# /usr/local touches no package manager state and no system library, so it cannot
# disturb whatever else is on the box. It also keeps the interpreter path fixed,
# which the systemd unit names explicitly.
#
# Usage (as root, on the host):
#   sudo bash /opt/dsh-remote-control/deploy/bootstrap-relay.sh <service-user>
#
# Optional overrides:
#   DSH_REMOTE_NODE_VERSION=22.23.2   Node version to fetch
#   DSH_REMOTE_AGENT_TOKEN=...        reuse an existing secret instead of generating
#   DSH_REMOTE_CONTROL_TOKEN=...      likewise

set -euo pipefail

SERVICE_USER="${1:-}"
if [[ -z "$SERVICE_USER" ]]; then
  echo "usage: sudo bash bootstrap-relay.sh <service-user>" >&2
  exit 2
fi

NODE_VERSION="${DSH_REMOTE_NODE_VERSION:-22.23.2}"
INSTALL_DIR="/opt/dsh-remote-control"
ENV_FILE="/etc/dsh-remote-relay.env"
SERVICE_FILE="/etc/systemd/system/dsh-remote-relay.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "bootstrap-relay: this script must run as root (use sudo)" >&2
  exit 2
fi

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "bootstrap-relay: no such user: $SERVICE_USER" >&2
  exit 2
fi

# ── 1. Node ──────────────────────────────────────────────────────────────────
NODE_BIN="/usr/local/bin/node"
want_major="${NODE_VERSION%%.*}"
have_major=""
if command -v node >/dev/null 2>&1; then
  have_major="$(node --version 2>/dev/null | sed 's/^v//; s/\..*//')"
fi

if [[ "$have_major" == "$want_major" ]]; then
  echo "bootstrap-relay: node $(node --version) already present"
else
  machine="$(uname -m)"
  case "$machine" in
    x86_64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *)
      echo "bootstrap-relay: unsupported architecture: $machine" >&2
      exit 2
      ;;
  esac
  tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  tmp="$(mktemp -d)"
  echo "bootstrap-relay: installing node $NODE_VERSION into /usr/local"
  if ! curl -fsSL "$url" -o "$tmp/$tarball"; then
    echo "bootstrap-relay: could not download $url" >&2
    echo "bootstrap-relay: set DSH_REMOTE_NODE_VERSION to a version listed at https://nodejs.org/dist/" >&2
    rm -rf "$tmp"
    exit 1
  fi
  # --strip-components drops the versioned top-level directory, so the result
  # merges into /usr/local/bin, /usr/local/lib, and /usr/local/include cleanly.
  tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 \
    --exclude CHANGELOG.md --exclude LICENSE --exclude README.md
  rm -rf "$tmp"
  echo "bootstrap-relay: installed $("$NODE_BIN" --version)"
fi

# ── 2. secrets ───────────────────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  echo "bootstrap-relay: keeping the existing $ENV_FILE"
else
  agent_token="${DSH_REMOTE_AGENT_TOKEN:-$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 44)}"
  control_token="${DSH_REMOTE_CONTROL_TOKEN:-$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 44)}"
  umask 077
  cat > "$ENV_FILE" <<EOF
DSH_REMOTE_AGENT_TOKEN=$agent_token
DSH_REMOTE_CONTROL_TOKEN=$control_token
EOF
  echo "bootstrap-relay: generated $ENV_FILE (mode 600, root only)"
fi
chmod 600 "$ENV_FILE"

# ── 3. hardening the unit for this host ──────────────────────────────────────
if [[ ! -f "$INSTALL_DIR/deploy/dsh-remote-relay.service" ]]; then
  echo "bootstrap-relay: $INSTALL_DIR/deploy/dsh-remote-relay.service is missing" >&2
  echo "bootstrap-relay: upload the repository first (see README section 6)" >&2
  exit 1
fi
sed -e "s/^User=.*/User=$SERVICE_USER/" -e "s/^Group=.*/Group=$SERVICE_USER/" \
  "$INSTALL_DIR/deploy/dsh-remote-relay.service" > "$SERVICE_FILE"
# Node lives in /usr/local here, and ProtectSystem=strict makes the root
# filesystem read-only, so the unit's own ExecStart must name the real path.
sed -i "s#^ExecStart=.*#ExecStart=$NODE_BIN $INSTALL_DIR/relay/server.js#" "$SERVICE_FILE"
echo "bootstrap-relay: wrote $SERVICE_FILE (User=$SERVICE_USER, ExecStart=$NODE_BIN)"

systemctl daemon-reload
systemctl enable --now dsh-remote-relay

# ── 4. prove it actually answers, rather than assuming the unit is healthy ───
port="$(sed -n 's/^Environment=DSH_REMOTE_RELAY_PORT=//p' "$SERVICE_FILE" | head -n1)"; [[ -n "$port" ]] || port=8787

# Wait for *any* HTTP response. A 401 is the healthy answer for an anonymous
# request, so probing for a 200 here would wait out the whole timeout on a
# perfectly good service.
status=""
for _ in $(seq 1 30); do
  status="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:${port}/api/state" || true)"
  if [[ -n "$status" && "$status" != "000" ]]; then
    break
  fi
  sleep 0.5
done

if [[ -z "$status" || "$status" == "000" ]]; then
  echo "bootstrap-relay: the relay never answered on 127.0.0.1:${port}" >&2
  journalctl -u dsh-remote-relay --no-pager -n 40 >&2 || true
  exit 1
fi
if [[ "$status" != "401" ]]; then
  echo "bootstrap-relay: anonymous /api/state answered HTTP $status; expected 401" >&2
  echo "bootstrap-relay: refusing to continue, because that means the token check is not enforcing" >&2
  exit 1
fi

# Now prove the token check accepts the real secret, so the operator does not
# discover a bad environment file only later, when a machine fails to register.
agent_token="$(sed -n 's/^DSH_REMOTE_AGENT_TOKEN=//p' "$ENV_FILE" | head -n1)"
hello_code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
  -X POST -H "authorization: Bearer ${agent_token}" -H 'content-type: application/json' \
  -d '{"nodeId":"__bootstrap_probe__","name":"__bootstrap_probe__"}' \
  "http://127.0.0.1:${port}/api/agent/hello" || true)"
if [[ "$hello_code" != "200" ]]; then
  echo "bootstrap-relay: an authenticated /api/agent/hello answered HTTP ${hello_code:-none}; expected 200" >&2
  exit 1
fi

echo "bootstrap-relay: relay is up on 127.0.0.1:${port}; anonymous requests are refused (401) and the agent token is accepted (200)"
echo "bootstrap-relay: note - the probe above registers __bootstrap_probe__ in the in-memory roster."
echo "bootstrap-relay:        It never polls, so it is reaped as offline within a minute and vanishes"
echo "bootstrap-relay:        entirely on 'systemctl restart dsh-remote-relay'."

echo
echo "bootstrap-relay: done. Remaining steps for the operator:"
echo "  1. add the location from $INSTALL_DIR/deploy/nginx-location.conf to your server block"
echo "     (keep the backup OUT of sites-enabled: everything in that directory is include'd,"
echo "      and a second copy of the server block is a fatal duplicate listen directive)"
echo "  2. nginx -t && systemctl reload nginx"
echo "  3. read the two tokens from $ENV_FILE and configure the machines"
