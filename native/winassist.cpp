// My Remote's Windows "assist" service: lets the authorized remote person see and use the HOST's
// secure desktop - above all the lock screen - which a normal-user process cannot touch.
//
// WHAT THIS IS, AND IS NOT. The lock screen, the logon screen and User Account Control prompts are
// drawn on Windows' "Winlogon" (secure) desktop, which only a process running as LocalSystem may open,
// capture or inject input into. This service, installed once with administrator rights, provides that
// LocalSystem reach so the remote person can:
//   - SEE the lock screen and TYPE THEIR OWN PASSWORD to unlock it (authentication is NOT bypassed:
//     the person still proves who they are, exactly as at the keyboard);
//   - SEE a UAC consent prompt (VIEW ONLY: no input is injected there).
// Input into the secure desktop is allowed ONLY while the session is LOCKED. A UAC consent prompt is
// never typed into or clicked: letting the remote side answer "Yes" to a consent prompt would let any
// program running as the same user raise itself to administrator without the person, so the helper
// refuses input whenever the secure desktop is up but the session is not locked. This is enforced here,
// in the LocalSystem helper, not only in the user-level host.
//
// It is the same architecture Chrome Remote Desktop, RustDesk and UltraVNC use for unattended access.
// It does nothing on the ordinary desktop (the user-level host captures and injects there itself); it
// only steps in while a secure desktop has the screen. The service is idle until the running host asks
// for it.
//
// Shape:
//   winassist.exe install | uninstall          copy to %ProgramFiles%\MyRemote and register / stop,
//                                               unregister and delete it  (must run elevated)
//   winassist.exe status                        is it installed and running
//   winassist.exe grab <file.bmp>               DEBUG: capture the current input desktop to a BMP
//                                               (run elevated to catch a secure desktop); no service
//   winassist.exe grabmon <prefix>              DEBUG: the same for every monitor, as the helper sends
//                                               them ('R'): <prefix>-<n>.bmp
//   winassist.exe                               service entry point (started by the Service Manager)
//   winassist.exe helper <sessionId>            the in-session worker the service spawns as SYSTEM
//
// The service runs from %ProgramFiles%\MyRemote (only administrators can write there): a LocalSystem
// service whose program lies in a folder the user can write to would let any program of the user replace
// it and run as SYSTEM. Its log is kept next to it for the same reason (not in ProgramData, where a user
// can plant a link where SYSTEM then writes).
//
// Built by native/build.js on the Linux build server (mingw-w64) into host/bin/winassist.exe, committed
// with its source-hash record like the DLLs, so the self-test can confirm the SYSTEM binary is exactly
// this audited source. It links nothing but Windows itself.
//
// Host <-> service <-> helper:
//   - The user-level host connects to the service's control pipe and asks for the helper ('S'); it keeps
//     that pipe open for as long as it wants the helper.
//   - A session-0 service cannot see the console session's desktops, so it only keeps one helper running
//     as LocalSystem IN the active console session (re-spawned after a session change or when it dies).
//   - The helper follows the input desktop itself (Default <-> Winlogon), creates the data pipe (it is the
//     server, first instance only, so nothing can hold that name before it), tells the host which desktop
//     has the screen and whether the session is locked, sends the secure desktop's frames (GDI), and
//     injects the input the host sends back - only while the session is locked (see above).

#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <sddl.h>
#include <wtsapi32.h>
#include <userenv.h>
#include <stdio.h>
#include <stdint.h>

#define SVC_NAME L"MyRemoteAssist"
#define SVC_DISPLAY L"My Remote Assist"
#define CONTROL_PIPE L"\\\\.\\pipe\\my-remote-assist"
#define DATA_PIPE L"\\\\.\\pipe\\my-remote-assist-data"
// The control pipe only asks for a helper, which is harmless: the interactive user, administrators,
// LocalSystem may use it. The data pipe (pictures of the secure desktop, keys typed into the lock screen)
// is the session's own user's only: see sessionUserSddl().
#define CONTROL_SDDL L"D:(A;;GA;;;IU)(A;;GA;;;BA)(A;;GA;;;SY)"
// The host's first message on the control pipe is 'S'; the answer is "ok" and this byte. Raise it when
// the data-pipe protocol below changes incompatibly, so a host and an installed service of different
// versions know. Additions an older host would not understand go behind a capability byte instead (the
// answer's fourth byte, which hosts that know only protocol 1 never read): ASSIST_CAPS.
#define ASSIST_PROTOCOL 1
// 'M': the helper sends every monitor ('R' frames) once the host asks for it with 'V' (from 2026-11-18).
// A service without it answers three bytes, and its helper must never be sent 'V' (it ends on any tag it
// does not know).
#define ASSIST_CAPS 'M'
// At most this many monitors, and pictures of at most 64 MB (the host's limit too).
#define MAX_MONS 16
#define MAX_FRAME_BYTES (64 * 1024 * 1024)

