# Changelog

## 0.12.1 — first public release

`dsh-win-pwsh7` puts a real PowerShell 7 under the Harness `pwsh` tool on Windows. This is the first
release published outside its author's machine, and it is the behaviour the README documents:

- **Detection and reporting** — `pwsh7_status` reads the executor rows, validates an explicit path,
  refuses a version-numbered Store path as un-pinnable, and prints a pasteable profile patch for the
  version-stable Store family alias.
- **One install path** — `pwsh7_install` installs the Microsoft Store package as a background job.
  It reads the connection cost first, because Windows defers Store downloads on a connection marked
  as metered, and the remedy it offers is that setting — never a second installer. When PowerShell 7
  is not wanted at all, the other answer is to disable the plugin.
- **A failed exit is evidence, not a verdict** — the runtime is re-probed before a failure is
  reported, because the Store can finish an install after winget has already exited non-zero.
- **Progress that is measured** — the job follows winget's own diagnostic log for named phases
  (downloading, deploying, registering) and measures the installer download from the bytes on disk,
  because winget reports no numeric progress of its own.
- **A prompt section** — the model is told which PowerShell the executor actually runs, so it knows
  whether `&&` and `||` work before it writes a command.
- **Two offline gates** under `tools/`, shipped with the package so anyone can re-run them. They run
  unconditionally — the behaviour half is fixture-pinned (`PATH`, `LOCALAPPDATA`, `ProgramFiles`)
  rather than skipped on a machine that has the per-machine MSI — they cover job cancellation and
  both inline install fallbacks, and every assertion has been shown to fail under a deliberate
  mutation.
- **Reviewed independently before release** — three Open Code Review passes, 36 findings triaged.
  30 were confirmed and fixed. The material ones: a gate that silently skipped half its checks; all
  inline install paths taking a single-shot verdict instead of the bounded re-probe; a stall warning
  that had become unreachable; a cancelled job that kept working (twice — the re-probe loop was the
  second half); an activation-time install that reported nothing because it waited forever; a report
  that could name a disabled row as the runtime. 4 findings were refuted with citations (the harness's
  own schema dialect, the ecosystem's client descriptor shape, the optional `jobs` service, and the
  string-error envelope), and 1 is recorded as backlog: the module-level state a second application
  in one process would share.
