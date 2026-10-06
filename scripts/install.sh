#!/bin/sh
# First execution trusts HTTPS; installed updates use the embedded release key.
# No Node, npm, Bun, Git or JSON interpreter is required by this bootstrap.
set -eu
NF_JSON=0 NF_VERSION='' NF_CHANNEL='' NF_NO_INIT=0 NF_NO_PATH=0 NF_MIGRATE_NPM=0
nf_fail() {
  if [ "$NF_JSON" = 1 ]; then printf '{"ok":false,"code":"bootstrap_failed","message":"%s"}\n' "$1"
  else printf 'Notifai installation failed: %s\n' "$1" >&2; fi
  exit 1
}
nf_version() {
  [ ${#1} -le 100 ] || return 1
  case "$1" in ''|*[!0-9A-Za-z.+-]*) return 1;; esac
  printf '%s\n' "$1" | awk '/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/ {ok=1} END {exit !ok}'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) NF_JSON=1; shift;;
    --no-init) NF_NO_INIT=1; shift;;
    --no-path) NF_NO_PATH=1; shift;;
    --migrate-npm) NF_MIGRATE_NPM=1; shift;;
    --version) [ "$#" -ge 2 ] && [ -z "$NF_VERSION" ] || nf_fail 'Supply one exact application version'; NF_VERSION=$2; shift 2;;
    --channel) [ "$#" -ge 2 ] && [ -z "$NF_CHANNEL" ] || nf_fail 'Supply one release channel'; NF_CHANNEL=$2; shift 2;;
    --help) printf '%s\n' 'Install Notifai: --json --version <exact> --channel <stable|beta> --no-init --no-path --migrate-npm'; exit 0;;
    *) nf_fail 'Unknown installer option';;
  esac
done
case "$NF_CHANNEL" in ''|stable|beta) ;; *) nf_fail 'Channel must be stable or beta';; esac
[ -z "$NF_VERSION" ] || nf_version "$NF_VERSION" || nf_fail 'Version must be an exact semantic version'
nf_run() {
  nf_executable=$1; shift
  set -- install --source shell "$@"
  [ -z "$NF_CHANNEL" ] || set -- "$@" --channel "$NF_CHANNEL"
  [ -z "$NF_VERSION" ] || set -- "$@" --version "$NF_VERSION"
  [ "$NF_JSON" = 0 ] || set -- "$@" --json
  [ "$NF_NO_INIT" = 0 ] || set -- "$@" --no-init
  [ "$NF_NO_PATH" = 0 ] || set -- "$@" --no-path
  [ "$NF_MIGRATE_NPM" = 0 ] || set -- "$@" --migrate-npm
  set +e
  "$nf_executable" "$@"
  exit "$?"
}
# Select the account's OS home, never a command from PATH or a relocated HOME.
NF_OS=$(uname -s) NF_ARCH=$(uname -m) NF_UID=$(id -u)
case "$NF_OS" in
  Darwin)
    NF_PLATFORM=darwin
    NF_HOME=$(/usr/bin/dscacheutil -q user -a uid "$NF_UID" | awk '/^dir: / {sub(/^dir: /, ""); print}')
    ;;
  Linux)
    NF_PLATFORM=linux
    command -v getent >/dev/null 2>&1 || nf_fail 'The OS account lookup tool getent is required'
    NF_HOME=$(getent passwd "$NF_UID" | awk -F: 'NF==7 {print $6}')
    ;;
  *) nf_fail 'Use the Windows PowerShell installer or a supported macOS or Linux host';;
