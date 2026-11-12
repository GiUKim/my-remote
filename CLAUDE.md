# CLAUDE.md

Personal P2P remote desktop for Windows, and for Linux with an X11 session (see "Linux (X11)" under
Gotchas). `host/` is an Electron app that captures every monitor and
injects input; the client is a single HTML file opened in Chrome/Edge on another PC. Media and input
flow peer-to-peer over WebRTC; a public ntfy server is used only to exchange encrypted handshake
messages. User-facing docs are in [README.md](README.md) (Korean). Reply to the user in Korean.

## Setting up a host PC (the usual request)

When the user asks you to set this up, do the following in order.

1. **Confirm intent first.** This tool hands over full control of the PC. Before running anything, tell
   the user in one or two sentences that (a) it must be allowed by their company's security policy and
   (b) it cannot be used while the screen is locked. Continue once they acknowledge.
2. **Run setup** from the repo root:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
   ```
   It needs no admin rights. It downloads portable Node 22 LTS into `tools\node` if Node >= 20 is
   missing (SHA-256 verified), runs `npm install` in `host`, then runs the self-test.
   On Linux (X11 session) run `./setup.sh` instead. It downloads no Node: without Node >= 20 and npm
   on PATH it says what to install and stops. Then `npm install` in `host` and the self-test, as above.
3. **Check the result.** Success is `[selftest] ALL PASS` and exit code 0. `INFO` lines are not
   failures. The self-test is local only (relay on 127.0.0.1, no STUN, throwaway key and profile,
   view-only client), so it is safe to run without asking. It does capture the screen for about a minute.
4. **Do not start the real host yourself.** Tell the user to double-click `start-host.bat` (Linux: run
   `./start-host.sh`). Starting the
   host connects the PC to an external server and makes it reachable with the key, so that step is the
   user's decision and action. Tell them a Windows Firewall prompt may appear on first run.
5. **Hand over the usage steps** from README.md "사용 방법": copy the key from the host window into a
   password manager, take `my-remote-client.html` to the other PC, leave the PC unlocked with sleep
   disabled.

If the user only wants to see it working, run or point them to `local-test.bat` (same isolation as the
self-test, opens a view-only client in their default browser; `./local-test.sh` on Linux opens it in
the client app instead).

## Rules for agents

- **Never read, print, log, or commit the access key.** It lives DPAPI-encrypted in
  `%APPDATA%\my-remote-host\config.json` (`keyEnc`); on Linux in `~/.config/my-remote-host/config.json`,
  encrypted with the desktop's keyring or, without one, only obscured (reading that file is reading
  the key). Do not decrypt it, do not ask the user to paste it
  into the chat, and do not put it in a URL, file, or commit. The user copies it with the host window's
  `키 복사` button.
- **Never bake a key into `my-remote-client.html`.** The committed client contains no key by design.
- **Keep the loader and its bootstrap protocol stable.** `my-remote-client.html` is a loader that users
  receive once and keep; old copies stay in use. Changing the `ver`/`app` exchange, the key derivation
  or the signaling format in `signal.js` strands them. New behaviour belongs in
  `client.template.html`, which the host serves and which therefore updates by itself.
- **Do not weaken the handshake.** Every signaling message must stay encrypted and authenticated with
  keys derived from the shared secret (`host/signal.js`); the DTLS fingerprints inside the SDP are what
  make the media channel trustworthy.
- **Do not run the non-isolated host** (`start-host.bat`, `start-host.sh` without `--selftest`, `npm start`)
  or kill a running host without the user asking. Use `--selftest` or `--localtest` for verification.
- **RustDesk is AGPL-3.0.** Its source may be read for ideas (see "Performance"), but do not copy code from
  it, or from any other copyleft project, into this repository.
- **Native code is built from the sources in `native/`** with the distribution's own cross-compiler on a
  Linux machine the user provides (`node native/build.js user@host`). Do not download compilers,
  toolchains or prebuilt binaries from elsewhere onto either machine. The one DLL that is committed is
  `host/bin/capture.dll`, together with `host/bin/capture.dll.json` (what it was built from); commit
  it only as `native/build.js` wrote it, in the same commit as the `capture.cpp` it was built from.
  The self-test fails when the two do not match. Never commit a DLL from anywhere else.
- **Do not inject input on the user's machine as a test** beyond what `--selftest` does (it injects
  none). Stray clicks and keystrokes land in whatever the user has open. `--dragout-check` does
  inject (into an Explorer window it opens itself), so run it only after the user agreed. So does
  `--input-check` (Linux: moves the pointer, clicks, scrolls and types into windows and a second
  program it opens itself): on a virtual display (Xvfb) only, or after the user agreed.
- Do not commit `node_modules/`, `tools/`, `dist/`, or any `config.json` (see `.gitignore`).

## Gotchas

- **Native capture** (`capture: 'auto'`, used when `host/bin/capture.dll` is there, which it is in the repo). `preload.js` loads the DLL through
  koffi (so the host window runs with `sandbox: false`; context isolation stays on) and runs one loop
  per monitor: `mc_next` waits for the next desktop image on a worker thread, the pixels become a
  `VideoFrame`, that goes over a message port to the page, and `host.js` writes it into a
  `MediaStreamTrackGenerator` whose track is sent like any other. Things that bit:
  - A wait that is under way when the page's script environment is torn down (the window reloads,
    e.g. after a new key is issued) kills the renderer process. The loops are therefore closed in
    `beforeunload`; closing waits for the wait under way. Keep it that way.
  - Windows allows one duplication of an output per process: a capturer left open by an earlier
    page makes the next `mc_open` fail. `capturer()` closes all eight handles when it loads the DLL.
  - Without a rest between images (`captureGap: 0`) the capturer has every image at once, but
    reading the screen back that often delayed the host's own screen under full-screen motion
    (the bench picture reached the host's screen in 78 ms at the 95th percentile instead of 26).
    With 8 ms of rest it does not, at the price of about 4 ms.
  - The images carry no pointer, so the system cursors are not hidden in this mode
    (`s.cursorHidden` is still reported as true: the video has no pointer in it).
  - The sound still comes from the engine's capture of the first monitor; its video track is stopped.
  - A still screen is sent `REPEATS` more times (`preload.js`) so the encoder brings it to full
    quality, then nothing is sent. A monitor nobody looks at is not captured at all (`show`).
  - A monitor in HDR mode or rotated, or any failure: the session is renegotiated with the engine's
    capturer (`nativeOff`). Not tried on such a monitor.

- **Mouse buttons held on the host.** Reported from a real session (2026-11-12): a window dragged
  across host monitors stopped half way, and after letting go the window still followed the pointer
  until the next click, i.e. the host kept the button down. The cause was not pinned down. A browser
  drag-and-drop or selection that takes over the pointer (`pointercancel`, no `pointerup`) would do
  exactly this, so the client blocks `dragstart`/`selectstart` and lets go on `pointercancel`, and
  every `mm` carries the held buttons (`h`) so the host can let go of one whose `mu` was lost. The
  diagnostics log counts each of these (`ptr`, `released`): read it if it happens again.
- **Another remote-control program connected at the same time.** In that session the host's main
  thread stalled three times (57, 71, 19 s), each stall ending when a Chrome Remote Desktop session
  to the same PC (re)connected (Windows Application log, source `chromoting`). Clicks did nothing
  meanwhile and were then injected all at once. The host now tells the client (`others`).

- **Dragging out of the remote picture.** A program that runs a drag-and-drop has handed the mouse to
  OLE's hidden window of class `CLIPBRDWNDCLASS`; `input.dragging()` reads that (`GetGUIThreadInfo`,
  read-only) and the host tells the client (`drag`). When the client's pointer then leaves every client
  window, moves are no longer sent (the host's pointer waits); on release outside, the host presses
  Escape (ends the drag without a drop), Ctrl+C (what was dragged is still selected), releases the
  button and sends the clipboard's files or text (`dragOut` in `main.js`). Explorer takes 0.35-0.5 s
  from the first move to starting its drag (measured with `--dragout-check`), so a quick drag leaves
  the client window before the host knows: while the pointer is outside with a button held and no
  drag is reported, the client sends no moves for up to `LEAVE_WAIT` (0.7 s) and asks the host at once
  (`dragq`; the host then polls `input.dragging()` every 15 ms). Let go in that time, it waits for the
  answer: a drag shows up -> `dragout`, else `mu` where the host's pointer waited. The old behaviour
  (moves past the edge at once) clamped the host's drag at the screen edge and, on release, let go
  there - the failure the user reported. A dragged folder is sent as its files with paths ('a/b/c')
  plus `dir` entries for empty folders; links and junctions are not followed. This replaces the host's
  clipboard. Isolated modes never do the key presses. On the client the app (`client/shell.js`) saves
  files into the folder they were dropped on (desktop, or an Explorer window whose folder it asks the
  shell for through PowerShell); for other targets it puts the data on the clipboard and, within 8 s of
  the drop, clicks once at the drop point and presses Ctrl+V. That click and key press are the only
  input the client app ever injects.

- **A display with Windows HDR on is captured wrong.** Desktop Duplication hands over the desktop after
  Windows raised SDR content to HDR brightness and clipped it at SDR white, so the picture is brighter
  and the light tones are plain white (measured: linear gain 3, everything above ~170/255 clipped). The
  clipped part is gone, so it cannot be corrected afterwards. `input.displayColor()` finds such displays
  (`DisplayConfigGetDeviceInfo`, read-only; Electron's `screen` does not report it reliably). The host
  logs a warning, the offer marks the monitor `hdr`, the client shows it. The fix is the user's: turn HDR
  off for that display. The bench avoids HDR displays, because the quality comparison is meaningless there.

- **Linux (X11).** `host/input.js` is the platform-neutral half (mapping to the desktop, held keys and
  buttons, the dry run); `host/platform/win32.js` holds all the Win32 code and `host/platform/linux.js`
  talks to X11 through koffi (libX11, libXtst, libXfixes) on a connection of its own, opened at first
  use. Callers use `input.*` without platform checks; where a platform has no equivalent the function
  returns a neutral value (`displayColor()` -> `[]`, `captureClass()` -> `''`, `hideCursors()` -> 0, ...).
  Things that bit or matter:
  - Only X11 sessions. On Wayland (`XDG_SESSION_TYPE=wayland`) and on macOS (no backend at all) the host
    runs view-only and says why (`input.viewOnlyReason()`: a `[host] WARNING` line and a line in the
    host window). Untested on macOS.
  - Xlib's default error handler ends the process. Only calls that name another program's window can
    fail; they run in `guarded()` (our handler, `XSync`, the old handler back). Everything sent through
    XTest is checked first (key codes against `XDisplayKeycodes`, buttons against `XGetPointerMapping`):
    a `BadValue` would end the host.
  - Keys: `KeyboardEvent.code` -> Linux evdev code, X key code = evdev + 8 (the evdev keymap of every
    current X server, Xvfb included); `HangulMode`/`HanjaMode` by meaning, like on Windows. Pointer:
    physical pixels are X root coordinates (`XTestFakeMotionEvent`), wheel = buttons 4-7, one click per
    120 with the rest kept, back/forward = buttons 8/9.
  - `screen.dipToScreenRect` exists only on Windows in Electron 33: `physicalRect()` in `main.js` scales
    the bounds by `scaleFactor` elsewhere. Electron fills `display_id` on X11, so sources still match
    displays by id.
  - The engine's capturer on X11 paints the pointer into every frame (measured with `--input-check`:
    the pixels under it change when it moves away), and X11 has no `SetSystemCursor`: `hideHostCursor`
    does nothing there (`input.hidesCursors` false, offer `cursorHidden: false`), so the client sees its
    own pointer and, slightly behind, the host's in the video. Fixing that needs a capturer that leaves
    the pointer out (reading the screen through XShm does); not done.
  - Cursor shape: `XFixesGetCursorImage` gives the picture and, for cursors loaded from a theme by name
    (GTK, Qt, libXcursor), the name. Chromium's own cursors and the X server's default cursor have none
    and go as pictures. `pixels` holds one `unsigned long` per pixel (8 bytes on x64).
  - Drag-out: an XDND drag is under way when its source took `XdndSelection` (an XFixes selection event)
    while a button pressed through us is held (sources keep that selection after the drag). What is
    dragged is then read from that selection (`input.dragData()`: `TARGETS`, then `text/uri-list` or
    `UTF8_STRING`), and the drag is ended with Escape and the release: no Ctrl+C, the host's clipboard
    stays as it was. Escape + Ctrl+C (still the fallback) does not work with Chromium-based sources:
    Chromium clears its text selection 3 ms after a cancelled drag, so Ctrl+C copies nothing. Whether
    Chrome or VS Code on a Windows host behave the same way was not checked.
  - The clipboard's change counter (`clipSeq`) counts XFixes owner changes of `CLIPBOARD`. Electron's
    `clipboard.writeBuffer` replaces the whole clipboard on each call, so a file list goes on in one
    format: `x-special/gnome-copied-files` (GNOME Files, Nemo, Caja, Thunar), `text/uri-list` when
    `XDG_CURRENT_DESKTOP` says KDE. Reading takes either.
  - The client app on Linux never clicks or types: files let go over the bare desktop (no window there,
    a `_NET_WM_WINDOW_TYPE_DESKTOP` window, or GNOME's desktop-icons window) go into
    `app.getPath('desktop')`, anything else onto the clipboard and the page says to paste. Received
    files wait in `~/.cache/my-remote-drop` (on Linux `/tmp` is shared by all users).
  - No keyring (`safeStorage` backend `basic_text`, usual outside a GNOME/KDE session): the host calls
    `setUsePlainTextEncryption(true)`, prints a warning and keeps `config.json` at mode 0600.
  - Chromium's sandbox needs its setuid helper (npm does not install it so) or unprivileged user
    namespaces: Ubuntu 22.04 has them (the self-test ran with the sandbox on), 23.10 and later restrict
    them through AppArmor. `host/linux-launch.sh` then stops and names the two ways out (the helper,
    with sudo, or `MY_REMOTE_NO_SANDBOX=1`).
  - `--localtest` opens the client app, not the default browser (often Firefox, which the page is not
    made for). The launchers start Electron in the background like the `.bat` files; its output goes to
    `$XDG_RUNTIME_DIR/my-remote-*.log`.
  - Windows-only: native capture, cursor hiding, HDR detection, the Chrome Remote Desktop and outline
    checks (`others` is `{crd: false, outline: false}`), `--dragout-check`, `--cursor-check`.

- **`ELECTRON_RUN_AS_NODE`**: terminals inside VS Code / Cursor set it, and Electron then runs as plain
  Node and crashes with `Cannot read properties of undefined (reading 'requestSingleInstanceLock')` or
  similar. Clear it before launching Electron (`Remove-Item Env:ELECTRON_RUN_AS_NODE` or `unset`). The
  `.bat` files and `setup.ps1` already do this.
- **Node may not be on PATH.** After setup it can be at `tools\node\node.exe`; use that path for `npm`.
- **Windows Firewall prompt** appears the first time a given `electron.exe` path opens UDP ports.
  Allowing it adds an inbound rule for that executable on the chosen network profile. Removing the rule
  later needs admin rights.
- **Lock screen / UAC** are on a separate secure desktop: they cannot be captured or controlled by a
  normal-user process. This is the main functional limitation, not a bug to "fix" with a quick patch.
- **Cursor and the captured video.** Chromium always paints the cursor into captured frames
  (`cursor: 'never'` is ignored, and hiding it with the Magnification API does not affect capture). The
  host therefore swaps the system cursors for a transparent one (`SetSystemCursor`) *before* capture
  starts and restores them with `SPI_SETCURSORS` when the session ends. Order matters: the capturer
  caches cursor pictures by handle, so a swap made after capture has started has no effect. Handles do
  not change, so reading the current cursor still works. `cursor-guard.js` restores the cursors if the
  host dies; a marker file in userData triggers a restore on the next start. App-specific cursors are
  not system cursors, so they stay in the video; their picture is sent so the client shows the same shape.
- **Clipboard read permission cannot be kept by a `file://` page**, so the client never calls
  `navigator.clipboard.readText()`. Client-to-host text comes from the browser's `paste` event: the
  paste shortcut is not `preventDefault`ed and its key-down is held until the event has delivered the text.
