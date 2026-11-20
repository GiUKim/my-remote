# CLAUDE.md

Personal P2P remote desktop for Windows, and for Linux with an X11 session (see "Linux (X11)" under
Gotchas). `host/` is an Electron app that captures every monitor and
injects input; the client is a single HTML file opened in Chrome/Edge on another PC. Media and input
flow peer-to-peer over WebRTC; a public ntfy server is used only to exchange encrypted handshake
messages. It runs from this source folder (the launchers below) or as an installed app that updates
itself (`app/`, `release/`; see "The installed app, releases and updates"). User-facing docs are in
[README.md](README.md) (Korean). Reply to the user in Korean.

## Setting up a host PC (the usual request)

When the user asks you to set this up, do the following in order.

1. **Confirm intent first.** This tool hands over full control of the PC. Before running anything, tell
   the user in one or two sentences that (a) it must be allowed by their company's security policy and
   (b) it cannot be used while the screen is locked. Continue once they acknowledge.
2. **Run setup** from the repo root:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
   ```
   It needs no admin rights. It downloads portable Node 22 LTS into `tools\node` if Node >= 22.12 is
   missing (SHA-256 verified), runs `npm install` in `host`, then runs the self-test.
   On Linux (X11 session) run `./setup.sh` instead: the same, Node 22 LTS into `tools/node` when none
   >= 22.12 with npm is on PATH (from nodejs.org's `latest-v22.x`, SHA-256 checked against its list;
   curl or wget), plus an offer to install Chromium's sandbox helper with sudo where Ubuntu 23.10+
   restricts the sandbox, and "My Remote Host"/"My Remote Client" entries in the user's app menu. The
   person can skip it: `start-host.sh`/`start-client.sh` run it (without the self-test) on their first
   start, in a terminal window of their own when started from the file manager.
3. **Check the result.** Success is `[selftest] ALL PASS` and exit code 0. `INFO` lines are not
   failures. The self-test is local only (relay on 127.0.0.1, no STUN, throwaway key and profile,
   view-only client), so it is safe to run without asking. It does capture the screen for about a minute.
4. **Do not start the real host yourself.** Tell the user to double-click `start-host.bat` (Linux: run
   `./start-host.sh`; run over ssh, it starts on the desktop the user is logged in to on that PC, and the
   user then reads the key with `./start-host.sh --show-key` in their own terminal). Starting the
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
  `%APPDATA%\my-remote-host\config.json` (`keyEnc`; the authenticator app's secret `otpEnc` too, when the
  person turned it on: never read either); on Linux in `~/.config/my-remote-host/config.json`,
  encrypted with the desktop's keyring or, without one, only obscured (reading that file is reading
  the key). The copies `config.json.bad-<time>` that the host keeps of a broken file next to it hold
  the key just the same: never read them either. Do not decrypt it, do not ask the user to paste it
  into the chat, and do not put it in a URL, file, or commit. The user copies it with the host window's
  `키 복사` button, or, on a Linux PC reached over ssh, reads it in their own terminal with
  `./start-host.sh --show-key`. Never run `--show-key` yourself, in any form and on any machine: its
  output is the key.
- **Never bake a key into `my-remote-client.html`.** The committed client contains no key by design.
- **The client app's list of PCs holds keys too.** `%APPDATA%\my-remote-client\hosts.json` (Linux:
  `~/.config/my-remote-client/hosts.json`) has the access key of every PC the person added, and
  `tokens.json` next to it the device tokens, encrypted like the host's own: never read or decrypt them,
  nor their `.bad-<time>` copies, and never start the client app on the person's own profile to look at
  the list. To try the list, use a
  profile of its own: `electron client --loader=<file> --list` (see Commands), with made-up keys.
- **Device tokens are secrets like the key.** The host's `devices.json` (next to `config.json`) holds the
  token of every client app it registered (see "Devices" under Gotchas), encrypted like the key: whoever
  has one reaches that host as that device. Never read or decrypt it, nor its `devices.json.bad-<time>`
  copies. `access.log` next to it holds no secret (times, device names, addresses); reading the person's
  is reading where they connect from, so only when they ask.
- **Keep the loader and its bootstrap protocol stable.** `my-remote-client.html` is a loader that users
  receive once and keep; old copies stay in use. Changing the `ver`/`app` exchange, the key derivation
  or the signaling format in `signal.js` strands them. New behaviour belongs in
  `client.template.html`, which the host serves and which therefore updates by itself.
- **Do not weaken the handshake.** Every signaling message must stay encrypted and authenticated with
  keys derived from the shared secret (`host/signal.js`): the access key, or a device's own token
  (`RD.DEVICE` salt); the DTLS fingerprints inside the SDP are what make the media channel trustworthy.
  A token goes only over a session's DTLS channel, never through the relay.
- **Do not run the non-isolated host** (`start-host.bat`, `start-host.sh` without `--selftest`, `npm start`)
  or kill a running host without the user asking. Use `--selftest` or `--localtest` for verification.
- **RustDesk is AGPL-3.0.** Its source may be read for ideas (see "Performance"), but do not copy code from
  it, or from any other copyleft project, into this repository.
- **Native code is built from the sources in `native/`** with the distribution's own cross-compiler on a
  Linux machine the user provides (`node native/build.js user@host`). Do not download compilers,
  toolchains or prebuilt binaries from elsewhere onto either machine. The committed binaries are
  `host/bin/capture.dll`, `shellops.dll` and `winassist.exe` (the assist service: it runs as LocalSystem),
  each with its `.json` record (what it was built from); commit one only as `native/build.js` wrote it, in
  the same commit as the source it was built from. The self-test fails when the two do not match. Never
  commit a binary from anywhere else. Run `native/build.js` from PowerShell: Git Bash's `scp` silently
  copies nothing for `C:\...` paths, and the server then builds an old copy of the sources.
- **Do not inject input on the user's machine as a test** beyond what `--selftest` does (it injects
  none). Stray clicks and keystrokes land in whatever the user has open. `--dragout-check` and
  `--dropin-check` do inject (into Explorer windows they open themselves), so run them only after the
  user agreed. Their press points are verified with UI Automation and the drop point with the window
  handle before anything is pressed or let go: once, an unverified point fell on Explorer's navigation
  pane and a real folder of the user's was dragged (nothing was changed; see Gotchas). So does
  `--input-check` (Linux: moves the pointer, clicks, scrolls and types into windows and a second
  program it opens itself): on a virtual display (Xvfb) only, or after the user agreed.
- **Never read, print, copy or commit the release signing key** (`~/.my-remote-release/update-signing-key.pem`,
  or wherever `--key` / `MY_REMOTE_RELEASE_KEY` points). Whoever has it can send code to every installed
  app. `release/build.js` signs with it and `release/keygen.js` makes it; nothing else touches it, and
  it stays on the machine that makes releases. The tests make keys of their own.
- **Publish a release only when the user asks for one.** Since 2026-11-16 (the user's decision, from
  v0.5.2 on) the agent publishes it, which was the user's step before: CI green on the commit
  (`release/build.js` checks), `release/build.js`, the packages (`release/package.js` on Windows; the
  Linux one built and self-tested on the Linux PC; each writes `<name>.package.json` next to its archive),
  both archives and both records in one folder and `release/build.js --sign-packages=<folder>`
  (`packages.json` + `.sig`, from 0.7.0 on: what installed apps replace their shell by), tag `v<version>`
  on that commit, then `gh release create v<version> <latest.json, latest.json.sig, the bundle, both
  packages, packages.json, packages.json.sig> --title "My Remote <version>" --notes-file <from
  release/notes> --latest` (GitHub CLI, logged in as the user on the Windows PC; never print its token),
  and check that `releases/latest/download/latest.json` and `packages.json` are the new ones. Every installed app sees it within 6 h. Never mark a release `--critical` (it installs itself on
  every app, without asking) unless the user said so for that release.
- **Keep `app/` small and stable.** It is the part an update cannot replace: a fault in `boot.js`,
  `core.js`, `updater.js` or `guard.js` stays with every installed app until its user installs a new
  package by hand. Change it only with `release/test-update.js` and `release/test-app.js --packaged`
  passing, and raise `base` in `app/package.json` when the code needs something new of the shell.
- Do not commit `node_modules/`, `tools/`, `dist/`, or any `config.json` (see `.gitignore`).
- **A change goes in only with its checks passing** (see "CI, gates and checks"): `release/ci-checks.js`
  (the pre-commit hook), the self-test, new checks for new behaviour, and the bench within its limits.
  Never weaken a check or raise a limit to make a change pass without saying why in the commit.

## Gotchas

- **Native capture** (`capture: 'auto'`, used when `host/bin/capture.dll` is there, which it is in the repo). `preload.js` loads the DLL through
  koffi (so the host window runs with `sandbox: false`; context isolation stays on) and runs one loop
  per monitor: `mc_next` waits for the next desktop image on a worker thread, the pixels become a
  `VideoFrame`, that goes over a message port to the page, and `host.js` writes it into a
  `MediaStreamTrackGenerator` whose track is sent like any other. On Linux (X11) the same loops run on
  `host/platform/x11capture.js` instead of the DLL (see the Linux notes). Things that bit:
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
    Each start of that capture costs the main process about 40 MB for a moment and leaves two
    sections and two mutexes behind there (Chromium; measured with a bare Electron script: 16 of each
    after 8 starts, with or without sound, while `desktopCapturer.getSources` and peer connections
    leave nothing). So the sound track outlives its session by a minute (`keepSpareAudio` in
    `host.js`) and the next session takes it over: a reconnect starts no capture at all.
  - Destroying a D3D device that had received duplicated frames left one section and one mutex behind
    in the process (150 `mc_open`/`mc_close` pairs, 150 of each; no GPU memory held), while 60
    duplications on one device that was kept left nothing, and device or factory creation alone leave
    nothing either. So each capturer handle keeps its device (`g_kept`) across `mc_close`/`mc_open`:
    the next session opens its monitors under the same handles and takes it over while it is on the
    same adapter and not removed (then a new one is made). After that, 60 pairs left no handle behind.
    `mc_test_lose(h, 2|3)` drops the kept device too.
  - After a change the last image is sent `REPEATS` (45) more times (`preload.js`) so the encoder
    brings it to full quality, then once a second while nothing changes (config `keepAlive`, ms; 0 =
    never); after a change below 1% of the picture (DXGI's
    dirty and move rectangles, `mc_next`'s `info[4]`: a blinking caret, a typed letter) only `FEW` (6),
    and a running series is never cut short. Every `show` (connected, back on screen, new size, the
    client's `view`) re-sends it with a full series: the encoder drops frames before it runs, and a
    `MediaStreamTrackGenerator` cannot answer its refresh request. A monitor nobody looks at is not
    captured at all.
  - **An encoder that stops taking frames** (`stalled()` in `host.js`, 2026-11-18). In CI on Linux (H.264
    from OpenH264, the runner having fewer than 8 cores) the engine now and then took every frame for one out
    of order and dropped it ("Incoming frame timestamp is not monotonically increasing", frame_cadence_adapter.cc;
    in 6 of 25 CI runs, from before 0.8.0 on, mostly right after the encoder was set up anew for a new size):
    the first such line compared one of our timestamps (page time, 3.9 s) with one of the engine's own clock
    (about 60 s), and the picture stood still for the rest of the session; once it failed the self-test's
    first check. Our timestamps rise (logged frame by frame); 50 runs of that first check on the build
    server (fast, and on 2 cores) never showed it; one frame stamped far ahead did not bring it about on
    Windows. So the host watches for it: two stats readings in a row (4 s) with 4 or more frames written each
    and none encoded -> `renew` (the client reconnects at once and keeps its windows), at most once a minute,
    counted as `stalls` in the host's numbers (diagnostics log). The self-test acts it out by giving the
    encoder an empty track of its own. Only readings that follow each other count (2026-11-20, found in a
    review): a reading skipped because the connection was not up (`stallForget`) and a monitor left out of a
    reading (not being sent) start the comparison afresh; before, two readings around a short loss of the
    connection could renew a session that was coming back by itself.
  - **Why the keep-alive** (2026-11-18): before it, nothing at all was sent while the screen stayed the
    same, and a receiver that gets no picture for 3 s asks for a key frame (WebRTC's frame time-out: a
    PLI, counted as `pli` in the diagnostics log); the encoder then makes the next picture one, so the
    first change after a pause - a key pressed after reading - came as a whole new picture. The Linux
    host's diagnostics log (2026-11-14, 2 h of real use from a Windows client): 98% of the frames shown
    late (251 of 257) were in the 2 s after a still stretch of 3-5 s, each after such a request, late by
    89 ms on average and up to 266 ms; 831 PLIs, all while still (longer pauses do not show in `late`,
    which leaves out gaps over 5 s). The bench, one change every 4 s: 106 ms p50 and 7 PLIs in 9
    changes, against 66 ms and none every 0.5 s. WebRTC's own screen sharing repeats a still frame once
    a second for the same reason (zero-hertz mode), which frames from a generator do not go through.
    Only while the screen can be read (`mc_next` 0, not 2): while it cannot, the assist service's
    pictures may be going into that video, and `host.js` keeps those alive itself (same setting).
  - A lost duplication (lock screen, UAC, mode change, a full-screen program) or a lost device (driver
    restart, TDR) is rebuilt inside the DLL (a new device when the old one was removed), at once and
    then up to once a second; meanwhile `mc_next` returns 2, the preload sends `paused` (host log), the
    session stays up and the client keeps the last picture. Only failures that last 10 s (the lock
    screen and session switches do not count) give -4, which, like a monitor in HDR mode or rotated
    (-2), renegotiates with the engine's capturer (`nativeOff`, until the host page restarts); -3 (a
    size change) renegotiates and stays native. `mc_test_lose(handle, 1|2|3)` simulates the losses.
    Recovery from a real lock screen was seen in the test VM (see "Lock screen / UAC"); from a real UAC
    prompt or driver restart it has not been tried.
  - **A PC that is already locked when the client connects** (reported from the person's home PC,
    2026-11-15, with 0.5.0 and the assist service installed: "여전히 접속되지 않습니다"): `mc_open` failed
    with E_ACCESSDENIED, the host fell back to the engine's capturer, which cannot read the lock screen
    either ("Could not start video source"), and the session ended before the assist service was ever
    asked. Now `mc_open` opens such a monitor all the same, at its size on the desktop (DXGI's
    `DesktopCoordinates`: physical pixels, the page's process being per-monitor DPI aware, measured),
    with no duplication: `mc_size` returns 2 for it (`waiting` in the preload's `opened`), `mc_next` 2
    until the screen can be read, as after a desktop switch. The session comes up, the loops say
    `paused`, the assist service's pictures fill the monitors' tracks, and the native capture
    takes over after the unlock. The engine's capture, which brings the sound, is not even tried then:
    the offer gets a sound transceiver without a track (`s.soundLater`) and the first native frame after
    the unlock fetches the sound and `replaceTrack`s it (`soundSoon`, once per session). `mc_test_elsewhere(1)`
    makes every new duplication fail as on the lock screen: the self-test starts a session that way.
    Verified in the test VM: locked first, then the real client page connected, saw the lock screen,
    typed the password, got the desktop. The sound part only on this PC through the self-test (the VM
    has no sound device).
  - `desktopCapturer.getSources` sets DXGI duplication up twice on the main thread (the one that
    injects input) and starts a thread; `getSources()` in `main.js` keeps its list until the displays
    change (or a session start failed), so a reconnect does not pay for it again.
  - Sessions open their loops one at a time (the preload knows loops by monitor number only, and
    `close` ends all of them); a loop's `failed` counts only for the session that opened it; an `open`
    without an answer in 4 s turns native capture off until the host page restarts.

- **Mouse buttons held on the host.** Reported from a real session (2026-11-12): a window dragged
  across host monitors stopped half way, and after letting go the window still followed the pointer
  until the next click, i.e. the host kept the button down. The cause was not pinned down. A browser
  drag-and-drop or selection that takes over the pointer (`pointercancel`, no `pointerup`) would do
  exactly this, so the client blocks `dragstart`/`selectstart` and lets go on `pointercancel`, and
  every `mm` carries the held buttons (`h`) so the host can let go of one whose `mu` was lost. The
  diagnostics log counts each of these (`ptr`, `released`): read it if it happens again.
- **A press on the picture does not get the pointer (Chromium 156).** `setPointerCapture` is ignored,
  without an error (`hasPointerCapture` false right after), by every element of a document that was
  put in place with `document.open/write` while the pointer was over its window - which is how the
  loader starts the client page, and where the pointer is when the person presses "접속". Measured with
  Electron 45.3.1 on Xvfb, real input: the pointer away at that moment, or the page loaded as a file of
  its own: granted. Electron 33 granted it always. The events of the pressed pointer then go to whatever
  is under it, outside the window to the root element, so the picture heard neither the pointer leave
  nor the button go up: nothing could be dragged out (`xfer.out` stayed 0), the host kept the button
  down until the pointer came back (`released` in the diagnostics log, no `ptr` counters), and a drag
  past the picture stopped at its edge. Reported 2026-11-14 right after the client moved to the 0.3.0
  app. So the page does not rely on capture: `hold(el, ev, handlers)` asks for it and notes who holds
  the pointer, and `routeHeld(doc)` (once per window) hands that pointer's move, up and cancel events
  that arrive anywhere else in the document to the holder's own handlers; a new press or a move without
  a button forgets a holder whose release was never seen. Used by the pictures and the arrangement
  panel; a finger's events are not routed (a touch keeps its first target by itself; not tried).
  The self-test dispatches the events at the root element and at the bar (`notGranted*`); it fails on
  the page from before. Posted window messages on Windows did not reproduce the loss (Windows takes the
  pointer off a window the real cursor is not over), so on Windows the loss itself
  was not seen; the person confirmed there that dragging out works again with the fixed page.
- **Another remote-control program connected at the same time.** In that session the host's main
  thread stalled three times (57, 71, 19 s), each stall ending when a Chrome Remote Desktop session
  to the same PC (re)connected (Windows Application log, source `chromoting`). Clicks did nothing
  meanwhile and were then injected all at once. The host now tells the client (`others`). Most likely
  the stalls were the next item's, which Chrome Remote Desktop's connection happens to end.
- **A press on the host's own window frame stopped remote control (until 0.8.1).** Reported 2026-11-16:
  the person pressed the host window's minimize button from the client; the host's main thread did not
  run for 184 s (diag.log `paused`) and came back when Chrome Remote Desktop connected. Reproduced in the
  test VM with a bare Electron window (2026-11-17): input injected with `SendInput` on the main thread onto
  that thread's own window's minimize, close or caption button (right button too, which then opens the
  window menu) has Windows track the press in a loop on that thread (`GetGUIThreadInfo`: the window holds
  the mouse) until the button goes up - and the release, the client's next message, is a task of the same
  thread, which Chromium does not run inside that loop: it never came back by itself. A drag of the title
  bar came back after about 0.5 s (Chromium runs its tasks inside the move loop); Alt+Space and Alt alone did
  not stall. A posted `WM_CANCELMODE` does nothing there; a sent one (`SendMessageTimeoutW` from another
  thread) ends the loop at once and the press is simply undone (the button stays down until the client's
  own release, so nothing is released twice). So: `input.js` never injects a press onto the frame of a
  window of its own thread (`ownFrame` in `platform/win32.js`: `WindowFromPoint`, its thread, `WM_NCHITTEST`)
  and does what it means (the window comes to the front; minimize, maximize, close on their release over
  them; the title bar moves the window with the pointer, twice in a row maximizes or restores; borders and
  the window menu do nothing), and `host/inputguard.js`, a worker thread with a heartbeat from the main
  thread, sends `WM_CANCELMODE` when the main thread has not beaten for 0.8 s while it holds the mouse, a
  menu or a window being moved (the net under what `ownFrame` did not foresee). `--frame-check` tries both
  with real input onto the host window (the test VM). Linux is not affected: the window manager, another
  program, runs the frames.

- **Dragging out of the remote picture.** A program that runs a drag-and-drop has handed the mouse to
  OLE's hidden window of class `CLIPBRDWNDCLASS`; `input.dragging()` reads that (`GetGUIThreadInfo`,
  read-only) and the host tells the client (`drag`). Once seen, the thread running the drag is
  followed, so a window that comes to the front meanwhile does not end it; `captureClass()`, which
  `dragOut` checks before pressing Escape and Ctrl+C, stays about the program in front, because
  those keys go there. (For half a day that check was missing: the keys would have closed the other
  program's dialog and its selection would have been sent as what was dragged. Found by a review,
  2026-11-13.) With another program in front, no key is pressed: Escape is posted to the window that
  holds the mouse in the dragging thread (`input.cancelDrag`, `PostMessageW`; OLE's drag loop reads its
  own thread's key messages), the button is let go and the client is told `nofront`. That path has not
  run with a real drag. When the client's pointer then leaves every client
  window, moves are no longer sent (the host's pointer waits); on release outside, the host presses
  Escape (ends the drag without a drop), Ctrl+C (what was dragged is still selected), releases the
  button and sends the clipboard's files or text (`dragOut` in `main.js`). Explorer takes 0.35-0.5 s
  from the first move to starting its drag (measured with `--dragout-check`), so a quick drag leaves
  the client window before the host knows: while the pointer is outside with a button held and no
  drag is reported, the client sends no moves for up to `LEAVE_WAIT` (0.7 s) and asks the host at once
  (`dragq`; the host then polls `input.dragging()` every 15 ms). Let go in that time, it waits for the
  answer: a drag shows up -> `dragout`, else `mu` where the host's pointer waited. The old behaviour
  (moves past the edge at once) clamped the host's drag at the screen edge and, on release, let go
  there - the failure the user reported. While a drag-out is being decided or carried out (let go
  outside, until the host's `dragdata`, at most 3 s: `outPending`), the page sends no moves and no
  presses: a move back into a window would say that no button is held, and the host would let go where
  its pointer waited - a drop there, onto whatever lies under it. (A real session's log showed two such
  releases, at the times of the person's failed drags out of a Linux host.) **Ctrl crosses at once** (the user's wish, 2026-11-13): with a
  button held and Ctrl pressed, leaving the host's picture - even onto this window's own bar or another
  client window - takes the pointer over to this PC (`view.crossed`): no wait, never on to the host's
  neighbouring monitor; let go there, what the host drags is carried out (a drag may still show up for
  1 s), else the button is let go where the host's pointer waited. Carrying out shows "놓으면 이 PC로
  복사됩니다" in the window (outside it the browser cannot show a drag image: the host's drag icon stays at
  the edge, which is what looked "blocked" to the user). In the client app a small window follows the
  real pointer meanwhile with what is being brought (`mrShell.dragGhost`, `ghostOn` in `client/shell.js`:
  no focus, no clicks, beside the pointer and never under it, none of the client's windows; gone when
  the page says so, when no button is held any more (Windows) or after 20 s without a word). The person
  asked for it: dragging into the picture shows the system's drag picture at the pointer, dragging out
  showed a bare pointer. An X11 host names what is dragged once the drag is seen (`drag` with `what`,
  asked of the dragging program as a drop target would, `drag-what` in `main.js`); a Windows host cannot
  tell before its Ctrl+C, so the window then says only that something is brought. Checked on Xvfb (shown
  beside the pointer, renamed, hidden, gone with the last window) and on Windows that it hides itself
  when no button is held; not seen yet in a real drag on Windows. A dragged folder is sent as its files with paths ('a/b/c')
  plus `dir` entries for empty folders; links and junctions are not followed. This replaces the host's
  clipboard. Isolated modes never do the key presses. On the client the app (`client/shell.js`) saves
  files into the folder they were dropped on (desktop, or an Explorer window whose folder it asks the
  shell for through PowerShell); for other targets it puts the data on the clipboard and, within 8 s of
  the drop, clicks once at the drop point and presses Ctrl+V. That click and key press are the only
  input the client app ever injects, and only after a drop it saw the person make: the app reads the
  real buttons itself (`input.buttonsHeld()`, `GetAsyncKeyState`, while one of its windows has focus or
  a button is held), and a drop counts when a button pressed over one of its windows went up at most
  0.4 s before the page asked (`shell:dropPoint`), once per release; never onto the taskbar, the Start
  menu or a console (`NO_CLICK`). Saving into a folder is not gated that way (the `--dragout-check`
  B/C events are synthetic while the host holds the real button). Files that fit neither a folder nor
  the clipboard go into Downloads (always on macOS, which has no input module). The app grants no
  clipboard-read permission, lets the page open only blank windows and blocks navigation away from it.
  In the app, "outside" also means another program's window lies over ours (`mrShell.pointerOwn()`,
  the window under the real pointer, asked every 50 ms while a button is held; it counts for real
  events only, since the B/C events are made up). While carrying out, every window shows the `copy`
  cursor; whether it shows outside the windows depends on the browser (not checked).

- **Files dragged or pasted in (client -> host).** (On a Linux host the drop is an XDND drag, see the
  Linux notes; what follows is Windows.) The page uploads them on an `upload` channel;
  `main.js` writes them under `%TEMP%\my-remote-in\<id>` (asynchronously: input shares that thread)
  and then drops them for real where they were let go: `so_drop` in `host/bin/shellops.dll`
  (`native/shellops.cpp`) runs an OLE drag of the shell's own data object for the items, so a folder
  window, a folder icon, the desktop, a mail or chat window each react as to a local drop. Things
  that had to be found out (with `--dropin-check` and a scratch drop test): targets take nothing
  from a drag without a button held, and the drag loop reads the REAL button state (not the thread's
  key state, not the posted message), so the left button is pressed onto an 8x8, alpha-1 window of
  ours under the pointer (which then becomes click-through) - the program under the pointer never
  gets a click; Explorer's item view answers only after the pointer moves, so the pointer goes one
  pixel right and back every 20 ms while the loop holds the mouse (posted fake moves carry no
  position and made targets answer for the wrong point); the button is let go after the target
  accepted twice (or after 0.6 s: refused) and the drop follows. A name clash makes Explorer ask
  Replace/Skip, and `so_drop` waits for that like a local drop would. When nothing takes the files
  (or the person clicked or typed since the drop), they go onto the host's clipboard instead; a paste
  (Ctrl+V with files on the client's clipboard; Chromium hands them over in the paste event) puts them
  on the host's clipboard and presses Ctrl+V. A paste is read like a drop (`dropEntries`): in Electron
  45 a pasted folder comes as an entry and goes whole (`--clip-check`: a file and a folder pasted, the
  folder's file inside arrives); a folder a browser hands over only as an unreadable file of 0 bytes is
  left out and the page names it (before, it was sent as such a file). Folders: `DataTransferItem.getAsFileSystemHandle()`
  never answered for a folder in the client app (no file-system permission is granted), so after
  1.5 s the older entries API is used; in one case that threw `InvalidStateError` (a real folder with
  a `.cache` inside), then only plain files go and the page says so.
- **Files copied on the host, pasted on the client.** No transfer when something is copied: the host
  only announces it (`clipfiles`). The client app fetches (`clipget`) when focus leaves every client
  window, i.e. when the person goes to the client's own programs, which is when they would paste
  there; copying and pasting inside the host costs nothing. The files then go through the drag-out
  path with no drop point, so `shell.dropFiles` puts them on the client's clipboard. A person who
  presses Ctrl+V on the client before a large transfer is done pastes nothing (the toast shows the
  progress).
- **The host started again after a crash** (`host/watchdog.js`, 0.7.1; the user's go-ahead 2026-11-16).
  Seen that day on the person's PC: the host (0.6.0) ended with 0xC0000409 in koffi.node (a fail-fast,
  parameter 7: abort) on its main thread while nobody was connected, one second after the client app had
  installed an update and was restarting; it stayed down. The minidump Windows kept
  (`%LOCALAPPDATA%\CrashDumps\MyRemote.exe.<pid>.dmp`; read locally with a script of the documented format,
  never sent anywhere) shows nested exception dispatch inside koffi (a C++ exception while unwinding ->
  terminate -> abort) with no Windows API frame on the stack; which koffi call it was cannot be named
  without koffi's debug symbols, and nothing in the host calls koffi on a timer while no session is on.
  So: a small process of its own (the app's program as Node, `stdio[0]` a pipe the host holds, so it learns
  of the host's end at once, with no pid to be reused), started 8 s after the host page loaded (the moment
  a new version says it is up: a host that crashes while starting is not started over and over), starts
  the host again with its own program, arguments and folder 3 s after it ended without quitting. Every quit
  writes `quit-on-purpose` in its profile first (`before-quit`, Windows' `session-end`, `powerMonitor`
  `shutdown`): `{ pid, kind, why }`; a marker of another pid does not count. From 0.8.1 only `kind: quit`
  (the tray's 종료, "quit" in the key dialog, the system ending the session) leaves the host down;
  `handover` (the shell swap, whose script restarts the host and needs this program's files free) makes the
  watchdog step aside at once; anything else - `restart` (`restart()`, an update by the shell's updater, a
  quit nobody named) - is one after which a host must come back: the watchdog waits up to 60 s for one
  (`running.json` naming another live process) and starts it when none came. Before, every quit counted
  as on purpose, and on 2026-11-16 the host (0.8.0, 20 s after an update) quit with a marker and stayed
  down; what quit it is not known (the host kept no log then: `host.log` now, below; before-quit writes who
  quit, with a stack when nobody named it). It never starts one while another host runs. At most 3
  restarts in 30 minutes (`watchdog.json`), each noted in `watchdog.log` there. A host ended from Task
  Manager counts as a crash (use the tray's 종료).
  Signals (Linux, macOS; 0.9.2): SIGTERM and SIGINT (kill, pkill, the session or the system going down,
  Ctrl+C in a terminal) are `quit: SIGTERM`/`SIGINT`, left down. Before, Electron quit on them by itself,
  naming nobody: `stop.sh --host-only` on the Linux PC (kill of the host's pid) and a host was running again
  62 s later (measured 2026-11-17 on .200 with `--localtest --no-client --watchdog` on a display of its own).
  The handler must be set up at `ready` or later: one set up before is never called and Electron's own quits
  instead (a bare Electron 45 script: at the top of the main script, not called; at ready and 1 s after,
  called before `before-quit`). SIGHUP (its terminal or ssh session went away) stays a quit nobody named, and
  the watchdog brings the host back (61 s, measured). The handler is `process.once`: with its listener gone, libuv
  puts the signal's default back, so a second signal ends a host whose quit got stuck, as Electron's own one-shot
  handler allowed. What is left of the difference: a main thread stuck in a call never runs the listener, so then
  only SIGKILL ends the host, where Electron's handler (which resets the signal in the handler itself) let a
  second signal through. Accepted for a quit that otherwise reads as a crash. The self-test (not on
  Windows) starts a local trial host of its own, ends it with SIGTERM once it is up and wants `quitting (quit:
  SIGTERM)`.
  Checked: `release/test-watchdog.js` (11 checks: the old marker, quit, handover, a restart that did and
  one that did not come back, a crash while another host runs, an end without a word, `abort()`, an older
  marker, the limit, old restarts) on Windows; with the real host on this PC (0.7.1, `--localtest
  --no-client --watchdog`): killed, it came back within 6 s; its window closed, it stayed down.
- **host.log** (0.8.1): what the host's main process and its page print also goes to `host.log` in its
  profile (1 MB, then `host.old.log`): the start (version, pid, flags), sessions, the capture in use and why
  not natively, quits and who quit, the input guard's interventions, uncaught exceptions (logged instead of
  Electron's dialog, which nobody can close on a PC reached only remotely). Nothing it prints holds the key
  (`--show-key` keeps no log). Read it with `diag.log` when something went wrong.
- **koffi ends Node-mode helpers with 0xC0000409.** The cursor guard (`cursor-guard.js`, a Node-mode
  process with koffi) ended that way four times on 2026-11-16, always after it had put the cursors back
  (Windows' crash reports: 33 modules, `koffi.node+0x72bed`), and so did second host instances and two
  hosts while quitting. Not reproduced elsewhere (the test VM, this PC, with the same calls). The guard now
  ends with `TerminateProcess` on itself once its work is done.
- **The host page going away, and the config file.** When the host page reloads or its process
  dies, `pageGone()` in `main.js` releases held keys and buttons, restores the cursors, drops offered
  drag-out files and unfinished uploads and sets the tray to idle (the page's own teardown does not
  run then). A crashed page is loaded again after 1 s, doubling to at most a minute (crashes counted
  over ten minutes); starting the host again does it at once. `새 키 발급` saves the new key first, ends
  the session with `bye` (`kick`, so the client does not keep trying the dead key) and reloads 400 ms
  later. Only a missing `config.json` makes a key by itself: a file that cannot be read, is not valid
  JSON, has no key or a key that cannot be decrypted is never replaced without asking. A copy is kept
  (`config.json.bad-<time>`, once per content); the key is still used when it can be found in a broken
  file (the host then runs on the defaults and says so in a dialog); without a usable key the host
  asks before starting (retry / new key / quit). The file is written to a temporary file and renamed
  over the old one. After `키 복사` the key is taken off the clipboard after a minute (and when the host
  quits) if it is still there. (On X11 the change count is taken only once the X server's word of the
  write has been read, and where the count cannot say, the text is read and compared: before that the
  key could stay on a Linux host's clipboard for good.) The config and crash paths were checked with a Node harness of
  `main.js` with a fake Electron; in Electron only the reloads of the self-test ran through
  `pageGone()`; a real renderer crash and the start-up dialogs have not been exercised.
- **The client app's list of PCs; several PCs at once.** The app (`client/main.js`) starts with a
  list window (`home.html`, bridge `home-preload.js` -> `window.mrHome`) of the PCs kept by
  `client/hosts.js` in `hosts.json`: a name the person gives, what the PC said it is at its last
  connection (`os`, `osName`, `pc` = the computer's name, monitors), when that was, and its key as
  safeStorage made it. Nothing hands a key to a page except as below; the list's page gets none back.
  - Each PC opens in a window of its own, in a session partition of its own (`persist:host-<id>`), so
    what one host's page keeps (its cached page, layouts) is not there for another host's page; any
    number may be open at once, each a shell of its own in `shell.js` (`attach(win, { host: id })`).
    Removing a PC clears its partition.
  - The key reaches the loader without being in an address: `preload.js` asks `shell:bootKey` once per
    load of such a window (only the window's top page, only when the document has the loader's `key` and
    `go` elements), puts it into the loader's field (with "remember" off, where an older loader has that
    box) and presses its button. So `mr_key` is not left in that window's storage. A PC with a device token
    gets no key: its loader asks `mrShell.bootDevice` (see "Devices").
  - The page tells the list about its session through `mrShell.hostInfo({ connected, os, name, pc,
    monitors })` (`tellList` in the page: on 'connected' and when a session is forgotten) and has a
    `PC 목록` button (`mrShell.home`); both exist only in a window opened from the list. A host older
    than 0.4.0 sends a page without that: the app then takes the picture starting to play
    (`media-started-playing`) for "connected" and notes the time, but learns no name or system.
  - Not shown: whether a PC is on before connecting. That would take a subscription and a message per
    PC on the public relay (ntfy.sh limits both), so it was left out.
  - The clipboard: every connected PC's session shares it with this PC, so text copied on host A goes
    on to host B (checked with two hosts); files copied on A are fetched when the focus leaves A's
    windows, also for B's window, and a paste there sends them to B (not tried).
  - One app per profile (`requestSingleInstanceLock`): a second start brings the list forward.
    `--loader=<file>` (no `--list`) is still one window on that loader with no list, as the self-test
    and the local trial use it. A key the app kept before it had a list (`mr_key` in the default
    session's storage, shared by all `file://` pages) is moved into the list by `home.html` at start.
  - Checked: `release/test-hosts.js` (the store), the self-test's `--client-app-check` (a PC added
    and opened through the list, the key from the app, the entry filled in), and two test hosts at once
    on Xvfb (below). Not tried: the list on the person's real profile, the migration of a real kept key,
    a Windows host and a Linux host side by side, files between two hosts, three or more PCs.
