#!/usr/bin/env bash
# Plugin-only, always-on SessionStart discoverability notice (NOT env-gated).
#
# The plugin-shipped enforcement hooks are opt-in and silent by default (each is wrapped
# in an `ABSTRACT_DATA_ENFORCE` env-gate that exits 0 when the var is unset). That silence
# can read as "no enforcement present," so the plugin builders inject THIS notice — un-gated
# — into the SessionStart/sessionStart event so the opt-in posture is visible in-band.
#
# This script also deploys to real projects via `apply` (it is just another *.sh in hooks/),
# but apply never REGISTERS it (only the plugin builders inject its registration), so it only
# ever fires on a plugin install.
echo "abstract-data enforcement hooks present but inactive; set ABSTRACT_DATA_ENFORCE=1 to enable."
exit 0