- **Console output encoding**: Korean text printed by the host is garbled in a PowerShell 5.1 pipe, so
  self-test output is English. Keep it that way. Keep `setup.ps1` ASCII-only for the same reason.
  The `.sh` files must keep LF line endings (`.gitattributes` says so for every checkout).
- **Same-PC control is unusable** (the injected cursor jumps under the viewer window). That is why
  `--localtest` is view-only.

## Commands

Run from `host/` with Electron's env var cleared.

| Command | What it does |
|---|---|
| `npm run selftest` | Local end-to-end test, prints `[selftest] PASS/FAIL` lines, exits 0 or 1 |
| `electron . --selftest --shell-check` | Same, plus the client app's one-click layout on the real screens. Fullscreen windows cover every monitor for a few seconds, so ask the user first |
| `electron . --selftest --dump-panel=<file.png>` | Quick look at the arrangement panel: connects, draws the panel as if the client had two screens, writes pictures (`<file>.png`, `-ctrl-drag`, `-swap-drag`, `-together`) and exits. About 20 s, opens no window |
| `node native/build.js user@host[:folder]` | Builds the native modules on a Linux machine with mingw-w64: `host/bin/capture.dll` + `capture.dll.json` (commit them with the source), `tools/native/capprobe.dll`. After a change in `native/` |
| `npm run bench -- --native-probe --capture-probe ...` | Bench with a native observer of the same display: reports when the picture was on the host's own screen and how long after that the capturer in use had it. Needs `tools/native/capprobe.dll` |
| `electron . --selftest --dragout-check` | Only real drags out of a real Explorer window this check opens on a temp folder (`dragcheck.js`): A straight on the host, B and C through a client window running the real page in the client app's shell (held outside; let go at once, before Explorer started its drag). INJECTS INPUT for about half a minute, so only with the user's agreement; skipped when the clipboard holds more than text, which is put back |
| `electron . --selftest --clip-check` | Same, plus putting two files on this PC's clipboard and reading them back. Only runs when the clipboard holds nothing or plain text, which is put back |
| `electron . --selftest --cursor-check` | Same, plus a real-screen check that hiding the host cursor removes it from the video. The PC's cursor vanishes for about 20 seconds, so ask the user first. Windows only |
| `electron . --selftest --input-check` | Linux (X11) only (`inputcheck.js`): the pointer read back after an XTest move, whether the engine's video has the pointer in it (INFO), all 133 keys of the table, five buttons and the wheel into a test window, window-or-desktop under the pointer, text and a file dragged out of a second program it starts, and the client app's drop placement. INJECTS INPUT: on a virtual display only, or with the user's agreement |
| `electron . --selftest --client-app-check` | Same, plus at the end the client app (`client/main.js`, a process of its own, with a profile of its own) on a loader that talks to the test's relay only; passes when its measurements say it shows the host's picture. Opens a window for about 20 s |
| `xvfb-run -a -s "-screen 0 1920x1080x24" <electron> . --selftest --input-check --clip-check --client-app-check` | How the Linux side was verified on a server (Ubuntu 22.04, Xvfb). Add `--no-sandbox` where Chromium's sandbox cannot run (see Gotchas) |
| `./setup.sh [--skip-selftest]`, `./start-host.sh`, `./start-client.sh`, `./local-test.sh` | Linux counterparts of `setup.ps1` and the `.bat` files (shared code in `host/linux-launch.sh`). Extra arguments go to Electron, e.g. `./start-host.sh --selftest` |
| `npm run bench -- --net=direct,home,narrow,wifi --try=old,base` | Measures delay and smoothness on this PC for the given link conditions and settings, prints a table (see "Performance"). `--picture-test=quality` measures picture quality instead (a window opening, a window being dragged, scrolling); `--snapshot` saves what the client showed next to what was drawn. About 45 s per run. Shows a test picture on one display and a small window on another for that time; they never take focus and no input is injected, but tell the user before a long series |
| `npm run bench -- --remote=user@host --net=direct --try=base` | The same bench with the client page on another machine, reached over ssh: a real second machine and a real network instead of one PC. That machine needs `~/my-remote-dev/electron/` (an unpacked Electron release for its platform) and `xvfb-run`; signaling goes through an ssh tunnel, only the WebRTC traffic crosses the network directly. Add `--capture-probe` to split the delay into its parts. This sends the picture of one of this PC's displays to that machine, so the user must have agreed |
| `npm run localtest` | Local trial: host window plus view-only client in the default browser |
| `npm start` | The real host (connects to the signaling server). User-initiated only |
| `npm run build-client` | Regenerates `../my-remote-client.html` (the loader) from `loader.template.html` and `signal.js` |
| `npx @electron/packager . MyRemoteHost --platform=win32 --arch=x64 --out=../dist --overwrite --no-asar` | Optional standalone exe folder (about 300 MB, not committed) |

