# CLAUDE.md

Personal P2P remote desktop for Windows. `host/` is an Electron app that captures every monitor and
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
3. **Check the result.** Success is `[selftest] ALL PASS` and exit code 0. `INFO` lines are not
   failures. The self-test is local only (relay on 127.0.0.1, no STUN, throwaway key and profile,
   view-only client), so it is safe to run without asking. It does capture the screen for about a minute.
4. **Do not start the real host yourself.** Tell the user to double-click `start-host.bat`. Starting the
   host connects the PC to an external server and makes it reachable with the key, so that step is the
   user's decision and action. Tell them a Windows Firewall prompt may appear on first run.
5. **Hand over the usage steps** from README.md "사용 방법": copy the key from the host window into a
   password manager, take `my-remote-client.html` to the other PC, leave the PC unlocked with sleep
   disabled.

If the user only wants to see it working, run or point them to `local-test.bat` (same isolation as the
self-test, opens a view-only client in their default browser).

## Rules for agents

- **Never read, print, log, or commit the access key.** It lives DPAPI-encrypted in
  `%APPDATA%\my-remote-host\config.json` (`keyEnc`). Do not decrypt it, do not ask the user to paste it
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
- **Do not run the non-isolated host** (`start-host.bat`, `npm start`) or kill a running host without
  the user asking. Use `--selftest` or `--localtest` for verification.
- **Do not inject input on the user's machine as a test** beyond what `--selftest` does (it injects
  none). Stray clicks and keystrokes land in whatever the user has open.
- Do not commit `node_modules/`, `tools/`, `dist/`, or any `config.json` (see `.gitignore`).

## Gotchas

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
- **Same-PC control is unusable** (the injected cursor jumps under the viewer window). That is why
  `--localtest` is view-only.

## Commands

Run from `host/` with Electron's env var cleared.

| Command | What it does |
|---|---|
| `npm run selftest` | Local end-to-end test, prints `[selftest] PASS/FAIL` lines, exits 0 or 1 |
| `electron . --selftest --shell-check` | Same, plus the client app's one-click layout on the real screens. Fullscreen windows cover every monitor for a few seconds, so ask the user first |
| `electron . --selftest --cursor-check` | Same, plus a real-screen check that hiding the host cursor removes it from the video. The PC's cursor vanishes for about 20 seconds, so ask the user first |
| `npm run bench -- --net=direct,home,narrow,wifi --try=old,base` | Measures delay and smoothness on this PC for the given link conditions and settings, prints a table (see "Performance"). About 45 s per run. Shows a test picture on one display and a small window on another for that time; they never take focus and no input is injected, but tell the user before a long series |
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
| `client/main.js`, `client/shell.js`, `client/preload.js` | Client app: a thin Electron window around the loader. `shell.js` places the page's windows on the requested screen, makes them fullscreen without a click per window and grants permissions. Exposes `window.mrShell` |
| `host/main.js` | Electron main: config and key storage, monitor enumeration, tray, IPC, isolated modes |
| `host/preload.js` | The only bridge between the renderer and main (`window.hostApi`) |
| `host/host.html`, `host/host.js` | Host UI and the WebRTC side: capture, encoding control, data-channel routing |
| `host/input.js` | Win32 through koffi FFI: `SendInput`, cursor shape and picture, hiding/restoring the system cursors |
| `host/cursor-guard.js` | Separate small process that restores the cursors if the host process dies |
| `host/signal.js` | Shared by host and client: key derivation, encrypted signaling channel |
| `host/loader.template.html` | Loader source: asks for the key, fetches the client page from the host, runs it |
| `host/client.template.html` | The client page itself. Built in memory at host start and sent to loaders; never shipped as a file |
| `host/build-client.js` | Builds both pages (`build`, `buildLoader`); the CLI writes the loader file |
| `host/selftest.js` | Local ntfy-compatible relay and the self-test scenario |
| `host/bench.js`, `host/bench-peer.js`, `host/bench-pattern.html` | The bench: host side, client side (its own Electron process) and the test picture |
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

1. client -> host topic: `{t:'hello', sid, ts, mode, codec}` (`codec` optional: `H264`, `VP9`, `AV1`)
2. host -> client topic: `{t:'offer', sid, ts, sdp, ice, audio, codec, cursorHidden, app, monitors:[{idx, mid, x, y, width, height, primary}]}`
   (`x`,`y`,`width`,`height` are the monitor's rectangle on the host's virtual desktop, physical pixels)