// The cross-compiler's wtsapi32.h (mingw-w64, GCC 10) predates WTSSessionInfoEx / WTSINFOEXW, which tell
// us whether the session is locked. Declare them here exactly as the Windows SDK does (same layout, so
// the OS fills the fields we read). Guarded in case a newer toolchain already has them.
#ifndef WTS_SESSIONSTATE_LOCK
#define WTS_SESSIONSTATE_LOCK 0
#define WTS_SESSIONSTATE_UNLOCK 1
#define WTSSessionInfoEx ((WTS_INFO_CLASS)25)
typedef struct _WTSINFOEX_LEVEL1_W {
  ULONG SessionId;
  WTS_CONNECTSTATE_CLASS SessionState;
  LONG SessionFlags;
  WCHAR WinStationName[33];
  WCHAR UserName[21];
  WCHAR DomainName[18];
  LARGE_INTEGER LogonTime;
  LARGE_INTEGER ConnectTime;
  LARGE_INTEGER DisconnectTime;
  LARGE_INTEGER LastInputTime;
  LARGE_INTEGER CurrentTime;
  DWORD IncomingBytes;
  DWORD OutgoingBytes;
  DWORD IncomingFrames;
  DWORD OutgoingFrames;
  DWORD IncomingCompressedBytes;
  DWORD OutgoingCompressedBytes;
} WTSINFOEX_LEVEL1_W;
typedef union _WTSINFOEX_LEVEL_W { WTSINFOEX_LEVEL1_W WTSInfoExLevel1; } WTSINFOEX_LEVEL_W;
typedef struct _WTSINFOEXW { DWORD Level; WTSINFOEX_LEVEL_W Data; } WTSINFOEXW;
#endif

// ---- small helpers ----------------------------------------------------------------------
// The folder this program runs from (no trailing backslash).
static bool selfDir(wchar_t* dir, DWORD cap) {
  DWORD n = GetModuleFileNameW(nullptr, dir, cap);
  if (!n || n >= cap) return false;
  wchar_t* slash = wcsrchr(dir, L'\\');
  if (!slash) return false;
  *slash = 0;
  return true;
}
static void logline(const char* s) { // assist.log next to the program (Program Files when installed); harmless if it cannot
  wchar_t dir[MAX_PATH];
  if (!selfDir(dir, MAX_PATH)) return;
  wchar_t path[MAX_PATH];
  _snwprintf_s(path, MAX_PATH, _TRUNCATE, L"%ls\\assist.log", dir);
  HANDLE f = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return;
  SYSTEMTIME t; GetLocalTime(&t);
  char line[600]; int k = _snprintf_s(line, sizeof line, _TRUNCATE, "%02d:%02d:%02d %s\r\n", t.wHour, t.wMinute, t.wSecond, s);
  DWORD wrote; if (k > 0) WriteFile(f, line, (DWORD)k, &wrote, nullptr);
  CloseHandle(f);
}

// Read/write exactly n bytes of the data pipe, which is opened for overlapped I/O: the reader thread
// waits for the host's input while the main thread sends pictures. On a handle without
// FILE_FLAG_OVERLAPPED, Windows runs the I/O of one file object one at a time, so the main thread's
// writes waited behind the reader's ReadFile and no state ever reached the host until it typed
// something (found in the test VM). `ev` is the calling thread's own manual-reset event.
// false on error, close or cancel (CancelIoEx).
static bool pipeIo(HANDLE h, void* buf, DWORD n, bool write, HANDLE ev) {
  DWORD done = 0;
  while (done < n) {
    OVERLAPPED ov; ZeroMemory(&ov, sizeof ov); ov.hEvent = ev; ResetEvent(ev);
    BOOL ok = write ? WriteFile(h, (const char*)buf + done, n - done, nullptr, &ov) : ReadFile(h, (char*)buf + done, n - done, nullptr, &ov);
    if (!ok && GetLastError() != ERROR_IO_PENDING) return false;
    DWORD got = 0;
    if (!GetOverlappedResult(h, &ov, &got, TRUE) || got == 0) return false;
    done += got;
  }
  return true;
}
static bool readAll(HANDLE h, void* buf, DWORD n, HANDLE ev) { return pipeIo(h, buf, n, false, ev); }
static bool writeAll(HANDLE h, const void* buf, DWORD n, HANDLE ev) { return pipeIo(h, (void*)buf, n, true, ev); }

// ---- desktop capture (GDI) --------------------------------------------------------------
// Captures the desktop the calling thread is attached to. The thread must already be on the input
// desktop (SetThreadDesktop) for a secure desktop to be caught. Returns a top-down BGRA buffer.
struct Frame { int w, h; uint8_t* bgra; };
// The rectangle (x, y, w, h) of `screen` into a top-down BGRA buffer (`reuse` when it is big enough).
static bool blit(HDC screen, int x, int y, int w, int h, Frame& out, uint8_t* reuse, int reuseCap) {
  if (w <= 0 || h <= 0 || (int64_t)w * h * 4 > MAX_FRAME_BYTES) return false;
  bool ok = false;
  HDC mem = CreateCompatibleDC(screen);
  HBITMAP bmp = CreateCompatibleBitmap(screen, w, h);
  if (mem && bmp) {
    HGDIOBJ old = SelectObject(mem, bmp);
    if (BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY)) {
      BITMAPINFO bi; ZeroMemory(&bi, sizeof bi);
      bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
      bi.bmiHeader.biWidth = w; bi.bmiHeader.biHeight = -h; // top-down
      bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32; bi.bmiHeader.biCompression = BI_RGB;
      int need = w * h * 4;
      uint8_t* buf = (reuse && reuseCap >= need) ? reuse : (uint8_t*)malloc(need);
      if (buf && GetDIBits(mem, bmp, 0, h, buf, &bi, DIB_RGB_COLORS) == h) {
        out.w = w; out.h = h; out.bgra = buf; ok = true;
      } else if (buf && buf != reuse) free(buf);
    }
    SelectObject(mem, old);
  }
  if (bmp) DeleteObject(bmp);
  if (mem) DeleteDC(mem);
  return ok;
}
// The primary monitor (what hosts of protocol 1 without 'V' get).
static bool capture(Frame& out, uint8_t* reuse, int reuseCap) {
  HDC screen = CreateDCW(L"DISPLAY", nullptr, nullptr, nullptr);
  if (!screen) return false;
  bool ok = blit(screen, 0, 0, GetDeviceCaps(screen, HORZRES), GetDeviceCaps(screen, VERTRES), out, reuse, reuseCap);
  DeleteDC(screen);
  return ok;
}
// A rectangle of the whole virtual screen, in the coordinates EnumDisplayMonitors gives (0,0 is the
// primary's top left; physical pixels, see dpiAware).
static bool captureRect(const RECT& r, Frame& out, uint8_t* reuse, int reuseCap) {
  HDC screen = GetDC(nullptr); // the thread's desktop, all monitors
  if (!screen) return false;
  bool ok = blit(screen, r.left, r.top, r.right - r.left, r.bottom - r.top, out, reuse, reuseCap);
  ReleaseDC(nullptr, screen);
  return ok;
}
// Every monitor's rectangle, at most `cap`. -> how many
static int monitorRects(RECT* out, int cap) {
  struct Ctx { RECT* out; int cap, n; } c = { out, cap, 0 };
  EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR, HDC, LPRECT r, LPARAM p) -> BOOL {
    Ctx* c = (Ctx*)p;
    if (r && c->n < c->cap) c->out[c->n++] = *r;
    return TRUE;
  }, (LPARAM)&c);
  return c.n;
}
// Real pixels on every monitor, as the host counts them (Electron's physical rectangles): per-monitor aware
// (Windows 10 1703 and later), else system aware (the primary in real pixels, as before).
typedef BOOL(WINAPI* SetDpiCtxFn)(HANDLE);
static void dpiAware() {
  SetDpiCtxFn set = (SetDpiCtxFn)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext");
  if (!set || !set((HANDLE)(intptr_t)-4 /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 */)) SetProcessDPIAware();
}

