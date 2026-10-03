#!/usr/bin/env bash
# Checks a freshly scaffolded project the way the bounty gate does:
# required files, no secrets, install/lint/build/tests, and every core route answering 200 with no env vars.
# Usage: .github/scripts/check-scaffold.sh <project-dir> <yarn|npm>
set -euo pipefail

DIR="$1"
PM="$2"
cd "$DIR"
run() { if [ "$PM" = "yarn" ]; then yarn "$@"; else npm run "$@"; fi; }
step() { echo; echo "::group::$1"; }
end() { echo "::endgroup::"; }

step "Required files"
for f in README.md AGENTS.md LICENCE package.json packages/nextjs/package.json packages/foundry/foundry.toml packages/treasury/package.json; do
  test -f "$f" || { echo "missing $f"; exit 1; }
done
test ! -f template.json || { echo "template.json should have been consumed by the CLI"; exit 1; }
end

step "No committed secrets"
if git ls-files 2>/dev/null | grep -E '(^|/)\.env(\.local)?$'; then echo ".env file is tracked"; exit 1; fi
if grep -RInE --exclude-dir=node_modules --exclude-dir=lib --exclude-dir=.next '(OPERATOR|SIGNER[0-9])_KEY=[0-9a-fA-Fx]{20,}' . ; then echo "private key found"; exit 1; fi
end

step "Lint and types"
run lint
run next:check-types
run treasury:check-types
end

step "Tests"
run treasury:test
run foundry:test
end

step "Production build"
run next:build
end

step "Core routes answer 200 without env vars"
(PORT=3000 run next:serve >/tmp/next.log 2>&1 &)
for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:3000/ && break; sleep 2; done
for path in / /proposals /budget /audit /new /debug /proposals/0.0.1; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$path")
  echo "$path -> $code"
  [ "$code" = "200" ] || { tail -50 /tmp/next.log; exit 1; }
done
end

echo "Scaffold check passed ($PM)"