- **Devices: client apps with a token of their own** (2026-11-16; the user's go-ahead after a look at how
  AnyDesk, TeamViewer and Chrome Remote Desktop let one's own PCs in without asking every time: "앱은 기기별
  토큰으로 ... 잃어버린 기기만 끊을 수 있습니다"). A device is one client app (its profile); browsers and
  phones are none and connect with the key every time.
  - Pairing: a client app connected with the key sends `hello.pair` (`{ pc, os, osName, app }`,
    `mrShell.deviceHello`); its `install` (the app's random id, by which the host gives an app that pairs
    again a new token in its old entry, still blocked if it was) goes over the session's `input` channel
    once it is open (`{t:'pair', install}`), not in the hello, which every key holder can read on the relay.
    The host then makes a token (`devices.add` in `host/devices.js`: 32 random bytes, safeStorage like the
    key, `devices.json`) and sends `{t:'device', ok, id, secret}` over that channel (DTLS), never through
    the relay. The page hands it to the app (`mrShell.devicePaired` -> `hosts.setDevice`), then asks the host
    for its page on the token's own topics (`verifyDevice`: a `ver` there, after 3, 6 and 12 s) and,
    answered, tells the app which token worked (`deviceVerified(tokenFp)` -> `hosts.dropKey`): the key is
    let go. Until then the app connects with the key, and pairs anew next time if the token never worked.
  - The app keeps tokens in `tokens.json` (by entry, with `install` and each token's hash), not in
    hosts.json, and a key let go leaves `keyEnc: 'none'`: a version from before tokens, which the app goes
    back to when a newer one does not come up, rewrites hosts.json with only the fields it knows and drops
    entries without `keyEnc`. It then keeps the entry (and asks for its key) and never touches the tokens.
  - A store that cannot read its file (a virus scanner holding it: tried again 5 times; anything else) never
    writes over it: the host listens on no token and gives none until it can read it again (every 10 s); the
    app adds and changes nothing; a list that cannot be read keeps the tokens of entries it cannot see.
    Found by a review: one failed read, then one pairing, had replaced every token, and those apps had let
    go of their keys.
  - Connecting: `openHost` loads the same loader. While the key is kept, `shell:bootKey` gives it; once it
    is let go, `mrShell.bootDevice` gives `{ id, secret }` (never both: a token taken away is no way back to
    the key, and a token not seen to work is never relied on). The loader talks to its own relay (never one
    a page names), and loader and page derive keys and topics from the token (`RD.derive(secret,
    RD.DEVICE)`): the token alone reaches the host, and nobody without it, the key's holders included, reads
    or forges what goes to it. The page gets it as `__mrBoot.device`; its self-update just reloads.
  - The host listens on its own topic and every token's on ONE subscription (ntfy: `/<t1>,<t2>/sse`, each
    message carries its `topic`; tried on ntfy.sh 2026-11-16; the self-test's relay does the same).
    `subscribe()` in host.js makes it anew when a token comes, goes or is blocked (`devices-changed` with
    `resub` from main; a rename does not), and lets the older ones go once the new one is open (a minute at
    most); messages go by topic to their route (`master` or the device's) and are answered on it; an answer
    must come on its session's route and is taken once (both subscriptions may bring it). Messages are put
    together per topic (`signal.js`), so junk on one topic pushes out nothing of another's.
    A blocked token is answered `{t:'denied', why:'blocked'}` and logged, at most once a minute per device
    (its holder may keep asking; `access.log` is kept under 2 MB while running too); a removed one is not
    listened to. Blocking or removing the device of the live session ends it with `bye`. At most 30 tokens.
  - The host window's card "접속한 기기": name (rename), system, last connection and its address, added;
    차단 / 차단 해제 / 삭제 (asks). "접속 기록": `access.log` (`host/accesslog.js`: JSON lines `connect`, `end`,
    `denied`, `paired`; the remote end of the selected candidate pair, or, when the engine hides a peer-
    reflexive one, the client's STUN address from its answer; 90 days, 2 MB). 새 키 발급 keeps the devices
    unless its box "등록된 기기 n대도 모두 삭제" is ticked.
  - Browsers no longer keep the key (the same go-ahead: other local files share the `file://` storage): the
    loader has no "remember" box, and the page empties `mr_key` at every start. The slot still carries the
    hand-over of a self-update (`mr_forget_key`), which the loaders handed out before need.
  - Bit once: on Windows safeStorage's key lives in the profile's `Local State`, which Chromium writes when
    the app quits normally. The self-test killed its first client app, and the next start could not read
    the token (`Local State` was not there at all). So the self-test closes them (`quitGently`: taskkill
    without /F, SIGTERM elsewhere). A person's app killed in its very first run loses what it stored the
    same way (key or token) and asks for the key again.
  - A token is as trustworthy as the session that gave it, and it lasts: someone holding the key who posed
    as the host at that moment (the real one off) could hand the app a token of their own, and the app would
    go on connecting to them, also after the real host got a new key. Before tokens such a person had to
    pose anew at every connection. The remedy for a key that leaked: 새 키 발급 with "등록된 기기도 모두 삭제"
    (the host then has no device of theirs either), then on every client app "키 바꾸기" (which pairs anew).
    The README says so. A review found this (2026-11-16); nothing short of the person comparing something
    on both screens tells the real host from a key holder.
  - **New devices confirmed** (`confirmNew`; the user's go-ahead the same day: "새 기기만 처음 한 번 확인",
    the authenticator app only for those who want it). A new install turns it on and lets its first
    connection with the key in without asking when it says it is an app (`firstFree`: until a day after the
    install, gone once that connection came up, a device paired or the person changed the setting; its page
    may come back for 12 hours like an allowed one); one from before keeps going as it did until the person
    turns it on (an update must not lock anybody out of a PC they reach only remotely). While on, a hello
    with the key (`main.js` 'gate') waits in the host page (`ask` in host.js) until the person presses 허용
    on the card at the top of the host window (a registered device connected from afar sees that window and
    can press it, which ends its own session: one session at a time; main brings the window forward and
    notifies), or the client gives the code of the authenticator app. Both screens show the same 4-digit
    number. One request waits at a time (the same page asking again replaces it), at most 6 in 10 minutes,
    each 2 minutes; refused, timed out or busy: `denied` with that `why` (busy answered at most every 10 s
    and logged at most once a minute: someone holding the key who keeps asking must not use up what the host
    may send to the relay). A page allowed may come back for 12 hours without asking (`allowedPks`). Devices
    with a token are never asked; a browser is asked every time it opens. A page from before the update (no
    `pk`) is sent an offer with only the new page's hash, which makes it reload into the new page.
  - The client page makes one ECDSA P-256 key per page (`myKey`, the private half not extractable) and puts
    its public half in every hello (`pk`), signed with it (`hsig` over `hello\n<sid>\n<ts>\n<pk>`); its answer
    (`sig` over `answer\n<sid>\n<sdp>`), a code (`otp\n<sid>\n<code>`) and its 취소 (`cancel\n<sid>`) are
    signed too, and the host takes them only so (`verifySig`): nobody else holding the key and reading the
    relay can answer in place of the client the person allowed, replace its request, cancel it, or come back
    in its name (a hello that carries an allowed page's key without its signature gets nothing).
  - The authenticator app (opt-in, "휴대폰 인증 앱 설정" in the devices card): `host/totp.js` (RFC 6238: SHA-1,
    6 digits, 30-s steps, the step before and after taken too, each step once: `otpLast`) and `host/qr.js`
    (the setup address as a QR code; a long computer name is cut to fit). The secret is shown once, kept
    only after its code was typed at the host, encrypted with safeStorage like the key (`otpEnc` in
    config.json). Five wrong codes lock the check for 15 minutes, doubling with each lock up to a day;
    while locked nothing is compared, the page is told, and the request still waits for 허용. No recovery
    codes (removed after a review): a code typed at a client goes over the relay readable by every key
    holder (who may even ask for one while posing as the host); a code of now is worthless a minute later, a
    recovery code would not be. A person who lost the phone allows from a registered device or at the host.
  - Loosening (confirmation off, the app set up or removed) is refused while a session is on and for 3 s
    after (`remoteNow`: a button held down from the client is let go by the session's end, and that click
    lands just after; a crashed page counts as an end), and turning something off asks in a dialog of its
    own. A session has the whole PC in hand (it could edit config.json), so this stops a click, not a
    determined person; a config.json that cannot be parsed keeps `confirmNew` and `otpEnc` (read from its
    text like the key), so breaking it does not turn the guard off. A setting that cannot be written is
    taken back (`changeSettings`).
  - **The page a host serves, signed** (the user's go-ahead the same day: "서명이 없으면 파일 저장 같은 앱 기능을
    주지 않습니다"). `release/build.js` builds the client page a host of the release builds for the default
    relay and signs `{kind:'page', app, version, server, sha256}` with the release key (`host/page.json`,
    `host/page.sig` in the bundle: the manifest lists them). The host sends that statement with its page
    (`app.sig`, `pageSig` in main.js) when the page it built is that one; a source folder or another relay
    serves it unsigned. In the client app the loader asks `mrShell.pageCheck({ statement, sig, sha256 })`
    before it writes the page in (`client/pagecheck.js`, with the keys of the app's own shell:
    update-config.json beside boot.js, which an update of the code cannot change); the answer holds until
    the window loads anything else (`did-start-navigation`). Only a signed page gets what the app adds to a
    browser: saving files where they were dropped, the click and Ctrl+V after a drop, the clipboard both
    ways (`clipPoll`/`clipWrite`), device tokens (`deviceHello`/`Paired`/`Verified`). Anything else runs as in
    a browser (pictures, input, windows, fullscreen) - with one exception, so that nobody who updates the
    client app before the host loses anything (the user's decision, 2026-11-16, before 0.8.0 was released):
    a page with no signature at all, in a window of a PC of the list whose host never sent a signed page (a
    host from before 0.8.0), keeps what it had before, all but device tokens (`pagecheck.decide`'s `legacy`;
    `signedPage` gates the tokens). The first signed page from that host pins it (`hosts.markSigned`, kept
    in tokens.json, implied by a token, forgotten with a new key or the entry): from then on an unsigned page
    from it runs as in a browser, so someone posing as it with the key gains nothing by leaving the
    signature out. Until a host is updated its protection is what it was in 0.7.x. `__mrBoot.signed` goes
    into the page's measurements (`cs.signed`).
    The isolated runs sign with a throwaway key (`testPageKey`) and start the client app with
    `--trust-page-key=` (taken only with `--loader=`); the in-process test windows are attached with `trust`.
    The key's public half is also written to the run's profile as `page-key.txt` (0.9.2), for a harness that starts
    client apps of its own on the run's loader, on this PC or another machine.
  - **One-time codes** (0.9.0; agreed 2026-11-16, built 2026-11-17: "남을 도울 때 쓰는 1회용 코드 + 수락").
    The host window's card "1회용 코드로 도움 받기" makes a code (`RD.newCode` in `signal.js`: 12 characters
    of Crockford's base32, 60 random bits, shown XXXX-XXXX-XXXX; typed forgivingly: case, spaces, dashes, O for
    0, I and L for 1: `RD.codeOf`). The code is stretched (PBKDF2-SHA256, 200 000 rounds) into a secret of the
    key's size that gives keys and topics of their own (`RD.deriveCode`, salt `my-remote-code-v1`), and the
    host listens on it for 10 minutes as one more route (`kind: 'code'`) on its one subscription. A hello on
    it always waits for 허용 in the host window, whatever "새 기기 확인" says (the card says it is a one-time
    code); the authenticator app does not let it in (refused even when a page sends a code), and `pairDevice`
    takes key routes only, so no device token. One page is let in (its `pk`; never added to `allowedPks`, so no
    way past the key's gate either); another page with the code gets `denied` `used`; the page let in may come
    back while the code lasts (a renew). The code ends 2 minutes after its session ended, at 끝내기 (which
    ends the session too), or unused after 10 minutes; ended, nobody listens on it (the loader's timeout then
    says the code may be wrong, expired or used). `access.log` writes `via: 'code'`. Why this is enough: the
    relay sees topics and ciphertexts of a secret that has 60 bits stretched 200 000 times and lives minutes,
    so guessing it is out of reach, and a person at the host still has to allow the request and sees the
    same 4-digit number as the other screen. The field of the loader and of the page takes a key or a code
    (loaders from before 0.9.0 take keys only: their `derive` wants 32 bytes); the page gets the code as
    `__mrBoot.key`, connects with `RD.deriveCode`, never asks for a device token (`ONE_TIME`). The client
    app's list has "1회용 코드로 접속": a window of its own on the loader, not in the list, with storage that is
    not kept (partition `onetime-<n>`), the code typed in once by the app (`shell:hasCode`/`shell:bootCode`,
    as `bootKey` does for a listed PC); a window not of the list has no device features. Checked by the
    self-test (the code shown in its form, typed in lower case with spaces; asked even with new devices off,
    the card's number the page's; let in; a second page with the code turned away `used`; the access log's
    `code` entries; 끝내기 ends the session; the code no good after; no device made) and its
    `--client-app-check` (the app's "1회용 코드로 접속" through `--home-js`: asked, let in, the picture shown,
    no device). Not tried: a real second PC over the internet, a phone.
    **자동 허용** (the user's wish, 2026-11-20): a switch on the card (`otAuto`), off for every new code and
    hidden once the code is used. On, the first page that signs its hello on the code comes in without the card
    (`allowed: 'auto'`, `approved` with `how: 'auto'` in the access log); a page without its own key still
    goes to `ask` (an old page is told to reload); a card shown before the switch was turned on is ended (the
    same page comes in instead, another one is told `used`). The rest stays: one page, no device token, the
    same ending. Not refused during a remote session, unlike the gate's settings: a person connected to the
    window can already make a code and press 허용. The card's text says which way it is (and no longer names
    `my-remote-client.html`). The self-test: off for a new code with the card's text, turned on the first page in
    without being asked, a second turned away `used`, `auto` in the access log, the switch hidden after.
  - **Connections that come back on themselves** (0.9.0; the user's go-ahead 2026-11-17, after a comparison
    with other remote programs: TeamViewer and AnyDesk refuse an ID of their own PC, Chrome Remote Desktop does
    not list it, none of them blocks two PCs controlling each other, which only feeds input back). Two cases,
    refused at the hello on every route (key, device, code) before anything is asked or started, `denied` with
    `why` `self` or `loop`, logged once a minute, in `access.log` (`접속 기록`: "이 PC 자신에 접속", "서로를 조종"):
    `self`, a client app on this very PC (the picture shows itself without end, and a key typed lands in the
    window that sends it, for ever); `loop`, the client app of a PC that this PC's client app controls right now
    (A controls B while B controls A: input on B's window of A goes back to A, and on A's window of B to B). The
    host makes an id at every start (`INSTANCE` in `main.js`, random, says nothing): in `running.json` and in the
    offer (`instance`). The client app puts its own PC's host into its hello (`from`, read from that host's
    `running.json` with its pid alive: `shell:localHost`), and keeps the hosts its windows control in `live.json`
    in its profile (`{ pid, at, hosts }`, `shell:liveHost` from the page on connected and when a session is
    forgotten, written again every 10 s, removed when none is controlled and when the app quits). `cycle.js`
    decides (`release/test-cycle.js`): `from` equal to this start's id is `self`; `from` among the hosts of a
    `live.json` whose pid lives and that is under 30 s old is `loop`. A chain (A controls B, B controls C) is no
    loop. Only pages a release signed get the two calls. A browser can say neither, nor apps and hosts from
    before 0.9.0 (both sides must have it: the page is the host's); for them the **input guard** in `input.js`
    (`stormed`) is the net: the same key pressed and let go 45 times within 3 s, or 30 clicks within 3 s (a held
    key repeats without being let go and does not count; a phone's keyboard marks its keys `s` and does not
    count: it deletes a word as many Backspaces at once), and input stops for 5 s (30 s again within a minute),
    what is held is let go, moves still go; `handle()` says `storm` once, main tells the page (`input-storm`),
    the page the client (`storm`), which says so in a toast. A test run of the client app never reads this PC's
    `running.json` (`--local-host=<file>` names a stand-in, with `--loader=` only), and an isolated host reads
    `client-live.json` in its own profile. Checked by the self-test: the guard in a dry run with a clock of its
    own (fast typing, a held key, a phone's word deleted, one key 40 times in 2.8 s and 25 clicks in 2.5 s do not
    trip it; 60 presses of a key and 40 clicks do, 30 s the second time), and with `--client-app-check` three
    runs of the client app: its PC running another host while this PC's client app controls a third (connects;
    its `live.json` names this host while connected, gone after), its PC being that third (`loop`) and this
    one (`self`): each turned away once, nothing asked. A real loop, in the test VM (2026-11-17, scratchpad `kb2`
    `run3.ps1`): the client app on the VM's own local trial host, not view-only and without `from` (as a browser),
    its window in front, one A key pressed: on 0.8.0 the key went round host -> page -> host for the whole 14 s
    watched, until the processes were ended; on 0.9.1 the host logged `input stopped for 5 s` 0.1 s after the press
    and the key never went down again. Two machines (2026-11-17): local trial host A and client app A in the test
    VM (Windows), local trial host B and client app B on the Linux PC (a display of its own), the relays joined by
    ssh tunnels, the media direct. Client app A controlled host B and its `live.json` named B's id from B's offer;
    copied to host A's `client-live.json` (a trial reads that name), client app B, naming host B as its own PC's
    host (`--local-host`), was turned away by host A as `loop` (access log `denied` `loop`); with the copy removed,
    the same app's next hello was let in (the session began; its media then timed out in that direction through
    the VM's NAT, which has nothing to do with this). Harness: scratchpad `kb2/run6.ps1`, `xm-b.sh`.
  - Checked: `release/test-devices.js` (26: the store, an unreadable file, the log), `release/test-hosts.js`
    (34: the app's side, unreadable and broken files, an older version's rewrite), `release/test-totp.js`
    (RFC 6238's test values), `release/test-qr.js` (the standard's worked example and tables; not yet read by
    a real phone), the self-test (allowed at the host with the same number on both; back without asking;
    refused; a wrong code and a recovery code; loosening refused during a session) and its
    `--client-app-check` (paired; the token read back from devices.json; the key let go; started again with
    the token alone, logged as the device; blocked: cut off and turned away; removed: not heard), the gate's
    checks (allowed with the same number on both screens; back without asking; refused; a wrong code, the
    right code unsigned by the page not taken, then signed and taken; a hello in an allowed page's name
    without its signature getting nothing; loosening refused during a session and for a moment after),
    independent reviews of the tokens and of the gate (their findings are fixed above), the cards in
    pictures with made-up devices. Not covered by a check: a new install's first-device pass (the
    isolated runs never get it). Bit while fixing: the once-a-minute limit started at 0 and the host page (reloaded by
    the self-test a minute earlier) answered nobody. Not tried: the real ntfy.sh with a real host and
    several tokens, a Linux client app, a browser whose key a real old loader had kept.
- **The self-test keeps every display's picture moving.** The native capturer sent nothing while a
  screen stayed the same (since 2026-11-18 its last picture once a second), and the checks that count frames failed now and then on a PC with two
  monitors, one of them idle. A 64x28 counter window (no focus, no clicks) sits in a corner of every
  display for the length of the test; before 2026-11-14 only on Linux.
- **Throwaway profiles.** Every isolated run (`--selftest`, `--localtest`, `--bench`, and the bench's
  client side) starts `profile-cleanup.js` as a small detached process of its own, which removes the
  run's `%TEMP%\myremote-local-*` / `myremote-peer-*` profile once the run's process has ended and then
  sweeps old ones (older than 10 min, their run dead, never while another run is going on, at low
  priority). On Windows a detached child inherits Electron's std handles and would keep whatever
  started the run waiting (a script that reads the self-test's output, `spawnSync` in `bench-run.js`),
  so `watch()` clears their inherit flag around the spawn.
- **The drop-in check once dragged a real folder of the user's.** Explorer scrolls its list sideways
  while something is dragged past its edge; a press point computed as "item left + 40 px" then lay on
  the navigation pane, which showed the user's `서버` folders, and that folder was dragged (the read
  failed before anything was sent; nothing was changed). A second time the drop point was not the
  client window and a file was dropped onto an empty Notepad, which said "file not found". Hence the
  verified press points and the window-handle check before letting go (`dragcheck.js`). A third time
  (2026-11-13) the point where the HOST drops was covered by a dialog of the person's on the primary
  screen (UI Automation: a #32770 dialog with an edit field; under the point a SysLink of it), which took
  nothing, and the not-taken fallback put the test files on the person's clipboard over the text they
  had copied. So the host's drop point is checked too (the window there must be the target Explorer
  window, else nothing is pressed), empty space is found in the target's list of items by UI Automation
  (not a fixed spot of the window), and a local trial never falls back to the clipboard.

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
  - Text from a phone's keyboard (`typeText`): X11 cannot type a character as such, so empty keycodes are
    lent to the characters' keysyms (Latin-1 = code point, else 0x1000000 + code point) and pressed,
    like xdotool. Chromium (Electron, VS Code, Chrome) reads the keyboard map again in a task of its own
    and reads a key with the map it has by then: measured on Xvfb, a keycode changed from one character
    to another and pressed at once came out as the old character, and with 32 keycodes changed at once a
    second change 30 ms later was what the first presses came out as. A keycode lent from empty comes out
    right at once. So a lent keycode keeps its character until 1 s after its last press, is then emptied
    and lent again only 0.5 s later, and presses wait 30 ms after a change; the map is read again before
    each step (a layout switch replaces it). Typing therefore takes time when a text has more different
    characters than there are empty keycodes (about 38 on Xvfb: 42 different ones took 3.3 s): typeText
    returns a promise and input.js holds later input back until it is done. Checked by `--input-check`
    (Latin, accents, Hangul, symbols, and the Enter after them) and a Node harness with a fake X server.
    Not tried: a real desktop, an input method (ibus, fcitx) in front, Qt and GTK programs.
  - Keys: `KeyboardEvent.code` -> Linux evdev code, X key code = evdev + 8 (the evdev keymap of every
    current X server, Xvfb included); `HangulMode`/`HanjaMode` by meaning, like on Windows. Pointer:
    physical pixels are X root coordinates (`XTestFakeMotionEvent`), wheel = buttons 4-7, one click per
    120 with the rest kept, back/forward = buttons 8/9.
  - `screen.dipToScreenRect` exists only on Windows in Electron 33: `physicalRect()` in `main.js` scales
    the bounds by `scaleFactor` elsewhere. Electron fills `display_id` on X11, so sources still match
    displays by id.
  - The engine's capturer on X11 paints the pointer into every frame (measured with `--input-check`:
    the pixels under it change when it moves away), and X11 has no `SetSystemCursor`: `hideHostCursor`
    does nothing there (`input.hidesCursors` false), so the client saw its own pointer and, slightly
    behind, the host's in the video. Hence native capture on X11 too: `host/platform/x11capture.js`, the
    calls of `capture.dll` (open, size, next, close, error) made in JavaScript, so the loops in `preload.js`,
    the repeats and `host.js` are the same. XDamage on the root window (a connection of Xlib's, level
    NonEmpty, the region fetched through XFixes) says what changed; the monitor's rectangle (`rect` in the
    `open` message, root coordinates) is read with MIT-SHM (`xcb_shm_get_image` on a connection of XCB's)
    and copied with `memcpy` into the loop's buffer. The X server leaves the pointer out of what is read,
    so the offer says `cursorHidden: true` as with native capture on Windows. Things that bit:
    - Nothing may run on another thread: a koffi `.async` call under way when the page reloads takes the
      process with it (see "Native capture"), and Xlib's and XCB's reads would block the page's thread.
      So the screen read is sent, and its answer (`xcb_poll_for_reply`) and new damage are looked for on
      timers (4 ms, which Chromium's timer clamp gives anyway). The libraries are all ones Electron links
      itself (libX11, libXdamage, libXfixes, libxcb, libxcb-shm); `libxcb-damage` is often missing.
    - `koffi.view` (an ArrayBuffer over the shared memory) ends the process in Electron: V8's memory cage
      allows no outside memory. Hence the copy.
    - XCB's replies must be let go of with `XFree`, never with libc's `free` looked up through koffi:
      Chromium replaces `malloc` in its processes (PartitionAlloc), XCB's `malloc` is that one, and libc's
      own `free` on its blocks crashed the renderer (Node, without the replacement, was fine).
    - The segment is attached read-write (`xcb_shm_attach` with read_only 0): ShmGetImage writes into it.
    - Measured on Xvfb with a window changing colour every 100 ms: every change captured, p50 8 ms and
      p95 11 ms after the window's frame; the same under GNOME Shell (mutter compositing) on Xvfb, p50 9,
      p95 11. Not tried: a real desktop and graphics card (glamor, page flipping), several monitors,
      HiDPI, an X server of another user (MIT-SHM is then refused and the engine's capturer is used).
    - A still screen sends nothing, as on Windows. The self-test therefore puts a small counter in a
      corner of a Linux display (a virtual display with the test's windows hidden never changes).
    - A capturer is nearly always closed while a read is under way (the loop waits in `next`). `close`
      then only marks it, and the read's end lets go of it: for half a day that end found the mark and
      freed nothing, so every monitor of every session left two X connections, a damage object and the
      shared memory of a whole screen behind (found by a review). `closed` (no more reads) and `freed`
      are separate now, `openCount()` counts what is really held, and the self-test checks it after a
      renegotiation.
  - Cursor shape: `XFixesGetCursorImage` gives the picture and, for cursors loaded from a theme by name
    (GTK, Qt, libXcursor), the name. Chromium's own cursors and the X server's default cursor have none
    and go as pictures. `pixels` holds one `unsigned long` per pixel (8 bytes on x64).
  - Drag-out: an XDND drag is under way when its source took `XdndSelection` (an XFixes selection event)
    while a button pressed through us is held (sources keep that selection after the drag). What is
    dragged is then read from that selection (`input.dragData()`: `TARGETS`, then `text/uri-list` or
    `UTF8_STRING`), and the drag is ended with Escape and the release: no Ctrl+C, the host's clipboard
    stays as it was. Escape + Ctrl+C (still the fallback) does not work with Chromium-based sources:
    Chromium clears its text selection 3 ms after a cancelled drag, so Ctrl+C copies nothing. Whether
    Chrome or VS Code on a Windows host behave the same way was not checked. With real Nautilus 42.6
    (the server, Xvfb, a session bus; the item found with AT-SPI, `pyatspi`) the drag of a file was seen
    142 ms after the press and its path read from the selection.
  - GTK 4 (Nautilus 46, Ubuntu 24.04) starts its drag only after a few more motion events than a quick
    drag out of the client window gives it: reported from a real session (Windows 11 client, a GNOME 46
    desktop on a virtual display), "the pointer is blocked at the window's edge", and reproduced end to
    end on a test display (GNOME Shell 46 + Nautilus 46, the real client page with synthetic pointer
    events, the selftest's relay): 1 or 2 moves inside the window, then out and held still (the client
    holds the host's pointer, see above) -> no drag ever, the button let go where the pointer waited;
    4 moves -> a drag. Explorer starts its drag on a timer instead. So while the client asks (`dragq`,
    `pollDrag` in `host.js`), every other look moves the pointer a pixel aside and back (`input.nudge`,
    X11 only, only while a button pressed through us is held): afterwards 1 or 2 moves gave a drag in
    50-100 ms and the file was carried out. For test harnesses: GTK 4's AT-SPI gives 0,0 as desktop
    coordinates; its window coordinates count from inside the client-side shadow, which
    `_GTK_FRAME_EXTENTS` on the X window gives (left, right, top, bottom).
  - Drop-in (files from the client): `dropFiles` in `platform/linux.js` is an XDND source, as
    `shellops.dll` does with OLE on Windows: the program under the pointer that takes drops is found from
    the root down (`XdndAware` on the program's window inside the window manager's frame; `XdndProxy`
    followed), told `XdndEnter` (text/uri-list) and `XdndPosition` (resent every 150 ms until it accepts,
    1.5 s at most), then `XdndDrop`; its `SelectionRequest` for the list is answered from `pump()`, and
    `XdndFinished` ends it (5 s at most). Nothing taking the drop: the clipboard, as before. Checked on
    Xvfb: a Chromium window and a GTK 3 window take the file (`--input-check` has the Chromium case), the
    bare root window takes nothing. Nautilus on that server refused every external drop, also from
    Chromium and from a real GTK 3 drag (its gvfs/document portal cannot start there: "fuse init
    failed"), so Nautilus and the GNOME desktop as targets are not verified. Before this the host only put
    the files on its clipboard, which the user saw as "copied to the clipboard" with nothing dropped.
  - The clipboard's change counter (`clipSeq`) counts XFixes owner changes of `CLIPBOARD`. Electron's
    `clipboard.writeBuffer` replaces the whole clipboard on each call, so a file list goes on in one
    format: `x-special/gnome-copied-files` (GNOME Files, Nemo, Caja, Thunar), `text/uri-list` when
    `XDG_CURRENT_DESKTOP` says KDE. Reading takes either.
  - The client app on Linux never clicks or types: files let go over the bare desktop (no window there,
    a `_NET_WM_WINDOW_TYPE_DESKTOP` window, or GNOME's desktop-icons window) go into
    `app.getPath('desktop')`, anything else onto the clipboard and the page says to paste. Received
    files wait in `~/.cache/my-remote-drop` (on Linux `/tmp` is shared by all users).
  - No keyring (`safeStorage` backend `basic_text`, usual outside a GNOME/KDE session): the key is only
    obscured ('v10', a fixed password); the host prints a warning and keeps `config.json` at mode 0600.
    The asynchronous calls work there without `setUsePlainTextEncryption` (the synchronous ones needed it).
    They ask the Secret Service whenever the session bus has one, whatever `--password-store` says, and a
    keyring that cannot ask for its password (no display for its prompter; a user who never logged in at
    the desktop has no keyring yet) answers only at D-Bus's time-out: the call takes 25 s (measured over
    ssh) and then falls back to 'v10'. The host then starts 25 s late.
  - Started over ssh (no display in the terminal, or only the ssh client's forwarded one, such as
    MobaXterm's `localhost:10.0`), the launchers run on the desktop session the user is logged in to on
    that PC (`desktop_env` in `host/linux-launch.sh`: this user's X11 session from logind, its DISPLAY,
    XAUTHORITY, bus and desktop variables read from a process in the session's scope). Without such a
    session they say to log in there first; a Wayland session is named as such. Checked with stand-ins
    for `loginctl` only, not yet with a real display manager's session.
  - `--show-key` (`showKey` in `main.js`, `show_key` in the launcher) is for a host reached over ssh: the
    key goes to stdout, reasons go to stderr marked `[show-key]` (the launcher shows only those lines of
    Electron's output). It opens no window, takes no lock and needs no display (`--ozone-platform=headless`;
    DISPLAY is unset so that an ssh client's X server is not asked), and runs without Chromium's sandbox
    where that cannot run (Ubuntu 23.10+ without the helper): it loads no page. Setting `DBUS_SESSION_BUS_ADDRESS`
    from `main.js` is too late (measured), so the launcher reads the stored key's scheme (`"keyEnc":
    "djEw` is 'v10') and gives Electron no bus for such a key; a 'v11' key needs the user's bus and an
    unlocked keyring. Checked with made-up keys in temporary folders: 'v10' under the user's real bus in
    0.2 s (25 s before that change), 'v11' with a throwaway unlocked GNOME keyring on a bus of its own in
    0.2 s, the same keyring locked, broken JSON, no key, no file.
  - Electron 45 links GTK 3 and other desktop libraries (NSS, ALSA, GBM, AT-SPI, ...) directly: on a
    system without a desktop, or a minimal one, it does not start at all ("error while loading shared
    libraries: libgtk-3.so.0"). `need_electron` in `host/linux-launch.sh` (setup and every launcher)
    checks with `ldd` and says what is missing and the install command (apt, picking Ubuntu 24.04's
    `t64` names; dnf/zypper by soname; pacman). With `XDG_CURRENT_DESKTOP=GNOME` or `KDE` it still loads
    only GTK 3, not GTK 4 next to it (checked on the server, GTK 4.6 installed, with a window and a tray
    icon); a real GNOME session was not tried.
  - Chromium's sandbox needs its setuid helper (npm does not install it so) or unprivileged user
    namespaces: Ubuntu 22.04 has them (the self-test ran with the sandbox on), 23.10 and later restrict
    them through AppArmor. `host/linux-launch.sh` then stops and names the two ways out (the helper,
    with sudo, or `MY_REMOTE_NO_SANDBOX=1`).
  - `--localtest` opens the client app, not the default browser (often Firefox, which the page is not
    made for). The launchers start Electron in the background like the `.bat` files; its output goes to
    `$XDG_RUNTIME_DIR/my-remote-*.log`.
  - Windows-only: `capture.dll` (X11 has its own native capture, above), cursor hiding, HDR detection,
    the Chrome Remote Desktop and outline checks (`others` is `{crd: false, outline: false}`),
    `--dragout-check`, `--cursor-check`.

- **`ELECTRON_RUN_AS_NODE`**: terminals inside VS Code / Cursor set it, and Electron then runs as plain
  Node and crashes with `Cannot read properties of undefined (reading 'requestSingleInstanceLock')` or
  similar. Clear it before launching Electron (`Remove-Item Env:ELECTRON_RUN_AS_NODE` or `unset`). The
  `.bat` files and `setup.ps1` already do this.
- **Node may not be on PATH.** After setup it can be at `tools\node\node.exe`; use that path for `npm`.
- **Windows Firewall prompt** appears the first time a given `electron.exe` path opens UDP ports.
  Allowing it adds an inbound rule for that executable on the chosen network profile. Removing the rule
  later needs admin rights.
- **Lock screen / UAC** (Windows) are on a separate secure desktop: they cannot be captured or controlled by a
  normal-user process. The host reaches them through the **assist service** (2026-11-15; the user's goal:
  a host installed from the README's download unlocks from the client like Chrome Remote Desktop):
  - `native/winassist.cpp` -> `host/bin/winassist.exe` (built and recorded by `native/build.js`, checked by
    the self-test like the DLLs). Installed from the host window's card "잠금 화면에서도 원격 조종"
    (`host/assist.js` runs `winassist.exe install` elevated: a UAC prompt at the host PC; `install` copies
    it to `%ProgramFiles%\MyRemote`, admin-only, registers the LocalSystem service `MyRemoteAssist` and
    starts it; run again it updates in place; `uninstall` removes it all). The card says "업데이트 필요"
    when the installed program is not the one this app brings.
  - **Offered at the host's first start** (the user's wish, 2026-11-15: "설치 시 크롬원격처럼 한번에"; Chrome
    Remote Desktop's installer sets its service up with the program): `assist.offer` asks once per profile
    (`assist-offered.json` in the host's userData, written with the answer) with a dialog whose default is
    "켜기 (권장)", and on yes runs the elevated install at once (one UAC prompt). Not asked when the
    service is there, in the isolated modes, or during a remote session. It lives in the bundle, not in
    the shell's first-start dialog (`app/boot.js`), so installed apps get it by update and the shell stays
    as it is; a host that ran before this version is asked once at its next start.
  - **Never installed or removed during a remote session** (`assist.install({ remote })`, why `remote`):
    Windows shows the consent prompt on the secure desktop, where nothing from the client arrives (the
    helper never types into UAC), so a click from the client on the card's button would leave an
    unattended PC waiting on that prompt, its client seeing only the notice. The card says to do it at
    the PC. `T.elevate` stands in for the elevated winassist.exe in `release/test-assist.js` and the
    self-test, so no test ever raises a real prompt.
  - The service (session 0) only keeps one helper alive as LocalSystem in the console session
    (`CreateProcessAsUser` with its own token moved to that session). The helper follows the input
    desktop, sends `S` (secure desktop? session locked? input accepted?) and, while a secure desktop has
    the screen, `F` frames (GDI `BitBlt` of the primary monitor, BGRX, change-gated, ~10/s), and injects
    `M`/`K`/`A` (SendInput / SendSAS) only while the session is locked (WTSINFOEX `SessionFlags ==
    WTS_SESSIONSTATE_LOCK`, failing closed): a UAC prompt is never typed into or clicked.
  - **Every monitor** (2026-11-18, the next step the user chose after "only the primary is sent"): the
    service answers four bytes, the fourth `ASSIST_CAPS` 'M'; only then the host sends `V` on the data pipe
    and the helper sends `R` frames instead of `F`: one per monitor (`EnumDisplayMonitors`, the helper per-
    monitor DPI aware so the rectangles are physical pixels like Electron's), with its top left on the
    virtual screen, each change-gated on its own, an unchanged one every 3 s. A service from before answers
    three bytes and is never sent `V` (its helper ends on a tag it does not know; the host would then
    reconnect for ever); a host from before reads three of the four bytes and gets `F` as always. The
    first frame after connecting can still be an `F` (sent before the helper read `V`): the host takes it
    for the primary's. `host.js` puts each picture into the monitor whose physical rectangle matches
    (`assistMonitor`, else by top left), repeats each on its own, and the `lock` message lists them (`ds`,
    `d` the primary among them); the client shows the bar on every window that shows one of them. The
    protocol byte stays 1. `winassist.exe grabmon <prefix>` writes every monitor as the helper sends them.
  - Pipes: control `\\.\pipe\my-remote-assist` (service, reply "ok"+`ASSIST_PROTOCOL`+`ASSIST_CAPS`), data
    `\\.\pipe\my-remote-assist-data` (helper; first instance only; DACL: SYSTEM and the session's user
    from `WTSQueryUserToken`). Both byte mode; the data pipe overlapped. **Bit once:** with a synchronous
    handle the helper's main thread could not write while its reader thread waited in ReadFile (Windows
    runs a file object's I/O one at a time): no state ever reached the host until it typed something.
    `host/assist.js` opens the pipes through koffi with overlapped I/O for the same reason (Node's
    pipe sockets would do the I/O but cannot give the handle), and checks each pipe's server session
    (`GetNamedPipeServerSessionId`: 0 for the service, this session for the helper) before anything
    is sent, so another account's pipe of the same name never receives a typed password.
  - In the host: `main.js` starts `assist` when a session goes live (not in `--selftest`/`--bench`; it does
    run in `--localtest`), stops it with the session or the page. While the helper says "locked",
    `input.setSink` sends every injected input to the helper; on another secure desktop the sink drops it.
    Frames go to the page (`assist` IPC) and into each monitor's `MediaStreamTrackGenerator` (the primary's
    only with a service from before 2026-11-18; only with native capture), repeated 30 times after a
    change, then kept alive like the capturer's (`keepAlive`), each monitor on its own time. The `lock` message
    gains `live`, `input`, `d` and `ds`; the client then shows the lock screen
    with a small bar and a Ctrl+Alt+Del button (`sas`) instead of the cover, and windows showing none of
    `ds` say which monitor has it. Found in a review (2026-11-20) and fixed, each with a check:
    - While a monitor's video has the secure desktop's picture, the capturer's frames are kept out of it
      (`assist.held`): it cannot read that desktop, but it still sent its last picture of the desktop (the
      rest of a series of repeats under way when the screen locked, or a whole series started by a `show`
      when the client changed what it showed), and the two went into one encoder in turn: the desktop
      flickered over the lock screen, or stood there for a second (185 such frames in 4.5 s in the
      self-test's acting out, before).
    - A monitor's keep-alive could come up to `keep` late after another monitor's repeats ended (1.5 s
      apart, three monitors); now the timer goes off when the next one is due.
    - What the service said last outlived the session (since 0.5.0): ended on the lock screen and unlocked
      at the PC before the next session, the next session's client was told "locked" and showed the cover
      over the desktop for as long as it lasted, since the new connection's first word, "the desktop", was
      the state a connection starts from and went unsaid. `teardown` forgets it, `assist.js` passes on every
      connection's first word, and the page takes the service's messages only while a session is on.
  - Verified 2026-11-15 in a throwaway Windows 10 22H2 VM (dockurr/windows under KVM on the GPU server,
    `~/my-remote-dev/winvm` there; see the `my-remote-test-vm` memory): GDI captures the real lock screen
    as LocalSystem (pictures checked), a click lifts the curtain, the typed password unlocks (probe in
    the VM), the service updates in place; and end to end, the real client page on the Windows PC against
    the real host in the VM (`--localtest --no-client`, relay tunnelled): lock -> the client shows the lock
    screen live with the bar -> click, password typed with trusted key events, Enter -> unlocked.
    `release/test-assist.js` (25 checks, fake service and helper) covers the protocol, the session checks,
    input routing and encoding, pictures in pieces, reconnecting, the refusal during a remote session, the
    first-start offer, every monitor (`V` only to a service that offers it, `R` pictures with their
    place, each deduplicated on its own), and a new connection's first word passed on. Every monitor, 2026-11-18: in the test VM (one monitor) the
    service updated in place answered `6f6b014d`, the helper sent the real lock screen as `R` (0,0
    1280x800, picture checked), a click changed it and the typed password unlocked (`assist-probe2.js`);
    `grabmon` on this PC's three monitors (the ordinary desktop, as a user) gave each monitor at the
    rectangle Windows reports, physical, with its own content; the self-test acts out every monitor's
    picture reaching its own video and the client's bar. Not verified: the offer's dialog on a real first
    start, a real PC's lock screen with several monitors (no VM with two), Ctrl+Alt+Del with `SoftwareSASGeneration` (not set
    by the installer), a UAC prompt through the service, the logon screen after a reboot (out of scope:
    the host is a per-user program), Windows 11.
  What was found out when the user asked how a locked host could be unlocked from the client
  (2026-11-14; sources: Microsoft Learn, systemd and GNOME Shell sources, Chromium's remoting docs):
  - Windows: the lock screen, the UAC prompt and the logon screen are on the Winlogon desktop, which
    only LocalSystem can open. Desktop Duplication gives E_ACCESSDENIED there unless the caller runs as
    LocalSystem; Ctrl+Alt+Del needs `SendSAS` from a service (policy `SoftwareSASGeneration`). There is
    no supported way for a user-level process to unlock a session (the companion-device framework is
    gone since Windows 10 2004). Every tool that does it (Chrome Remote Desktop, RustDesk, UltraVNC)
    installs a LocalSystem service that starts a LocalSystem helper inside the session, which follows
    the input desktop. For this program that means: native code (a service and a helper in `native/`),
    an install step with administrator rights, frames and input passed between the helper and the
    user-level host. One trap to design around: the key and the WebRTC session live in the user-level
    host, so a helper that takes its orders from that host lets any program of the same user type on
    the secure desktop. On the lock screen that gains nothing (the password is still needed); on a UAC
    consent prompt it would be a way to elevate without the person. So: lock screen first, UAC view-only.
    Built as described above.
  - Keeping Windows from locking is no substitute: `SetThreadExecutionState` does not stop the screen
    saver or the inactivity-limit policy; only input resets that timer. After a reboot nobody is signed
    in and a per-user host does not run at all (automatic sign-in stores the password as an LSA secret).
  - Linux, X11: the lock screen of GNOME Shell is drawn on the session's own display, so the host shows
    it and the client's keys reach it. Checked on Xvfb with GNOME Shell 46 through the real host and
    client page: the locked screen in the client's picture, a letter sent from the client as a dot in
    the password field. Nothing had to be built. The session's owner may also unlock without a password
    (`loginctl unlock-session <id>`: logind lets the owner, GNOME Shell obeys; exit 0, unlocked): not
    offered to the client, since the access key alone would then open a locked session.
    Not the same everywhere: light-locker switches to a greeter on another display, the display
    manager's greeter before login is another user's (GDM's is Wayland), xscreensaver ignores logind's
    unlock, and a Wayland GNOME session ends remote sessions when it locks. Electron's
    `getSystemIdleState` says 'idle', never 'locked', there: the client shows no lock notice on Linux,
    which is right, since the picture shows the lock screen itself.
  The client is told (`lock`): main reports Windows' lock and unlock (`powerMonitor`, and
  `getSystemIdleState` when a session starts), and native capture loops that cannot read their screen
  for over 1.5 s count as a secure prompt (`screenGone` in `host.js`); every client window then says so
  over the picture until the screen is back. A lock learned by asking (at a session's start; Windows'
  idle check also calls a screensaver that does not lock "locked"; on Linux no lock events come at all)
  is asked about again every 2 s and cleared when it is over; a monitor whose capture loop is stopped
  (nobody shows it) stops counting as paused, since a stopped loop can never report it back. For 2.5 s
  after an unlock, loops that have not read the screen again yet do not count as a secure prompt.
- **Fullscreen is the host, a window is this PC** (the user's first rule, `systemKey` in
  `client.template.html`). In fullscreen every key goes to the host, the system's shortcuts too (the
  Windows key and its combinations such as Win+Shift+S, Alt+Tab, Alt+F4, Ctrl+Esc, PrintScreen): the
  page is in HTML fullscreen with `navigator.keyboard.lock()` in a browser and in the client app alike
  (`FULLSCREEN_JS` in `client/shell.js`), so Chromium holds them for the page. In a window those
  shortcuts are not sent and act on the client PC; a key whose press was sent always has its release
  sent, and a release whose press was not sent never is. The modifier of such a shortcut did go first
  (Alt of Alt+Space, Ctrl of Ctrl+Esc), and its release may never come (Windows' window menu takes it):
  when a shortcut stays on the client, the page sends `reset` so the host lets go of everything. On a
  Mac client Option+Tab/F4/Esc/Space and Ctrl+Esc are no system shortcuts and go to the host. Keyboard
  Lock holds the Windows key on Windows (seen in the test VM, 2026-11-17; Ctrl+Alt+Del and Win+L cannot
  be held by anything). The clipboard is the one exception: shared in both modes. When the
  host lets go of Alt or the Windows key in a `reset` (the client left with Alt+Tab while Alt was
  held), it first presses a key of no meaning (Windows: VK 0xE8; X11: an empty keycode; `maskKey`), or
  the lone release would open the program's menu bar or the Start menu.
- **The menu at the top in fullscreen** (0.9.2; the user's wish, 2026-11-17). Fullscreen hides the bar and gives
  the picture the whole screen. `attachPeek` (every view, not on a phone): the pointer resting at the very top of
  the window (`clientY < 2`, still within `PEEK_STILL` 6 px: moving along the edge starts the time again) for
  `PEEK_DWELL` (400 ms) with no button held brings a menu over the picture, in the middle: the main window its own
  `#bar` (`:fullscreen #bar.peek`, fixed and centred, `#stats` hidden so its width does not change under the
  pointer; the `전체화면` button reads `전체화면 끝내기` in fullscreen, on a phone too, and ends it), a window of a
  monitor of its own a small one (`peekMenu`/`fillPeek`: its monitors, the overview, fullscreen on or off, closing
  that window, disconnect). In the client app such a window is frameless and the size of its screen: out of
  fullscreen it counts as covering, so the menu comes there too and brings fullscreen back. It goes `PEEK_LEAVE`
  (700 ms) after the pointer left it (24 px around it count as on it) or the window (`mouseout` to nowhere), at a
  press elsewhere, on blur and with fullscreen; the focus left in it (a select) goes back to the picture. Not while
  a 1:1 picture can still pan up (pushing against the top edge pans it), not while the window shows the lock
  screen's bar (its Ctrl+Alt+Del button is there). A pass along the top edge does not bring it (host tabs, title
  bars); the picture is not moved (the menu lies over it), and moves over the menu are not sent. The fullscreen
  hint says so. Also from the review of 0.9.2 (a workflow of four reviewers, 2026-11-17): a key whose press went to
  the host has its release sent even when the focus moved to a field of the page meanwhile (`attachKeys`: before,
  `local()` swallowed it and the host held the key). Checked by the self-test (`forceFull`: resting brings the bar
  and it stays on it past `PEEK_LEAVE`, also after leaving and coming back; it goes, the focus goes back; a quick
  visit, a pass along the edge, leaving the window, a held button, a finger, the lock bar, a picture still panning
  up and a window do not bring it; the small menu's buttons on a stand-in view; the key release with a select
  focused) and in the test VM in real fullscreen through the client app's debugging port (shown at the top after
  0.9 s, still there 0.3 s after moving away, gone at 1.8 s; the same with the pointer moved away in steps; a
  picture of the screen shows the bar centred over the picture). Not tried: a window of its own in real fullscreen
  on a second monitor.
- **Keyboard Lock and modifier keys** (0.9.1). Reported 2026-11-17 from a real session (a Windows client app
  controlling the Linux host): Esc sent the client's windows to the back one by one, a click on a taskbar group
  opened its first window instead of the choice, letters did not type - on the client PC, also after the app had
  quit. Windows held Ctrl and Alt down for good. Chromium's Keyboard Lock on Windows
  (`ui/events/win/modifier_keyboard_hook_win.cc`) swallows Ctrl, Alt and the Windows key, presses and releases,
  while its window is fullscreen and focused; nothing tells it a press the system saw before the hook began, so
  that key's release is swallowed too, and taking the hook away only resets its own thread's key state. The page's
  Ctrl+Alt+Enter (fullscreen) locks while both are held. Reproduced in the test VM with injected input (the hook
  treats it as real; a scheduled task in the signed-in session, scratchpad `kbtest`): after Ctrl+Alt+Enter the
  system kept Ctrl+Alt down, after the window had gone too, until each was pressed again. The same happens when
  the focus comes back to a locked window with one held (Win+1). Fix: `client/keylock.js` `safeKeyboardLock`
  wraps `Keyboard.prototype.lock/unlock`: the real lock only at an event that shows Ctrl, Alt and Meta up (their
  releases have reached the system), or at once when the client app says the system holds none
  (`mrShell.modsHeld`, `GetAsyncKeyState`, answered only to a focused window of ours); given up on blur, at
  fullscreen's end, at a modifier pressed while it was being taken (until 150 ms after), and when the app still
  sees one held right after; the page's `lock()`/`unlock()` keep their meaning. The client app puts it into every
  window's own world from the preload (the text from main, `shell:keylock`: a sandboxed preload cannot require a
  file), before the page runs, so pages of hosts that are not updated are covered; it survives the loader's
  `document.open()` (the window and its prototypes stay; its listeners are added again at every `lock()`). The page
  has the same function as text (for browsers) and locks only through it; `FULLSCREEN_JS` locks only when the
  wrapper is there (else no lock: losing the system shortcuts in fullscreen is the lesser harm).
  `release/test-keylock.js` checks the rules with a stand-in window, that the page's copy is the same text, and
  that no bare `keyboard.lock()` is left; the self-test that the page and every app window have the wrapper. In the
  test VM, real Chromium: the bare lock left Ctrl+Alt held; the page's copy and the app's preload (with a page
  written in place and a bare lock, as an old host's page does) left nothing held, and the Windows key pressed
  afterwards went to the page. Then the real client app on a local trial host in the VM (view-only; scratchpad
  `kb2`: `keys2.ps1` presses, `keystate.ps1` logs the system's key state every 20 ms), the 0.8.0 copy against
  0.9.1: Ctrl+Alt+Enter into fullscreen left Ctrl+Alt held on 0.8.0, nothing on 0.9.1; coming back to the
  fullscreen picture from Notepad by a click with Ctrl held left Ctrl held on 0.8.0 (the second way in, as
  foreseen), nothing on 0.9.1; Ctrl+Alt+Enter out of fullscreen left nothing on either; the Windows key pressed
  after each way in never reached the system on 0.9.1 (the lock was back). A client PC that has the keys stuck:
  press and let go of each Ctrl, Alt and Windows key. X11 keeps key state in the server (a grab does not hide
  releases from it): not affected.
- **The clipboard is shared both ways.** Host to client: text at once (the host page polls main's
  clipboard; the client app writes it with `shell:clipWrite`, a browser when one of its windows has the
  focus), files when the client's own programs get the focus (`clipfiles`/`clipget`). Client to host: in
  the client app text at once (`shell:clipPoll` twice a second while connected: `clipSeq`, then the
  text; what was on the clipboard before the session began is not sent, the host's text counts then);
  files, and in a browser also text, when pasted into the picture (a browser lets a page read the
  clipboard only in a paste event). Text a password manager marked as private goes neither way
  (`clipboardPrivate()`; Windows: `ExcludeClipboardContentFromMonitorProcessing`, `Clipboard Viewer
  Ignore`, and Windows' own history/cloud opt-outs `CanIncludeInClipboardHistory` and
  `CanUploadToCloudClipboard`, all by presence, without opening the clipboard; Linux and the macOS client
  app: a type in Electron's `clipboard.read()` of KDE's `x-kde-passwordManagerHint` (KeePassXC; checked
  on Xvfb) or NSPasteboard's `org.nspasteboard.ConcealedType`/`TransientType` (not tried)). Echoes are cut by the last text on each side (`lastClip`, `s.clip`). Never passed to
  the client: the access key that `키 복사` put on the host's clipboard (by change count, and any text
  that is the key), what a drag-out's Ctrl+C copied (the drag hands it over; announced again, the app
  would fetch the same files twice), and files the client sent itself (in the host's inbox). Every new
  connection starts with the host's text, which the client does not write again when it is what both had
  (the person may have copied something else meanwhile). The client app's first reading of a session is
  only remembered, never sent (on a Mac the change counter changes on every reading, so text is
  compared), and readings never overlap on either side. Host files fetched onto the client's clipboard
  and pasted back into the picture are not sent back: the host's own Ctrl+V pastes its originals.
- **Languages** (2026-11-20, the user's wish; read [docs/i18n.md](docs/i18n.md)): 12 languages, one setting per
  PC (`<appData>/my-remote/settings.json`, `host/settings.js`) that the start screen, the host window, the PC list
  and the toolbar's 🌐 all change, each program following the others' changes. The Korean text in the code is the
  key: `t('키 복사')` (`tr` in the page, `tl` in the loader, `T` in `client/shell.js`), catalogs in `host/i18n/`,
  fallback English then Korean. Rules: never build a sentence from pieces (`t('… {0} …', x)`); a new or changed
  Korean text needs its entry in every language (`node release/i18n-sources.js --missing`), and
  `release/test-i18n.js` (CI) fails otherwise, also when a button quoted in a sentence is not that button's own
  translation; the same Korean word used for two meanings needs two sources (the access log's `접속 종료`/`허용됨`/
  `거부됨` against the buttons' `종료`/`허용`/`거부`). Isolated runs start in Korean (their checks read Korean), the pages too (`--lang`:
  a test window's page follows the browser's language; on GitHub's English runners it started in English), unless
  `MY_REMOTE_LANG` is set; a person changing the language of a test run's window fails those checks (seen
  once). The client page carries no catalog (the loader's 40-chunk reply): the loader brings it, else the host
  sends the page's texts on request (`lang`/`strings`), kept per page hash. The picker is a hidden `<select>` shown
  as a button with SVG flags (Windows draws flag emoji as letters; `I18N.picker`); its keys stay in the page
  (`local()`). The 진단 report is English for every language but Korean (`page-report.json`).
- **Phones and tablets** (`TOUCH`: `(pointer: coarse)`, or `#touch` for tests; `attachTouch`). A
  finger's pointer events are taken before the mouse handling (capture listeners at the target,
  `stopImmediatePropagation`): a tap clicks, a long press (550 ms) clicks the right button, holding
  still for 300 ms and then moving drags with the left button, a quick swipe scrolls (the wheel, scaled
  by host pixels per screen pixel so the content follows the finger), two fingers zoom (1x-5x) and move
  the picture locally (`view.zoom`, `view.pan` in `layout`; the host is asked for more pixels when
  zoomed). The phone's keyboard types into a hidden textarea (`#kbd`) that always keeps one space so
  Backspace has something to delete; what changes there goes as `text` (characters, Hangul composition
  included) or Backspace/Enter/Tab keys. The host types `text` with `KEYEVENTF_UNICODE` on Windows; on
  X11 with keycodes lent to the characters' keysyms (see the Linux gotchas). A key row offers Esc, Tab, sticky Ctrl/Alt/Shift/Win (for the next
  key), arrows, Home/End, PgUp/PgDn, Del, F5. Without the person's own codec choice a phone asks for
  H.264 unless `MediaCapabilities` says it decodes AV1 power-efficiently. Not tried on a real phone;
  how a phone gets the loader file (no file:// on iPhone) is not settled.
- **Electron's main-process `clipboard` is promise-based since Electron 44**: `readText`, `writeText`,
  `read`, `write` (an array of `ClipboardItem`) and `has` return promises; `availableFormats`,
  `readBuffer`, `writeBuffer`, `readHTML` and `readRTF` are gone; formats without a MIME name go as
  `electron application/osclipboard;format="..."`; `text/uri-list` is the native file list. An
  unawaited `readText()` is a Promise whose `.length` is undefined: after the upgrade the host sent the
  client no text and `키 복사` never cleared the key, silently, until every call was awaited. The
  Linux helpers `clipboardFiles`/`setClipboardFiles` return promises now (callers await; the Win32
  ones return at once). The self-test now fails when text on the host's clipboard does not reach the
  client (it was an INFO line). `clearKeyClip` compares the clipboard's change count instead of
  reading the text back, so it also works in `before-quit`. Since a write completes later, input that
  arrives while text from the client is being written waits for that write (`injectInput` and
  `releaseInput` in `main.js`, at most 500 ms): the page sends the text of a paste right before the
  paste shortcut, and Ctrl+V could otherwise paste what was on the clipboard before (`--clip-check`
  checks the order).
- **Electron 45's npm package no longer fetches Electron's program at install time** (it would at
  first start through the package's own launcher, which the `.bat`/`.sh` launchers do not use: they
  start `dist/electron` directly). `setup.ps1`/`setup.sh` run `node node_modules/electron/install.js`
  after `npm install`. A host that runs while `npm install` replaces Electron makes it fail: stop the
  host first. The package needs Node >= 22.12 (the setup scripts check). `safeStorage` ciphertexts of
  33 and 45, sync and async calls, are interchangeable in both directions (checked with a throwaway
  profile and a made-up secret on Windows, where the key lives in the profile's Local State, which an
  immediate `app.exit()` never writes, so let such a test quit normally; and on Linux with a keyring,
  gnome-libsecret 'v11', and without one, 'v10'). The sync calls are deprecated in 45 and removed in 46:
  `loadConfig`/`saveConfig` use the async ones (`decryptStringAsync`, `encryptStringAsync`,
  `isAsyncEncryptionAvailable`), and `saveConfig` decrypts what it encrypted before it writes the file.
  When `decryptStringAsync` says `shouldReEncrypt`, a file that is fine otherwise is written again with
  the same key (not seen yet). Code pulled without running setup runs on the Electron installed before
  (33 on a PC set up earlier, also after the tray's "다시 시작"): there the synchronous calls are used
  (`ASYNC_SAFE_STORAGE`), since a key that cannot be read makes the host ask for a new one and every
  client would lose access; the host logs and shows that setup is still to be run (`updateNote`). What
  changed underneath (Chromium 130 -> 156, WebRTC branch 6723 -> 8078): the libaom AV1 encoder changes
  its speed setting by itself (`WebRTC-EncoderSpeed`, `dynamic_speed`), the frame cadence adapter
  (`refine`) and the receiver's timing were rewritten, and probing also happens outside ALR. The three
  field trials in `ENGINE_TRIALS` are still read under the same names. Benched on this PC (2026-11-13,
  native capture, one run each, so read the spread as noise): the default (sharp, AV1) about the same
  or better, scroll delay p50 direct 92-133 ms against 115 on 33, typing 66-80 against 79, quality equal
  or better (settles at 42.0 against 41.2 dB, settled after 344 against 693 ms); H.264 shows 53 fps on
  the direct link against 28. Smooth mode got worse: 33-37 fps shown against 47-59, the encoder at QP
  ~200 and 33-35 fps (its `motion` content hint has 156 encode the screen as camera content); on the
  direct link the bench could not even read its frames. `WebRTC-EncoderSpeed/dynamic_speed:false,
  av1_camera:normal/` raised the encoder to 42-52 fps but not the frames shown or the delay, and made
  no difference in the default mode: not adopted. **Smooth mode fixed (2026-11-18, 0.9.3):** the `detail`
  hint in both modes and `balanced` instead of `maintain-framerate` (`applyEncoding`). Benched on 45.3.4,
  the old setting acted out through `hostJs`, two runs each, fps shown / scroll delay p50 / scroll dB:
  direct old 36-39 / 93-106 ms / 23 dB, new 57-58 / 66 ms / 40 dB (sharp 47-54 / 80-93 ms); home old
  33-37 / 106-133 / 23, new 40-43 / 146 / 40 (sharp 49-51 / 106-109); narrow old 44 fps at 475 ms or
  failed (the picture down to 107x60), new 42-43 / 173 / 40 (sharp 41-55 / 93-173). On 45.3.1 the
  `detail` hint with `maintain-framerate` was mixed (on the direct link 11 of 24 typing changes never
  shown). So the new smooth mode is as sharp as the sharp mode and about as smooth, sometimes more,
  sometimes less (the runs spread widely); the old one was broken on every link.
- **Electron 45.3.4** (2026-11-18, was 45.3.1; 45.3.2 brought Chromium 156.0.8078.100 and fixes from upstream
  Chromium, V8, ANGLE, Dawn and Skia; 45.3.3 Node 24.22.3; 45.3.4 a leak fix). A new shell identity: installed
  apps take the new package through the shell swap. The self-test passed on it (78 checks with
  `--client-app-check`). koffi stays 2.16.3 (it belongs to the shell; nothing in 2.16.4 called for a change).
- **The GPU hand-over** (`capture: 'gpu'`, an experiment of 2026-11-18, off by default): `mc_next_gpu`
  copies each image on the graphics card into a new texture shared by an NT handle; the preload imports it
  with Electron's `sharedTexture.subtle.importSharedTexture` (the page's process loaded the DLL, so the
  handle is that process's, as Electron's design note allows) as a VideoFrame that stays on the graphics
  card; no read-back. A new texture per image (the encoder may read it later than anyone can know), the copy
  finished (event query) before it is handed over, the newest 8 imports kept alive, only for monitors on
  the first adapter, and any failure sends that loop back to reading back for good (an image whose import
  failed is lost). Benched on the direct link, two runs each: with AV1 (the default) worse: encode 25-29
  ms against 14, 32-38 fps encoded against 49-50, typing delay p50 80-123 ms against 66 (the CPU encoder
  needs the pixels anyway, and Chromium reads them back inside the encoder, more slowly). With H.264 on
  the graphics card better: typing p50 40 ms against 53 in both runs, scroll 53-66 against 53-79, host
  CPU 4.5% against 5.3%, but more gaps over 50 ms (72-76 against 27-56). So not the default; turning it
  on by itself for H.264 sessions would need runs between two machines, several monitors and other
  graphics cards first. No self-test covers it (the bench does: `--tries-file` with `{ "cfg": { "capture": "gpu" } }`).
  Looked into again the same day (after the keep-alive), H.264 on the graphics card, eight runs: scroll p50
  40-53 ms against 53-79, 60-61 fps shown against 55-60, encode 7-8 ms against 12-13, host CPU 3.8-4.4%
  against 5.1-5.6%. The gaps: the bench's `gaps` count a frame the probe did not read (some 20% of those
  shown) as a gap; counted per frame presented (`shownGap`), the GPU runs still have about twice the gaps of
  50-67 ms (32-64 against 16-27 in 20 s of scrolling; none over 100 ms, the read-back runs up to 200 ms).
  Where: not at the capture (gaps at the encoder's input, `--capture-probe`: 0 against 1), and nearly all
  of them frames that were received on time and drawn late (`sure50rx`: 1-5 of 33-39 received that far
  apart), with the client decoding in hardware or in software alike; the host's own screen is not
  disturbed (`--native-probe`: on screen 18.9 against 18.2 ms after it is drawn, 74.2 against 74.5 fps). So
  the gaps come from the client's drawing on the same graphics card as the host's GPU work - which a client
  on another PC does not share - but that is not shown yet: the two-machine run is still the step before a default.
  Shown the same day: the client on the build server (Electron 45.3.1 under Xvfb, drawn in software), the
  host on this PC, H.264 on the graphics card, two runs each, read-back -> GPU: scroll p50 52-62 -> 40-42 ms,
  typing p50 40-44 -> 33-36 ms (max 153-399 -> 68-73), 50-56 -> 60-61 fps shown, gaps over 50 ms per frame
  presented 37-39 -> 32-34, over 100 ms 0-3 -> 0, received that far apart 20-24 -> 6-7, host CPU 5.1-5.2% ->
  3.8-3.9%. Better on every figure once the client is another PC. Still open before it could be the default
  for H.264 sessions: other graphics cards (only NVIDIA's encoder was tried) and several monitors with it on
  (the self-test has no way to turn it on yet).
- **The client's side of the delay** (2026-11-18): the receiver already shows each frame as soon as it is
  decoded (`ForceSendPlayoutDelay` 0/0 in `ENGINE_TRIALS`, and `jitterBufferTarget`/`playoutDelayHint` 0
  in the page); received to screen is about 14 ms on this PC (decode about 1 ms). Keeping the client page
  drawing every frame (a `requestAnimationFrame` loop touching a 2 px element, so the compositor never
  sleeps) was worse, not better: typing 79 against 66 ms, scroll 93 against 67, more gaps. Not adopted.
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
  `--localtest` is view-only. From 0.9.0 a client app connecting to its own PC's host is refused (`self`,
  see "Connections that come back on themselves"); a browser is not, and the input guard is its net.

## The installed app, releases and updates

Besides running from a source folder (the launchers above), the program ships as an installed app for
Windows and Linux: one program with two faces (`--host`, `--client`). Read `app/core.js`'s header first.

- **Two layers.** The *shell* (`app/`: Electron as npm installed it, `boot.js`, `updater.js`, `guard.js`,
  koffi) changes rarely and has a generation number (`base` in `app/package.json`). The *code* it runs
  (`host/`, `client/`, `my-remote-client.html`: about 0.5 MB) is a *bundle*: the one built into the
  package (`resources/app/bundle`), or a newer one the updater put into the user's data folder
  (`%LOCALAPPDATA%\my-remote\app\versions\<version>`, `~/.local/share/my-remote/app/...`). `boot.js`
  picks one at every start (`core.choose`) and `require`s its `host/main.js` or `client/main.js`, which
  are the same files a source folder runs. They see the shell as `global.__mrApp` (`version`, `ok()`,
  `update`); from a source folder there is none, and updates come by git.
- **Trust.** A bundle is described by a manifest (`latest.json`: version, `needsBase`, `minimum`,
  `critical`, notes, the SHA-256 of every file) signed with Ed25519. The public keys are in
  `app/update-config.json`, part of the shell. A manifest that does not verify, a bundle that is not the
  manifest's, a file the manifest does not list, a file name that could leave the folder: never
  installed. Installed files are checked against their signed manifest at every start. So the feed
  (`feed` in `update-config.json`: any https folder with `latest.json`, `latest.json.sig` and the bundle
  file) need not be trusted. Never an older version than the one running. The feed is this repository's
  own GitHub releases (`https://github.com/GiUKim/my-remote/releases/latest/download/`; the README's
  download buttons point there too), which is why the repository is public: a private repository's
  releases cannot be fetched without logging in. Decided 2026-11-14, after checking the history (only the
  noreply address as author; no address, account name, path or key-shaped string in any commit). Packages
  0.3.0-0.4.1 point at a separate `GiUKim/my-remote-releases` that was never created: an app installed
  from one of them never sees an update and must be installed once more from a 0.4.2 or later package.
- **The updater lives in the shell**, not in the bundle: a bad release cannot take away the means to
  replace it. It looks at the feed 20 s after the start and every 6 h. An ordinary update is only
  announced (the host window's card, `showUpdate` in `host.js`; the client app asks in a dialog) and
  installed when the person says so. "업데이트 확인" (the user's wish, 2026-11-15: both apps show their
  version and have the button; an update found is asked about, "지금 업데이트할까요?") looks at once: next
  to the version in the host window (`checkUpdate`/`updateChecked` in the page, `askUpdate` in main, also
  the tray's item; shown only in the installed app) and next to "My Remote vX" in the client app's list
  (`home:checkUpdate`, `offerUpdate`). An update put off before is asked about again then, and the client
  app's question is asked once although a check also tells its listeners. Both windows' titles carry the
  version. Also on the start screen (the user's wish, 2026-11-16: "여기 화면에 업데이트 확인을 넣어서 한번에";
  `start:checkUpdate`, the same `checkNow` as the list; the question goes over whichever of the two is
  open): one installed version serves both faces, so one update is both. Its host line says when the
  running host is older than the app ("원격 접속이 없을 때 새 버전으로 다시 시작합니다", from `running.json`,
  asked again every 5 s), and a client app that follows the host's update comes back as the start screen
  when only that was open. Looked at in pictures (a stand-in for the updater, test mode). A *required* one (`critical`, or the running version is below the
  release's `minimum`) is installed without asking and the app restarted when the code says the moment
  fits (`setCanRestart`: the host when no session is on, 30 min at most; the client app after a notice).
  `release/policy.json` carries `minimum` forward, so apps that missed a critical release are still
  forced by later ordinary ones. A release with a higher `needsBase` than the shell is only announced
  (`kind: 'package'`): a new package must be installed by hand. Since 0.7.0 the code replaces the shell
  itself with a newer package (see "The shell replaced by a newer package" below).
- **Going back.** A version started for the first time is on trial until the code calls `ok()` (the
  host: its page loaded and stayed 8 s; the client app: 4 s after its window loaded). It is marked bad
  and the version before (at last the built-in one) runs again when it throws while starting, does not
  say `ok()` in 2 min, or ends without a word twice (`guard.js`, a small process of its own, starts it
  again; `boot.js` counts the starts in `state.json`). A bad version is never offered again. A remote
  host that came back broken from an update could not be reached to be repaired. Starts beside a trial
  that is still running (another click on the shortcut) do not count.
- **Things that bit** (found by `release/test-app.js`, which runs the shell in real Electron against a
  local feed, with made-up versions that behave well, throw, die or stay silent):
  - The guard runs Electron as plain Node (`ELECTRON_RUN_AS_NODE=1`) and handed that on to the program
    it restarted, which then ran as Node too and did nothing. It clears the variable.
  - `win.loadFile('host.html')` is relative to the app's folder, which in the installed app is the
    shell's: the host page was not found. It is `path.join(__dirname, 'host.html')` now. Likewise the
    client app as a second program (`--localtest` on Linux, `--client-app-check`): from a source folder
    Electron is given the `client` folder, the installed app is told `--client`.
  - koffi belongs to the shell; the bundle finds it through `NODE_PATH` (set in `boot.js`). The page's
    process inherits the variable but does NOT search it (measured with Electron 45: `require('koffi')`
    fails in a preload whose folder has no node_modules above it): code an update put into the data folder
    never loaded the native capturer, and every updated host ran on the engine's capturer, with its
    pointer in the picture, from 0.3.x until 0.8.1 (found 2026-11-17 on the user's PC; the built-in code
    finds the shell's modules by its folder, which was all the packaged test ran). `host/preload.js` reads
    the paths from the variable again (`Module._initPaths()`, as `boot.js` does), and `test-app.js
    --packaged` now runs the self-test a second time through the same code installed as an update
    (version 9.9.9 in the test's data folder), which fails on the check "the native capturer loads in
    the host page (no module missing)" without that.
  - `--selftest`, `--localtest`, `--bench`, `--show-key` and `--loader=` are errands: no updater, and no
    start counted against a trial.
- **Names.** The two faces keep the profile names they always had (`my-remote-host`: its config and
  the key, encrypted under that name on Linux and macOS; `my-remote-client`), set in `boot.js` before
  anything else, so an app installed over a source folder's use keeps the key.
- **Packages** (`release/package.js`) are made on the platform they are for, from
  `host/node_modules/electron/dist` (nothing else is downloaded): a folder to unpack and run
  (`MyRemote.exe`, `./my-remote.sh`), zipped as `MyRemote-Windows-x64.zip` / `MyRemote-Linux-x64.tar.gz` holding a folder `MyRemote` (on Windows `MyRemote.exe`'s version resource is rewritten in place to say MyRemote instead of "Electron" by "GitHub, Inc.", which the firewall's prompt, Task Manager and a notification without a shortcut showed: `brandExe` in `release/package.js`, same-length UTF-16 values, no outside tool (installing one was refused by the permission check); the exe's icon is still Electron's, the shortcuts carry ours; `test-app.js --packaged` checks the names Windows reads): no version in the names, so the README's download buttons (`.../releases/latest/download/<name>`) always fetch the newest and a self-updating folder is not named after an old version. No installer, no code signing: Windows SmartScreen warns
  at the first start. macOS is not built (an unsigned app does not run there). Every file in a package
  is dated when it was made (Electron's own files come dated 1980-01-01 and Windows keeps a copied file's
  date: the unpacked folder showed 1980, the user saw it on 2026-11-16; `test-app.js --packaged` checks).
- **One app, a start screen with two big buttons** (the user's wish, 2026-11-16: "호스트와 클라이언트를
  앱 하나에 통일, 처음 시작할 때 큰 버튼 2개"; reported first: the client app had updated to 0.5.2 and the
  host, still running in the tray, stayed 0.5.1). The faces stay two programs with two profiles (the
  host's key and the client's list are encrypted under their own profile: one process could not read
  both), but:
  - `client/launcher.html` (bridge `launcher-preload.js` -> `window.mrStart`) is the start screen: "이 PC
    공유" (host) and "다른 PC에 접속" (client), the host's state ("켜져 있음", from `running.json` that the
    host keeps in its profile while it runs) and, where there is no entry yet, "바로가기 만들기". It runs as
    the client app's first window (`--client --launcher`): the client choice turns it into the list, the
    host choice starts the host as a program of its own (`--host`; Linux through `my-remote.sh`; a
    second start only brings a running host forward) and the client app ends with it.
  - One entry, "MyRemote" (Windows `Start menu\Programs\MyRemote\MyRemote.lnk`, Linux
    `my-remote.desktop`), runs `--client --launcher`. The shell makes it (`makeShortcuts`, `--shortcuts`)
    and, started without `--host`/`--client`, opens the start screen when the code has one (else the old
    dialog). Apps installed from 0.3.0-0.5.x packages keep their shell: the code replaces their two
    shortcuts with the entry at the start of either face (`host/appsync.js` `unifyShortcuts`; only the
    app's own: a source folder's `setup.sh` makes Linux entries of the same names, which stay). Their
    exe started without arguments still shows the old dialog until a new package is installed.
  - Seen 2026-11-16 on the person's PC (unpacked from the 0.4.2 package, code 0.6.0 by update; they
    reported "앱이 하나가 아니라 클라이언트 전용 앱, 호스트 전용 앱으로 나뉩니다"): the exe started directly
    showed that old dialog, and its box "시작 메뉴에 호스트와 클라이언트 바로가기 만들기" (ticked by default)
    made `MyRemote-Host`/`MyRemote-Client` again next to the entry while the host ran, so the face it
    started only brought the host forward and nothing removed them. Each face now puts the entry back
    alone also when another start reaches it (`oneEntry` on `second-instance`). The dialog stays until the
    folder holds a new package (the README says so). A shortcut named `Electron` to the same exe (no
    arguments, so the old dialog) was in the Start menu's top folder too, from 2026-11-14: not one the app
    makes; probably Windows' when the exe was pinned to Start (the 0.4.2 exe still described itself as
    Electron). Left alone: the code does not remove shortcuts it did not make.
  - **One id on Windows** (`appsync.APP_ID`, the entry's `kr.myremote.client`). The shell gives each face
    its own (`kr.myremote.host`/`.client`). Since the host's shortcut went in 0.6.0, the host's windows sat
    apart from the client app's on the taskbar, and its "원격 접속이 시작되었습니다" notice had no entry
    (Windows shows a desktop program's notifications only for an id a Start-menu shortcut carries).
    Both faces set the entry's id before any window (`[host] app id` in its output; `test-app.js
    --packaged` checks it, `test-appsync.js` that the code's and the shell's entries carry it). Whether
    the notice really failed to show in 0.6.0 was not tried.
  - "나가기" in both faces (the user's wish, 2026-11-16): the host window's (`start-screen`, `openStartScreen`
    in `host/main.js`) starts the client app with `--client --launcher` (a running one shows the start
    screen on that second start) and hides the host window; the host keeps running, since quitting it
    would end remote access (the tray quits it), and the start screen says it runs. Never in the isolated
    runs (the client app would start on the person's own profile): the self-test checks the button is
    hidden there and opens nothing. The list's (`home:exit`) shows the start screen and then closes the
    list; the PCs' windows stay. Checked in test mode: list -> 나가기 -> start screen -> 다른 PC에 접속 -> list.
  - Updates followed: `appsync.watch` reads the shell's `state.json` every 30 s; when `current` is newer
    than what runs and has come up (its trial over, never a bad one), the host restarts into it once no
    session is on, and the client app restarts at once with no PC window open, else asks. A restart keeps
    the face (`--host`): a remote host never waits on the start screen.
  `release/test-appsync.js` checks the watch and the entry (plain Node); `test-app.js` the shell's start
  screen and entry; the screen itself was looked at in pictures and both buttons pressed in a harness
  (test mode, no host started). Not tried yet: the real host started from the screen, the update
  followed by a running host in real use.
- **The shell replaced by a newer package** (`host/shellswap.js`, 0.7.0; the user's go-ahead 2026-11-16,
  after an app unpacked from the 0.4.2 package kept showing its old first-start dialog: without this every
  PC needs its package unpacked again by hand for a new Electron or shell, and a PC reached only through
  this app cannot be done at all, since quitting its host ends the connection).
  - What a shell is: `release/package.js` writes `resources/app/shell.json` (Electron, koffi, a hash of
    the shell's own files with plain line ends and of the config and package.json without the version,
    `base`, `rev` = `SHELL_REV`, raised by hand when package.js changes a package in another way). Its
    identity decides: a newer release whose package holds another shell replaces it; the same shell in a
    newer release costs no download. Shells from before 0.7.0 have no shell.json: replaced once.
  - What the newest packages are: `packages.json` in the feed, signed with the release key (`kind:
    'packages'`, so a manifest cannot pass for it nor it for a manifest), made by `release/build.js
    --sign-packages=<folder>` from the records package.js writes (`<name>.package.json`: platform, file,
    SHA-256, size, version, shell). The public keys and feed come from the shell's update-config.json
    (`appsync.shellParts().conf`).
  - Staged next to the app folder (`<folder>.next`, the same disk; the archive into `<data>/shell/<v>/`,
    checked against the list's size and SHA-256 while it comes, unpacked with Windows' own tar / tar -xz,
    its shell.json checked again): `<data>/shell/next.json`. One stager (`stage.lock`). Not when the
    folder above the app cannot be written (Program Files) or the disk lacks 3x the archive. The host
    looks 3 min after the start and every 6 h, never while a session is on (a session starting aborts the
    download); the client app only when no host runs and no PC window is open.
  - Swapped by a script written for that one swap (`<data>/shell/swap.ps1` with a BOM for non-ASCII
    paths, or `swap.sh`): the host starts it and quits when no session is on, the client app does not run
    (its `running.json`) and no swap was held back in the last 6 h; the client app at `will-quit` when no
    host runs (nothing is started again then: the new program runs once as Node and must load the shell's
    core.js). The script waits up to 2 min for every process of the folder to end, renames the folder to
    `.old` and `.next` into its place, starts the host (`--host`), and waits up to 3 min for `up.json`
    with the new identity (`shellswap.confirm`, at the moment the host also calls `APP.ok()`). Not up: the
    new folder becomes `.failed`, `.old` comes back and is started, `bad-<version>` keeps that release from
    being staged again. App still running or a folder that cannot be moved: nothing swapped, the staged
    shell stays, `held` keeps the app from trying again for 6 h. A later start removes a leftover `.old`,
    and `.failed` after a week (`sweep`).
  - Things that bit (found by `release/test-shellswap.js` on fake app folders whose program is a copy of
    Node): a PowerShell that Node starts `detached` gets no console and ends at once without running its
    script, and one started attached sits in the job object libuv puts children in, which ends them with
    the parent: so a short-lived PowerShell `Start-Process`es the script's (a hidden window of its own;
    libuv's job lets grandchildren go) and `begin` waits for it (`spawnSync`, about half a second). A
    PowerShell function's single result comes back unrolled, and a CIM object has no `.Count`: the wait
    for running processes saw none and swapped under a running program. Windows lets a folder be renamed
    while a program in it runs, so that wait is the only guard. Windows refuses to delete any hard link
    of a running image (a test artifact: give old and new programs different files). PowerShell 5.1 writes
    UTF-8 with a BOM (readJson strips it). Twice a new module that was required but not yet in git left
    the packaged test's app unable to start, with an error box on the PC: `build.js --allow-dirty` now
    takes untracked files too.
  - `--localtest --shell-swap`: the swap in a local trial (throwaway profile, local relay; started again
    the same way); `shellTiming` in the shell's config shortens the waits for a test package.
  - Hardened before the first release (a remote host must never quit for a swap that will not bring it
    back): the script runs as a command (`Get-Content | Invoke-Expression`), not as a script file, which an
    execution policy (a company PC's) could forbid; it writes `swap.started` first and the app quits only
    once it sees it (`begin` resolves; 20 s, else the app keeps running and the swap is dropped); cmdlets
    instead of .NET calls (constrained language); `Move-Item` never onto a folder that is there.
  - "Up" is the moment the host calls `APP.ok()`: its page finished loading 8 s ago. A page that is missing
    gives an error page that also finishes loading (a test package without host.html counted as up); a
    shell whose program does not start, or whose code throws, never gets there.
  - Verified 2026-11-16: `test-shellswap.js` (11 checks, the real PowerShell and sh scripts, a folder name
    with Korean, a space and an apostrophe) on Windows 10 and Ubuntu 24.04. End to end with real packages
    signed by a test key and a feed on 127.0.0.1, the host in `--localtest --shell-swap`: in the test VM
    (Windows 10) a host on a shell without shell.json (0.7.0) fetched 0.7.1, quit, was swapped and came
    back on the new shell, up 10 s later, the old folder gone; with the final code a 0.7.1 host fetched a
    0.7.2 whose MyRemote.exe was no program, swapped, waited 3 min, put it aside as `.failed`, came back on
    0.7.1 and recorded `bad-0.7.2`. On the Linux PC (Ubuntu 24.04, its own Xvfb display and data root) the
    same first swap through `my-remote.sh`: swapped 2 s after the host quit, up 34 s later. The first real
    one, through the published 0.7.0 and the real feed, on the person's PC (2026-11-16 16:12): the host on
    the 0.6.0 package's shell began the swap, quit, and was swapped 5 s later; the new shell's host said it
    was up 10 s after that. The first new Electron through it (0.9.3, 45.3.1 -> 45.3.4, 2026-11-18): the
    Linux PC's installed host (0.8.1, reached only remotely) fetched the 117 MB package at its 6-hour look,
    swapped while idle and came back as 0.9.3 3 s later (its host.log); this Windows PC's app staged its
    package and waits, since the client app runs there all the time (as designed: no swap while it runs).
    Not verified: the client app's swap at quit with the real app, a company PC's
    policies (constrained language), a virus scanner holding files, a PC with the app in Program Files.
- **Plain names.** No file or folder the package holds or the app makes has a space or anything but
  ASCII in its name (the user's rule, 2026-11-14: a path with Korean or a space fails on some systems
  and with some tools): `MyRemote.exe`, `README.txt` (Korean inside, with a byte order mark on
  Windows), Start menu `MyRemote\MyRemote.lnk` (0.3.0-0.5.x: `MyRemote-Host.lnk`, `MyRemote-Client.lnk`), the profile of a start
  that only asks or makes shortcuts at `<data folder>/../launcher` (Electron's default would be a
  folder named after the product). 0.3.0-0.4.0 had `My Remote.exe`, a Korean read-me name, Korean
  shortcut names and `%APPDATA%\My Remote`; making the new shortcuts removes the old ones.
  `release/test-app.js --packaged` walks the package and fails on any other name. Display texts
  (window titles, the shortcuts' descriptions, Linux menu entries' `Name=`) are not names of files and
  stay as they are. Where the person unpacks the package, and their account's name, are theirs: the
  app must keep working there (the self-test passed from a folder with Korean in its path).
- **Making a release**: README "릴리스 만들기". `release/build.js` takes the files from the commit that is
  checked out (`git show HEAD:...`: the same bundle on every machine, nothing uncommitted), signs with
  the key outside the repository and checks the result the way an app will.

Verified (2026-11-13): `release/test-update.js` (40 checks, plain Node) and `release/test-app.js
--packaged` (12 checks) on Windows 10 and on Ubuntu 22.04 under Xvfb: the made-up versions as listed
above, the real code as a package passing the self-test through the shell (Windows 44 checks with the
native capturer; Linux 32 with the X11 one), the two shortcuts into a test folder. Not verified: a real
update from a real feed (there is none yet), an update while a real session is connected, the dialog
that asks host or client and the shortcuts in the real Start menu, the client app's update dialogs,
`my-remote.sh` from an app menu entry, Ubuntu 24.04 as a package, anything on macOS.

## CI, gates and checks (what a change must pass)

Set up 2026-11-15 at the user's request ("기능을 넣을 때 통과해야 하는 벤치마크, 버그를 잡는 CI/CD"):

- **`.github/workflows/ci.yml`** on every push to `main`, every pull request, by hand and weekly:
  `checks` (`release/ci-checks.js`, `test-update.js`, `test-hosts.js`, `test-devices.js`, `test-qr.js`, `test-totp.js`, `test-pagecheck.js`, `test-appsync.js`, `test-shellswap.js` with sh, `test-watchdog.js`, `test-cycle.js`, `test-keylock.js`, `test-i18n.js`), `native` (`release/ci-native.js`:
  every committed binary rebuilt from `native/` with Ubuntu 22.04's mingw-w64 and compared byte for byte),
  `Windows` (`test-assist.js`, `test-shellswap.js` with PowerShell, `test-watchdog.js`, the self-test with `--client-app-check` (from 2026-11-16: device tokens, and safeStorage's key that only a normal quit writes, are Windows matters), `test-app.js --packaged`), `Linux X11` (the self-test with
  `--input-check --clip-check --client-app-check` under Xvfb, `test-app.js --packaged`) and the `performance
  gate` on both (`release/bench-gate.js --profile=ci`). `codeql.yml` scans the JavaScript; `dependabot.yml`
  proposes Electron/koffi/action updates as pull requests that CI then tests.
- **The release gate:** `release/build.js` refuses to build from a commit whose CI has not passed on GitHub
  (every check run finished successfully, each CI job among them; asked anonymously, the repository is
  public). `--skip-ci` overrides it and says so; `--allow-dirty` try-out builds skip it.
- **Locally:** `git config core.hooksPath .githooks` once per clone turns on the pre-commit hook (the
  static checks, the leak scan on what is staged). Patterns of your own that must never be committed go
  into `.git/info/private-patterns` (one regular expression per line, untracked); in CI the same list can
  be given as the secret `PRIVATE_PATTERNS`. The leak scan prints where, never what.
- **When adding a feature:** add its checks (a self-test check, or a `release/test-*.js` for logic that
  runs without Electron), run `release/ci-checks.js`, the self-test, and on a development PC
  `release/bench-gate.js --profile=dev` (limits in `release/bench-thresholds.json`: raise them only with
  a measured reason). A change to `native/` needs `native/build.js` (from PowerShell) and the new binary
  and record in the same commit; `ci-native.js` fails otherwise.
- Not automated: anything needing a second real PC, a real lock screen (the Windows test VM, see the
  `my-remote-test-vm` memory, does that by hand), several monitors, real phones, macOS.
- Found while setting it up: GNU ld puts the output path into a DLL (`-o out/x.dll` vs `-o x.dll` give
  different bytes; line ends do not matter), so the reproducibility check builds into `out/` exactly as
  `native/build.js` does; and `host/bench-run.js` only knew `electron.exe` (now Linux too).
- **Reading a failed run without admin rights:** a job's log can be downloaded only by the repository's
  admins, so every test step runs through `release/ci-run.js`, which turns each `FAIL` line into a GitHub
  annotation (`::error::`); `GET /repos/<owner>/<repo>/check-runs/<job id>/annotations` reads them
  anonymously. Asking the runs API for a commit needs the full hash (`head_sha=` ignores a short one).
- The first run (2026-11-15): `checks`, `native` (byte for byte on GitHub's Ubuntu too) and `Linux X11`
  passed on GitHub's runners; on `windows-2022` the assist test and the self-test passed and the packaged
  app test failed; the second run's annotations named it: the self-test's "sends only as many pixels as
  are shown" (also run inside the packaged test). Its expectation was wrong, not the host: the host
  scales by steps (1, 1.25, 1.5, ...) and never below the shown size, so a monitor shown at 828 of 1024
  (factor 1.24, the runner's 1024x768 screen) is rightly sent whole; the check wanted "fewer" whenever the
  window was smaller, which this PC's 1920-wide monitors always made true. It now expects the step.
  The third run passed everything but the Linux performance gate: the bench had never run on Linux
  (`screen.dipToScreenRect` is Windows only, and the peer took the passed-on `--no-sandbox` for its config
  file). Fixed; on the Linux PC (Xvfb) the bench then gave 59.8 fps, scroll p50 32.5 ms, typing p50
  32.7 ms. The Windows gate passed on GitHub's runner from its first run. Dependabot opened PRs for checkout v7,
  setup-node v7, CodeQL v4 (taken into the workflows) and koffi 3 (a major version under input, capture
  and the clipboard: merge only when CI passes on it, after reading its changes).
- **koffi 3** (Dependabot's PR #4, 2.16.3 -> 3.3.7, looked at 2026-11-16). Both self-tests passed on it,
  so the code runs on it. The packaged-app test failed on both systems: koffi 3 ships its binary in a
  package per platform (`@koromix/koffi-win32-x64`, ..., optional dependencies), and `release/package.js`
  copies it from `koffi/build/koffi/<platform>_<arch>`, koffi 2's place. And koffi belongs to the shell:
  an installed app keeps the koffi its package brought, so the code must work on koffi 2 for as long as
  such apps are in use, with nothing in CI running it there once the source folder moved on. koffi 2 is
  still maintained (2.16.3 of July 2026 came after 3.0.0 of May). The user agreed (2026-11-16): the PR was
  closed with `@dependabot ignore this major version` (Dependabot answered it will not propose 3.x again;
  2.x updates still come). koffi 3 comes back once the shell swap (above) has moved every app onto a new
  package, together with package.js copying `@koromix/koffi-<platform>-<arch>`.
- **A flake on GitHub's Linux runner**: "a window the client app reports minimized is not sent ..." and
  "1:1 mode receives the full resolution" failed once (2026-11-16, commit 7f9fd6c) and passed when the
  job ran again (`gh run rerun --failed`). Not seen on the Linux PCs. Likewise "sends only as many pixels as are
  shown" (2026-11-20, commit a3e6b74: received 1920x1080 for 1280 expected within its 15 s; passed on the re-run).
  All three wait for the host to change what it sends: the runner is slow then, not the code wrong, as far as
  seen. `gh` is not on the Windows PC's PATH: it is under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_*`.

## Commands

Run from `host/` with Electron's env var cleared.

| Command | What it does |
|---|---|
| `npm run selftest` | Local end-to-end test, prints `[selftest] PASS/FAIL` lines, exits 0 or 1 |
| `electron . --selftest --shell-check` | Same, plus the client app's one-click layout on the real screens. Fullscreen windows cover every monitor for a few seconds, so ask the user first |
| `electron . --selftest --dump-phone=<file.png>` | Pictures of the phone layout: client windows of a phone's size (915x412 and 412x915, `#touch`) with the key row open, written as `<file>-landscape.png` and `<file>-portrait.png`. About 30 s, opens no window |
| `electron . --selftest --dump-panel=<file.png>` | Quick look at the arrangement panel: connects, draws the panel as if the client had two screens, writes pictures (`<file>.png`, `-ctrl-drag`, `-swap-drag`, `-together`) and exits. About 20 s, opens no window |
| `electron . --selftest --dump-lang=<folder>` | The whole self-test, and its language check writes pictures of the toolbar, the shortcuts and diagnostics dialogs and the host window in every language into `<folder>` (`page-bar-de.png`, `host-ru.png`, ...), for a look at what a longer language does to the layout |
| `node native/build.js user@host[:folder]` | Builds the native modules on a Linux machine with mingw-w64: `host/bin/capture.dll` + `capture.dll.json` (commit them with the source), `tools/native/capprobe.dll`. After a change in `native/` |
| `npm run bench -- --native-probe --capture-probe ...` | Bench with a native observer of the same display: reports when the picture was on the host's own screen and how long after that the capturer in use had it. Needs `tools/native/capprobe.dll` |
| `electron . --selftest --dragout-check` | Only real drags out of a real Explorer window this check opens on a temp folder (`dragcheck.js`): A straight on the host, B and C through a client window running the real page in the client app's shell (held outside; let go at once, before Explorer started its drag). INJECTS INPUT for about half a minute, so only with the user's agreement; skipped when the clipboard holds more than text, which is put back |
| `electron . --selftest --frame-check` | Only presses from the client onto the host window's own frame (`framecheck.js`, Windows): its minimize button and a title-bar drag through the real input path, then a press around it that the input guard must end within about a second. Shows the host window and INJECTS INPUT onto it for about fifteen seconds: the test VM, or with the user's agreement |
| `electron . --selftest --dropin-check` | Only real drags IN (`dragcheck.js runIn`): from an Explorer window on the second display onto a client window's picture of the first, dropped by the host into another Explorer window (empty space; a folder icon; a whole folder). Needs two displays. INJECTS INPUT for about half a minute: only with the user's agreement |
| `electron . --selftest --soak=<minutes>` | A long session instead of the rest of the self-test, to find what grows: the view-only client keeps switching monitors and going to the overview, and the host drops the session every minute so the client reconnects. Every 20 s (15, 35 and 55 s after a reconnect), after collecting garbage in every process (the pages through the debugger protocol, the main process through V8's `gc()`): memory of every process (the host page and the client page separately), the script heaps of both pages and of the main process, and on Windows the kernel/GDI/USER handles of the main process and the host page. Fails when what each session leaves behind in the main process and both pages together (median of the last third of the samples minus the first, per reconnect, after the first 3 minutes) passes 2 MB. `--soak-heap=<folder>` writes two heap snapshots of the main process (they hold the test's throwaway key; delete them), `--soak-no-audio` leaves the system sound out after the first session. 2026-11-13, before that day's fixes: about +1.2 MB and +8 to +10 kernel handles (sections and mutexes) per reconnect in the main process. Traced with a bare Electron script to the engine's desktop capture started for the sound of every session (2 sections and 2 mutexes per start; `desktopCapturer.getSources` and peer connections leave nothing) and fixed (the sound is taken over, the source list cached). After: 10 min, 9 reconnects, main process 85-86 MB and its handles flat, both pages flat; the host page still gained about 2 handles per monitor per session, traced to destroyed D3D devices and fixed in `capture.dll` (see "Native capture") |
| `electron . --selftest --clip-check` | Same, plus putting two files on this PC's clipboard and reading them back, files copied on the host announced and fetched, files the client sent not announced back, and (Windows) text from the client on the clipboard before the next input. Only runs when the clipboard holds nothing or plain text, which is put back |
| `electron . --selftest --cursor-check` | Same, plus a real-screen check that hiding the host cursor removes it from the video. The PC's cursor vanishes for about 20 seconds, so ask the user first. Windows only |
| `electron . --selftest --input-check` | Linux (X11) only (`inputcheck.js`): the pointer read back after an XTest move, whether the engine's video has the pointer in it (INFO), all 133 keys of the table, five buttons and the wheel into a test window, window-or-desktop under the pointer, text and a file dragged out of a second program it starts, and the client app's drop placement. INJECTS INPUT: on a virtual display only, or with the user's agreement |
| `electron . --selftest --client-app-check` | Same, plus at the end the client app (`client/main.js`, a process of its own, with a profile of its own) on a loader that talks to the test's relay only, and then once more through its list of PCs (`--list`: the test's key added and opened as a PC, the loader given the key by the app); passes when its measurements say it shows the host's picture. Opens a window for about 20 s |
| `xvfb-run -a -s "-screen 0 1920x1080x24" <electron> . --selftest --input-check --clip-check --client-app-check` | How the Linux side was verified on a server (Ubuntu 22.04, Xvfb). Add `--no-sandbox` where Chromium's sandbox cannot run (see Gotchas) |
| `./setup.sh [--skip-selftest] [--hold]`, `./start-host.sh`, `./start-client.sh`, `./local-test.sh` | Linux counterparts of `setup.ps1` and the `.bat` files (shared code in `host/linux-launch.sh`); the launchers set the folder up on their first start (`ensure_setup`). Extra arguments go to Electron, e.g. `./start-host.sh --selftest`. `MY_REMOTE_NODE_DIST` points the Node download elsewhere (tests) |
| `npm run bench -- --net=direct,home,narrow,wifi --try=old,base` | Measures delay and smoothness on this PC for the given link conditions and settings, prints a table (see "Performance"). `--picture-test=quality` measures picture quality instead (a window opening, a window being dragged, scrolling); `--snapshot` saves what the client showed next to what was drawn. About 45 s per run. Shows a test picture on one display and a small window on another for that time; they never take focus and no input is injected, but tell the user before a long series |
| `npm run bench -- --remote=user@host --net=direct --try=base` | The same bench with the client page on another machine, reached over ssh: a real second machine and a real network instead of one PC. That machine needs `~/my-remote-dev/electron/` (an unpacked Electron release for its platform) and `xvfb-run`; signaling goes through an ssh tunnel, only the WebRTC traffic crosses the network directly. Add `--capture-probe` to split the delay into its parts. This sends the picture of one of this PC's displays to that machine, so the user must have agreed |
| `node release/install-local.js [--dry]` | Puts the release in `dist/release` into this PC's installed app as its updater would (the signature checked, then `core.installVersion` and `activate`): the app runs it from its next start, on trial. For a PC whose app cannot reach a feed, and for trying a release before it is published. It changes the person's installed app, so only when they asked for that version there |
| `node release/ci-checks.js [--staged]` | The static checks CI and the pre-commit hook run: syntax of every JS file and of the built pages' scripts, JSON, `my-remote-client.html` up to date, ASCII names, native records, the leak scan. Seconds, no Electron |
| `node release/ci-native.js` | Rebuilds the committed binaries from `native/` (needs `x86_64-w64-mingw32-g++`: CI's Ubuntu 22.04, or the build server) and compares them byte for byte with `host/bin` |
| `node release/bench-gate.js --profile=dev\|ci` | Runs the bench and fails when a figure leaves `release/bench-thresholds.json` (dev: a development PC; ci: CI machines). About a minute; shows the bench's test picture meanwhile |
| `node release/test-assist.js` | The host's side of the Windows assist service (`host/assist.js`) against a fake service and helper on test pipes: protocol and version, the pipe-server session checks, input routing per state and its encoding, pictures in pieces, Ctrl+Alt+Del, reconnecting, installing refused during a remote session, the first-start offer. Windows only (skips elsewhere); no input reaches the PC (the sink is recorded, never installed) and nothing runs elevated (`T.elevate`). A few seconds |
| `host\bin\winassist.exe install`, `uninstall`, `status`, `grab <file.bmp>`, `grabmon <prefix>` | The assist service itself: install/uninstall need an elevated prompt (the host window's card does this through UAC). `grab` writes the current input desktop to a BMP (a secure one only when run as LocalSystem); `grabmon` every monitor as the helper sends them (`<prefix>-<n>.bmp`, rectangles printed). Both are pictures of the person's screen: delete them after looking |
| `node release/test-hosts.js` | The client app's list of PCs (`client/hosts.js`) in plain Node with a stand-in for the system's encryption: keys never as text in the file, duplicates, renaming, a new key, removal, a broken file kept, device tokens (kept, the key let go only for the token that worked, a key given again replaces the token). A second |
| `node release/test-i18n.js` | The translations (every text of the code in every language, no Korean left, holes, tags, plural forms, French spacing, a quoted button name read as that button), the translator, the PC's language setting. Seconds, no Electron |
| `node release/i18n-sources.js [surface] [--missing]` | The Korean texts each part of the app shows, read from the code; `--missing` lists the ones a catalog lacks (host, page, client, loader) |
| `node release/test-devices.js` | The host's device tokens (`host/devices.js`) and access log (`host/accesslog.js`) in plain Node: tokens never as text, the same app pairing again, blocking, removal, the limit, a file that cannot be read never written over, a broken file kept; log entries with known fields only, kept 90 days and under 2 MB. A second |
| `node release/test-pagecheck.js` | The client app's check of a host's page (`client/pagecheck.js`): signed by a release key or not, a changed statement, another page, a manifest that is no statement; and that `release/build.js` signs the page a host builds for the default relay (a real build with a test key). Seconds |
| `node release/test-qr.js`, `node release/test-totp.js` | The QR codes (`host/qr.js`) against the standard's worked example, format and version information and the layout; the one-time codes (`host/totp.js`) against RFC 6238's test values, base32, recovery codes. For the opt-in authenticator app of "Devices". A second |
| `node release/test-cycle.js` | Connections that come back on themselves (`host/cycle.js`) in plain Node: a client app on this PC (`self`), the client app of a PC this PC's client app controls (`loop`), a chain, a browser, a stale or dead `live.json`. A second |
| `node release/test-watchdog.js` | The host's watchdog (`host/watchdog.js`) in plain Node with a fake host that starts it as `main.js` does: a quit on purpose, an end without a word, `abort()`, an older host's marker, the limit of 3 restarts in 30 minutes. Half a minute |
| `node release/test-shellswap.js` | The shell replaced by a newer package (`host/shellswap.js`) in plain Node with keys, a feed on 127.0.0.1 and app folders of its own: the signed list, which package replaces which shell, staging (and archives that are not the listed one), and the real swap script (PowerShell / sh) on fake folders whose program is a copy of Node: swapped and confirmed, not confirmed (put back), still running (not swapped), nothing to start, the sweep. About a minute |
| `node release/build.js --sign-packages=<folder>` | `packages.json` and its signature from the packages' records (`<name>.package.json`) and archives in `<folder>`, each archive hashed again; checked with the keys in `app/update-config.json`. Part of every release from 0.7.0 on |
| `node release/test-appsync.js` | The two faces kept one app (`host/appsync.js`) in plain Node: a newer version followed once it came up in the other face (not on trial, not a bad one, once), the one entry in place of the two shortcuts (Windows and Linux layouts in folders of its own; a source folder's Linux entries stay). A second |
| `electron client --loader=<file> --list [--home-shot=<file.png> --home-size=940x480 --home-js=<code>]` | The client app's list on a profile of its own next to `<file>` (any loader file), never the person's. PCs come from `home-import.json` next to it (`[{ name, key, open, loader, seen, lastAt }]`, made-up keys; removed when read). With `--home-shot` no window is shown: a picture of the list is written and the app ends (how `docs/img/home.png` was made). Without it, `--home-js` runs in the list once it is up, as a person's click would (the self-test's one-time code: `mrHome.oneTime('<code>')`) |
| `node release/test-update.js` | The update logic (`app/core.js`, `app/updater.js`) in plain Node with made-up releases and feeds: signatures, file names, downgrades, the trial and going back, ordinary and required updates. A few seconds |
| `node release/test-app.js [--packaged]` | The app's shell in real Electron against a feed on this machine (made-up versions; nothing leaves the PC, the real host is not started). `--packaged` also builds this folder's code as the real package (test key, temporary folder) and runs its self-test through the shell: about 4 minutes. On Linux under `xvfb-run`; `MR_TEST_ELECTRON_ARGS=--no-sandbox` where the sandbox cannot run |
| `node release/build.js [--critical]` | Builds a release from the checked-out commit into `dist/release` (`latest.json`, its signature, the bundle, and `bundle/` for packaging). Signs with the key outside the repository |
| `node release/package.js` | The installable app for this platform from `dist/release`, into `dist/pack` (the folder `MyRemote` and `MyRemote-Windows-x64.zip` or `MyRemote-Linux-x64.tar.gz`, about 120-140 MB) |
| `<electron> release/make-icon.js` | Draws `app/icon.png` and `app/icon.ico` from `host/icon.svg` |
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
| `README.md`, `docs/img/*.svg` | The page people see first: download buttons, three steps, features and shortcuts as pictures and short tables; everything longer is folded into `<details>` under "자세히". Keep the top short; put new explanations into the folded part. The pictures are hand-written SVG (each with its own dark panel, so they read on a light and a dark page) |
| `setup.ps1` | One-shot host setup and self-test |
| `start-host.bat`, `local-test.bat` | Launchers for the real host and the local trial |
| `my-remote-client.html` | Built loader: the one file a client PC keeps (generated, committed for convenience) |
| `start-client.bat` | Launcher for the client app (uses the Electron installed under `host/node_modules`) |
| `setup.sh`, `start-host.sh`, `start-client.sh`, `local-test.sh` | The same for Linux (bash, executable in git, LF line endings) |
| `host/linux-launch.sh` | Sourced by those: Electron's path, the first-start setup (`ensure_setup`), X11 session, library and sandbox checks, errors also as a dialog (`fail`: zenity or notify-send, when there is no terminal), starting Electron in the background |
| `host/icon.svg` | The app's icon for the Linux app menu entries (the tray icon is drawn in `main.js`) |
| `client/hosts.js`, `client/home.html`, `client/home-preload.js` | The client app's list of PCs: the store (`hosts.json`, keys only encrypted; Electron-free), the list window's page and its bridge `window.mrHome` (see Gotchas) |
| `client/launcher.html`, `client/launcher-preload.js` | The installed app's start screen (two big buttons: this PC shared as the host, another PC reached as the client), the client app's first window with `--launcher`; its bridge `window.mrStart` |
| `host/watchdog.js`, `release/test-watchdog.js` | Starts the host again when it ended without quitting (a crash); its test, plain Node |
| `host/shellswap.js`, `release/test-shellswap.js` | The installed app's shell replaced by a newer package: the signed list, the decision, staging next to the folder, the swap script, the check that the new shell is up. Its test, plain Node (see "The shell replaced by a newer package") |
| `host/appsync.js`, `release/test-appsync.js` | The two faces kept one app: a running face follows a version the other installed; the one "MyRemote" entry in place of older packages' two shortcuts. Its test, plain Node |
| `release/test-hosts.js` | The store's test, plain Node |
| `host/devices.js`, `host/accesslog.js`, `release/test-devices.js` | The host's device tokens (`devices.json`: client apps that connect without the key, blocked or removed one by one) and its access log (`access.log`, 90 days); their test, plain Node. See "Devices" |
| `release/install-local.js` | A built release into this PC's installed app, the updater's way without a feed |
| `client/main.js`, `client/shell.js`, `client/preload.js` | Client app: the list of PCs and, for each PC, a thin Electron window around the loader. `shell.js` places the page's windows on the requested screen, makes them fullscreen without a click per window, grants permissions, and puts things dragged out of the remote picture where they were dropped (it loads `host/input.js`: Win32 or X11, and `host/files.js`). Exposes `window.mrShell` (`fileAbort`, `pointerOwn`, `clipPoll` and `clipWrite` from 2026-11-13 on), and from 2026-11-13 on marks a minimized or hidden window's document (`data-mr-hidden`, event `mrshown`): its windows run with `backgroundThrottling` off, so `visibilityState` never says hidden there, and the page (`unseen()`) stops asking the host for what such a window shows. `main.js --loader=<file>` shows another loader with a profile of its own (self-test, local trial on Linux). These files are not updated through the loader: the page must feature-detect what an installed app offers |
| `app/boot.js`, `app/core.js`, `app/updater.js`, `app/guard.js` | The installed app's shell: picks host or client and the code bundle to run, verifies it, keeps a new version on trial and goes back when it does not come up; finds and installs updates. See "The installed app, releases and updates" |
| `app/update-config.json`, `app/package.json` | Where updates are fetched from and the public keys that may sign them; the shell's generation (`base`) |
| `app/my-remote.sh`, `app/icon.png`, `app/icon.ico` | The installed app's launcher on Linux; its icons (drawn by `release/make-icon.js`) |
| `release/build.js`, `release/package.js`, `release/keygen.js` | Make a release (bundle, signed manifest), the installable package for this platform, the signing key pair |
| `release/test-update.js`, `release/test-app.js` | Tests of the shell: the logic in plain Node, and end to end in Electron |
| `release/policy.json`, `release/notes/<version>.json` | The oldest version still allowed (set by a critical release); what changed, shown with an update |
| `host/main.js` | Electron main: config and key storage, monitor enumeration, tray, IPC, isolated modes |
| `host/preload.js` | The only bridge between the renderer and main (`window.hostApi`). Also runs the native capturer's loops and hands their frames to the page over a message port |
| `host/host.html`, `host/host.js` | Host UI and the WebRTC side: capture, encoding control, data-channel routing |
| `native/capture.cpp` | The native screen capturer (DXGI Desktop Duplication) |
| `host/bin/capture.dll`, `capture.dll.json` | That capturer built by `native/build.js` (stripped, no time stamp: the same source and compiler give the same file), and the record of the source hash, DLL hash, compiler and command. Committed. The host loads it when it is there; without it the engine's capturer is used |
| `native/winassist.cpp`, `host/bin/winassist.exe` (+ `.json`) | The Windows assist service and its in-session LocalSystem helper: the lock screen's pictures and the typed password (see "Lock screen / UAC"). Committed like the DLLs; installed into `%ProgramFiles%\MyRemote` by the host window's card |
| `host/assist.js` | The host's side of that service (main process): installed/current/running, install and remove (elevated), and during a session the overlapped pipe client with its server-session checks, the input sink while locked, frames to the page |
| `native/shellops.cpp`, `host/bin/shellops.dll` (+ `.json`) | `so_drop`: drops files onto whatever is under the pointer as a real drag-and-drop (see Gotchas). Committed like `capture.dll` |
| `host/cycle.js`, `release/test-cycle.js` | Whether a hello comes back on itself (`self`: this PC's own client app; `loop`: the client app of a PC this PC's client app controls), from the hello's `from`, this start's id and the client app's `live.json`; its test, plain Node. See "Connections that come back on themselves" |
| `host/files.js` | Safe names and paths for files from the other side (`stagedPath` never leaves its folder), sweeping old transfers. Used by the host and the client app |
| `host/profile-cleanup.js` | Removes an isolated run's throwaway profile once the run has ended, and old ones (see Gotchas) |
| `host/dragcheck.js` | The opt-in real-input checks `--dragout-check` and `--dropin-check` |
| `native/capprobe.cpp` | Bench only: watches a display natively and reports when each bench frame was presented and handed over |
| `native/build.js` | Sends the sources in `native/` to a Linux machine, builds them there with mingw-w64 and brings the DLLs back: `capture.dll` (and its record) into `host/bin`, the rest into `tools/native` |
| `host/input.js` | Input injection, platform-neutral half: the client's messages mapped to the desktop, held keys and buttons, the self-test's dry run; picks the platform module and exports one interface |
| `host/platform/win32.js` | Win32 through koffi FFI: `SendInput`, cursor shape and picture, hiding/restoring the system cursors, HDR displays, drag detection, the clipboard's file list, the client app's drop helpers |
| `host/platform/linux.js` | X11 through koffi FFI: XTest input, XFixes cursor and selection events, the dragged data read from `XdndSelection`, the window under the pointer, the clipboard's file list |
| `host/platform/x11capture.js` | Native screen capture on X11 for `preload.js` (XDamage + MIT-SHM through koffi, no pointer in the picture): the calls of `capture.dll` in JavaScript |
| `host/inputcheck.js` | `--input-check` (Linux): real input into windows and a second program it opens itself |
| `host/cursor-guard.js` | Separate small process that restores the cursors if the host process dies (Windows) |
| `host/inputguard.js`, `host/framecheck.js` | A worker thread of the host's main process that frees the input thread from a window loop (Windows; see "A press on the host's own window frame"); the opt-in real-input check `--frame-check` |
| `host/signal.js` | Shared by host and client: key derivation, encrypted signaling channel |
| `host/i18n.js`, `host/i18n/*.json`, `host/settings.js` | The languages: the translator, the markup relabeller, the fonts per script, the flag picker (one file for the main processes, the host window, and inlined into the page and the loader); the catalogs; the PC's one setting (see `docs/i18n.md`) |
| `release/i18n-sources.js`, `release/test-i18n.js` | The Korean texts read from the code (`--missing` lists what a catalog lacks); the test of the catalogs and the translator |
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
- host -> client topic: `{t:'app', sid, ts, hash, html?, sig?}`; `html` is left out when `have === hash`; `sig`
  (from 0.8.0): `{ statement, sig }`, the release's signature of the page (see "Devices"), which old loaders ignore

The loader stores the page in localStorage, sets `window.__mrBoot = {key, device?, remember, preset, updated}`
and replaces its own document with the page (`document.open/write`); the page then connects as below.
In the client app a PC with a device token (see "Devices") runs the same exchange on the token's own
topics and keys (`RD.derive(token, RD.DEVICE)`); a host answers a blocked token's `ver` or `hello` with
`{t:'denied', sid, ts, why:'blocked'}`. The host subscribes to its own topic and every token's at once
(`/<t1>,<t2>/sse`), answers each message on the topics it came by, and takes an `answer` only on its
session's. From 0.9.0 the same goes for a one-time code while it lasts (`RD.deriveCode(code)`, see
"One-time codes"): its hello always waits for 허용 at the host; a second page gets `denied` `used`.
The host builds the page once at start, so page and host always match. Loaders built from 2026-11-13
on check a stored page's SHA-256 against the hash the host confirmed (at least 20 hex digits) and
otherwise fetch it again (Chrome and Edge share one localStorage among all `file://` pages); older
copies do not.

A receiver drops a message of more than 40 chunks (120,000 characters, about 90 KB deflated). Every
loader handed out has this limit and cannot be changed, so the `app` reply with the whole page must
fit: the self-test fails above 36 chunks (19 on 2026-11-13). New code also drops a message that
inflates past 1 MiB. The relay subscription (`signal.js`) resubscribes by itself when EventSource
gives up (2 s, doubling to 60 s), when a subscription has not opened within 2 minutes, and when a
stream that brought ntfy keepalives stays silent for 3 minutes; what is published in that gap is
lost and the sender retries. Checked with Node tests against a fake EventSource and relay only.

Signaling (through the relay, each message deflated, encrypted, chunked to 3000 chars):

1. client -> host topic: `{t:'hello', sid, ts, mode, codec, pk, hsig, pair?, from?}` (`codec` optional: `H264`, `H264HQ`, `VP9`, `AV1`; `pk`: the page's own ECDSA P-256 public key, SPKI base64, `hsig` its signature of `hello\n<sid>\n<ts>\n<pk>`; `pair`: a client app connected with the key asks for a device token, `{ pc, os, osName, app }`; `from` (0.9.0, the client app only): the id of the host running on the client's own PC, for `cycle.js`; refused with `denied` `self` or `loop`, see "Connections that come back on themselves")
   - with new devices confirmed: host -> client `{t:'confirm', sid, ts, code, otp, locked, wait}` (the number both screens show; `otp`: a code may be given; `locked`: the code check is locked for now), client -> host `{t:'otp', sid, ts, code, sig}` and `{t:'cancel', sid, ts, sig}`, host -> client `{t:'otp', sid, ok: false, why: 'code' | 'locked', left}`; allowed: the offer follows; else `{t:'denied', sid, why}` (`refused`, `timeout`, `busy`, `old`, `blocked`)
2. host -> client topic: `{t:'offer', sid, ts, sdp, ice, audio, codec, cursorHidden, app, os, instance, monitors:[{idx, mid, x, y, width, height, primary, hdr?}]}`
   (`instance`, 0.9.0: this start of the host, random; the client app keeps it in its `live.json` while it controls the host)
   (`os`: `{os: 'windows'|'linux'|'mac', name, pc}`, what the host runs, e.g. `Windows 10` or `Ubuntu 22.04.5 LTS`, and from 0.4.0 the computer's name (`os.hostname()`); the arrangement panel shows them with a logo, the client app's list keeps them)
   (`x`,`y`,`width`,`height` are the monitor's rectangle on the host's virtual desktop, physical pixels)
3. client -> host topic: `{t:'answer', sid, ts, sdp, sig}` (`sig`: ECDSA over `answer\n<sid>\n<sdp>` with the hello's key; required when the hello had one)

The host appends `x-google-start-bitrate` to the answer's video codec parameters so the bandwidth
estimate does not start near 300 kbps. ICE is non-trickle (candidates are gathered before sending). The host rejects messages older than five
minutes or without a numeric `ts`, a `sid` over 64 characters, and replayed `sid` values; the sids it
took are kept in the host page's localStorage (`mr_host_seen`) for as long as they could pass the
five-minute test, so a restart does not forget them. A new `hello` replaces the current session: a
session is current from its hello on, a teardown during its setup closes what it has, and the host
ends a session as soon as its input channel closes.

A message lost on the relay (the public one loses one now and then; in CI a hello went out before the
host had subscribed) used to end a try: the page waited 20 s and gave up (a first connection; a reconnect
tried again 1.5 s later). Since 2026-11-19 the page starts over once by itself (`tryAgain`): 6 s after its
hello when the host said nothing at all (no offer, no `confirm`, no `denied`), or 8 s after its answer when
the connection is not up. Never while the host asks the person there (`confirm`): the same page asking
again replaces its question there, and a host takes at most 6 in 10 minutes. Once per try (the count starts
again on 연결, on a connection up, and at each reconnect). The self-test has its relay lose an offer and an
answer (`relayDrop`): up again after 8 and 10 s. The loader's own `ver`/`app` exchange (15 s, no second
try) is unchanged: loaders handed out cannot change, and the client app's loader is the same file.

Data channel `input` (JSON text):

| Direction | Message | Meaning |
|---|---|---|
| client -> host | `mm` `md` `mu` `mw` | Mouse move/down/up/wheel; `d` = monitor index, `x`,`y` = 0..1 within that monitor. During a drag they may leave 0..1, which continues onto the neighbouring monitor. `mm` carries `h`: the buttons the client's pointer holds (bit b = button b of `md`/`mu`); the host lets go of any button it holds that is not in `h`, so a lost `mu` cannot leave a button down. A move never presses anything |
| client -> host | `kd` `ku` | Key down/up; `c` = `KeyboardEvent.code`, `k` = `key`; `s: 1` (0.9.0): a key of the phone's keyboard or key row, which the input guard does not count |
| client -> host | `reset` | Release every held key and button |
| client -> host | `view` | `v` = `[{i, w, h}]`: monitors on screen and the size each is shown at, in device pixels (`0` = full size). The host pauses the rest, scales down to the shown size (never up) and splits bitrate by pixels sent |
| client -> host | `mode` | `sharp` or `smooth` |
| client -> host | `cs` | Client measurements for the host's diagnostics log |
| client -> host | `dragout` | The pointer was let go outside every client window while the host reported a drag; `b` = button. The host ends its drag, copies what was dragged and answers with `dragdata` |
| client -> host | `dragq` | The pointer just left every client window with a button held: the host checks for a drag-and-drop every 15 ms for 1.2 s and sends `drag` the moment one starts |
| both | `clip` | Clipboard text, at most 60000 chars (see "The clipboard is shared both ways") |
| client -> host | `text` | `s`: characters typed on a phone's keyboard, at most 400 at a time; the host types them as characters (Windows `KEYEVENTF_UNICODE`; X11 keycodes lent to their keysyms, typed over time with later input held back), whatever its layout and input method |
| host -> client | `lock` | `on`, `why`: `lock` (the host's session is locked) or `secure` (a UAC prompt or another secure desktop has the screen). Sent when a session starts and when it changes; the client says so over the picture. With the assist service (Windows) also `live` (the secure desktop's picture is in monitor `d`'s video) and `input` (typing reaches it: the lock screen only); the window showing `d` then shows a bar instead of the cover |
| client -> host | `sas` | Ctrl+Alt+Del for the host's lock screen (the bar's button; the client PC keeps that key combination itself). The helper honours it only while the session is locked, and only where `SoftwareSASGeneration` allows services to generate it |
| host -> client | `cur` | Current host cursor: `c` = CSS cursor name, or `img` (PNG data URL) with hotspot `hx`,`hy` for an app-specific cursor. The host page asks main about 30 times a second and passes the cursor it has, so the picture is copied over IPC only when it changes |
| host -> client | `hs` | Host-side statistics every 2 s (codec and `from`, whose choice it was: `client` (the 진단 dialog, kept in the client's localStorage `mr_codec`), `config` or `auto`; encoder, bitrate, per-monitor capture/encode fps and limiting factor) for the client's diagnostics report; the host's diagnostics log gets the same |
| host -> client | `drag` | `on`: whether a drag-and-drop is under way on the host. An X11 host sends it once more with `what`: `{kind:'files', n, name}` (the number of files and the first one's name, no path) or `{kind:'text'}`, for the client app's picture at the pointer while it is carried out |
| host -> client | `dragdata` | Answer to `dragout`: `kind` `text` (`s`, `cut`), `files` (`files:[{id,name,size,dir?}]`, `skipped`; the bytes follow on the `file` channel; `name` may be a path 'folder/sub/file') or `none` with `why`: `nodrag`, `nocopy`, `empty`, `toobig` |
| host -> client | `clipfiles` | Files were copied on the host during the session: `seq` (the clipboard's change count), `n` items, `dirs` of them folders, `bytes` of the plain files, `names` (at most 3, no paths). Files already on the clipboard when the session began are not announced, nor files the client sent itself (a paste, or a drop nothing took: they lie in the host's inbox), which it would otherwise fetch back |
| client -> host | `clipget` | Fetch the files of `clipfiles` `seq`; refused (`dragdata` `none`, `why:'changed'`) when the clipboard changed since. The answer is a `dragdata` with `clip: true`, the bytes on a `file` channel as for dragging out. The client asks when focus leaves all of its windows (the person went to the client's own programs to paste), at most 512 MB, the app only; the files go onto the client's clipboard |
| host -> client | `others` | `crd`: a Chrome Remote Desktop session is connected to the host as well (`remoting_desktop.exe` runs); `outline`: the host drags windows as an outline only. Checked every 10 s, sent when it changes; the client shows a warning. Both are checked on Windows only (elsewhere always false). The process list is a Toolhelp snapshot taken on a koffi worker thread (`input.processRunning`; about 67 ms for 479 processes on the test PC, so never on the main thread), not `tasklist` |
| host -> client | `storm` | (0.9.0) Input stopped for `ms` because the same key or click came again and again, faster than a person (the input guard, `input.js` `stormed`); the client says so in a toast |
| client -> host | `pair` | Right after the channel opened, when the hello asked for a token: `install`, the app's own random id (the host replaces the token of an app that pairs again). Here, not in the hello: key holders can read hellos on the relay |
| host -> client | `device` | Answer to `hello.pair` (after `pair`): `ok`, `id`, `secret` (the device token: 32 bytes, base64url) or `why` (`full`, `nostore`, `unreadable`). Only over this channel, never through the relay |
| host -> client | `bye` | Deliberate close; the client must not auto-reconnect |
| host -> client | `renew` | Host monitors changed (or the capture method); the client reconnects at once and keeps its windows. A session whose input channel is not open yet gets it when it opens. After a native capturer's size renew, the matching `displays-changed` is ignored when the next session already has the current monitors (10 s) |

Data channel `upload` (client -> host, opened by the client per transfer, ordered): text
`{t:'begin', mode:'drop'|'paste', at:{d,x,y}|null}`, `{t:'dir', name}` for empty folders, per file
`{t:'file', name, size}` + binary pieces of at most 60000 + `{t:'fileend'}`, then `{t:'done'}`. Names
may be paths ('folder/sub/file'); the host makes every part safe and keeps them inside the transfer's
folder, refuses more than announced, 5000 files or 2 GB. The host answers on `input` with
`{t:'put', state:'done', how:'dropped'|'pasted'|'clipboard'|'staged'|'none', n, why}` or
`{t:'put', state:'error', why}`. A drop goes where it was let go unless the person clicked or typed
since (`md`/`kd` after `begin`): then onto the clipboard.

Data channel `file` (host -> client, opened by the host per transfer, ordered): text `{t:'file', id, name, size}`,
then the bytes in binary messages of at most 60000, text `{t:'fileend', id}`; an empty folder of a
dragged folder as `{t:'dir', name}`; after the last file `{t:'filesdone'}`, or `{t:'fileerror'}`. The
client app stages one transfer under one folder (`shell.fileBegin(name, group)`, names made safe part
by part, never leaving the staging folder) and moves its top-level files and folders to the target. The host only sends files it found on its own clipboard in the
`dragout` step; the client cannot ask for a path. The client refuses a file whose bytes differ from
its `size` (and closes the channel), and takes a close or error before `filesdone`, a channel that
does not open within 12 s of `dragdata` or a lost connection as a failure: the app throws away what it
staged (`shell.fileAbort`). A browser keeps the pieces in 16 MB Blobs, stops at 2 GB and saves each
file as a download. On the host a transfer ends when its channel or its session closes and then
releases only its own files; the files of one drag-out stay readable while another starts, and
offers nobody read for ten minutes are dropped.

Monitor coordinates are physical pixels (`screen.dipToScreenRect`), mapped to the 0..65535 virtual
desktop range for `SendInput`. Keys are sent as set-1 scancodes so the host's keyboard layout applies;
`HangulMode`/`HanjaMode` and a few others go by virtual-key code. A numpad key goes as what the
client's NumLock made of it (`k`): a digit as the numpad digit's virtual key, End/arrows/... as those
keys, so the host's NumLock state does not matter; a key is released the way it was pressed. Keys the
host presses itself (`tap`: Escape, Ctrl+C, Ctrl+V for drag-out and pasted files) go as virtual keys
(the same in every layout), skip keys the person already holds and lift other held modifiers around
themselves. On X11 the physical pixels are the
root window's coordinates as they are, and keys go as X key codes (Linux evdev code + 8), which the
host's keyboard layout applies to in the same way.

On the client side: a second button pressed or let go while another is held arrives as a move and is
sent as `md`/`mu`; a `mu` is sent only for a button the page pressed (a release on its own would reach
the host as a stray button-up, a right one opening a context menu). On a Mac client, Cmd goes as Ctrl,
Cmd+V is the paste shortcut, and keys pressed under Cmd are released with it (macOS sends no key-up for
them). AltGr (`getModifierState('AltGraph')`) never triggers the `Ctrl+Alt` shortcuts. Not tried on a
Mac or with an AltGr layout.

## Client layout model

Each client window is a *view*. What it shows is `sel`: one host monitor (its index), several together in
their real arrangement with gaps closed (a sorted list of indexes; `'all'` when it is every monitor), or
nothing (`'none'`, main window only). One monitor can be shown in `fit` or `1:1` mode. The video element is sized to the monitor's exact
aspect ratio, so pointer mapping is a plain proportion of the element. Policy, in `client.template.html`:

- `planLayout(N, M, cur, primary)` decides which host monitor goes on which client screen (both sorted
  left to right): all N on neighbouring screens when N <= M, otherwise M neighbouring monitors around the
  primary. The result is remembered per `N:M` in localStorage.
- Selecting a monitor that another window shows swaps the two, so a monitor is never shown twice.
- The arrangement panel shows next to "호스트 PC" and "이 PC" each one's operating system, a logo drawn
  in the page (`OS_ICON`: Windows, Linux, Apple, Android, a plain screen otherwise) and a name: the
  host's from its offer (`os`), this PC's from the browser (`userAgentData`, Windows 11 by
  `platformVersion` >= 13).
- The arrangement panel (`모니터 배치`, `arr*` functions) edits one list: for every host monitor, the client
  screen it is shown on, or null. `arrOp(A, src, dst, copy)` is the whole drag rule set (host onto host
  swaps, Ctrl adds the target to the dragged monitor's screen; screen and host: that screen shows that
  monitor and what it showed moves to the monitor's old place; screen onto screen swaps).
  `applyAssign(A, cs)` makes the windows match: it changes what open windows show, opens a window on a
  screen that needs one and closes the window of an emptied screen (the main window shows a hint
  instead). A click on a host tile turns it off and remembers where it was. While the panel is open
  every monitor is requested at tile size, so tiles of unused monitors are live too.
- Windows are matched to client screens by where their centre is now (`screenMap`: one window per
  screen, the main window first; a further window on a taken screen counts as on none), and an
  overview (`'all'`) counts last in `currentAssign`. After `applyAssign` or `spread`, a window not
  placed on a screen gives up any monitor now shown elsewhere and closes when left with none
  (`notTwice`).
- `Ctrl+Alt` + arrows / digits / Enter are local shortcuts and are not forwarded (user can turn them off).
- An exact integer enlargement is drawn with `image-rendering: pixelated`; anything else is smoothed.
- Browsers allow one popup and one fullscreen request per click and restrict window placement, so in
  a browser each extra window needs a click. The client app (`client/`) removes this: the page detects
  it through `window.mrShell`, asks it for the screens and for `fullscreenAll()`. The page is the same
  in both; keep app-only behaviour behind `if (shell)`.
- The offer carries the hash of the page the host serves (`app`). An open page whose stored hash
  differs reloads through the loader to fetch the new one, so clients follow host updates by themselves.
  The key never goes into the address for that (the browser would keep it in its history): the page
  puts it where loaders before 2026-11-16 kept a remembered key (`mr_key`) with a mark (`mr_forget_key`,
  in the tab's sessionStorage and next to the key in localStorage), the loader takes it from there, and
  the new page empties both at once (since 2026-11-16 every page empties `mr_key` when it starts; browsers
  keep no key). A page with a device token just reloads. sessionStorage `mr_respread` brings the spread windows back afterwards (the app; a browser is
  told which button to press).

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

**The client app's connect.log** (from 0.9.5; `%APPDATA%\my-remote-client\connect.log`, Linux
`~/.config/my-remote-client/connect.log`, kept under 256 KB with `connect.old.log`): one line per step of each
try to connect, written by the page through `mrShell.connLog` - `request key|token|one-time code` (`, again`,
`, reconnecting`), `asked at the host`, `offer +N ms`, `answer +N ms`, `connected +N ms`, `again <why>`,
`lost <text>`, `refused <why>` - with the time and the list entry's id. No key, token, sid or relay topic
(the self-test checks the file for them), so it may be read: when a connection would not come up, it says
where it stopped (on 2026-11-18 a token's try at the Linux host stalled after the host's offer and nothing
on the client told why). The loader's steps before the page are not in it.

The client sends its measurements every 2 s (`cs` message) and the host appends them, with its own
encoder statistics, to `%APPDATA%\my-remote-host\diag.log` (Linux: `~/.config/my-remote-host/diag.log`;
JSON lines, numbers only, rotated at 3 MB).
Read this file when the user reports stutter or lag instead of guessing: compare host capture fps,
encode fps and the limiting factor (`cpu`, `bandwidth`, `none`) with the client's received fps, late
frames, packet loss, round-trip time and jitter-buffer delay. `late` is the stutter measure: shown
frames (`f`) that came on screen more than 50 ms later after the frame before them than they were
captured after it (`n`, together `ms`, `worst`; `watchFrames` in the page, from the frames' RTP
timestamps), and of those the ones that also arrived late (`rn`, `rms`: the network's or the host's
doing; the rest were drawn late on the client). A browser's hidden or minimized window is left out; the
client app's windows always count as visible (it turns `backgroundThrottling` off), so there a
minimized window shows up as frames drawn late, not received late. The self-test's hidden window draws
seldom and its INFO line shows exactly that. The engine's `freezes`/`freezeDur` are no such measure:
they count every pause of more than about 150 ms between shown frames, and the native capturer sends
only one picture a second while the screen stays the same (nothing at all before 2026-11-18; a real session of 2026-11-12: 627 "freezes", 385 s, in an
hour of normal use). `pli`: key frames the client asked for; many of them while the picture is still
mean the keep-alive is not working (see "Native capture"), and each makes the next change late. Counters run per connection. An entry may carry `slow`: main-process
calls that took over 50 ms since the previous entry (`input mm`, `clip-read`, `clip-files`,
`drag clipboard` (reading the clipboard waits for its owner), `cursor`, ...) and
`paused` (the main thread itself did not run for over a second), each as count, total and longest ms.
The client's input is injected on that thread, so a stall there is a stall of every click. Entries
written many at once after a gap mean the same. The host's part says which capturer runs (`cap`:
`native` or `engine`, from 0.8.1) and, for the engine, why (`capWhy`: `config`, `given up: <error>` for
10 minutes after a native failure (an HDR monitor: until the host restarts), `no capturer: <why>`, or
the monitor that could not be opened). Before 0.8.1 nothing said so: an updated host ran on the engine's
capturer for weeks unnoticed (see "The installed app"). `host.log` next to it has the host's own messages. `released`: buttons the host let go because the
client's moves said they were no longer held. The client's part may carry `ptr`: `cancel` (the
browser ended a pointer while a button was held), `lost` (pointer capture went away while held),
`drag` (browser drag-and-drop starts that were blocked), `released` (host buttons let go after a
cancel), and `xfer` for dragging out: `out` (dragouts sent), `late` (let go before the host's drag
started, carried out after waiting), `files`, `placed`, `text`, `none`, `failed`, and the last `why`
code and placement `how` (fixed words, no names or paths). It never contains the key; `config.json`
in the same folder does (and so do its `config.json.bad-*` copies), so do not read those. The
client's own report (`진단`) compares counters within one connection only: a reconnect starts them again.

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

Verified for the list of PCs and several PCs at once (2026-11-14, the Ubuntu 24.04 PC, three Xvfb
displays, a harness outside the repository): two test hosts, each with a relay and a throwaway key of
its own, and the client app with its list on the third display, given both as PCs to add and open. Both
windows showed their host's picture at the same time (each host got the app's measurements, 40 fps), the
list showed both as connected with system and computer name, neither window kept a key in its storage,
closing one left the other connected, opening it again connected again. On Windows the list was only
looked at (pictures with made-up PCs) and exercised by the self-test with one host.

Verified with real input and the real client app (2026-11-14, the Ubuntu 24.04 PC, two Xvfb displays:
the host with GNOME Shell and Nautilus 46 on one, the client app as a program of its own on the other,
its pointer moved and pressed through XTest; a harness outside the repository): a file pressed in the
picture, dragged out of the window and let go there arrives in the client's desktop folder, with the
drag ghost shown - slowly, with 2 moves before leaving, and let go 150 ms after leaving. Before the
fix (see "A press on the picture does not get the pointer") the same run carried nothing out. With
a real mouse on a Windows client (the 0.3.0 app) and that Linux host on 0.3.1, the person reported the
same day that files go both ways. Whether the drag ghost showed there was not said.

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

Verified for files dragged or pasted in: the upload channel with folders, hostile names and a file
that sends more than announced (self-test); `so_drop` into an Explorer folder, onto a folder icon and
onto the window frame, with a name clash raising Explorer's own Replace/Skip (scratch test, real
Explorer); the whole way with real drags from Explorer onto a client window in the app's shell,
dropped by the host into another Explorer window, its folder icon, and a whole folder (`--dropin-check`);
Chromium handing over files copied in Explorer in a paste event. Not verified: dropping into other
programs (mail, chat, browser upload fields), the desktop, an elevated target (Windows blocks it),
a paste into Explorer through the host, a real second PC, folders whose reading throws.

Electron 45.3.1 (2026-11-13, was 33.4.11): the self-test passes on it (44 checks, among them text on
the host's clipboard reaching the client, the lock notice, a phone's gestures and keyboard traced from
synthetic touch events, the fullscreen/window key rule and the clipboard poll's logic). The first
self-test on 45 passed too while the clipboard text never reached the client (see the clipboard gotcha):
the code was ported after a review of the breaking changes from 34 to 45. On Linux (the server, Xvfb)
the whole self-test with `--input-check`, `--clip-check` and `--client-app-check` passes on 45 (42
checks; they cover the clipboard helpers there, rewritten for the promise-based clipboard), with the key
stored through the asynchronous `safeStorage` calls. Not yet checked on 45: the bench (latency and
quality), on Windows `--clip-check`, `--client-app-check` and `--shell-check` (the client app), and
`--dragout-check`/`--dropin-check`; the client app marking a real minimized window (the page's side,
with the mark set by hand, is in the self-test).
Not verified anywhere: a real phone, Keyboard Lock holding the Windows key on Windows, `shell:clipPoll`
in a real client app with a real password manager.

Audit fixes of 2026-11-13 (signaling, session lifecycle, the main process, the client page, the client
app, native capture): after merging them all, the self-test with `--clip-check` (41 checks),
`--dragout-check` A/B/C and `--dropin-check` D/E/F passed on this PC. Each group was also checked on
its own with Node harnesses and fakes (a fake EventSource and relay, `host.js` and the client page in a
vm, `main.js` with a fake Electron, the repeat policy simulated); those cover behaviour the self-test
does not reach. Not verified: a real relay reconnect after a 502 or 429, a real renderer crash and the
start-up key dialog, native capture recovering from a real lock screen, UAC prompt or driver restart
(the DLL's recovery code has not run), the `FEW`/`SMALL` repeat counts on the bench, a Mac client,
`pointerOwn` with a real window lying over a client window, the `copy` cursor outside the windows,
touch and pen, AltGr layouts, the browser's fullscreen click after spreading, the app spreading again
after a self-update, and a browser download of a large file through Blobs.

Test round of 2026-11-15 (after the assist service, at the user's request to test every OS case; all
passed): Windows 10 PC (this one): the self-test (44 checks, the binaries' records included),
`test-assist.js` (18), `test-app.js --packaged` (14, the branded exe), the bench gate (dev: 49.7 fps,
scroll p50 80 ms, typing p50 53 ms). Ubuntu 24.04 (the Linux PC, Xvfb): the self-test with
`--input-check --clip-check --client-app-check` (native X11 capture, AV1). The Windows 10 test VM: the
self-test with `--clip-check --client-app-check` (37 checks; native capture works on its display) and
`--dragout-check` A/B/C (real Explorer drags; injecting there touches nobody's desktop). Across machines
with the lock screen: the Windows client page against the host in the VM, and the Linux client (Ubuntu
24.04, Xvfb) against it: lock, the lock screen live with the bar, click, password typed, unlocked. GitHub's
runners: `checks`, `native` (byte for byte), `Linux X11` passed on the first run.

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
captured once from PulseAudio (the track arrived; audibility not checked). Native capture on X11
(`platform/x11capture.js`, 2026-11-13, Electron 45, the same server and Xvfb): the whole self-test with
`--input-check`, `--clip-check` and `--client-app-check` runs on it (49 checks, ALL PASS), among them
"the native capture has no pointer in the video" (0 pixels under the pointer changed when it moved away).
Ubuntu 24.04 (another server, the first run there, Electron 45 without Chromium's sandbox, which 24.04
restricts): the self-test with `--input-check` and `--clip-check` on Xvfb, 48 checks, ALL PASS; and the
plain self-test on a virtual desktop as a person would use one on a PC without a monitor (Xvfb, GNOME
Shell 46 started directly with `--x11 --mode=ubuntu` on a session bus of its own, since GNOME 45's
gnome-session has no `--builtin` and runs only inside a systemd login; the host without a session bus,
so that the locked keyring is never asked), 32 checks, ALL PASS. Not verified on Linux: a
real desktop session (GNOME, KDE, Xfce) with a window manager, a real file manager as the drag source
or drop target (Nautilus, Dolphin; the clipboard formats were only read back by this program), the
desktop-icons detection on a real desktop, several monitors (Xvfb's RandR here kept no extra monitor),
HiDPI scaling, Xwayland, a Korean input method receiving the Hangul key, the tray icon on a real desktop,
the keyring path in the host itself (a throwaway gnome-keyring was tried with a safeStorage harness only),
`npm install` itself, Ubuntu 23.10+ (the sandbox message). macOS: no input backend; the view-only path
was not run anywhere.

Verified for the one-step Linux install (2026-11-13, the server, Ubuntu 22.04 with its own Node 12 on PATH,
a GitHub-style zip from `git archive` unzipped into a fresh folder, HOME pointed into that folder, Xvfb):
`./start-host.sh --localtest` in a terminal downloaded Node 22.23.5 into `tools/node` (SHA-256 checked),
ran npm install and Electron's download, added the two app menu entries and started the host (11 s on that
network); the same with no terminal and no session bus ran the setup into its log and started; with a
session bus (`dbus-run-session`) gnome-terminal opened and ran the setup; `./setup.sh` afterwards passed
the self-test; and a Windows client controlled that freshly installed host over the LAN (below: video,
pointer, click, keys, Korean text). With a session bus and an empty HOME the host then waited on GNOME
keyring's "new keyring password" prompt (gcr-prompter): the asynchronous safeStorage calls use the Secret
Service when one answers, even where `getSelectedStorageBackend()` said `basic_text` (no
XDG_CURRENT_DESKTOP). On a real desktop the login keyring is unlocked at a password login; with
auto-login it asks once. Not tried: a real Ubuntu desktop, 24.04, the file manager's "Run as a Program".

Verified across the two OSes over the LAN (2026-11-13, Electron 45): a Windows client (this PC, the real
page in a hidden window, throwaway profile) controlling a Linux host (the server: `--localtest` on Xvfb,
its local relay tunnelled over ssh, its own client app stopped): a direct connection (host candidates,
UDP, 1 ms), AV1 by libaom at 60 fps, the offer's `os` ("Ubuntu 22.04.5 LTS"), a pointer move landing on
the exact pixel computed, a click into a window there, and keys with Shift plus a phone keyboard's text
with Hangul typed into it in order ("Hi é 한글" and Enter). The other way, a Linux client controlling a
Windows host, only the picture was measured (the two-machine bench); its input would land on this PC's
desktop and was not tried.

Verified between two machines on one LAN (see "Performance"): connecting across subnets without STUN,
AV1 and H.264 decoding on a second machine, the delay and quality figures. Not verified: anything in
"Performance" on a real link between two networks (home to office), AV1 decoding speed on a client other than this PC, AV1 encoding load on a host with fewer cores,
the effect of the start/min/max bitrate hints on a real link, whether Keyboard Lock captures
Alt+Tab and the Windows key inside the client app, dragging between windows on a real multi-monitor
client, popup and fullscreen behaviour in a plain browser, hosts with mixed resolutions, DPI scales,
portrait or ultrawide monitors, monitors wider than 4096 px with H.264, any connection across two different networks, real-world latency, TURN, audio audibility,
client-to-host clipboard, the packaged exe, behaviour with monitors powered off. Say so when the user
asks how well it works; do not present these as working.