`host/client.template.html` is served by the running host, so changes to it reach clients once the host
is restarted; nothing needs rebuilding. After changing `host/loader.template.html` or `host/signal.js`,
run `npm run build-client` and commit the regenerated `my-remote-client.html` (and remember that users
must then be given the new file). Run `npm run selftest` after either.

## Layout

| Path | Role |
|---|---|
| `setup.ps1` | One-shot host setup and self-test |
| `start-host.bat`, `local-test.bat` | Launchers for the real host and the local trial |
| `my-remote-client.html` | Built loader: the one file a client PC keeps (generated, committed for convenience) |
| `start-client.bat` | Launcher for the client app (uses the Electron installed under `host/node_modules`) |
| `setup.sh`, `start-host.sh`, `start-client.sh`, `local-test.sh` | The same for Linux (bash, executable in git, LF line endings) |
| `host/linux-launch.sh` | Sourced by those: Electron's path, X11 session and sandbox checks, starting Electron in the background |
| `client/main.js`, `client/shell.js`, `client/preload.js` | Client app: a thin Electron window around the loader. `shell.js` places the page's windows on the requested screen, makes them fullscreen without a click per window, grants permissions, and puts things dragged out of the remote picture where they were dropped (it loads `host/input.js`: Win32 or X11). Exposes `window.mrShell`. `main.js --loader=<file>` shows another loader with a profile of its own (self-test, local trial on Linux). These files are not updated through the loader: the page must feature-detect what an installed app offers |
| `host/main.js` | Electron main: config and key storage, monitor enumeration, tray, IPC, isolated modes |
| `host/preload.js` | The only bridge between the renderer and main (`window.hostApi`). Also runs the native capturer's loops and hands their frames to the page over a message port |
| `host/host.html`, `host/host.js` | Host UI and the WebRTC side: capture, encoding control, data-channel routing |
| `native/capture.cpp` | The native screen capturer (DXGI Desktop Duplication) |
| `host/bin/capture.dll`, `capture.dll.json` | That capturer built by `native/build.js` (stripped, no time stamp: the same source and compiler give the same file), and the record of the source hash, DLL hash, compiler and command. Committed. The host loads it when it is there; without it the engine's capturer is used |
| `native/capprobe.cpp` | Bench only: watches a display natively and reports when each bench frame was presented and handed over |
| `native/build.js` | Sends the sources in `native/` to a Linux machine, builds them there with mingw-w64 and brings the DLLs back: `capture.dll` (and its record) into `host/bin`, the rest into `tools/native` |
| `host/input.js` | Input injection, platform-neutral half: the client's messages mapped to the desktop, held keys and buttons, the self-test's dry run; picks the platform module and exports one interface |
| `host/platform/win32.js` | Win32 through koffi FFI: `SendInput`, cursor shape and picture, hiding/restoring the system cursors, HDR displays, drag detection, the clipboard's file list, the client app's drop helpers |
| `host/platform/linux.js` | X11 through koffi FFI: XTest input, XFixes cursor and selection events, the dragged data read from `XdndSelection`, the window under the pointer, the clipboard's file list |
| `host/inputcheck.js` | `--input-check` (Linux): real input into windows and a second program it opens itself |
| `host/cursor-guard.js` | Separate small process that restores the cursors if the host process dies (Windows) |
| `host/signal.js` | Shared by host and client: key derivation, encrypted signaling channel |
| `host/loader.template.html` | Loader source: asks for the key, fetches the client page from the host, runs it |
| `host/client.template.html` | The client page itself. Built in memory at host start and sent to loaders; never shipped as a file |
| `host/build-client.js` | Builds both pages (`build`, `buildLoader`); the CLI writes the loader file |
| `host/selftest.js` | Local ntfy-compatible relay and the self-test scenario |
| `host/dragcheck.js` | `--dragout-check` (Windows): real drags out of a real Explorer window |
| `host/bench.js`, `host/bench-peer.js`, `host/bench-pattern.html` | The bench: host side, client side (its own Electron process) and the test picture |
| `host/bench-remote.js` | The client side of a two-machine bench run; copied to the other machine and driven over ssh |
| `host/netem.js` | UDP link emulator for the bench: delay, jitter, loss, rate limit with a bounded queue |
| `host/bench-run.js` | Runs the bench over link conditions (`NETS`) and settings (`TRIES`) and prints one table |