esac
case "$NF_HOME" in /*) ;; *) nf_fail 'Cannot resolve this account home';; esac
case "$NF_HOME" in *'
'*) nf_fail 'OS account lookup returned multiple homes';; esac
[ -z "${HOME:-}" ] || [ "${HOME%/}" = "${NF_HOME%/}" ] || nf_fail 'HOME differs from the OS account home'
NF_EXISTING="$NF_HOME/.notifai/bin/notifai"
if [ -e "$NF_EXISTING" ] || [ -L "$NF_EXISTING" ]; then
  # Check the execution path before trusting the installed launcher. The native
  # Installation then verifies signed bytes and resumes setup without discovery.
  for nf_path in "$NF_HOME" "$NF_HOME/.notifai" "$NF_HOME/.notifai/bin" "$NF_EXISTING"; do
    [ ! -L "$nf_path" ] || nf_fail 'Existing installation contains a symbolic link; inspect it before repair'
    if [ "$NF_PLATFORM" = darwin ]; then nf_access=$(stat -f '%u %Lp' "$nf_path")
    else nf_access=$(stat -c '%u %a' "$nf_path"); fi
    printf '%s\n' "$nf_access" | awk -v uid="$NF_UID" '
      NF!=2 || $1!=uid || $2!~/^[0-7]+$/ {exit 1}
      {n=length($2); group=substr($2,n-1,1)+0; other=substr($2,n,1)+0; if(int(group/2)%2 || int(other/2)%2) exit 1}
    ' || nf_fail 'Existing installation is not privately owned; inspect it before repair'
  done
  [ -f "$NF_EXISTING" ] && [ -x "$NF_EXISTING" ] || nf_fail 'Existing launcher is not an executable file; repair it explicitly'
  nf_run "$NF_EXISTING"
fi
for nf_tool in curl tar gzip awk mktemp wc tr chmod mv mkdir rm; do
  command -v "$nf_tool" >/dev/null 2>&1 || nf_fail 'A required OS download or archive tool is unavailable'
done
if command -v sha256sum >/dev/null 2>&1; then NF_SHA=sha256sum
elif command -v shasum >/dev/null 2>&1; then NF_SHA=shasum
else nf_fail 'A SHA-256 checksum tool is required'; fi
nf_hash() { if [ "$NF_SHA" = sha256sum ]; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }
if [ "$NF_PLATFORM" = darwin ]; then
  if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then NF_ARCH=arm64; fi
  # Filled with the reviewed publisher identity before macOS publication.
  NF_MACOS_TEAM_ID='J3Q8DE3U2S'
  [ -n "$NF_MACOS_TEAM_ID" ] || nf_fail 'This installer has no configured macOS publisher identity yet'
else
  command -v getconf >/dev/null 2>&1 && getconf GNU_LIBC_VERSION >/dev/null 2>&1 || nf_fail 'This release requires glibc Linux; musl is not supported'
fi
case "$NF_ARCH" in x86_64|amd64) NF_ARCH=x64;; aarch64|arm64) NF_ARCH=arm64;; *) nf_fail 'This native CPU architecture is not supported';; esac
if [ "$NF_ARCH" = x64 ]; then
  if [ "$NF_PLATFORM" = linux ]; then
    awk '/^flags[[:space:]]*:/ {for(i=1;i<=NF;i++) if($i=="sse4_2") ok=1} END {exit !ok}' /proc/cpuinfo || nf_fail 'This x64 release requires SSE4.2 support'
  else
    /usr/sbin/sysctl -n machdep.cpu.features | awk '{for(i=1;i<=NF;i++) if($i=="SSE4.2") ok=1} END {exit !ok}' || nf_fail 'This x64 release requires SSE4.2 support'
  fi
fi
NF_TARGET="bun-$NF_PLATFORM-$NF_ARCH"
NF_SELECTED_CHANNEL=${NF_CHANNEL:-stable}
if [ "$NF_SELECTED_CHANNEL" = stable ]; then case "${NF_VERSION%%+*}" in *-*) nf_fail 'A prerelease requires --channel beta';; esac; fi
umask 077
NF_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/notifai-install.XXXXXXXX") || nf_fail 'Cannot create a private installer directory'
# Every child writes only inside this unique directory. No recursive cleanup
# path is read from an archive, release record, repository or User configuration.
trap 'rm -rf -- "$NF_TEMP"' EXIT
trap 'exit 1' HUP INT TERM
nf_download() {
  nf_url=$1 nf_output=$2 nf_limit=$3 nf_redirect=0
  while :; do
    case "$nf_url" in https://github.com/*|https://raw.githubusercontent.com/*|https://release-assets.githubusercontent.com/*) ;; *) nf_fail 'Release download left its trusted HTTPS origins';; esac
    # curl checks declared lengths; the OS file-size limit also bounds responses
    # without Content-Length on older curl. Shell block units vary, so verify
    # the exact byte limit after each completed response as well.
    if ! (ulimit -f "$(((nf_limit + 511) / 512))"; curl --disable --proto '=https' --tlsv1.2 --fail --silent --show-error \
      --connect-timeout 15 --max-time 180 --max-filesize "$nf_limit" --output "$nf_output.part" \
      --write-out '%{http_code}\n%{redirect_url}\n' "$nf_url") > "$NF_TEMP/response"; then nf_fail 'Release download failed; retry when the HTTPS channel is available'; fi
    [ "$(wc -c < "$nf_output.part" | tr -d ' ')" -le "$nf_limit" ] || nf_fail 'Release download exceeded its size limit'
    nf_status=$(awk 'NR==1 {print;exit}' "$NF_TEMP/response")
    case "$nf_status" in
      200) mv -f "$nf_output.part" "$nf_output"; return;;
      301|302|303|307|308)
        nf_redirect=$((nf_redirect + 1)); [ "$nf_redirect" -le 5 ] || nf_fail 'Release download has too many redirects'
        nf_url=$(awk 'NR==2 {print;exit}' "$NF_TEMP/response");;
      *) nf_fail 'Release download was unavailable';;
    esac
  done
}
nf_download "https://raw.githubusercontent.com/Raidiant-io/notifai/release-metadata/$NF_SELECTED_CHANNEL.bootstrap.tsv" "$NF_TEMP/channel.tsv" 262144
awk -F '\t' -v channel="$NF_SELECTED_CHANNEL" '
  function digest(s) {return length(s)==64 && s !~ /[^a-f0-9]/}
  NR==1 {if(NF!=5 || $1!="notifai-channel-v1" || $2!=channel || $3!~/^[1-9][0-9]*$/ || length($3)>16 || !digest($5)) exit 1; next}
  {if(NF!=2 || $1!="withdrawn" || length($2)>100 || $2!~/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/ || NR>1001) exit 1}
  END {if(NR<1) exit 1}
' "$NF_TEMP/channel.tsv" || nf_fail 'Invalid channel metadata'
NF_LATEST=$(awk -F '\t' 'NR==1 {print $4}' "$NF_TEMP/channel.tsv")
NF_LATEST_HASH=$(awk -F '\t' 'NR==1 {print $5}' "$NF_TEMP/channel.tsv")
nf_version "$NF_LATEST" || nf_fail 'Invalid channel version'
NF_SELECTED_VERSION=${NF_VERSION:-$NF_LATEST}
nf_version "$NF_SELECTED_VERSION" || nf_fail 'Invalid selected version'
if [ "$NF_SELECTED_CHANNEL" = stable ]; then case "${NF_SELECTED_VERSION%%+*}" in *-*) nf_fail 'Stable discovery selected a prerelease';; esac; fi
awk -F '\t' -v version="$NF_SELECTED_VERSION" 'NR>1 && $2==version {bad=1} END {exit bad}' "$NF_TEMP/channel.tsv" || nf_fail 'The requested release has been withdrawn'
NF_BASE="https://github.com/Raidiant-io/notifai/releases/download/v$NF_SELECTED_VERSION"
nf_download "$NF_BASE/bootstrap.tsv" "$NF_TEMP/bootstrap.tsv" 262144
awk -F '\t' -v version="$NF_SELECTED_VERSION" -v target="$NF_TARGET" '
  function digest(s) {return length(s)==64 && s !~ /[^a-f0-9]/}
  NR==1 {if(NF!=3 || $1!="notifai-bootstrap-v1" || $2!=version || !digest($3)) exit 1; next}
  {suffix=($2 ~ /^bun-windows-/)?"zip":"tar.gz"; name="notifai-"version"-"substr($2,5)"."suffix
   if(NF!=7 || $1!="artifact" || $2!~/^bun-(darwin|linux|windows)-(arm64|x64)$/ || seen[$2]++ || $3!=name || $4!~/^[1-9][0-9]*$/ || $4>268435456 || !digest($5) || !digest($6) || !digest($7) || NR>7) exit 1
   if($2==target) found=1}
  END {if(NR<2 || !found) exit 1}
' "$NF_TEMP/bootstrap.tsv" || nf_fail 'Invalid or unsupported release artifact metadata'
NF_INVENTORY_HASH=$(awk -F '\t' 'NR==1 {print $3}' "$NF_TEMP/bootstrap.tsv")
if [ "$NF_SELECTED_VERSION" = "$NF_LATEST" ]; then [ "$NF_INVENTORY_HASH" = "$NF_LATEST_HASH" ] || nf_fail 'Channel and release inventory differ'; fi
NF_FILENAME="notifai-$NF_SELECTED_VERSION-$NF_PLATFORM-$NF_ARCH.tar.gz"
NF_BYTES=$(awk -F '\t' -v target="$NF_TARGET" '$2==target {print $4}' "$NF_TEMP/bootstrap.tsv")
NF_ARCHIVE_HASH=$(awk -F '\t' -v target="$NF_TARGET" '$2==target {print $5}' "$NF_TEMP/bootstrap.tsv")
NF_LAUNCHER_HASH=$(awk -F '\t' -v target="$NF_TARGET" '$2==target {print $6}' "$NF_TEMP/bootstrap.tsv")
NF_RUNTIME_HASH=$(awk -F '\t' -v target="$NF_TARGET" '$2==target {print $7}' "$NF_TEMP/bootstrap.tsv")
nf_download "$NF_BASE/inventory.json" "$NF_TEMP/inventory.json" 262144
[ "$(nf_hash "$NF_TEMP/inventory.json")" = "$NF_INVENTORY_HASH" ] || nf_fail 'Release inventory digest differs'
nf_download "$NF_BASE/$NF_FILENAME" "$NF_TEMP/release.tar.gz" "$NF_BYTES"
[ "$(wc -c < "$NF_TEMP/release.tar.gz" | tr -d ' ')" = "$NF_BYTES" ] && [ "$(nf_hash "$NF_TEMP/release.tar.gz")" = "$NF_ARCHIVE_HASH" ] || nf_fail 'Release archive digest or size differs'
(ulimit -f 1572864; gzip -dc "$NF_TEMP/release.tar.gz" > "$NF_TEMP/release.tar") || nf_fail 'Release archive could not be expanded safely'
[ "$(wc -c < "$NF_TEMP/release.tar" | tr -d ' ')" -le 805306368 ] || nf_fail 'Expanded release archive exceeds its size limit'
tar -tf "$NF_TEMP/release.tar" > "$NF_TEMP/names" || nf_fail 'Release archive is invalid'
awk '
  {name=$0; lower=tolower(name); n=split(name,parts,"/")
   if(length(name)>240 || n>8 || seen[lower]++) exit 1
   for(i=1;i<=n;i++) if(parts[i]!~/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/ || parts[i]~/\.$/ || tolower(parts[i])~/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/) exit 1
   for(prior in paths) if(index(lower,prior"/")==1 || index(prior,lower"/")==1) exit 1
   paths[lower]=1; if(name=="notifai") launcher=1; if(name=="notifai-runtime") runtime=1}
  END {if(NR>130 || !launcher || !runtime) exit 1}
' "$NF_TEMP/names" || nf_fail 'Release archive contains unsafe or missing paths'
tar -tvf "$NF_TEMP/release.tar" > "$NF_TEMP/types" || nf_fail 'Cannot inspect release archive types'
awk 'substr($0,1,1)!="-" {bad=1} END {exit bad}' "$NF_TEMP/types" || nf_fail 'Release archive contains a link or non-regular member'
mkdir "$NF_TEMP/release"
tar --no-same-owner --no-same-permissions -xf "$NF_TEMP/release.tar" -C "$NF_TEMP/release" || nf_fail 'Cannot extract release files'
[ "$(nf_hash "$NF_TEMP/release/notifai")" = "$NF_LAUNCHER_HASH" ] && [ "$(nf_hash "$NF_TEMP/release/notifai-runtime")" = "$NF_RUNTIME_HASH" ] || nf_fail 'Release executable digests differ'
chmod 700 "$NF_TEMP/release/notifai" "$NF_TEMP/release/notifai-runtime"
if [ "$NF_PLATFORM" = darwin ]; then
  /usr/bin/codesign --verify --strict "$NF_TEMP/release/notifai" && /usr/bin/codesign --verify --strict "$NF_TEMP/release/notifai-runtime" || nf_fail 'macOS code signature verification failed'
  for nf_executable in notifai notifai-runtime; do
    /usr/bin/codesign -dv --verbose=4 "$NF_TEMP/release/$nf_executable" 2>&1 | awk -F= -v team="$NF_MACOS_TEAM_ID" '$1=="TeamIdentifier" && $2==team {ok=1} END {exit !ok}' || nf_fail 'macOS publisher identity differs'
    /usr/bin/codesign -vvvv -R=notarized --check-notarization "$NF_TEMP/release/$nf_executable" || nf_fail 'macOS notarization ticket verification failed'
  done
fi
nf_run "$NF_TEMP/release/notifai" --directory "$NF_TEMP/release" --inventory "$NF_TEMP/inventory.json"
