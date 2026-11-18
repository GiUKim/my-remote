// Screen capture for the host: DXGI Desktop Duplication, one capturer per monitor.
//
// Why not the browser engine's own capturer: measured on the same frames, it hands a frame to the
// encoder 13 to 14 ms after Windows presented it and delivers 45 to 50 of 75 frames a second;
// Desktop Duplication used directly has the frame within a fraction of a millisecond and misses
// almost none. The image it gives also has no mouse pointer in it, so the host does not have to
// hide the pointer on its own screen.
//
// Built as a DLL (native/build.js) and loaded by host/preload.js through koffi. mc_next is meant
// to be called on a worker thread: it waits for the next desktop image and copies it out as
// 4 bytes per pixel (blue, green, red, unused), top row first. It only reads the screen.
#define _WIN32_WINNT 0x0A00 // Windows 10 and later
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

#define EXPORT extern "C" __declspec(dllexport)

struct Capturer {
  bool used;
  SRWLOCK lock;
  int slot;            // its handle, which is also its place in g_kept
  int px, py;          // a point of the desktop inside the monitor, in physical pixels (from mc_open)
  IDXGIOutput1* output; ID3D11Device* device; ID3D11DeviceContext* context; IDXGIOutputDuplication* dup; ID3D11Texture2D* staging;
  int width, height;   // of the desktop image
  int stagingW, stagingH;
  // While the image cannot be had: tries that failed in a row, when to try next, and since when the
  // tries have failed for a reason other than another desktop having the screen (0: they have not).
  int failures; LONGLONG retryAt, failingSince;
  union { RECT dirty[256]; DXGI_OUTDUPL_MOVE_RECT moved[170]; } meta; // what changed with a frame
  int adapter;         // the monitor's adapter, in DXGI's order (0: the one Chromium draws with, as a rule)
  ID3D11Query* done;   // mc_next_gpu: tells when the copy into a shared texture is finished
};
static Capturer g_caps[8];
// The graphics device of each capturer handle outlives mc_close: the next mc_open of that handle (the
// next session opens its monitors in the same order) takes it over while it is on the same adapter and
// still works. Destroying a device that had received duplicated frames left one section and one mutex
// behind in this process every time (150 open/close pairs, 150 of each; none when the device is kept),
// and making a device costs time at every session start. Each handle has its own, so a device context
// is never used by two capturers.
struct Kept { LUID luid; ID3D11Device* device; ID3D11DeviceContext* context; };
static Kept g_kept[8];
static SRWLOCK g_table = SRWLOCK_INIT;
static char g_error[200] = "";
// A capture that keeps failing is tried again for this long before mc_next gives up (-4) and the
// host goes on with the engine's capturer. The time another desktop has the screen (the lock screen,
// a permission prompt, another user's session) does not count: that can last for hours, ends by
// itself, and no capturer of this user could read it meanwhile.
static const double GIVE_UP_MS = 10000;

// One clock: the performance counter, anchored once to the system time (ms since 1970). Windows
// reports presentation times as performance counter values, so they convert exactly.
static double g_baseMs = 0, g_tickMs = 0;
static LONGLONG g_baseTick = 0;
static LONGLONG tick() { LARGE_INTEGER t; QueryPerformanceCounter(&t); return t.QuadPart; }
static double toMs(LONGLONG t) { return g_baseMs + (double)(t - g_baseTick) * g_tickMs; }
static void initClock() {
  if (g_tickMs != 0) return;
  LARGE_INTEGER f; QueryPerformanceFrequency(&f);
  FILETIME ft;
  LONGLONG a = tick(); GetSystemTimePreciseAsFileTime(&ft); LONGLONG b = tick();
  ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
  g_baseMs = (double)(t - 116444736000000000ULL) / 10000.0;
  g_baseTick = (a + b) / 2;
  g_tickMs = 1000.0 / (double)f.QuadPart;
}
static void fail(const char* what, HRESULT hr) { snprintf(g_error, sizeof g_error, "%s (0x%08lx)", what, (unsigned long)hr); }
template <class T> static void drop(T*& p) { if (p) { p->Release(); p = nullptr; } }
// The lock screen, a permission prompt (UAC) or another user's session has the screen.
static bool elsewhere(HRESULT hr) { return hr == E_ACCESSDENIED || hr == DXGI_ERROR_SESSION_DISCONNECTED; }
// For the self-test only (mc_test_elsewhere): every new duplication fails as on the lock screen.
static volatile LONG g_testElsewhere = 0;