## Protocol

Shared secret: 32 random bytes, base64url. HKDF-SHA256 derives two AES-256-GCM keys (one per
direction) and two topic names.

Bootstrap (loader, before anything else; same channel and encryption as signaling):

- loader -> host topic: `{t:'ver', sid, ts, have}` where `have` is the hash of the page it has cached, or `''`
- host -> client topic: `{t:'app', sid, ts, hash, html?}`; `html` is left out when `have === hash`

The loader stores the page in localStorage, sets `window.__mrBoot = {key, remember, preset, updated}`
and replaces its own document with the page (`document.open/write`); the page then connects as below.
The host builds the page once at start, so page and host always match.

Signaling (through the relay, each message deflated, encrypted, chunked to 3000 chars):

1. client -> host topic: `{t:'hello', sid, ts, mode, codec}` (`codec` optional: `H264`, `H264HQ`, `VP9`, `AV1`)
2. host -> client topic: `{t:'offer', sid, ts, sdp, ice, audio, codec, cursorHidden, app, monitors:[{idx, mid, x, y, width, height, primary, hdr?}]}`
   (`x`,`y`,`width`,`height` are the monitor's rectangle on the host's virtual desktop, physical pixels)
3. client -> host topic: `{t:'answer', sid, ts, sdp}`

