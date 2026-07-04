#!/usr/bin/env bash
# Deploy the bundled workflow recipes. Refuses to overwrite files whose
# content differs from the bundle unless --force is given.
#   install.sh [--force] [DEST]     DEST default: ~/.claude/workflows
set -euo pipefail

force=0
dest="$HOME/.claude/workflows"
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    *) dest="$arg" ;;
  esac
done

src="$(cd "$(dirname "$0")/../workflows" && pwd)"
mkdir -p "$dest/_lib"

conflicts=()
while IFS= read -r f; do
  rel="${f#"$src"/}"
  if [ -f "$dest/$rel" ] && ! cmp -s "$f" "$dest/$rel"; then
    conflicts+=("$rel")
  fi
done < <(find "$src" -type f)

if [ "${#conflicts[@]}" -gt 0 ] && [ "$force" -ne 1 ]; then
  echo "REFUSED: these files exist at $dest with DIFFERENT content:" >&2
  printf '  %s\n' "${conflicts[@]}" >&2
  echo "Review (diff) then re-run with --force to overwrite." >&2
  exit 1
fi

while IFS= read -r f; do
  rel="${f#"$src"/}"
  mkdir -p "$dest/$(dirname "$rel")"
  cp "$f" "$dest/$rel"
  echo "installed: $dest/$rel"
done < <(find "$src" -type f)

echo "done: $(find "$src" -type f | wc -l | tr -d ' ') file(s) → $dest"