// (Re)starts the duplication of the capturer's output. Fails e.g. while the lock screen or a
// permission prompt has the screen.
static HRESULT duplicate(Capturer& c) {
  drop(c.dup);
  HRESULT hr = g_testElsewhere ? E_ACCESSDENIED : c.output->DuplicateOutput(c.device, &c.dup);
  if (FAILED(hr)) { fail(elsewhere(hr) ? "another desktop has the screen (lock screen, permission prompt, other session)" : "DuplicateOutput", hr); return hr; }
  DXGI_OUTDUPL_DESC d; c.dup->GetDesc(&d);
  if (d.Rotation != DXGI_MODE_ROTATION_IDENTITY && d.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) { fail("the monitor is rotated", E_NOTIMPL); drop(c.dup); return E_NOTIMPL; }
  c.width = (int)d.ModeDesc.Width; c.height = (int)d.ModeDesc.Height;
  return S_OK;
}
// Lets go of the duplication and of this capturer's hold on the graphics device (the device itself is
// kept for the next capturer of this handle, see g_kept), to start over or for good.
static void release(Capturer& c) { drop(c.done); drop(c.staging); drop(c.dup); drop(c.context); drop(c.device); drop(c.output); }
static void forget(Kept& k) { drop(k.context); drop(k.device); }
static void closeAll(Capturer& c) {
  if (c.context) { c.context->ClearState(); c.context->Flush(); } // the kept device holds on to nothing of this capturer's
  release(c);
  c.used = false;
}

// Finds the monitor at the capturer's point, makes a graphics device and starts the duplication.
// What it made stays in c also when a later step failed.
static HRESULT start(Capturer& c) {
  release(c);
  IDXGIFactory1* factory = nullptr; IDXGIAdapter1* adapter = nullptr; IDXGIOutput* output = nullptr;
  HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
  bool found = false;
  if (FAILED(hr)) fail("CreateDXGIFactory1", hr);
  for (UINT a = 0; SUCCEEDED(hr) && !found && factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; a++) {
    for (UINT o = 0; !found && adapter->EnumOutputs(o, &output) != DXGI_ERROR_NOT_FOUND; o++) {
      DXGI_OUTPUT_DESC d; output->GetDesc(&d);
      const RECT& r = d.DesktopCoordinates;
      found = d.AttachedToDesktop && c.px >= r.left && c.px < r.right && c.py >= r.top && c.py < r.bottom;
      if (found) c.adapter = (int)a;
      if (!found) drop(output);
    }
    if (!found) drop(adapter);
  }
  if (SUCCEEDED(hr) && !found) { hr = E_FAIL; fail("no monitor at that point", hr); }
  // The device must be on the adapter the monitor hangs on (a PC can have several). The one kept for
  // this handle is taken when it is on that adapter and was not removed (a reset of the graphics card).
  if (SUCCEEDED(hr)) {
    DXGI_ADAPTER_DESC1 ad = {};
    adapter->GetDesc1(&ad);
    Kept& k = g_kept[c.slot];
    if (k.device && (memcmp(&k.luid, &ad.AdapterLuid, sizeof ad.AdapterLuid) != 0 || k.device->GetDeviceRemovedReason() != S_OK)) forget(k);
    if (!k.device) {
      hr = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &k.device, nullptr, &k.context);
      if (FAILED(hr)) { fail("D3D11CreateDevice", hr); forget(k); } else k.luid = ad.AdapterLuid;
    }
    if (SUCCEEDED(hr)) { c.device = k.device; c.device->AddRef(); c.context = k.context; c.context->AddRef(); }
  }
  if (SUCCEEDED(hr)) { hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&c.output); if (FAILED(hr)) fail("IDXGIOutput1", hr); }
  if (SUCCEEDED(hr)) hr = duplicate(c);
  drop(output); drop(adapter); drop(factory);
  return hr;
}