The host appends `x-google-start-bitrate` to the answer's video codec parameters so the bandwidth
estimate does not start near 300 kbps. ICE is non-trickle (candidates are gathered before sending). The host rejects messages older than five
minutes and replayed `sid` values. A new `hello` replaces the current session.

Data channel `input` (JSON text):

| Direction | Message | Meaning |
|---|---|---|
| client -> host | `mm` `md` `mu` `mw` | Mouse move/down/up/wheel; `d` = monitor index, `x`,`y` = 0..1 within that monitor. During a drag they may leave 0..1, which continues onto the neighbouring monitor. `mm` carries `h`: the buttons the client's pointer holds (bit b = button b of `md`/`mu`); the host lets go of any button it holds that is not in `h`, so a lost `mu` cannot leave a button down. A move never presses anything |
| client -> host | `kd` `ku` | Key down/up; `c` = `KeyboardEvent.code`, `k` = `key` |
| client -> host | `reset` | Release every held key and button |
| client -> host | `view` | `v` = `[{i, w, h}]`: monitors on screen and the size each is shown at, in device pixels (`0` = full size). The host pauses the rest, scales down to the shown size (never up) and splits bitrate by pixels sent |
| client -> host | `mode` | `sharp` or `smooth` |
| client -> host | `cs` | Client measurements for the host's diagnostics log |
| client -> host | `dragout` | The pointer was let go outside every client window while the host reported a drag; `b` = button. The host ends its drag, copies what was dragged and answers with `dragdata` |
| client -> host | `dragq` | The pointer just left every client window with a button held: the host checks for a drag-and-drop every 15 ms for 1.2 s and sends `drag` the moment one starts |
| both | `clip` | Clipboard text, at most 60000 chars |
| host -> client | `cur` | Current host cursor: `c` = CSS cursor name, or `img` (PNG data URL) with hotspot `hx`,`hy` for an app-specific cursor |
| host -> client | `hs` | Host-side statistics every 2 s (codec, encoder, bitrate, per-monitor capture/encode fps and limiting factor) for the client's diagnostics report |
| host -> client | `drag` | `on`: whether a drag-and-drop is under way on the host |
| host -> client | `dragdata` | Answer to `dragout`: `kind` `text` (`s`, `cut`), `files` (`files:[{id,name,size,dir?}]`, `skipped`; the bytes follow on the `file` channel; `name` may be a path 'folder/sub/file') or `none` with `why`: `nodrag`, `nocopy`, `empty`, `toobig` |
| host -> client | `others` | `crd`: a Chrome Remote Desktop session is connected to the host as well (`remoting_desktop.exe` runs); `outline`: the host drags windows as an outline only. Checked every 10 s, sent when it changes; the client shows a warning. Both are checked on Windows only (elsewhere always false) |
| host -> client | `bye` | Deliberate close; the client must not auto-reconnect |
| host -> client | `renew` | Host monitors changed; the client reconnects at once and keeps its windows |

