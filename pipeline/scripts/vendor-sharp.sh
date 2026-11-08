#!/usr/bin/env bash
#
# Vendor `sharp` for the Lambda runtime into the deployment directory.
#
# The pipeline uses `sharp` to check uploaded images and to fit images to the critic's
# limits. `sharp` ships a
# native binary, so esbuild cannot bundle it: the bundle marks it external and the real
# module has to sit next to the handler as `node_modules/sharp`.
#
# The binary must match the *Lambda* platform, not this laptop. `--os`/`--cpu`/`--libc`
# force npm to resolve the linux-arm64 glibc prebuild (`@img/sharp-linux-arm64`) even on
# an arm64 macOS host, which would otherwise install the darwin one and fail at runtime
# with "Could not load the sharp module using the linux-arm64 runtime".
#
# The install runs in a temporary directory rather than in `build/`: `build/` lives inside
# an npm-workspaces repo, so npm walks up, decides the workspace root is the project root
# and installs there instead.
set -euo pipefail

# Pinned deliberately, and to the same version `shared` depends on. The vendored
# binary and the bundled JS are one unit; letting them drift is a runtime ABI error.
VERSION="0.35.5"
PLATFORM=(--os=linux --cpu=arm64 --libc=glibc)

dest="$(cd "$(dirname "$0")/../../infra/modules/pipeline/build" && pwd)"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

echo '{"name":"sharp-vendor","private":true}' > "$staging/package.json"
npm install --prefix "$staging" --no-package-lock --no-save --include=optional \
  "${PLATFORM[@]}" "sharp@$VERSION" >/dev/null

if ! find "$staging/node_modules/@img" -name '*.node' | grep -q linux-arm64; then
  echo "vendor-sharp: no linux-arm64 binary in the resolved tree" >&2
  exit 1
fi

rm -rf "$dest/node_modules"
cp -R "$staging/node_modules" "$dest/node_modules"
echo "vendor-sharp: sharp@$VERSION (linux-arm64) -> $dest/node_modules"
