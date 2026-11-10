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
| `electron . --selftest --cursor-check` | Same, plus a real-screen check that hiding the host cursor removes it from the video. The PC's cursor vanishes for about 20 seconds, so ask the user first |
| `npm run localtest` | Local trial: host window plus view-only client in the default browser |
| `npm start` | The real host (connects to the signaling server). User-initiated only |
| `npm run build-client` | Regenerates `../my-remote-client.html` from the template and `signal.js` |
| `npx @electron/packager . MyRemoteHost --platform=win32 --arch=x64 --out=../dist --overwrite --no-asar` | Optional standalone exe folder (about 300 MB, not committed) |

After changing `host/client.template.html` or `host/signal.js`, run `npm run build-client` and commit the
regenerated `my-remote-client.html`, then run `npm run selftest`.

## Layout

| Path | Role |
|---|---|
| `setup.ps1` | One-shot host setup and self-test |
| `start-host.bat`, `local-test.bat` | Launchers for the real host and the local trial |
| `my-remote-client.html` | Built single-file client (generated, committed for convenience) |
| `host/main.js` | Electron main: config and key storage, monitor enumeration, tray, IPC, isolated modes |
| `host/preload.js` | The only bridge between the renderer and main (`window.hostApi`) |
| `host/host.html`, `host/host.js` | Host UI and the WebRTC side: capture, encoding control, data-channel routing |
| `host/input.js` | Win32 through koffi FFI: `SendInput`, cursor shape and picture, hiding/restoring the system cursors |
| `host/cursor-guard.js` | Separate small process that restores the cursors if the host process dies |
| `host/signal.js` | Shared by host and client: key derivation, encrypted signaling channel |
| `host/client.template.html` | Client source; `signal.js` is inlined into it at build time |
| `host/build-client.js` | Builds the client file |
| `host/selftest.js` | Local ntfy-compatible relay and the self-test scenario |

## Protocol

Shared secret: 32 random bytes, base64url. HKDF-SHA256 derives two AES-256-GCM keys (one per
direction) and two topic names.

Signaling (through the relay, each message deflated, encrypted, chunked to 3000 chars):

1. client -> host topic: `{t:'hello', sid, ts, mode, codec}` (`codec` optional: `H264`, `VP9`, `AV1`)
2. host -> client topic: `{t:'offer', sid, ts, sdp, ice, audio, codec, cursorHidden, monitors:[{idx, mid, x, y, width, height, primary}]}`
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
- Browsers allow one popup and one fullscreen request per click, so each extra window needs a click.
  Do not try to work around this; a native client would be the way to remove it.

## Verified and unverified

Verified by `--selftest` on one PC with three 1080p monitors: connection, hardware H.264 encoding,
cursor sync, cursor picture extraction, the paste-event path, host statistics, per-monitor pause and switch, size-aware downscaling, 1:1 mode, overview, shortcuts, the
layout plan, renegotiation on a (simulated) monitor change, auto reconnect, and the coordinate math for
dragging across monitors of different sizes. Input injection was verified separately, and
`--cursor-check` confirmed on the real screen that hiding the host cursor removes it from the video and
that it is restored afterwards. The hardware encoder is used at window-sized and full resolutions; the
small overview tiles (480x270) fall back to OpenH264 and the hardware encoder returns afterwards.

Not verified: anything that needs a real multi-monitor client (spreading windows across screens,
dragging between windows, popup and fullscreen behaviour), hosts with mixed resolutions, DPI scales,
portrait or ultrawide monitors, monitors wider than 4096 px with H.264, any connection across two different networks, real-world latency, TURN, audio audibility,
client-to-host clipboard, the packaged exe, behaviour with monitors powered off. Say so when the user
asks how well it works; do not present these as working.