Data channel `file` (host -> client, opened by the host per transfer, ordered): text `{t:'file', id, name, size}`,
then the bytes in binary messages of at most 60000, text `{t:'fileend', id}`; an empty folder of a
dragged folder as `{t:'dir', name}`; after the last file `{t:'filesdone'}`, or `{t:'fileerror'}`. The
client app stages one transfer under one folder (`shell.fileBegin(name, group)`, names made safe part
by part, never leaving the staging folder) and moves its top-level files and folders to the target. The host only sends files it found on its own clipboard in the
`dragout` step; the client cannot ask for a path.

Monitor coordinates are physical pixels (`screen.dipToScreenRect`), mapped to the 0..65535 virtual
desktop range for `SendInput`. Keys are sent as set-1 scancodes so the host's keyboard layout applies;
`HangulMode`/`HanjaMode` and a few others go by virtual-key code. On X11 the physical pixels are the
root window's coordinates as they are, and keys go as X key codes (Linux evdev code + 8), which the
host's keyboard layout applies to in the same way.

## Client layout model

Each client window is a *view*. What it shows is `sel`: one host monitor (its index), several together in
their real arrangement with gaps closed (a sorted list of indexes; `'all'` when it is every monitor), or
nothing (`'none'`, main window only). One monitor can be shown in `fit` or `1:1` mode. The video element is sized to the monitor's exact
aspect ratio, so pointer mapping is a plain proportion of the element. Policy, in `client.template.html`:

- `planLayout(N, M, cur, primary)` decides which host monitor goes on which client screen (both sorted
  left to right): all N on neighbouring screens when N <= M, otherwise M neighbouring monitors around the
  primary. The result is remembered per `N:M` in localStorage.
