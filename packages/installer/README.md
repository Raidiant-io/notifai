# Notifai npm installer

An optional, explicitly invoked bootstrap for the standalone Notifai CLI.
This candidate package is not published; its release trust and publication
workflow must be configured before it is offered to users.

Node is needed to run this bootstrap. The installed Notifai CLI, its hooks and
resident work use the native installation afterward. The package has no
`install` or `postinstall` script and does not claim the `notifai` command name.

`notifai-install --help` lists its flags. `--version` selects an exact runtime
version; `--channel beta` explicitly selects prereleases. Repeated invocation
reuses the fixed owned installation without fetching another release. Setup,
PATH configuration and subsequent `notifai update` operations belong to the
native CLI. Installing a newer version of this npm package only changes the
bootstrap. Removing it leaves the native installation and user data intact.

Before first execution, the bootstrap verifies the signed release records,
archive digest and extracted files with source-embedded release keys. Windows
staging uses a private NTFS directory. macOS also verifies raw-code notarization.
No release URL, key or native executable is selected from project configuration.