3. client -> host topic: `{t:'answer', sid, ts, sdp}`

The host appends `x-google-start-bitrate` to the answer's video codec parameters so the bandwidth
estimate does not start near 300 kbps. ICE is non-trickle (candidates are gathered before sending). The host rejects messages older than five
minutes and replayed `sid` values. A new `hello` replaces the current session.

Data channel `input` (JSON text):

| Direction | Message | Meaning |
|---|---|---|
| client -> host | `mm` `md` `mu` `mw` | Mouse move/down/up/wheel; `d` = monitor index, `x`,`y` = 0..1 within that monitor. During a drag they may leave 0..1, which continues onto the neighbouring monitor |
| client -> host | `kd` `ku` | Key down/up; `c` = `KeyboardEvent.code`, `k` = `key` |
| client -> host | `reset` | Release every held key and button |
| client -> host | `view` | `v` = `[{i, w, h}]`: monitors on screen and the size each is shown at, in device pixels (`0` = full size). The host pauses the rest, scales down to the shown size (never up) and splits bitrate by pixels sent |
| client -> host | `mode` | `sharp` or `smooth` |
| client -> host | `cs` | Client measurements for the host's diagnostics log |
| both | `clip` | Clipboard text, at most 60000 chars |
| host -> client | `cur` | Current host cursor: `c` = CSS cursor name, or `img` (PNG data URL) with hotspot `hx`,`hy` for an app-specific cursor |
| host -> client | `hs` | Host-side statistics every 2 s (codec, encoder, bitrate, per-monitor capture/encode fps and limiting factor) for the client's diagnostics report |
| host -> client | `bye` | Deliberate close; the client must not auto-reconnect |
| host -> client | `renew` | Host monitors changed; the client reconnects at once and keeps its windows |

Monitor coordinates are physical pixels (`screen.dipToScreenRect`), mapped to the 0..65535 virtual
desktop range for `SendInput`. Keys are sent as set-1 scancodes so the host's keyboard layout applies;
`HangulMode`/`HanjaMode` and a few others go by virtual-key code.

## Client layout model

Each client window is a *view*: it shows one host monitor (`sel` = index) or all of them in their real
arrangement (`sel` = `'all'`), in `fit` or `1:1` mode. The video element is sized to the monitor's exact
aspect ratio, so pointer mapping is a plain proportion of the element. Policy, in `client.template.html`:

- `planLayout(N, M, cur, primary)` decides which host monitor goes on which client screen (both sorted
  left to right): all N on neighbouring screens when N <= M, otherwise M neighbouring monitors around the
  primary. The result is remembered per `N:M` in localStorage.
- Selecting a monitor that another window shows swaps the two, so a monitor is never shown twice.
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
- Not fixed: capture delivers 45-50 fps for 60 requested (the capturer spends at most half of each
  interval capturing); on a 6 Mbps link the estimate still collapses now and then when a scroll
  starts; `minFrameRate: 0`, the WGC capturer, 120 fps capture and turning the frame dropper off
  were tried and were worse or no better.

## Diagnostics log

The client sends its measurements every 2 s (`cs` message) and the host appends them, with its own
encoder statistics, to `%APPDATA%\my-remote-host\diag.log` (JSON lines, numbers only, rotated at 3 MB).
Read this file when the user reports stutter or lag instead of guessing: compare host capture fps,
encode fps and the limiting factor (`cpu`, `bandwidth`, `none`) with the client's received fps, freeze
count, packet loss, round-trip time and jitter-buffer delay. It never contains the key; `config.json`
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

Not verified: anything in "Performance" on a real link between two networks (the bench is one PC with an
emulated link), AV1 decoding speed on a client other than this PC, AV1 encoding load on a host with fewer cores,
the effect of the start/min/max bitrate hints on a real link, whether Keyboard Lock captures
Alt+Tab and the Windows key inside the client app, dragging between windows on a real multi-monitor
client, popup and fullscreen behaviour in a plain browser, hosts with mixed resolutions, DPI scales,
portrait or ultrawide monitors, monitors wider than 4096 px with H.264, any connection across two different networks, real-world latency, TURN, audio audibility,
client-to-host clipboard, the packaged exe, behaviour with monitors powered off. Say so when the user
asks how well it works; do not present these as working.