// ---- the data-pipe protocol between helper and host -------------------------------------
// Every message: 1 tag byte, then a fixed little-endian body. Frames carry their pixels after the body.
//   helper -> host:
//     'S' state: u8 flags  (bit0 secure desktop, bit1 session locked, bit2 input is accepted)
//     'F' frame: u16 w, u16 h, u32 bytes, then <bytes> of top-down BGRA   (the primary monitor)
//     'R' frame of one monitor: i32 x, i32 y, u16 w, u16 h, u32 bytes, then <bytes> of top-down BGRA;
//         x, y = its top left on the virtual screen in physical pixels. Instead of 'F', once 'V' came.
//   host -> helper:
//     'V' send every monitor ('R'), from now on   (no body; any time, it shows nothing new: only sent
//         when the service's answer had ASSIST_CAPS)
//   host -> helper (only honoured while input is accepted):
//     'M' mouse: u32 flags, i32 x, i32 y, i32 data   (SendInput MOUSEINPUT; x,y are 0..65535 absolute)
//     'K' key:   u16 vk, u16 scan, u32 flags          (SendInput KEYBDINPUT)
//     'A' secure attention sequence (Ctrl+Alt+Del)    (no body)
// Before the host sends anything typed, it checks that the pipe's server process
// (GetNamedPipeServerProcessId) is %ProgramFiles%\MyRemote\winassist.exe: a pipe of the same name made by
// someone else first would otherwise receive the password typed into the lock screen (this helper then
// fails to start, thanks to FILE_FLAG_FIRST_PIPE_INSTANCE, and logs why).
#pragma pack(push, 1)
struct MouseMsg { uint32_t flags; int32_t x, y, data; };
struct KeyMsg { uint16_t vk, scan; uint32_t flags; };
#pragma pack(pop)

typedef BOOL(WINAPI* SendInputFn)(UINT, LPINPUT, int);
typedef VOID(WINAPI* SendSASFn)(BOOL);

// Is the active console session locked? WTSINFOEX tells us; the lock state is what separates "the lock
// screen" (type the password, input allowed) from "a UAC consent prompt on the secure desktop" (view only).
static bool sessionLocked(DWORD session) {
  bool locked = false;
  LPWSTR info = nullptr; DWORD bytes = 0;
  if (WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session, WTSSessionInfoEx, &info, &bytes) && info && bytes >= sizeof(WTSINFOEXW)) {
    WTSINFOEXW* ex = (WTSINFOEXW*)info;
    if (ex->Level == 1) {
      LONG f = ex->Data.WTSInfoExLevel1.SessionFlags;
      // Fail closed: "locked" is what lets input through, so only a clear WTS_SESSIONSTATE_LOCK counts.
      // Unknown (-1) or anything else is "not locked": a UAC prompt is then view-only, as it must be.
      // (Windows 7/2008 R2 reported the two values swapped; this program needs Windows 10 or later.)
      locked = (f == WTS_SESSIONSTATE_LOCK);
    }
  }
  if (info) WTSFreeMemory(info);
  return locked;
}

// The name of the desktop that currently has the input (e.g. "Default" or "Winlogon").
static bool inputDesktopName(wchar_t* name, DWORD cap) {
  HDESK d = OpenInputDesktop(0, FALSE, GENERIC_READ);
  if (!d) return false;
  DWORD need = 0;
  BOOL ok = GetUserObjectInformationW(d, UOI_NAME, name, cap * sizeof(wchar_t), &need);
  CloseDesktop(d);
  return ok != 0;
}

