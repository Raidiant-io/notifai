# Shell quoting and lossless files

Use the shell running the tool, regardless of the terminal that launched the
agent. The skill's Send section owns quoting for every text value. Preserve
supplied punctuation, whitespace and newlines; shell escaping must deliver
the original bytes to the CLI.

## Native Windows arguments

Windows PowerShell 5.1 and PowerShell's Legacy native argument mode can lose
empty values, trailing backslashes and embedded double quotes when passing
arguments to executables. Use UTF-8 files for those values and for forms:
`--body-file <path>`,
`ask --form <path>` or `guidance set <topic> --file <path>`. Quote paths for
the shell too. Write it in the system temp directory, never the repository;
use UTF-8 without a BOM and preserve line endings exactly,
using the harness's file tool, which may need approval. Existing files need
no write. For text flags without a file option, use the lossless POSIX route
in an available Bash tool; its approval may be required.

PowerShell 7.3+ with native argument mode Windows or Standard preserves double
quotes for native executables. There, `--form-json '<json>'` works with every
single-quote character doubled. Use files when the native mode or installed
command wrapper is uncertain; leave the User's shell settings alone.

## Harness shells and approvals

- Claude Code on Windows supports Git Bash and PowerShell; without Git for
  Windows it uses PowerShell. Its `Bash(notifai …)` rules cover Bash commands;
  they do not establish PowerShell approval. Let that tool ask. On macOS/Linux
  its Bash tool uses POSIX quoting.
- Codex uses bash/zsh on macOS/Linux and PowerShell on native Windows. The
  literal concatenation in the skill preserves apostrophes and matches its
  rules. The backslash variant `'it'\''s'` does not match. See [Codex command limits](harness-codex.md#command-approval).
- Grok on native Windows prefers pwsh, then Windows PowerShell, then Git Bash;
  GROK_SHELL can override it. Use the actual tool shell's quoting rule.
- Cursor runs commands in its agent terminal; native Windows can use
  PowerShell and WSL uses POSIX quoting. Inspect the tool shell rather than
  assuming the editor's terminal profile. Command approval is User-owned.

A file write, heredoc, pipe or escaped value may need approval. Use a lossless
route even then: no prompt-free route is proven for every value on every
harness. An existing Body or form file can keep Codex's invocation a plain
`notifai …` command; preparing that file has a separate permission gate.

Sources: [PowerShell quoting](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules),
[native argument passing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing),
[Claude Code Windows setup](https://code.claude.com/docs/en/setup#native-windows),
[Grok shell selection](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-config/src/shell.rs),
[Cursor terminal](https://cursor.com/docs/agent/tools/terminal).
