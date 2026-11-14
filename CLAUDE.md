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
  `%APPDATA%\my-remote-host\config.json` (`keyEnc`); on Linux in `~/.config/my-remote-host/config.json`,
  encrypted with the desktop's keyring or, without one, only obscured (reading that file is reading
  the key). The copies `config.json.bad-<time>` that the host keeps of a broken file next to it hold
  the key just the same: never read them either. Do not decrypt it, do not ask the user to paste it
  into the chat, and do not put it in a URL, file, or commit. The user copies it with the host window's
  `키 복사` button, or, on a Linux PC reached over ssh, reads it in their own terminal with
  `./start-host.sh --show-key`. Never run `--show-key` yourself, in any form and on any machine: its
  output is the key.
- **Never bake a key into `my-remote-client.html`.** The committed client contains no key by design.
- **The client app's list of PCs holds keys too.** `%APPDATA%\my-remote-client\hosts.json` (Linux:
  `~/.config/my-remote-client/hosts.json`) has the access key of every PC the person added, encrypted
  like the host's own: never read or decrypt it, nor its `hosts.json.bad-<time>` copies, and never start
  the client app on the person's own profile to look at the list. To try the list, use a profile of its
  own: `electron client --loader=<file> --list` (see Commands), with made-up keys.
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
- **Putting a release where apps fetch it is the user's step**, like starting a host: build it
  (`release/build.js`), say what is in `dist/release`, and let them upload it. Never mark a release
  `--critical` (it installs itself on every app, without asking) unless the user said so for that release.
- **Keep `app/` small and stable.** It is the part an update cannot replace: a fault in `boot.js`,
  `core.js`, `updater.js` or `guard.js` stays with every installed app until its user installs a new
  package by hand. Change it only with `release/test-update.js` and `release/test-app.js --packaged`
  passing, and raise `base` in `app/package.json` when the code needs something new of the shell.
- Do not commit `node_modules/`, `tools/`, `dist/`, or any `config.json` (see `.gitignore`).

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
    brings it to full quality, then nothing is sent; after a change below 1% of the picture (DXGI's
    dirty and move rectangles, `mc_next`'s `info[4]`: a blinking caret, a typed letter) only `FEW` (6),
    and a running series is never cut short. Every `show` (connected, back on screen, new size, the
    client's `view`) re-sends it with a full series: the encoder drops frames before it runs, and a
    `MediaStreamTrackGenerator` cannot answer its refresh request. A monitor nobody looks at is not
    captured at all.
  - A lost duplication (lock screen, UAC, mode change, a full-screen program) or a lost device (driver
    restart, TDR) is rebuilt inside the DLL (a new device when the old one was removed), at once and
    then up to once a second; meanwhile `mc_next` returns 2, the preload sends `paused` (host log), the
    session stays up and the client keeps the last picture. Only failures that last 10 s (the lock
    screen and session switches do not count) give -4, which, like a monitor in HDR mode or rotated
    (-2), renegotiates with the engine's capturer (`nativeOff`, until the host page restarts); -3 (a
    size change) renegotiates and stays native. `mc_test_lose(handle, 1|2|3)` simulates the losses.
    Recovery from a real lock screen, UAC prompt or driver restart has not been tried.
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
  meanwhile and were then injected all at once. The host now tells the client (`others`).

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
    load of such a window (only the window's top page, only when the document has the loader's `key`,
    `go` and `remember` elements), puts it into the loader's field with "remember" off and presses its
    button. So `mr_key` is not left in that window's storage. The loader file is unchanged.
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
- **The self-test keeps every display's picture moving.** The native capturer sends nothing while a
  screen stays the same, and the checks that count frames failed now and then on a PC with two
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
- **Lock screen / UAC** are on a separate secure desktop: they cannot be captured or controlled by a
  normal-user process. This is the main functional limitation, not a bug to "fix" with a quick patch.
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
  Mac client Option+Tab/F4/Esc/Space and Ctrl+Esc are no system shortcuts and go to the host. Whether
  Keyboard Lock really holds the Windows key on Windows was not checked (Ctrl+Alt+Del and
  Win+L cannot be held by anything). The clipboard is the one exception: shared in both modes. When the
  host lets go of Alt or the Windows key in a `reset` (the client left with Alt+Tab while Alt was
  held), it first presses a key of no meaning (Windows: VK 0xE8; X11: an empty keycode; `maskKey`), or
  the lone release would open the program's menu bar or the Start menu.
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
  no difference in the default mode: not adopted. Next to try: smooth mode with the `detail` hint and
  only `maintain-framerate`.
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
  file) need not be trusted, and may be a public place while the repository is private. Never an older
  version than the one running.