// Put the calling thread on the desktop that has the input now. Desktops are per thread: capture and
// SendInput reach only the thread's own desktop, and SendInput is refused unless that is the input
// desktop. `cur` is the handle the thread is on; the old one is closed after the switch.
static void followInputDesktop(HDESK& cur) {
  HDESK d = OpenInputDesktop(0, FALSE, GENERIC_ALL);
  if (!d) return;
  if (SetThreadDesktop(d)) { if (cur) CloseDesktop(cur); cur = d; }
  else CloseDesktop(d);
}

// The data pipe's security descriptor: LocalSystem and the user signed in to this session, nobody else.
// As SYSTEM (spawned by the service) the user is the session's (WTSQueryUserToken needs SeTcbPrivilege,
// which only SYSTEM has); run by hand for a test, it is whoever runs it.
static bool sessionUserSddl(DWORD session, wchar_t* sddl, size_t cap) {
  HANDLE tok = nullptr;
  if (!WTSQueryUserToken(session, &tok) && !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) return false;
  bool ok = false;
  DWORD need = 0;
  GetTokenInformation(tok, TokenUser, nullptr, 0, &need);
  TOKEN_USER* tu = need ? (TOKEN_USER*)malloc(need) : nullptr;
  if (tu && GetTokenInformation(tok, TokenUser, tu, need, &need)) {
    LPWSTR sid = nullptr;
    if (ConvertSidToStringSidW(tu->User.Sid, &sid)) {
      _snwprintf_s(sddl, cap, _TRUNCATE, L"D:P(A;;GA;;;SY)(A;;GA;;;%ls)", sid);
      LocalFree(sid);
      ok = true;
    }
  }
  free(tu);
  CloseHandle(tok);
  return ok;
}

