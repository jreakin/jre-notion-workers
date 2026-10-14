#!/usr/bin/env bash
# Ensure Node ^22.18.0 || >=24.11.0 on Cursor Cloud Agent VMs (LOCK-61).
# Source from the install step: `. scripts/ensure-node.sh && ensure_node22`.
# Idempotent and non-fatal: on any failure it warns and returns 1; callers
# decide (GitNexus then records impact UNKNOWN). Installs Node 22 LTS with a
# pinned nvm, then links node/npm/npx into a PATH dir so later shells and MCP
# servers (which don't read ~/.bashrc) get the same binary.
# ENSURE_NODE_BIN_DIR overrides the link dir (tests).
NVM_VERSION="v0.40.3"
NODE_MAJOR="22"

_node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v maj min
  v="$(node --version 2>/dev/null)"; v="${v#v}"
  maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
  [[ "$maj" =~ ^[0-9]+$ && "$min" =~ ^[0-9]+$ ]] || return 1
  if [ "$maj" -eq 22 ] && [ "$min" -ge 18 ]; then return 0; fi
  if [ "$maj" -eq 24 ] && [ "$min" -ge 11 ]; then return 0; fi
  [ "$maj" -ge 25 ]
}

_link_node_bins() {  # $1 = dir containing node/npm/npx
  local src="$1" dest="${ENSURE_NODE_BIN_DIR:-}"
  if [ -n "$dest" ]; then mkdir -p "$dest"
  elif [ -w /usr/local/bin ]; then dest=/usr/local/bin
  elif sudo -n true 2>/dev/null; then dest=/usr/local/bin
  else dest="$HOME/.local/bin"; mkdir -p "$dest"
  fi
  local b
  for b in node npm npx; do
    if [ "$dest" = /usr/local/bin ] && [ ! -w "$dest" ]; then
      sudo -n ln -sf "$src/$b" "$dest/$b"
    else
      ln -sf "$src/$b" "$dest/$b"
    fi
  done
  case ":$PATH:" in *":$dest:"*) ;; *) export PATH="$dest:$PATH" ;; esac
  hash -r
}

ensure_node22() {
  if _node_ok; then
    echo "ensure-node: $(node --version) already satisfies ^22.18.0 || >=24.11.0" >&2
    return 0
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" \
      | PROFILE=/dev/null bash >/dev/null 2>&1 \
      || { echo "ensure-node: nvm ${NVM_VERSION} install failed" >&2; return 1; }
  fi
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh" || { echo "ensure-node: cannot load nvm" >&2; return 1; }
  nvm install "$NODE_MAJOR" >/dev/null 2>&1 && nvm alias default "$NODE_MAJOR" >/dev/null 2>&1 \
    || { echo "ensure-node: nvm install $NODE_MAJOR failed" >&2; return 1; }
  _link_node_bins "$(dirname "$(nvm which "$NODE_MAJOR")")"
  if _node_ok; then
    echo "ensure-node: using $(command -v node) $(node --version)" >&2
    return 0
  fi
  echo "ensure-node: node $(node --version 2>/dev/null || echo none) still below 22.18" >&2
  return 1
}