- **The updater lives in the shell**, not in the bundle: a bad release cannot take away the means to
  replace it. It looks at the feed 20 s after the start and every 6 h. An ordinary update is only
  announced (the host window's card, `showUpdate` in `host.js`; the client app asks in a dialog) and
  installed when the person says so. A *required* one (`critical`, or the running version is below the
  release's `minimum`) is installed without asking and the app restarted when the code says the moment
  fits (`setCanRestart`: the host when no session is on, 30 min at most; the client app after a notice).
  `release/policy.json` carries `minimum` forward, so apps that missed a critical release are still
  forced by later ordinary ones. A release with a higher `needsBase` than the shell is only announced
  (`kind: 'package'`): a new package must be installed by hand. Updating the shell itself (a new
  Electron) automatically is not built; it matters, since Electron needs security updates.
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
  - koffi belongs to the shell; the bundle finds it through `NODE_PATH` (set in `boot.js`, inherited by
    the page's process, where the native capture loads it).
  - `--selftest`, `--localtest`, `--bench`, `--show-key` and `--loader=` are errands: no updater, and no
    start counted against a trial.
- **Names.** The two faces keep the profile names they always had (`my-remote-host`: its config and
  the key, encrypted under that name on Linux and macOS; `my-remote-client`), set in `boot.js` before
  anything else, so an app installed over a source folder's use keeps the key.
- **Packages** (`release/package.js`) are made on the platform they are for, from
  `host/node_modules/electron/dist` (nothing else is downloaded): a folder to unpack and run
  (`MyRemote.exe`, `./my-remote.sh`), zipped as `MyRemote-Windows-x64.zip` / `MyRemote-Linux-x64.tar.gz` holding a folder `MyRemote`: no version in the names, so the README's download buttons (`.../releases/latest/download/<name>`) always fetch the newest and a self-updating folder is not named after an old version. No installer, no code signing: Windows SmartScreen warns
  at the first start. macOS is not built (an unsigned app does not run there). Started without `--host`
  or `--client` the app asks which and offers the two shortcuts (`--shortcuts` makes them without asking).
- **Plain names.** No file or folder the package holds or the app makes has a space or anything but
  ASCII in its name (the user's rule, 2026-11-14: a path with Korean or a space fails on some systems
  and with some tools): `MyRemote.exe`, `README.txt` (Korean inside, with a byte order mark on
  Windows), Start menu `MyRemote\MyRemote-Host.lnk` and `MyRemote-Client.lnk`, the profile of a start
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

## Commands

Run from `host/` with Electron's env var cleared.

| Command | What it does |
|---|---|
| `npm run selftest` | Local end-to-end test, prints `[selftest] PASS/FAIL` lines, exits 0 or 1 |
| `electron . --selftest --shell-check` | Same, plus the client app's one-click layout on the real screens. Fullscreen windows cover every monitor for a few seconds, so ask the user first |
| `electron . --selftest --dump-phone=<file.png>` | Pictures of the phone layout: client windows of a phone's size (915x412 and 412x915, `#touch`) with the key row open, written as `<file>-landscape.png` and `<file>-portrait.png`. About 30 s, opens no window |
| `electron . --selftest --dump-panel=<file.png>` | Quick look at the arrangement panel: connects, draws the panel as if the client had two screens, writes pictures (`<file>.png`, `-ctrl-drag`, `-swap-drag`, `-together`) and exits. About 20 s, opens no window |
| `node native/build.js user@host[:folder]` | Builds the native modules on a Linux machine with mingw-w64: `host/bin/capture.dll` + `capture.dll.json` (commit them with the source), `tools/native/capprobe.dll`. After a change in `native/` |
| `npm run bench -- --native-probe --capture-probe ...` | Bench with a native observer of the same display: reports when the picture was on the host's own screen and how long after that the capturer in use had it. Needs `tools/native/capprobe.dll` |
| `electron . --selftest --dragout-check` | Only real drags out of a real Explorer window this check opens on a temp folder (`dragcheck.js`): A straight on the host, B and C through a client window running the real page in the client app's shell (held outside; let go at once, before Explorer started its drag). INJECTS INPUT for about half a minute, so only with the user's agreement; skipped when the clipboard holds more than text, which is put back |
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
| `node release/test-hosts.js` | The client app's list of PCs (`client/hosts.js`) in plain Node with a stand-in for the system's encryption: keys never as text in the file, duplicates, renaming, a new key, removal, a broken file kept. A second |
| `electron client --loader=<file> --list [--home-shot=<file.png> --home-size=940x480 --home-js=<code>]` | The client app's list on a profile of its own next to `<file>` (any loader file), never the person's. PCs come from `home-import.json` next to it (`[{ name, key, open, loader, seen, lastAt }]`, made-up keys; removed when read). With `--home-shot` no window is shown: a picture of the list is written and the app ends (how `docs/img/home.png` was made) |
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
| `release/test-hosts.js` | The store's test, plain Node |
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
| `native/shellops.cpp`, `host/bin/shellops.dll` (+ `.json`) | `so_drop`: drops files onto whatever is under the pointer as a real drag-and-drop (see Gotchas). Committed like `capture.dll` |
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

1. client -> host topic: `{t:'hello', sid, ts, mode, codec}` (`codec` optional: `H264`, `H264HQ`, `VP9`, `AV1`)
2. host -> client topic: `{t:'offer', sid, ts, sdp, ice, audio, codec, cursorHidden, app, os, monitors:[{idx, mid, x, y, width, height, primary, hdr?}]}`
   (`os`: `{os: 'windows'|'linux'|'mac', name, pc}`, what the host runs, e.g. `Windows 10` or `Ubuntu 22.04.5 LTS`, and from 0.4.0 the computer's name (`os.hostname()`); the arrangement panel shows them with a logo, the client app's list keeps them)
   (`x`,`y`,`width`,`height` are the monitor's rectangle on the host's virtual desktop, physical pixels)
3. client -> host topic: `{t:'answer', sid, ts, sdp}`

The host appends `x-google-start-bitrate` to the answer's video codec parameters so the bandwidth
estimate does not start near 300 kbps. ICE is non-trickle (candidates are gathered before sending). The host rejects messages older than five
minutes or without a numeric `ts`, a `sid` over 64 characters, and replayed `sid` values; the sids it
took are kept in the host page's localStorage (`mr_host_seen`) for as long as they could pass the
five-minute test, so a restart does not forget them. A new `hello` replaces the current session: a
session is current from its hello on, a teardown during its setup closes what it has, and the host
ends a session as soon as its input channel closes.

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
| both | `clip` | Clipboard text, at most 60000 chars (see "The clipboard is shared both ways") |
| client -> host | `text` | `s`: characters typed on a phone's keyboard, at most 400 at a time; the host types them as characters (Windows `KEYEVENTF_UNICODE`; X11 keycodes lent to their keysyms, typed over time with later input held back), whatever its layout and input method |
| host -> client | `lock` | `on`, `why`: `lock` (the host's session is locked) or `secure` (a UAC prompt or another secure desktop has the screen). Sent when a session starts and when it changes; the client says so over the picture |
| host -> client | `cur` | Current host cursor: `c` = CSS cursor name, or `img` (PNG data URL) with hotspot `hx`,`hy` for an app-specific cursor. The host page asks main about 30 times a second and passes the cursor it has, so the picture is copied over IPC only when it changes |
| host -> client | `hs` | Host-side statistics every 2 s (codec and `from`, whose choice it was: `client` (the 진단 dialog, kept in the client's localStorage `mr_codec`), `config` or `auto`; encoder, bitrate, per-monitor capture/encode fps and limiting factor) for the client's diagnostics report; the host's diagnostics log gets the same |
| host -> client | `drag` | `on`: whether a drag-and-drop is under way on the host. An X11 host sends it once more with `what`: `{kind:'files', n, name}` (the number of files and the first one's name, no path) or `{kind:'text'}`, for the client app's picture at the pointer while it is carried out |
| host -> client | `dragdata` | Answer to `dragout`: `kind` `text` (`s`, `cut`), `files` (`files:[{id,name,size,dir?}]`, `skipped`; the bytes follow on the `file` channel; `name` may be a path 'folder/sub/file') or `none` with `why`: `nodrag`, `nocopy`, `empty`, `toobig` |
| host -> client | `clipfiles` | Files were copied on the host during the session: `seq` (the clipboard's change count), `n` items, `dirs` of them folders, `bytes` of the plain files, `names` (at most 3, no paths). Files already on the clipboard when the session began are not announced, nor files the client sent itself (a paste, or a drop nothing took: they lie in the host's inbox), which it would otherwise fetch back |
| client -> host | `clipget` | Fetch the files of `clipfiles` `seq`; refused (`dragdata` `none`, `why:'changed'`) when the clipboard changed since. The answer is a `dragdata` with `clip: true`, the bytes on a `file` channel as for dragging out. The client asks when focus leaves all of its windows (the person went to the client's own programs to paste), at most 512 MB, the app only; the files go onto the client's clipboard |
| host -> client | `others` | `crd`: a Chrome Remote Desktop session is connected to the host as well (`remoting_desktop.exe` runs); `outline`: the host drags windows as an outline only. Checked every 10 s, sent when it changes; the client shows a warning. Both are checked on Windows only (elsewhere always false). The process list is a Toolhelp snapshot taken on a koffi worker thread (`input.processRunning`; about 67 ms for 479 processes on the test PC, so never on the main thread), not `tasklist` |
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
  puts it where the loader keeps a remembered key (`mr_key`) and, when the person had not asked to keep
  it there, leaves a mark (`mr_forget_key`, in the tab's sessionStorage and next to the key in
  localStorage) so that the new page removes it at once - or, when the tab was closed before the new
  page started, the page that starts next. sessionStorage `mr_respread` brings the spread windows back afterwards (the app; a browser is
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
nothing while the screen stays the same (a real session of 2026-11-12: 627 "freezes", 385 s, in an
hour of normal use). Counters run per connection. An entry may carry `slow`: main-process
calls that took over 50 ms since the previous entry (`input mm`, `clip-read`, `clip-files`,
`drag clipboard` (reading the clipboard waits for its owner), `cursor`, ...) and
`paused` (the main thread itself did not run for over a second), each as count, total and longest ms.
The client's input is injected on that thread, so a stall there is a stall of every click. Entries
written many at once after a gap mean the same. `released`: buttons the host let go because the
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