// ---- the helper: runs as SYSTEM in the console session, follows the input desktop ------------------
static int runHelper(DWORD session) {
  // Real pixels, not the 96-dpi picture Windows gives a program that does not say it knows about scaling.
  dpiAware();
  // Pin this thread to the input desktop so capture reaches the secure desktop.
  HDESK input = nullptr;
  followInputDesktop(input);

  HMODULE u32 = GetModuleHandleW(L"user32.dll");
  SendInputFn sendInput = (SendInputFn)GetProcAddress(u32, "SendInput");
  HMODULE sas = LoadLibraryW(L"sas.dll");
  SendSASFn sendSAS = sas ? (SendSASFn)GetProcAddress(sas, "SendSAS") : nullptr;

  // The helper owns the data pipe (SYSTEM), with a security descriptor that lets the person's host
  // connect; the host is the client. A fresh instance each time the service re-spawns the helper.
  // FIRST_PIPE_INSTANCE: if any other program already holds this name, fail instead of sharing it (the
  // host must never send a lock-screen password to a pipe someone else made). Byte mode: the reader takes
  // a message apart field by field, which a message-mode pipe answers with ERROR_MORE_DATA.
  // Only this session's user (and LocalSystem) may connect: another account on this PC (fast user
  // switching) must not see the lock screen or receive the password typed into it.
  wchar_t sddl[256];
  if (!sessionUserSddl(session, sddl, 256)) wcscpy_s(sddl, 256, L"D:P(A;;GA;;;SY)");
  SECURITY_ATTRIBUTES sa; ZeroMemory(&sa, sizeof sa); sa.nLength = sizeof sa;
  ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &sa.lpSecurityDescriptor, nullptr);
  HANDLE pipe = CreateNamedPipeW(DATA_PIPE, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                                 PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 1 << 20, 1 << 20, 0, &sa);
  if (sa.lpSecurityDescriptor) LocalFree(sa.lpSecurityDescriptor);
  if (pipe == INVALID_HANDLE_VALUE) { char m[80]; _snprintf_s(m, sizeof m, _TRUNCATE, "helper: could not create the data pipe (%lu)", GetLastError()); logline(m); return 1; }
  logline("helper: waiting for the host");
  // Wait for the host to connect (the service ends this process when the host lets go of the control pipe).
  HANDLE wev = CreateEventW(nullptr, TRUE, FALSE, nullptr); // the main thread's (connect, then writes)
  BOOL connected = FALSE;
  {
    OVERLAPPED cov; ZeroMemory(&cov, sizeof cov); cov.hEvent = wev;
    if (ConnectNamedPipe(pipe, &cov)) connected = TRUE;
    else if (GetLastError() == ERROR_PIPE_CONNECTED) connected = TRUE;
    else if (GetLastError() == ERROR_IO_PENDING) { DWORD n; connected = GetOverlappedResult(pipe, &cov, &n, TRUE); }
  }
  if (!connected) { CloseHandle(wev); CloseHandle(pipe); logline("helper: no host connected"); return 1; }
  logline("helper: host connected");

  // A thread reads input from the host and injects it; the main thread captures and sends frames.
  struct Shared { HANDLE pipe; DWORD session; SendInputFn sendInput; SendSASFn sendSAS; volatile LONG stop; volatile LONG multi; } sh = { pipe, session, sendInput, sendSAS, 0, 0 };
  HANDLE reader = CreateThread(nullptr, 0, [](LPVOID p) -> DWORD {
    Shared* s = (Shared*)p;
    HDESK mine = nullptr; // this thread's own desktop: a new thread starts on the process's, not the input one
    HANDLE rev = CreateEventW(nullptr, TRUE, FALSE, nullptr); // this thread's own, for its reads
    uint8_t tag;
    while (!s->stop && rev && readAll(s->pipe, &tag, 1, rev)) {
      // Input is honoured only while the session is locked (never on a UAC consent prompt).
      bool allow = sessionLocked(s->session);
      if (allow) followInputDesktop(mine);
      if (tag == 'M') {
        MouseMsg m; if (!readAll(s->pipe, &m, sizeof m, rev)) break;
        if (allow && s->sendInput) { INPUT in; ZeroMemory(&in, sizeof in); in.type = INPUT_MOUSE; in.mi.dwFlags = m.flags; in.mi.dx = m.x; in.mi.dy = m.y; in.mi.mouseData = m.data; s->sendInput(1, &in, sizeof in); }
      } else if (tag == 'K') {
        KeyMsg k; if (!readAll(s->pipe, &k, sizeof k, rev)) break;
        if (allow && s->sendInput) { INPUT in; ZeroMemory(&in, sizeof in); in.type = INPUT_KEYBOARD; in.ki.wVk = k.vk; in.ki.wScan = k.scan; in.ki.dwFlags = k.flags; s->sendInput(1, &in, sizeof in); }
      } else if (tag == 'A') {
        if (allow && s->sendSAS) s->sendSAS(FALSE);
      } else if (tag == 'V') {
        InterlockedExchange(&s->multi, 1); // every monitor from now on (pictures only: nothing to allow)
      } else break;
    }
    s->stop = 1;
    if (rev) CloseHandle(rev);
    if (mine) CloseDesktop(mine);
    return 0;
  }, &sh, 0, nullptr);

  uint8_t* buf = nullptr; int cap = 0, lastW = 0, lastH = 0; uint8_t lastState = 0xff;
  uint8_t* prev = nullptr; int prevCap = 0;
  // Every monitor ('V'): its rectangle and the last picture sent of it (mlen 0: send it again).
  RECT mrect[MAX_MONS]; int mons = 0;
  uint8_t* mprev[MAX_MONS] = {}; int mcap[MAX_MONS] = {}, mlen[MAX_MONS] = {};
  int tick = 0;
  while (!sh.stop) {
    // Keep following the input desktop (Default <-> Winlogon).
    followInputDesktop(input);

    bool secure = false; wchar_t dn[128];
    if (inputDesktopName(dn, 128)) secure = (_wcsicmp(dn, L"Default") != 0);
    bool locked = sessionLocked(session);
    uint8_t state = (secure ? 1 : 0) | (locked ? 2 : 0) | ((secure && locked) ? 4 : 0);
    if (state != lastState) {
      uint8_t hdr[2] = { 'S', state }; if (!writeAll(pipe, hdr, 2, wev)) break;
      lastState = state; lastW = lastH = 0;
      for (int k = 0; k < MAX_MONS; k++) mlen[k] = 0;
    }

    // Only a secure desktop is this helper's to send; on the ordinary desktop the host captures itself.
    Frame f;
    if (!secure) { Sleep(150); tick++; continue; }
    if (sh.multi) {
      // Every monitor, each sent when it changed (the lock screen's password box is on one of them, its
      // clock changes once a minute) and an unchanged one every 3 s. A new arrangement: all of them again.
      RECT r[MAX_MONS]; int n = monitorRects(r, MAX_MONS);
      if (n != mons || memcmp(r, mrect, n * sizeof(RECT)) != 0) {
        mons = n; memcpy(mrect, r, n * sizeof(RECT));
        for (int k = 0; k < MAX_MONS; k++) mlen[k] = 0;
      }
      bool broken = false;
      for (int k = 0; k < mons && !sh.stop; k++) {
        if (!captureRect(mrect[k], f, buf, cap)) continue;
        if (f.bgra != buf) { free(buf); buf = f.bgra; cap = f.w * f.h * 4; }
        int bytes = f.w * f.h * 4;
        bool changed = mlen[k] != bytes || memcmp(mprev[k], buf, bytes) != 0;
        if (!changed && (tick % 30) != 0) continue;
        uint8_t hdr[17]; hdr[0] = 'R';
        *(int32_t*)(hdr + 1) = (int32_t)mrect[k].left; *(int32_t*)(hdr + 5) = (int32_t)mrect[k].top;
        *(uint16_t*)(hdr + 9) = (uint16_t)f.w; *(uint16_t*)(hdr + 11) = (uint16_t)f.h; *(uint32_t*)(hdr + 13) = (uint32_t)bytes;
        if (!writeAll(pipe, hdr, 17, wev) || !writeAll(pipe, buf, bytes, wev)) { broken = true; break; }
        if (mcap[k] < bytes) { free(mprev[k]); mprev[k] = (uint8_t*)malloc(bytes); mcap[k] = mprev[k] ? bytes : 0; }
        if (mprev[k]) { memcpy(mprev[k], buf, bytes); mlen[k] = bytes; } else mlen[k] = 0;
      }
      if (broken) break;
    } else if (capture(f, buf, cap)) {
      if (f.bgra != buf) { free(buf); buf = f.bgra; cap = f.w * f.h * 4; }
      int bytes = f.w * f.h * 4;
      bool changed = (f.w != lastW || f.h != lastH) || !prev || memcmp(prev, buf, bytes) != 0;
      // Send a changed frame at once; an unchanged one about once a second so a late connection catches up.
      if (changed || (tick % 10) == 0) {
        uint8_t hdr[9]; hdr[0] = 'F';
        *(uint16_t*)(hdr + 1) = (uint16_t)f.w; *(uint16_t*)(hdr + 3) = (uint16_t)f.h; *(uint32_t*)(hdr + 5) = (uint32_t)bytes;
        if (!writeAll(pipe, hdr, 9, wev) || !writeAll(pipe, buf, bytes, wev)) break;
        if (prevCap < bytes) { free(prev); prev = (uint8_t*)malloc(bytes); prevCap = prev ? bytes : 0; }
        if (prev) memcpy(prev, buf, bytes);
        lastW = f.w; lastH = f.h;
      }
    }
    tick++;
    Sleep(100); // about 10 frames a second; the secure desktop barely moves
  }
  sh.stop = 1;
  CancelIoEx(pipe, nullptr); // the reader's pending read ends with an error and the thread returns
  if (reader) { WaitForSingleObject(reader, 2000); CloseHandle(reader); }
  free(buf); free(prev);
  for (int k = 0; k < MAX_MONS; k++) free(mprev[k]);
  CloseHandle(wev);
  CloseHandle(pipe);
  if (input) CloseDesktop(input);
  logline("helper: host gone");
  return 0;
}

