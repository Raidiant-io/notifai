# Notifai for Claude Code, Codex & more

Your agents can reach you, and you can answer from your phone. The answer goes
back to the exact Agent Session that asked, in whichever harness it runs:
Claude Code, Codex, Cursor, OpenCode, OpenClaw, Hermes or Grok. T3 Code and
Orca work too.

Know which one needs you. Notifications name the Project and Agent Session
they come from, so several agents at once never blur into one generic bell.

<p align="center">
  <img src="https://raw.githubusercontent.com/Raidiant-io/notifai/main/docs/images/companion-home.jpg" width="250" alt="Notifai iPhone app home screen: several projects, each with agent sessions running in different harnesses">
</p>

Your agent sets it up. Paste this into any agent:

```text
Set up Notifai: https://app.notifai.sh/setup.md
```

## Install it yourself

On macOS, Linux or WSL:

```sh
curl -fsSL https://notifai.sh/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://notifai.sh/install.ps1 | iex
```

The installer doesn't need Node.js. It installs the `notifai` command and runs
`notifai init`, which signs you in and connects your harnesses.

This npm package is an optional launcher (Node.js 20.12 or newer) that installs
the same native runtime:

```sh
npx --yes @raidiant/notifai@latest init
```

Then get the Companion App for
[iPhone](https://app.notifai.sh/setup/companion?platform=iphone) or
[Mac](https://app.notifai.sh/download/mac), or
[join the free Android test](https://app.notifai.sh/test-android), and sign in
with the same Account.

## Pricing

Notifai is a paid subscription with a free trial. One plan covers the CLI and
every app. See [pricing](https://app.notifai.sh/pricing).

## More

- [Using Notifai](https://github.com/Raidiant-io/notifai/blob/main/docs/USAGE.md): commands, questions, setup options and updates.
- [Harness support](https://github.com/Raidiant-io/notifai/blob/main/docs/HARNESSES.md): what works in each harness.
- [Source and issues](https://github.com/Raidiant-io/notifai) on GitHub.
- [notifai.sh](https://notifai.sh), the [changelog](https://notifai.sh/changelog) and [support](https://app.notifai.sh/support).

Apache-2.0.
