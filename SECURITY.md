# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's [private
vulnerability reporting](https://github.com/Raidiant-io/notifai/security/advisories/new)
on this repository. Do not open a public issue for a suspected
vulnerability.

Expect an acknowledgement within a few days. If you have not heard back
within a week, please open a public issue saying only that you are
waiting on a security response — with no details of the issue itself.

## Supported versions

Only the latest published version receives fixes.

## Scope

This repository is the client surface: the CLI and its native launcher, the
installers and update verification, the wire contract, and the agent skill.
The service and Companion Apps live elsewhere.

A report about **this repository** is in scope if it concerns the CLI or
the protocol types — for example credential handling on disk, a hook
adapter writing somewhere it should not, or a draft that passes local
validation but should not.

A report about **the service** is still welcome here, through the same
private channel, and will be routed onward.

## Design notes that may save you a report

These are deliberate, and knowing them may tell you whether what you
found is a finding.

**The service must remain secure when everything in this repository is
fully known.** Nothing here is a shared secret, and there is no security
value in any part of this tree being unread. If you find something whose
safety depends on this code being private, that *is* a vulnerability and
we want to hear about it.

**Machine credentials are stored per-machine, not in the repository.**
On macOS they go to the Keychain, or to a `0600` file when the Keychain is
unavailable. On Windows they are protected with the
Data Protection API for the current user and stored under
`%LOCALAPPDATA%\notifai`, not roaming configuration. On a Linux desktop
session they go to the Secret Service through `secret-tool`; a Linux
machine without one (a server, CI, SSH-only) keeps a `0600` file, and an
existing file is never moved into the Secret Service implicitly.
`NOTIFAI_CREDENTIALS=file` forces the plaintext file store for development
and tests; POSIX mode bits are not an NTFS ACL, so that override is not a
protected Windows store. A credential is scoped to one machine and can be
revoked without affecting others; `notifai logout --revoke` revokes it from
the machine itself.

A Notifai desktop app on the same machine hands the CLI a credential with
`notifai auth adopt --stdin`, so one sign-in sets up both. The secret
travels on standard input only, and adopt never replaces a different
credential that is already stored.

**A Companion Receipt proves delivery to a device, not display to a
person.** It is deliberately not evidence that anyone saw anything.

**Harness hooks run with the user's own privileges.** The CLI adds a
harness integration only when asked; updates keep integrations that are
already installed current. It does not edit a repository's ignore rules or
create commits in it.