// ---- the service: follow the input desktop, keep a helper on any secure one -------------------------
static SERVICE_STATUS_HANDLE g_statusHandle = nullptr;
static SERVICE_STATUS g_status = {};
static volatile LONG g_stop = 0;

static void setState(DWORD state) {
  g_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  g_status.dwCurrentState = state;
  g_status.dwControlsAccepted = (state == SERVICE_RUNNING) ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
  g_status.dwWin32ExitCode = NO_ERROR;
  g_status.dwWaitHint = 3000;
  if (g_statusHandle) SetServiceStatus(g_statusHandle, &g_status);
}

// A token for the active console session's user, LocalSystem but placed in that session, to launch the
// helper there. (The helper must run in the user's session to reach its desktops; a session-0 service
// cannot capture or inject on another session's desktop.)
static HANDLE systemTokenForSession(DWORD session) {
  HANDLE self = nullptr, dup = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID, &self)) return nullptr;
  if (DuplicateTokenEx(self, MAXIMUM_ALLOWED, nullptr, SecurityImpersonation, TokenPrimary, &dup)) {
    if (!SetTokenInformation(dup, TokenSessionId, &session, sizeof session)) { CloseHandle(dup); dup = nullptr; }
  }
  CloseHandle(self);
  return dup;
}

// Launch winassist.exe helper <session> as LocalSystem in the session, on the current input desktop.
static HANDLE spawnHelper(DWORD session) {
  HANDLE token = systemTokenForSession(session);
  if (!token) { logline("service: no session token"); return nullptr; }
  wchar_t exe[MAX_PATH]; GetModuleFileNameW(nullptr, exe, MAX_PATH);
  wchar_t cmd[MAX_PATH + 64];
  _snwprintf_s(cmd, _countof(cmd), _TRUNCATE, L"\"%ls\" helper %lu", exe, session);
  STARTUPINFOW si; ZeroMemory(&si, sizeof si); si.cb = sizeof si;
  wchar_t desktop[] = L"winsta0\\default"; si.lpDesktop = desktop; // overridden by the helper's own OpenInputDesktop
  LPVOID env = nullptr; CreateEnvironmentBlock(&env, token, FALSE);
  PROCESS_INFORMATION pi; ZeroMemory(&pi, sizeof pi);
  BOOL ok = CreateProcessAsUserW(token, nullptr, cmd, nullptr, nullptr, FALSE,
                                 CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env, nullptr, &si, &pi);
  if (env) DestroyEnvironmentBlock(env);
  CloseHandle(token);
  if (!ok) { char m[80]; _snprintf_s(m, sizeof m, _TRUNCATE, "service: CreateProcessAsUser failed %lu", GetLastError()); logline(m); return nullptr; }
  CloseHandle(pi.hThread);
  return pi.hProcess;
}

// One connected host: keep exactly one helper alive in the active console session. A session-0 service
// cannot see or open the console session's desktops itself, so it does not try to detect the lock
// screen; it only ensures a helper runs IN the session. The helper, being in the session, follows the
// input desktop (Default <-> Winlogon) on its own and tells the host which one has the screen, sending
// the secure desktop's frames and accepting input only while the session is locked (see runHelper).
static void serveHost(HANDLE control) {
  HANDLE helper = nullptr; DWORD onSession = 0xFFFFFFFF;
  while (!g_stop) {
    // Stop keeping a helper alive the moment the host lets go of the control pipe.
    char peek; DWORD avail = 0, got = 0;
    if (!PeekNamedPipe(control, &peek, 0, &got, &avail, nullptr)) break;
    DWORD session = WTSGetActiveConsoleSessionId();
    bool helperDead = helper && WaitForSingleObject(helper, 0) == WAIT_OBJECT_0;
    if (helperDead) { CloseHandle(helper); helper = nullptr; }
    if (session != 0xFFFFFFFF) {
      // (Re)spawn when none runs or the console session changed (fast user switch, sign-out/in).
      if (!helper || session != onSession) {
        if (helper) { TerminateProcess(helper, 0); CloseHandle(helper); helper = nullptr; }
        helper = spawnHelper(session);
        onSession = session;
        if (helper) logline("service: helper in the console session");
        else Sleep(1000); // a session with no console yet (the logon screen before anyone signs in): try again
      }
    }
    Sleep(500);
  }
  if (helper) { TerminateProcess(helper, 0); CloseHandle(helper); }
}