// After a failure. Windows takes the duplication away on every desktop switch (lock screen,
// permission prompt), mode change and full-screen program; then only the duplication is made again.
// After anything else, or when the graphics device is gone (a reset of the graphics card, a driver
// restart: a removed device never works again), the next try starts over with a new device. The
// first try is at once, later ones less and less often. True when the tries have failed for
// GIVE_UP_MS, not counting time on another desktop.
static bool setback(Capturer& c, HRESULT hr) {
  const bool device = c.device && c.output && c.device->GetDeviceRemovedReason() == S_OK;
  if (device && (hr == DXGI_ERROR_ACCESS_LOST || elsewhere(hr))) drop(c.dup); else release(c);
  static const int waitMs[] = { 0, 50, 100, 200, 500, 1000 };
  const LONGLONG now = tick();
  c.retryAt = now + (LONGLONG)(waitMs[c.failures < 5 ? c.failures : 5] / g_tickMs);
  c.failures++;
  if (elsewhere(hr)) { c.failingSince = 0; return false; }
  if (!c.failingSince) c.failingSince = now;
  return (double)(now - c.failingSince) * g_tickMs >= GIVE_UP_MS;
}
static void working(Capturer& c) { c.failures = 0; c.failingSince = 0; }

// The share of the image that changed with this frame, 0..1: the areas Windows reports as drawn anew
// (dirty rectangles) and as moved there (move rectangles). Overlaps count twice, so it can come out
// too large but not too small; 1 when Windows does not say or says more than fits here.
static double changedShare(Capturer& c, const DXGI_OUTDUPL_FRAME_INFO& fi) {
  const double all = (double)c.width * c.height;
  if (all <= 0 || fi.TotalMetadataBufferSize == 0 || fi.TotalMetadataBufferSize > sizeof c.meta) return 1;
  double area = 0;
  UINT n = 0;
  if (FAILED(c.dup->GetFrameMoveRects(sizeof c.meta, c.meta.moved, &n))) return 1;
  for (UINT i = 0; i < n / sizeof *c.meta.moved; i++) { const RECT& r = c.meta.moved[i].DestinationRect; area += (double)(r.right - r.left) * (r.bottom - r.top); }
  if (FAILED(c.dup->GetFrameDirtyRects(sizeof c.meta, c.meta.dirty, &n))) return 1;
  for (UINT i = 0; i < n / sizeof *c.meta.dirty; i++) { const RECT& r = c.meta.dirty[i]; area += (double)(r.right - r.left) * (r.bottom - r.top); }
  return area >= all ? 1 : area / all;
}

// Starts capturing the monitor that contains the desktop point (px,py), in physical pixels.
// Returns a handle (0..7), or -1 (see mc_error). While another desktop has the screen (the lock
// screen, a permission prompt) the monitor is opened all the same, at its size on the desktop, and
// mc_next returns 2 until the screen can be read, as when that happens during a capture. Before, a host
// reached while its PC was locked could not start a session at all (the engine's capturer cannot read
// that screen either), and the assist service's pictures of the lock screen need the session's track.
EXPORT int mc_open(int px, int py) {
  initClock();
  AcquireSRWLockExclusive(&g_table);
  int handle = -1;
  for (int i = 0; i < 8 && handle < 0; i++) if (!g_caps[i].used) handle = i;
  if (handle < 0) { snprintf(g_error, sizeof g_error, "too many capturers"); ReleaseSRWLockExclusive(&g_table); return -1; }
  Capturer& c = g_caps[handle];
  memset(&c, 0, sizeof c);
  InitializeSRWLock(&c.lock);
  c.slot = handle;
  c.px = px; c.py = py;
  const HRESULT hr = start(c);
  DXGI_OUTPUT_DESC d;
  if (SUCCEEDED(hr)) c.used = true;
  else if (elsewhere(hr) && c.output && c.device && SUCCEEDED(c.output->GetDesc(&d))) {
    c.width = (int)(d.DesktopCoordinates.right - d.DesktopCoordinates.left);
    c.height = (int)(d.DesktopCoordinates.bottom - d.DesktopCoordinates.top);
    setback(c, hr); // the first try is at once; time on another desktop never counts towards GIVE_UP_MS
    c.used = true;
  } else { closeAll(c); handle = -1; }
  ReleaseSRWLockExclusive(&g_table);
  return handle;
}