- Selecting a monitor that another window shows swaps the two, so a monitor is never shown twice.
- The arrangement panel (`모니터 배치`, `arr*` functions) edits one list: for every host monitor, the client
  screen it is shown on, or null. `arrOp(A, src, dst, copy)` is the whole drag rule set (host onto host
  swaps, Ctrl adds the target to the dragged monitor's screen; screen and host: that screen shows that
  monitor and what it showed moves to the monitor's old place; screen onto screen swaps).
  `applyAssign(A, cs)` makes the windows match: it changes what open windows show, opens a window on a
  screen that needs one and closes the window of an emptied screen (the main window shows a hint
  instead). A click on a host tile turns it off and remembers where it was. While the panel is open
  every monitor is requested at tile size, so tiles of unused monitors are live too.
- `Ctrl+Alt` + arrows / digits / Enter are local shortcuts and are not forwarded (user can turn them off).
- An exact integer enlargement is drawn with `image-rendering: pixelated`; anything else is smoothed.
- Browsers allow one popup and one fullscreen request per click and restrict window placement, so in
  a browser each extra window needs a click. The client app (`client/`) removes this: the page detects
  it through `window.mrShell`, asks it for the screens and for `fullscreenAll()`. The page is the same
  in both; keep app-only behaviour behind `if (shell)`.
- The offer carries the hash of the page the host serves (`app`). An open page whose stored hash
  differs reloads through the loader to fetch the new one, so clients follow host updates by themselves.

## Performance

Do not tune by guessing; measure. `npm run bench` (from `host/`) runs the real host and the real
client page on this PC, isolated like the self-test. A test picture alternates between a still
screen with one small change every 0.5 s ("typing") and a page of text scrolling at the display's
refresh rate ("scroll"); every frame carries its draw time in a row of cells, and the client side
reads it from each frame it shows. The result is frames shown per second, the delay from "drawn on
the host" to "on the client's screen" (p50/p95/max), gaps between shown frames, plus encoder,
pacer, jitter-buffer and bandwidth-estimate figures. `--net=` sends the traffic through
`netem.js` (see `NETS` in `bench-run.js`); `--try=` picks settings (`TRIES`, or `--tries-file`);
`--snapshot` saves what the client showed mid-scroll and when still. A run's config can set host
config, engine field trials and switches, and JavaScript to run in the host or client page, so a
change can be tried before it is written into the code.

What it measures and what it does not: both ends share this PC's CPU and GPU; the delay includes
the test picture's own way to the screen (one to two refresh intervals); the link is a model. Runs
vary, especially on the narrow link: repeat before concluding. With one display the client window
sits on the captured display and feeds back (a still screen is never still).

Findings so far (i9-9900K, RTX 3060, three 1080p displays at 75 Hz, 1280x720 picture):

- With the engine's defaults for screen content the delay was about 2 s on every link, for scrolling
  and for the typing that followed: packets are paced at exactly the estimated bandwidth and may
  queue for 2.9 s, and the receiver's buffer grew to 0.4 s. The field trials in `main.js`
  (`ENGINE_TRIALS`) bring that to about 0.13 s (scroll) and 0.07 s (typing) on a good link.
- Without `x-google-max-bitrate` the engine never probes above 5 Mbps; a real session's log showed
  the estimate pinned near 5 Mbps on a link with 3 ms round-trip time.
- The hardware H.264 encoder lets the quantizer sink to its minimum on a still screen; when motion
  starts it sends 4-6 times its bitrate for up to a second, and the engine then drops frames.
  AV1 (libaom, on the CPU) does neither, stays sharp while scrolling at a third of the bitrate, and
  costs about 1.6 cores for one moving 1080p picture. Hence `codec: 'auto'`.
- Picture quality (`--picture-test=quality`, PSNR of brightness against what was drawn; 30 dB = soft
  but readable, 35 = good, 40+ = hard to tell from the original). AV1 while a window is dragged or a
  page scrolls: 41 to 43 dB. After the whole picture changes at once it first shows after 130 to 170 ms
  at about 35 dB (text readable, fine photo grain smoothed) and then improves. A still screen used
  to get only a few frames a second, so that took 2 to 3 s; with `minFrameRate: 0` on the capture
  (`refine` in `capture()`, AV1 only) the engine repeats the still frame until the encoder reports it has
  settled: 0.5 to 1 s, at the cost of about one frame of delay while things move (scroll delay p50
  +10 to +20 ms; capturing at 120 or 240 fps did not buy that back). AV1 levels off near 43 dB (its
  quantizer has a floor). The graphics card's
  H.264 encoder at three times the bitrate (`H264HQ`) gives 52 to 55 dB from the first frame on a link
  with room for it (fine on an emulated 200 Mbps link; on a 40 Mbps one the estimate collapsed and it showed 7 fps), so it is only ever an explicit choice.
- Between two machines (host on this PC, client on a Linux server on another subnet of the same LAN,
  1 ms round trip, client drawn in software under Xvfb), AV1, default settings: 50 fps shown, scroll
  delay about 90 ms, typing delay about 85 ms. Split (`--capture-probe`): drawn on the host until the
  frame reaches the encoder 35-40 ms (this includes the picture's own way to the host's screen, one
  to two refresh intervals), from there until received by the client 24-29 ms, from received to the
  client's screen about 26 ms.
- Sound held the picture back: the system sound was sent in the same stream as the first monitor's
  picture, so the receiver kept that monitor in step with the sound's buffering. With any sound
  playing on the host, the first monitor was 130 ms later than the others (scroll delay 203 ms
  instead of 87). The sound now goes out as its own stream (`startSession` in `host.js`). Found only
  in the two-machine run; keep the two streams separate.
- `refine` (`minFrameRate: 0`) costs 13-16 ms on everything: with it, encoder to client takes
  24-29 ms, without it 8-12 ms. `minFrameRate` above 0 (config `refine: 'always'`) has no such cost
  and sharpens fastest (42 dB after 0.5 s, 45 dB after 1 s), but the capturer then hands over every
  frame, changed or not: about 50 fps, 0.7 Mbps and 0.4 of a core per still monitor, for as long as
  the client is connected. Not the default for that reason; an idle cut-off (lower `maxFramerate`
  when no input arrives and nothing moves) would make it one.
- Frames can be routed through JavaScript without measurable delay: capture track ->
  `MediaStreamTrackProcessor` -> `MediaStreamTrackGenerator` -> sender gave the same delay and quality
  as the direct path (and, like `minFrameRate` > 0, delivers every frame). That is the place where
  frames from a native capturer could be fed to the engine's encoder and transport.
- Connection figures (round trip, available bitrate, relay or direct) must be read from the
  transport's `selectedCandidatePairId`; a machine with several addresses has several "nominated"
  pairs.
- Native capture, measured on the same frames (`--native-probe`: a second, native duplication of the
  display reports when Windows presented each bench frame and when it had it). The picture is on the
  host's own screen about 23 ms after it is drawn. A native capturer has the frame 0.1 ms after
  that and sees 73-74 of 75 frames a second; the engine's capturer hands it to the encoder
  13-14 ms after the screen (20-22 ms at the 95th percentile) and delivers 45-50 a second.
- Native capture in use, against the engine's capturer with `refine` (the previous default), between
  two machines: scroll delay 73 against 90 ms, typing 64 against 84 ms, 59 against 47 frames a
  second shown, the same processor use (8.7% of the machine), picture quality the same within
  1 dB (settles at 45 dB). Counted from the host's own screen, the client is 47 ms (scroll) and
  41 ms (typing) behind, against 69 and 62. On the emulated links on one PC: home 119 against
  133 ms, wireless 120 against 133, narrow 159 against 146 (more frames to send; typing 80
  against 93 on all three).
- Where the remaining 41-47 ms go (native capture): about 9 ms until the encoder has the frame
  (3-4 ms of that is reading the image back from the graphics card), about 12 ms encoding and
  sending, about 26 ms on the client (drawn in software in that test; about 20 on a PC).
  The next steps in that order of gain: encoding on the graphics card straight from the captured
  texture (no read-back, no colour conversion on the processor), and presenting on the client
  without waiting for the browser's compositor - both need more native code than a capturer.
- Not fixed: the engine's capturer delivers 45-50 fps for 60 requested (the capturer spends at most half of each
  interval capturing); on a 6 Mbps link the estimate still collapses now and then when a scroll
  starts; `minFrameRate: 0`, the WGC capturer, 120 fps capture and turning the frame dropper off
  were tried and were worse or no better.

## Diagnostics log

