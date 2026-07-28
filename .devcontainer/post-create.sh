#!/usr/bin/env bash
set -euo pipefail

# registry.npmjs.org is not reachable from this container. Every package client
# must resolve through the corporate feed proxy instead.
readonly FEED_PROXY="https://packagefeedproxy.microsoft.io/npm/"
# pnpm's "latest" dist-tag currently points at a 12.x prerelease, so pin a version
# unless package.json declares one.
readonly PNPM_DEFAULT_VERSION="10.34.5"

echo "==> Configuring git"
git config --global --add safe.directory "${PWD}"

echo "==> Pointing every npm client at the feed proxy"
# npm's builtin npmrc is read by npm, npx and pnpm for *every* user, including root
# via sudo -- which strips NPM_CONFIG_REGISTRY from the environment.
sudo touch /usr/local/etc/npmrc
sudo sed -i '/^registry=/d' /usr/local/etc/npmrc
sudo tee -a /usr/local/etc/npmrc >/dev/null <<<"registry=${FEED_PROXY}"

echo "==> Installing pnpm"
# corepack cannot be used here: it resolves package managers via npm's per-version
# manifest endpoint (/<pkg>/<version>), which the feed proxy does not serve.
pnpm_spec="pnpm@${PNPM_DEFAULT_VERSION}"
if [ -f package.json ]; then
  pinned="$(node -p "(require('./package.json').packageManager ?? '').split('+')[0]" 2>/dev/null || true)"
  case "${pinned}" in
    pnpm@*) pnpm_spec="${pinned}" ;;
  esac
fi
npm install -g "${pnpm_spec}"

echo "==> Installing global CLI tooling"
npm install -g @github/copilot @beads/bd

if [ -f pnpm-lock.yaml ]; then
  echo "==> Installing workspace dependencies"
  pnpm install --frozen-lockfile
elif [ -f package.json ]; then
  echo "==> Installing workspace dependencies"
  pnpm install
fi

echo "==> Verifying nothing bypasses the feed proxy"
for client in "npm:$(npm config get registry)" \
              "pnpm:$(pnpm config get registry)" \
              "npm-as-root:$(sudo npm config get registry)"; do
  echo "    ${client%%:*} -> ${client#*:}"
  case "${client#*:}" in
    "${FEED_PROXY}"*) ;;
    *) echo "ERROR: ${client%%:*} resolves a registry outside the feed proxy" >&2; exit 1 ;;
  esac
done

echo "==> Versions"
node --version
pnpm --version
docker --version || echo "docker socket not mounted"
gh --version | head -1
copilot --version || true
bd version || true

echo "==> Done. Run 'gh auth login' and 'copilot' to authenticate."