// Size of the monitor's image in pixels. Returns 0, or 2 when the screen cannot be read yet (another
// desktop had it when the capturer was opened, see mc_open), -1 for a handle that is not open.
EXPORT int mc_size(int handle, int* width, int* height) {
  if (handle < 0 || handle >= 8 || !g_caps[handle].used) return -1;
  *width = g_caps[handle].width; *height = g_caps[handle].height;
  return g_caps[handle].dup ? 0 : 2;
}

// Waits up to timeoutMs for the next desktop image and copies it into dst (width*height*4 bytes).
// Returns 1: a new image was copied; info = { presented, handed over, copied (ms since 1970), images
// Windows composed since the last call, share of the image that changed (0..1) }.  0: nothing new in
// that time (or only the pointer moved).  2: the screen cannot be read right now (the lock screen or a
// permission prompt has it, or the capture is being started again after a mode change or a reset of
// the graphics card); the next calls go on trying, mc_error says why.  -1: closed.  -2: the pixel
// format is not 8 bits per colour (a monitor in HDR mode).  -3: the size changed, ask mc_size again.
// -4: the capture could not be started again for GIVE_UP_MS (see mc_error).
EXPORT int mc_next(int handle, unsigned char* dst, int dstLen, int timeoutMs, double* info) {
  if (handle < 0 || handle >= 8) return -1;
  Capturer& c = g_caps[handle];
  AcquireSRWLockExclusive(&c.lock);
  int result = 0;
  const LONGLONG deadline = tick() + (LONGLONG)(timeoutMs / g_tickMs);
  while (c.used) {
    const LONGLONG now = tick();
    const int left = (int)((deadline - now) * g_tickMs);
    if (left <= 0) break;
    if (!c.dup) {
      // Lost earlier: try again when it is time.
      if (now < c.retryAt) { const int wait = (int)((c.retryAt - now) * g_tickMs) + 1; Sleep(wait < left ? wait : left); continue; }
      const int w = c.width, h = c.height;
      const HRESULT hr = c.device ? duplicate(c) : start(c);
      if (FAILED(hr)) { if (setback(c, hr)) { result = -4; break; } continue; }
      if (c.width != w || c.height != h) { result = -3; break; }
    }
    DXGI_OUTDUPL_FRAME_INFO fi; IDXGIResource* resource = nullptr;
    HRESULT hr = c.dup->AcquireNextFrame(left, &fi, &resource);
    const LONGLONG handed = tick();
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
      // A still screen, unless the graphics device is gone: then nothing comes any more.
      hr = c.device->GetDeviceRemovedReason();
      if (hr == S_OK) { working(c); break; }
      fail("the graphics device was removed", hr);
      if (setback(c, hr)) { result = -4; break; }
      continue;
    }
    if (FAILED(hr)) {
      fail(hr == DXGI_ERROR_ACCESS_LOST ? "the duplication was lost (desktop switch, mode change)" : "AcquireNextFrame", hr);
      if (setback(c, hr)) { result = -4; break; }
      continue;
    }
    if (fi.LastPresentTime.QuadPart == 0) { drop(resource); c.dup->ReleaseFrame(); continue; } // only the pointer moved
    const double changed = changedShare(c, fi);
    ID3D11Texture2D* image = nullptr;
    hr = resource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&image);
    D3D11_TEXTURE2D_DESC td = {};
    if (SUCCEEDED(hr)) image->GetDesc(&td);
    const bool bytes = td.Format == DXGI_FORMAT_B8G8R8A8_UNORM || td.Format == DXGI_FORMAT_B8G8R8X8_UNORM;
    if (SUCCEEDED(hr) && bytes && (!c.staging || c.stagingW != (int)td.Width || c.stagingH != (int)td.Height)) {
      drop(c.staging);
      D3D11_TEXTURE2D_DESC sd = td;
      sd.Usage = D3D11_USAGE_STAGING; sd.BindFlags = 0; sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ; sd.MiscFlags = 0; sd.MipLevels = 1; sd.ArraySize = 1; sd.SampleDesc.Count = 1; sd.SampleDesc.Quality = 0;
      hr = c.device->CreateTexture2D(&sd, nullptr, &c.staging);
      c.stagingW = (int)td.Width; c.stagingH = (int)td.Height;
    }
    // The copy to the staging texture is queued on the graphics card; the frame can be given back at once.
    if (SUCCEEDED(hr) && bytes) c.context->CopyResource(c.staging, image);
    drop(image); drop(resource);
    c.dup->ReleaseFrame();
    // A new duplication starts with the current desktop image, so this one is not lost for good.
    if (FAILED(hr)) { fail("reading the desktop image", hr); if (setback(c, hr)) { result = -4; break; } continue; }
    if (!bytes) { result = -2; fail("the monitor is not in an 8 bit colour mode (HDR?)", E_NOTIMPL); break; }
    if ((int)td.Width != c.width || (int)td.Height != c.height || dstLen < c.width * c.height * 4) { c.width = (int)td.Width; c.height = (int)td.Height; result = -3; break; }
    D3D11_MAPPED_SUBRESOURCE m;
    hr = c.context->Map(c.staging, 0, D3D11_MAP_READ, 0, &m); // waits for the copy to finish
    if (FAILED(hr)) { fail("Map", hr); if (setback(c, hr)) { result = -4; break; } continue; }
    const int rowBytes = c.width * 4;
    if ((int)m.RowPitch == rowBytes) memcpy(dst, m.pData, (size_t)rowBytes * c.height);
    else for (int y = 0; y < c.height; y++) memcpy(dst + (size_t)y * rowBytes, (const unsigned char*)m.pData + (size_t)y * m.RowPitch, rowBytes);
    c.context->Unmap(c.staging, 0);
    info[0] = toMs(fi.LastPresentTime.QuadPart); info[1] = toMs(handed); info[2] = toMs(tick()); info[3] = (double)fi.AccumulatedFrames; info[4] = changed;
    working(c);
    result = 1;
    break;
  }
  if (!c.used) result = -1;
  else if (result == 0 && !c.dup) result = 2; // still trying
  ReleaseSRWLockExclusive(&c.lock);
  return result;
}

