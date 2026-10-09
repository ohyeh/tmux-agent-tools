# Sourced first by every smoke (zsh and bash). A smoke never runs with the real HOME: on
# 2026-10-09 a mutation run let a test hook delete the developer's home directory. Run smokes
# through scripts/run-all-smokes (it gives each job its own HOME), e.g.
# `scripts/run-all-smokes test-sentinel-smoke`.
smoke_real_home="$(eval "printf '%s' ~$(id -un)")"
if [ -z "${HOME:-}" ] || [ "$HOME" = / ] ||
   [ "$(cd "$HOME" 2>/dev/null && pwd -P)" = "$(cd "$smoke_real_home" 2>/dev/null && pwd -P)" ]; then
  echo "smoke: refusing to run with the real HOME ($HOME); use scripts/run-all-smokes <test>" >&2
  exit 3
fi
unset smoke_real_home
