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
#include <stdio.h>
#include <string.h>

#define EXPORT extern "C" __declspec(dllexport)

struct Capturer {
  bool used;
  SRWLOCK lock;
  IDXGIOutput1* output; ID3D11Device* device; ID3D11DeviceContext* context; IDXGIOutputDuplication* dup; ID3D11Texture2D* staging;
  int width, height;   // of the desktop image
  int stagingW, stagingH;
};
static Capturer g_caps[8];
static SRWLOCK g_table = SRWLOCK_INIT;
static char g_error[200] = "";

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

// (Re)starts the duplication of the capturer's output. False while that is not possible, e.g.
// while the lock screen or a permission prompt has the screen.
static bool duplicate(Capturer& c) {
  drop(c.dup);
  HRESULT hr = c.output->DuplicateOutput(c.device, &c.dup);
  if (FAILED(hr)) { fail("DuplicateOutput", hr); return false; }
  DXGI_OUTDUPL_DESC d; c.dup->GetDesc(&d);
  if (d.Rotation != DXGI_MODE_ROTATION_IDENTITY && d.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) { fail("the monitor is rotated", E_NOTIMPL); drop(c.dup); return false; }
  c.width = (int)d.ModeDesc.Width; c.height = (int)d.ModeDesc.Height;
  return true;
}
static void closeAll(Capturer& c) { drop(c.staging); drop(c.dup); drop(c.context); drop(c.device); drop(c.output); c.used = false; }

// Starts capturing the monitor that contains the desktop point (px,py), in physical pixels.
// Returns a handle (0..7), or -1 (see mc_error).
EXPORT int mc_open(int px, int py) {
  initClock();
  AcquireSRWLockExclusive(&g_table);
  int handle = -1;
  for (int i = 0; i < 8 && handle < 0; i++) if (!g_caps[i].used) handle = i;
  if (handle < 0) { snprintf(g_error, sizeof g_error, "too many capturers"); ReleaseSRWLockExclusive(&g_table); return -1; }
  Capturer& c = g_caps[handle];
  memset(&c, 0, sizeof c);
  InitializeSRWLock(&c.lock);
  IDXGIFactory1* factory = nullptr; IDXGIAdapter1* adapter = nullptr; IDXGIOutput* output = nullptr;
  HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
  bool found = false;
  if (FAILED(hr)) fail("CreateDXGIFactory1", hr);
  for (UINT a = 0; SUCCEEDED(hr) && !found && factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; a++) {
    for (UINT o = 0; !found && adapter->EnumOutputs(o, &output) != DXGI_ERROR_NOT_FOUND; o++) {
      DXGI_OUTPUT_DESC d; output->GetDesc(&d);
      const RECT& r = d.DesktopCoordinates;
      found = d.AttachedToDesktop && px >= r.left && px < r.right && py >= r.top && py < r.bottom;
      if (!found) drop(output);
    }
    if (!found) drop(adapter);
  }
  if (SUCCEEDED(hr) && !found) { hr = E_FAIL; fail("no monitor at that point", hr); }
  // The device must be on the adapter the monitor hangs on (a PC can have several).
  if (SUCCEEDED(hr)) { hr = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &c.device, nullptr, &c.context); if (FAILED(hr)) fail("D3D11CreateDevice", hr); }
  if (SUCCEEDED(hr)) { hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&c.output); if (FAILED(hr)) fail("IDXGIOutput1", hr); }
  if (SUCCEEDED(hr) && !duplicate(c)) hr = E_FAIL;
  drop(output); drop(adapter); drop(factory);
  if (FAILED(hr)) { closeAll(c); handle = -1; } else c.used = true;
  ReleaseSRWLockExclusive(&g_table);
  return handle;
}

// Size of the monitor's image in pixels.
EXPORT int mc_size(int handle, int* width, int* height) {
  if (handle < 0 || handle >= 8 || !g_caps[handle].used) return -1;
  *width = g_caps[handle].width; *height = g_caps[handle].height;
  return 0;
}

// Waits up to timeoutMs for the next desktop image and copies it into dst (width*height*4 bytes).
// Returns 1: a new image was copied; info = { presented, handed over, copied (ms since 1970), images
// Windows composed since the last call }.  0: nothing new in that time (or only the pointer moved, or
// the screen is not available right now).  -1: closed.  -2: the pixel format is not 8 bits per colour
// (a monitor in HDR mode).  -3: the size changed, ask mc_size again.
EXPORT int mc_next(int handle, unsigned char* dst, int dstLen, int timeoutMs, double* info) {
  if (handle < 0 || handle >= 8) return -1;
  Capturer& c = g_caps[handle];
  AcquireSRWLockExclusive(&c.lock);
  int result = 0;
  const LONGLONG deadline = tick() + (LONGLONG)(timeoutMs / g_tickMs);
  while (c.used) {
    const int left = (int)((deadline - tick()) * g_tickMs);
    if (left <= 0) break;
    if (!c.dup) {
      // Lost earlier (resolution change, lock screen, permission prompt): try again, calmly.
      const int before = c.width * c.height;
      if (!duplicate(c)) { Sleep(left < 50 ? left : 50); continue; }
      if (c.width * c.height != before) { result = -3; break; }
    }
    DXGI_OUTDUPL_FRAME_INFO fi; IDXGIResource* resource = nullptr;
    HRESULT hr = c.dup->AcquireNextFrame(left, &fi, &resource);
    const LONGLONG handed = tick();
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) break;
    if (FAILED(hr)) { drop(c.dup); continue; }
    if (fi.LastPresentTime.QuadPart == 0) { drop(resource); c.dup->ReleaseFrame(); continue; } // only the pointer moved
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
    if (FAILED(hr)) { fail("reading the desktop image", hr); continue; }
    if (!bytes) { result = -2; fail("the monitor is not in an 8 bit colour mode (HDR?)", E_NOTIMPL); break; }
    if ((int)td.Width != c.width || (int)td.Height != c.height || dstLen < c.width * c.height * 4) { c.width = (int)td.Width; c.height = (int)td.Height; result = -3; break; }
    D3D11_MAPPED_SUBRESOURCE m;
    hr = c.context->Map(c.staging, 0, D3D11_MAP_READ, 0, &m); // waits for the copy to finish
    if (FAILED(hr)) { fail("Map", hr); continue; }
    const int rowBytes = c.width * 4;
    if ((int)m.RowPitch == rowBytes) memcpy(dst, m.pData, (size_t)rowBytes * c.height);
    else for (int y = 0; y < c.height; y++) memcpy(dst + (size_t)y * rowBytes, (const unsigned char*)m.pData + (size_t)y * m.RowPitch, rowBytes);
    c.context->Unmap(c.staging, 0);
    info[0] = toMs(fi.LastPresentTime.QuadPart); info[1] = toMs(handed); info[2] = toMs(tick()); info[3] = (double)fi.AccumulatedFrames;
    result = 1;
    break;
  }
  if (!c.used) result = -1;
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
EXPORT double mc_now(void) { initClock(); return toMs(tick()); }
EXPORT const char* mc_error(void) { return g_error; }
