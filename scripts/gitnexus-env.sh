#!/usr/bin/env bash
# Shared helpers for the GitNexus pilot (LOCK-61). Source, don't execute.
# shellcheck disable=SC2034
GITNEXUS_TOOL_DIR="tools/gitnexus"
GITNEXUS_BIN="$GITNEXUS_TOOL_DIR/node_modules/.bin/gitnexus"
export SCARF_ANALYTICS=false            # @scarf/scarf install telemetry off
export GITNEXUS_NO_UPDATE_NOTIFIER=1
# Bound LadybugDB memory on agent VMs (default is min(2 GiB, 80% RAM)).
export GITNEXUS_LBUG_BUFFER_POOL_SIZE="${GITNEXUS_LBUG_BUFFER_POOL_SIZE:-536870912}"

gitnexus_unknown() { echo "gitnexus: $* (GitNexus skipped; impact UNKNOWN)" >&2; }

# True iff `node` satisfies gitnexus@1.6.12 engines: ^22.18.0 || >=24.11.0.
# Leading "v" is stripped (process.version is "v22.18.0").
gitnexus_node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v maj min
  v="$(node --version 2>/dev/null)"; v="${v#v}"
  maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
  [[ "$maj" =~ ^[0-9]+$ && "$min" =~ ^[0-9]+$ ]] || return 1
  if [ "$maj" -eq 22 ] && [ "$min" -ge 18 ]; then return 0; fi
  if [ "$maj" -eq 24 ] && [ "$min" -ge 11 ]; then return 0; fi
  [ "$maj" -ge 25 ]
}