EXPORT void mc_close(int handle) {
  if (handle < 0 || handle >= 8) return;
  Capturer& c = g_caps[handle];
  AcquireSRWLockExclusive(&c.lock); // waits for a call of mc_next that is under way
  if (c.used) closeAll(c);
  ReleaseSRWLockExclusive(&c.lock);
}
// ---- GPU hand-over: an experiment (2026-11-18), used only when the host's config says capture: 'gpu' -----
// mc_next's loop, but the image is not read back: it is copied, on the graphics card, into a texture of its
// own shared by an NT handle, which the page's process imports with Electron's sharedTexture as a VideoFrame
// that stays on the graphics card. Every image gets a new texture that is never written again: the encoder
// may read it later than anything here can know. The handle is this process's; Chromium duplicates it while
// importing, and mc_gpu_done then lets go of ours and of the texture. Kept here meanwhile (at most
// GPU_PENDING; the oldest is let go when more come, which only happens when the caller forgets).
#define GPU_PENDING 32
static struct { HANDLE h; ID3D11Texture2D* tex; } g_pending[GPU_PENDING];
static int g_pendNext = 0;
static SRWLOCK g_pendLock = SRWLOCK_INIT;
static void pendingAdd(HANDLE h, ID3D11Texture2D* tex) {
  AcquireSRWLockExclusive(&g_pendLock);
  auto& p = g_pending[g_pendNext];
  if (p.h) { CloseHandle(p.h); drop(p.tex); }
  p.h = h; p.tex = tex;
  g_pendNext = (g_pendNext + 1) % GPU_PENDING;
  ReleaseSRWLockExclusive(&g_pendLock);
}
EXPORT void mc_gpu_done(unsigned long long shared) {
  AcquireSRWLockExclusive(&g_pendLock);
  for (auto& p : g_pending) if (p.h && (unsigned long long)(uintptr_t)p.h == shared) { CloseHandle(p.h); drop(p.tex); p.h = nullptr; }
  ReleaseSRWLockExclusive(&g_pendLock);
}
// The adapter of a capturer's monitor in DXGI's order, -1 for a handle that is not open. A texture can only
// be shared with Chromium's device when both are on the same adapter.
EXPORT int mc_adapter(int handle) { return handle < 0 || handle >= 8 || !g_caps[handle].used ? -1 : g_caps[handle].adapter; }
// As mc_next, with *shared the NT handle of the image's texture instead of its pixels; -5: no shared texture
// could be made (the caller goes back to mc_next).
EXPORT int mc_next_gpu(int handle, int timeoutMs, double* info, unsigned long long* shared) {
  if (handle < 0 || handle >= 8) return -1;
  *shared = 0;
  Capturer& c = g_caps[handle];
  AcquireSRWLockExclusive(&c.lock);
  int result = 0;
  const LONGLONG deadline = tick() + (LONGLONG)(timeoutMs / g_tickMs);
  while (c.used) {
    const LONGLONG now = tick();
    const int left = (int)((deadline - now) * g_tickMs);
    if (left <= 0) break;
    if (!c.dup) {
      if (now < c.retryAt) { const int wait = (int)((c.retryAt - now) * g_tickMs) + 1; Sleep(wait < left ? wait : left); continue; }
      const int w = c.width, h = c.height;
      const HRESULT hr = c.device ? duplicate(c) : start(c);
      if (FAILED(hr)) { if (setback(c, hr)) { result = -4; break; } continue; }
      if (c.width != w || c.height != h) { result = -3; break; }
    }
    DXGI_OUTDUPL_FRAME_INFO fi; IDXGIResource* resource = nullptr;
    HRESULT hr = c.dup->AcquireNextFrame(left, &fi, &resource);
    const LONGLONG handed = tick();
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
      hr = c.device->GetDeviceRemovedReason();
      if (hr == S_OK) { working(c); break; }
      fail("the graphics device was removed", hr);
      if (setback(c, hr)) { result = -4; break; }
      continue;
    }
    if (FAILED(hr)) {
      fail(hr == DXGI_ERROR_ACCESS_LOST ? "the duplication was lost (desktop switch, mode change)" : "AcquireNextFrame", hr);
      if (setback(c, hr)) { result = -4; break; }
      continue;
    }
    if (fi.LastPresentTime.QuadPart == 0) { drop(resource); c.dup->ReleaseFrame(); continue; }
    const double changed = changedShare(c, fi);
    ID3D11Texture2D* image = nullptr;
    hr = resource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&image);
    D3D11_TEXTURE2D_DESC td = {};
    if (SUCCEEDED(hr)) image->GetDesc(&td);
    const bool bytes = td.Format == DXGI_FORMAT_B8G8R8A8_UNORM || td.Format == DXGI_FORMAT_B8G8R8X8_UNORM;
    ID3D11Texture2D* tex = nullptr;
    HRESULT made = E_FAIL;
    if (SUCCEEDED(hr) && bytes && (int)td.Width == c.width && (int)td.Height == c.height) {
      D3D11_TEXTURE2D_DESC sd = {};
      sd.Width = td.Width; sd.Height = td.Height; sd.MipLevels = 1; sd.ArraySize = 1; sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      sd.SampleDesc.Count = 1; sd.Usage = D3D11_USAGE_DEFAULT; sd.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
      sd.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
      made = c.device->CreateTexture2D(&sd, nullptr, &tex);
      if (SUCCEEDED(made)) c.context->CopyResource(tex, image);
    }
    drop(image); drop(resource);
    c.dup->ReleaseFrame();
    if (FAILED(hr)) { drop(tex); fail("reading the desktop image", hr); if (setback(c, hr)) { result = -4; break; } continue; }
    if (!bytes) { drop(tex); result = -2; fail("the monitor is not in an 8 bit colour mode (HDR?)", E_NOTIMPL); break; }
    if ((int)td.Width != c.width || (int)td.Height != c.height) { drop(tex); c.width = (int)td.Width; c.height = (int)td.Height; result = -3; break; }
    if (FAILED(made)) { fail("CreateTexture2D (shared)", made); result = -5; break; }
    HANDLE h = nullptr; IDXGIResource1* r1 = nullptr;
    HRESULT sh = tex->QueryInterface(__uuidof(IDXGIResource1), (void**)&r1);
    if (SUCCEEDED(sh)) sh = r1->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &h);
    drop(r1);
    // The copy is finished before the texture is handed over: Chromium reads it with a device of its own.
    if (SUCCEEDED(sh) && !c.done) { D3D11_QUERY_DESC qd = {}; qd.Query = D3D11_QUERY_EVENT; sh = c.device->CreateQuery(&qd, &c.done); }
    if (SUCCEEDED(sh)) {
      c.context->End(c.done);
      c.context->Flush();
      const LONGLONG until = tick() + (LONGLONG)(100 / g_tickMs);
      while (c.context->GetData(c.done, nullptr, 0, 0) == S_FALSE && tick() < until) SwitchToThread();
    }
    if (FAILED(sh) || !h) { if (h) CloseHandle(h); drop(tex); fail("sharing the image", sh); result = -5; break; }
    pendingAdd(h, tex);
    *shared = (unsigned long long)(uintptr_t)h;
    info[0] = toMs(fi.LastPresentTime.QuadPart); info[1] = toMs(handed); info[2] = toMs(tick()); info[3] = (double)fi.AccumulatedFrames; info[4] = changed;
    working(c);
    result = 1;
    break;
  }
  if (!c.used) result = -1;
  else if (result == 0 && !c.dup) result = 2;
  ReleaseSRWLockExclusive(&c.lock);
  return result;
}