// The control pipe: a host connects, names its data pipe (a path under \\.\pipe\), and the service
// serves it until it disconnects. One host at a time (a PC has one person at its secure desktop).
static void controlLoop() {
  while (!g_stop) {
    // Only an administrator or the interactive user may connect (they are the one at this PC).
    SECURITY_ATTRIBUTES sa; ZeroMemory(&sa, sizeof sa); sa.nLength = sizeof sa;
    ConvertStringSecurityDescriptorToSecurityDescriptorW(CONTROL_SDDL, SDDL_REVISION_1, &sa.lpSecurityDescriptor, nullptr);
    HANDLE pipe = CreateNamedPipeW(CONTROL_PIPE, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                   PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, &sa);
    if (sa.lpSecurityDescriptor) LocalFree(sa.lpSecurityDescriptor);
    if (pipe == INVALID_HANDLE_VALUE) { Sleep(500); continue; }
    BOOL connected = ConnectNamedPipe(pipe, nullptr) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
    if (connected && !g_stop) {
      // The host asks to start the secure-desktop helper with one byte, 'S'.
      char req = 0; DWORD got = 0;
      if (ReadFile(pipe, &req, 1, &got, nullptr) && got == 1 && req == 'S') {
        // One write: a host reads the four bytes at once (one that knows only protocol 1 reads three).
        const char ok[4] = { 'o', 'k', ASSIST_PROTOCOL, ASSIST_CAPS }; DWORD put; WriteFile(pipe, ok, 4, &put, nullptr);
        logline("service: a host asked for the secure-desktop helper");
        serveHost(pipe); // keeps a helper alive until the host disconnects or the service stops
      }
    }
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
  }
}

static DWORD WINAPI onControl(DWORD code, DWORD, LPVOID, LPVOID) {
  if (code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN) {
    InterlockedExchange(&g_stop, 1);
    setState(SERVICE_STOP_PENDING);
    // controlLoop may be waiting in ConnectNamedPipe: connect once ourselves so it wakes and sees g_stop.
    HANDLE h = CreateFileW(CONTROL_PIPE, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
  }
  return NO_ERROR;
}
static VOID WINAPI serviceMain(DWORD, LPWSTR*) {
  g_statusHandle = RegisterServiceCtrlHandlerExW(SVC_NAME, onControl, nullptr);
  if (!g_statusHandle) return;
  setState(SERVICE_START_PENDING);
  setState(SERVICE_RUNNING);
  logline("service: running");
  controlLoop();
  setState(SERVICE_STOPPED);
}

// ---- install / uninstall / status -------------------------------------------------------
// %ProgramFiles%\MyRemote and the program's path in it.
static bool installPaths(wchar_t* dir, wchar_t* exe) {
  wchar_t pf[MAX_PATH];
  DWORD n = GetEnvironmentVariableW(L"ProgramFiles", pf, MAX_PATH);
  if (!n || n >= MAX_PATH) return false;
  _snwprintf_s(dir, MAX_PATH, _TRUNCATE, L"%ls\\MyRemote", pf);
  _snwprintf_s(exe, MAX_PATH, _TRUNCATE, L"%ls\\winassist.exe", dir);
  return true;
}
static int installService() {
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_ALL_ACCESS);
  if (!scm) { printf("open SCM failed (%lu); run as administrator\n", GetLastError()); return 1; }
  // The service runs from a folder only administrators can write to (see the top of this file).
  wchar_t dir[MAX_PATH], exe[MAX_PATH], self[MAX_PATH];
  if (!installPaths(dir, exe) || !GetModuleFileNameW(nullptr, self, MAX_PATH)) { printf("no Program Files folder\n"); CloseServiceHandle(scm); return 1; }
  CreateDirectoryW(dir, nullptr);
  // Installed already (a newer app brings a newer program): stop it, so that its program and its helper
  // let go of the file, replace the program, start it again.
  SC_HANDLE svc = OpenServiceW(scm, SVC_NAME, SERVICE_ALL_ACCESS);
  bool update = svc != nullptr;
  if (svc) {
    SERVICE_STATUS st; ControlService(svc, SERVICE_CONTROL_STOP, &st);
    for (int i = 0; i < 100 && QueryServiceStatus(svc, &st) && st.dwCurrentState != SERVICE_STOPPED; i++) Sleep(100);
  }
  bool copied = _wcsicmp(self, exe) == 0;
  for (int i = 0; i < 30 && !copied; i++) { copied = CopyFileW(self, exe, FALSE) != 0; if (!copied) Sleep(100); } // a helper may take a moment to end
  if (!copied) { printf("copy to %ls failed (%lu)\n", exe, GetLastError()); if (svc) { StartServiceW(svc, 0, nullptr); CloseServiceHandle(svc); } CloseServiceHandle(scm); return 1; }
  if (!svc) {
    wchar_t bin[MAX_PATH + 2]; _snwprintf_s(bin, _countof(bin), _TRUNCATE, L"\"%ls\"", exe);
    svc = CreateServiceW(scm, SVC_NAME, SVC_DISPLAY, SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS,
                         SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, bin, nullptr, nullptr, nullptr, nullptr, nullptr);
    if (!svc) { printf("create service failed (%lu)\n", GetLastError()); CloseServiceHandle(scm); return 1; }
    SERVICE_DESCRIPTIONW d; d.lpDescription = (LPWSTR)L"Lets My Remote show and use this PC's lock screen for the authorized remote user. Idle until a session asks for it.";
    ChangeServiceConfig2W(svc, SERVICE_CONFIG_DESCRIPTION, &d);
  }
  if (!StartServiceW(svc, 0, nullptr) && GetLastError() != ERROR_SERVICE_ALREADY_RUNNING) {
    printf("start failed (%lu)\n", GetLastError()); CloseServiceHandle(svc); CloseServiceHandle(scm); return 1;
  }
  printf(update ? "updated and started\n" : "installed and started\n");
  CloseServiceHandle(svc); CloseServiceHandle(scm);
  return 0;
}
static int uninstallService() {
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_ALL_ACCESS);
  if (!scm) { printf("open SCM failed (%lu); run as administrator\n", GetLastError()); return 1; }
  SC_HANDLE svc = OpenServiceW(scm, SVC_NAME, SERVICE_ALL_ACCESS);
  if (!svc) { printf("not installed\n"); CloseServiceHandle(scm); return 0; }
  SERVICE_STATUS st; ControlService(svc, SERVICE_CONTROL_STOP, &st);
  for (int i = 0; i < 50 && QueryServiceStatus(svc, &st) && st.dwCurrentState != SERVICE_STOPPED; i++) Sleep(100);
  if (!DeleteService(svc)) printf("delete failed (%lu)\n", GetLastError()); else printf("removed\n");
  CloseServiceHandle(svc); CloseServiceHandle(scm);
  // Remove the installed program, its log and the folder (a file still in use goes at the next restart).
  wchar_t dir[MAX_PATH], exe[MAX_PATH], log[MAX_PATH];
  if (installPaths(dir, exe)) {
    _snwprintf_s(log, MAX_PATH, _TRUNCATE, L"%ls\\assist.log", dir);
    DeleteFileW(log);
    if (!DeleteFileW(exe)) MoveFileExW(exe, nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);
    RemoveDirectoryW(dir);
  }
  return 0;
}
static int statusService() {
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  if (!scm) { printf("not-installed\n"); return 1; }
  SC_HANDLE svc = OpenServiceW(scm, SVC_NAME, SERVICE_QUERY_STATUS);
  int rc = 1;
  if (svc) {
    SERVICE_STATUS st;
    if (QueryServiceStatus(svc, &st)) { printf(st.dwCurrentState == SERVICE_RUNNING ? "running\n" : "installed\n"); rc = 0; }
    CloseServiceHandle(svc);
  } else printf("not-installed\n");
  CloseServiceHandle(scm);
  return rc;
}

