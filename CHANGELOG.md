# Changelog

## 0.12.3 — the gates read the desktop build's nested harness

The desktop build (`DeepSeek Harness.exe` 0.2.1-rc.2) packs a different layout than 2.0.19-next: the
archive root carries only a shell — `dsh`, `node_modules`, `lib`, `package.json`, `renderer` — and its
`node_modules/@deepseek-ai` holds eight packages (cordis, cosmokit, dsh-api-gateway, dsh-brand,
dsh-deque, dsh-timeout, dsh-typert-protocol, schemastery), while all 306 harness packages sit under
`dsh/`. `0.12.2` accepted any root carrying `cordis`, so it picked the shell and the Host gate died
with `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`.

- **The harness is recognised by carrying both `cordis` and `dsh-tools`**, not `cordis` alone, and a
  root or its `dsh`/`app` subdirectory is searched for it — `harnessAt()` in
  `tools/dsh-app-modules.mjs`.
- **The unpack now also takes `dsh/`**, so a packed desktop archive yields `<cache>\dsh`, and the
  `note — the harness packages come from an asar archive, unpacked for this run into …` line names it.
- **A cache created by an older release is not trusted**: it is reused only when the full harness is
  inside it, so upgrading the plugin repairs the stale unpack instead of failing again.
- **Measured**: new desktop install 30 s cold / 6 s cached, previous 2.0.19-next install 6 s cached,
  both gates green; no installation at all still prints the actionable note and exits 1.
- **The READMEs now describe all three layouts** and the "Releasing" sections explain that the tag
  publishes through CI (trusted publishing, OIDC) and that provenance requires `repository.url` to be
  byte-identical to the GitHub context.

## 0.12.2 — the gates read a packed DSH 2.0 install

DSH 2.0.19-next ships its packages inside `resources/app.asar`, and the Host gate could not find them
there: Node resolves nothing inside an archive, and the sibling `app.asar.unpacked` holds only five
packages (cordis is not among them), so the run ended in
`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis'`. The plugin's own halves were never
affected — both load and run on 2.0.19-next — but nobody could re-run the gates on a 2.0 machine,
which is exactly when they are wanted.

- **`tools/dsh-app-modules.mjs` (new)** resolves the harness: `DSH_APP_DIR` first, then the nearest
  ancestor of the tools directory or the working directory that carries
  `node_modules/@deepseek-ai/cordis`. `DSH_APP_DIR` now accepts an install root, `resources/app`
  (an unpacked install), or `resources/app.asar` (a packed one).
- **A packed installation is unpacked once** into `%TEMP%\dsh-app-modules-<archive>-<size>-<mtime>` —
  only `node_modules` and `package.json`, staged under `<cache>.<pid>` and renamed into place, reused
  by later runs. Unpacking the real tree instead of re-implementing Node's resolution over the archive
  is deliberate: a hand-written resolver can disagree with Node on `exports` maps, conditions, and
  CJS/ESM, and that disagreement would show up as a green gate that proves nothing.
- **The hook and the Host gate use it**, and the gate says where the packages came from. A machine
  with no installation at all still fails the gate — with one actionable line naming the three
  accepted hand-offs, instead of a bare `ERR_MODULE_NOT_FOUND`.
- **Measured on 2.0.19-next**: 38 s cold (the unpack is most of it), 6 s on the cached second run,
  both gates green.

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
- **Confirmed on the machine that found it** — the "a disabled row is never named as the runtime" fix
  is not theoretical. This profile carries `pwsh-sandbox` (disabled) beside
  `desktop-windows-pwsh-sandbox` (enabled), both pinning the same Store family alias; the report named
  the *disabled* row until the fix, and after the restart it names the enabled one instead.
