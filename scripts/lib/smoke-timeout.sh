# Sourced by smokes that bound a run with timeout(1): sets timeout_bin or exits 1.
timeout_bin="$(command -v timeout || command -v gtimeout || true)"
if [[ -z "$timeout_bin" ]]; then
  echo "  FAIL timeout or gtimeout is required" >&2
  echo "0 passed, 1 failed" >&2
  exit 1
fi