EXPORT double mc_now(void) { initClock(); return toMs(tick()); }
EXPORT const char* mc_error(void) { return g_error; }

// For the self-test only: acts as if Windows had taken the duplication away (what 1: as on the lock
// screen or a mode change) or the graphics device (2: as on a reset of the graphics card), so that
// the way back can be tested without either. 3: as 2, and the monitor does not come back: the next
// mc_next gives up (-4) without waiting GIVE_UP_MS.
EXPORT void mc_test_lose(int handle, int what) {
  if (handle < 0 || handle >= 8) return;
  Capturer& c = g_caps[handle];
  AcquireSRWLockExclusive(&c.lock);
  if (c.used) {
    if (what == 1) drop(c.dup); else { release(c); forget(g_kept[handle]); } // a lost device is not kept either
    if (what == 3) { c.px = c.py = INT_MIN; c.failingSince = tick() - (LONGLONG)(GIVE_UP_MS / g_tickMs) - 1; }
  }
  ReleaseSRWLockExclusive(&c.lock);
}
// For the self-test only: while on, every new duplication fails as while the lock screen has the screen
// (a capturer opened meanwhile waits, see mc_open), so that a session started on a locked PC can be
// tested without locking it. Capturers that are running go on until their duplication is lost.
EXPORT void mc_test_elsewhere(int on) { InterlockedExchange(&g_testElsewhere, on ? 1 : 0); }