// ---- grab: capture the current input desktop to a BMP (debugging; no service) ------------
static bool writeBmp(const wchar_t* file, const Frame& f) {
  BITMAPFILEHEADER fh; ZeroMemory(&fh, sizeof fh); fh.bfType = 0x4D42;
  BITMAPINFOHEADER ih; ZeroMemory(&ih, sizeof ih);
  ih.biSize = sizeof ih; ih.biWidth = f.w; ih.biHeight = -f.h; ih.biPlanes = 1; ih.biBitCount = 32; ih.biCompression = BI_RGB;
  int bytes = f.w * f.h * 4;
  fh.bfOffBits = sizeof fh + sizeof ih; fh.bfSize = fh.bfOffBits + bytes;
  HANDLE out = CreateFileW(file, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (out == INVALID_HANDLE_VALUE) { printf("cannot write %ls (%lu)\n", file, GetLastError()); return false; }
  DWORD w; WriteFile(out, &fh, sizeof fh, &w, nullptr); WriteFile(out, &ih, sizeof ih, &w, nullptr); WriteFile(out, f.bgra, bytes, &w, nullptr);
  CloseHandle(out);
  return true;
}
static int grab(const wchar_t* file) {
  dpiAware();
  HDESK input = nullptr;
  followInputDesktop(input);
  Frame f;
  if (!capture(f, nullptr, 0)) { printf("capture failed (%lu); for a secure desktop run elevated\n", GetLastError()); return 1; }
  int rc = writeBmp(file, f) ? 0 : 1;
  if (!rc) printf("wrote %dx%d\n", f.w, f.h);
  free(f.bgra);
  if (input) CloseDesktop(input);
  return rc;
}
// Every monitor as the helper sends them after 'V': <prefix>-<n>.bmp, and each one's rectangle printed.
static int grabMonitors(const wchar_t* prefix) {
  dpiAware();
  HDESK input = nullptr;
  followInputDesktop(input);
  RECT r[MAX_MONS]; int n = monitorRects(r, MAX_MONS), rc = n ? 0 : 1;
  for (int k = 0; k < n; k++) {
    Frame f;
    if (!captureRect(r[k], f, nullptr, 0)) { printf("monitor %d: capture failed (%lu)\n", k, GetLastError()); rc = 1; continue; }
    wchar_t file[MAX_PATH]; _snwprintf_s(file, MAX_PATH, _TRUNCATE, L"%ls-%d.bmp", prefix, k);
    if (writeBmp(file, f)) printf("monitor %d: %ld,%ld %dx%d\n", k, r[k].left, r[k].top, f.w, f.h); else rc = 1;
    free(f.bgra);
  }
  if (input) CloseDesktop(input);
  return rc;
}

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2) {
    if (_wcsicmp(argv[1], L"install") == 0) return installService();
    if (_wcsicmp(argv[1], L"uninstall") == 0) return uninstallService();
    if (_wcsicmp(argv[1], L"status") == 0) return statusService();
    if (_wcsicmp(argv[1], L"grab") == 0 && argc >= 3) return grab(argv[2]);
    if (_wcsicmp(argv[1], L"grabmon") == 0 && argc >= 3) return grabMonitors(argv[2]);
    if (_wcsicmp(argv[1], L"helper") == 0 && argc >= 3) return runHelper((DWORD)_wtoi(argv[2]));
    printf("usage: winassist.exe install | uninstall | status | grab <file.bmp> | grabmon <prefix>\n");
    return 2;
  }
  // No arguments: the Service Manager is starting us.
  SERVICE_TABLE_ENTRYW table[] = { { (LPWSTR)SVC_NAME, serviceMain }, { nullptr, nullptr } };
  if (!StartServiceCtrlDispatcherW(table)) {
    printf("this is a Windows service; use: winassist.exe install\n");
    return 1;
  }
  return 0;
}