The client sends its measurements every 2 s (`cs` message) and the host appends them, with its own
encoder statistics, to `%APPDATA%\my-remote-host\diag.log` (Linux: `~/.config/my-remote-host/diag.log`;
JSON lines, numbers only, rotated at 3 MB).
Read this file when the user reports stutter or lag instead of guessing: compare host capture fps,
encode fps and the limiting factor (`cpu`, `bandwidth`, `none`) with the client's received fps, freeze
count, packet loss, round-trip time and jitter-buffer delay. An entry may carry `slow`: main-process
calls that took over 50 ms since the previous entry (`input mm`, `clip-read`, `cursor`, ...) and
`paused` (the main thread itself did not run for over a second), each as count, total and longest ms.
The client's input is injected on that thread, so a stall there is a stall of every click. Entries
written many at once after a gap mean the same. `released`: buttons the host let go because the
client's moves said they were no longer held. The client's part may carry `ptr`: `cancel` (the
browser ended a pointer while a button was held), `lost` (pointer capture went away while held),
`drag` (browser drag-and-drop starts that were blocked), `released` (host buttons let go after a
cancel), and `xfer` for dragging out: `out` (dragouts sent), `late` (let go before the host's drag
started, carried out after waiting), `files`, `placed`, `text`, `none`, `failed`, and the last `why`
code and placement `how` (fixed words, no names or paths). It never contains the key; `config.json`
in the same folder does, so do not read that one.

## Verified and unverified

Verified by `--selftest` on one PC with three 1080p monitors: connection, AV1 (libaom) and hardware H.264 encoding,
the loader (fetch from host, cached reuse, self-update of an open page), the client app's one-click
layout on three real screens (`--shell-check`), cursor sync, cursor picture extraction, the paste-event path, host statistics, per-monitor pause and switch, size-aware downscaling, 1:1 mode, overview, shortcuts, the
layout plan, renegotiation on a (simulated) monitor change, auto reconnect, and the coordinate math for
dragging across monitors of different sizes. Input injection was verified separately, and
`--cursor-check` confirmed on the real screen that hiding the host cursor removes it from the video and
that it is restored afterwards. With `codec: H264` the hardware encoder is used at window-sized and full resolutions; the
small overview tiles (480x270) fall back to OpenH264 and the hardware encoder returns afterwards.

Verified for native capture: the whole self-test with it in use (it is what `auto` picks on this PC),
three monitors on two graphics cards, a host window reload during a session, the figures in
"Performance". Not verified: a monitor in HDR mode or rotated, the lock screen and permission prompts
(the capturer should pause and resume), a resolution change during a session, any PC but this one.

Verified by the self-test for dragging out: the file channel end to end (3 MB, hashes compared, a
file inside a folder), listing a dragged folder (links skipped), the "pointer left every window"
test, the wait-then-decide rules with traced pointer events, saving files and folders into a folder
under a free name, staged names never leaving the staging folder, the clipboard file format
(`--clip-check`). Verified with `--dragout-check` on this PC (Windows 10, real Explorer, real injected
input, 2026-11-13): the host sees Explorer's drag (`CLIPBRDWNDCLASS` held by Explorer's foreground
thread, 0.36-0.5 s after the first move), Escape plus Ctrl+C yields the dragged file, and the whole
way through a client window in the app's shell, held outside and let go at once, ends with the file
in the Explorer folder it was let go over (the folder resolved through the shell). Not verified:
text dragged out of an editor, the client app's click-and-paste into another program, a real second
PC as the client, Windows 11 tabbed Explorer.

Verified by the self-test: the arrangement rules, applying an arrangement (two monitors together, an
empty screen), the panel showing every monitor live, and a drag and a click done with synthetic pointer
events. Not verified: the arrangement panel opening windows on a real second client screen (browser or
client app), HDR detection on any PC but this one, `H264HQ` on a real link.

Verified on Linux (2026-11-13, a server with Ubuntu 22.04, Electron 33.4.11, Xvfb 1920x1080, no window
manager, one monitor): the whole self-test with the host on Linux (ALL PASS, with Chromium's sandbox
on; capture by the engine, AV1 by libaom, about 60 fps), `--clip-check` (both file-list formats),
`--input-check` (the pointer to the pixel, all 133 keys with the codes sent, five buttons, the wheel
both ways, text and a file dragged out of a second program in about 100 ms with nothing left held,
the client app's drop placement), `--client-app-check` (the client app as a process of its own shows
the Linux host's picture), and the launchers (`setup.sh` with a stand-in for `npm install`,
`start-host.sh --selftest`, `start-client.sh`, `local-test.sh`). Also seen there: system sound was
captured once from PulseAudio (the track arrived; audibility not checked). Not verified on Linux: a
real desktop session (GNOME, KDE, Xfce) with a window manager, a real file manager as the drag source
or drop target (Nautilus, Dolphin; the clipboard formats were only read back by this program), the
desktop-icons detection on a real desktop, several monitors (Xvfb's RandR here kept no extra monitor),
HiDPI scaling, Xwayland, a Korean input method receiving the Hangul key, a Linux client against a
Windows host or the reverse over a real network, the tray icon, the keyring path (the server had none;
the fallback warning was seen), `npm install` itself, Ubuntu 23.10+ (the sandbox message). macOS: no
input backend; the view-only path was not run anywhere.

Verified between two machines on one LAN (see "Performance"): connecting across subnets without STUN,
AV1 and H.264 decoding on a second machine, the delay and quality figures. Not verified: anything in
"Performance" on a real link between two networks (home to office), AV1 decoding speed on a client other than this PC, AV1 encoding load on a host with fewer cores,
the effect of the start/min/max bitrate hints on a real link, whether Keyboard Lock captures
Alt+Tab and the Windows key inside the client app, dragging between windows on a real multi-monitor
client, popup and fullscreen behaviour in a plain browser, hosts with mixed resolutions, DPI scales,
portrait or ultrawide monitors, monitors wider than 4096 px with H.264, any connection across two different networks, real-world latency, TURN, audio audibility,
client-to-host clipboard, the packaged exe, behaviour with monitors powered off. Say so when the user
asks how well it works; do not present these as working.
