// Measures how soon a native capturer has each picture frame of the bench (host/bench.js).
//
// It duplicates one output with DXGI Desktop Duplication on a thread of its own and, for every
// new desktop image, notes: when Windows presented that image (the moment it is on the host's
// screen), when the image was handed to this code, and which bench picture frame it is (the row
// of black and white cells, see host/bench-pattern.html). Comparing that with when Chromium's
// capturer delivers the same frame shows what a native capturer would gain.
//
// Built as a DLL (native/build.js) and loaded by host/bench-peer.js through koffi. It only reads
// the screen: nothing is injected, written or sent.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <stdio.h>

#define EXPORT extern "C" __declspec(dllexport)

struct Row { double acquired, presented, readable, code; }; // times in ms since 1970, see cap_now
static const int MAX_ROWS = 60000;
static Row* g_rows = nullptr;
static volatile LONG g_count = 0, g_stop = 0, g_state = 0; // state: 0 starting, 1 running, -1 failed
static HANDLE g_thread = nullptr;
static char g_error[200] = "";
static struct { int px, py, x, y, cell, cells; } g_cfg;
static volatile LONG g_images = 0, g_pointerOnly = 0, g_timeouts = 0, g_unreadable = 0, g_accumulated = 0, g_lost = 0;
static int g_refresh = 0, g_format = 0;

// One clock for everything: the performance counter, anchored once to the system time. The
// presentation times Windows reports are performance counter values, so they convert exactly.
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

static DWORD WINAPI run(LPVOID) {
  IDXGIFactory1* factory = nullptr; IDXGIAdapter1* adapter = nullptr; IDXGIOutput* output = nullptr; IDXGIOutput1* output1 = nullptr;
  ID3D11Device* device = nullptr; ID3D11DeviceContext* context = nullptr; IDXGIOutputDuplication* dup = nullptr; ID3D11Texture2D* staging = nullptr;
  const int W = g_cfg.cell * g_cfg.cells;
  HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
  bool found = false;
  if (FAILED(hr)) fail("CreateDXGIFactory1", hr);
  // The output (monitor) that contains the given point of the desktop, and the adapter it hangs on.
  for (UINT a = 0; SUCCEEDED(hr) && !found && factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; a++) {
    for (UINT o = 0; !found && adapter->EnumOutputs(o, &output) != DXGI_ERROR_NOT_FOUND; o++) {
      DXGI_OUTPUT_DESC d; output->GetDesc(&d);
      const RECT& r = d.DesktopCoordinates;
      found = d.AttachedToDesktop && g_cfg.px >= r.left && g_cfg.px < r.right && g_cfg.py >= r.top && g_cfg.py < r.bottom;
      if (!found) drop(output);
    }
    if (!found) drop(adapter);
  }
  if (SUCCEEDED(hr) && !found) { hr = E_FAIL; fail("no monitor at that point", hr); }
  if (SUCCEEDED(hr)) { hr = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context); if (FAILED(hr)) fail("D3D11CreateDevice", hr); }
  if (SUCCEEDED(hr)) { hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&output1); if (FAILED(hr)) fail("IDXGIOutput1", hr); }
  if (SUCCEEDED(hr)) { hr = output1->DuplicateOutput(device, &dup); if (FAILED(hr)) fail("DuplicateOutput", hr); }
  if (SUCCEEDED(hr)) {
    DXGI_OUTDUPL_DESC d; dup->GetDesc(&d);
    g_refresh = d.ModeDesc.RefreshRate.Denominator ? (int)(d.ModeDesc.RefreshRate.Numerator / d.ModeDesc.RefreshRate.Denominator) : 0;
    g_format = (int)d.ModeDesc.Format;
  }
  InterlockedExchange(&g_state, SUCCEEDED(hr) ? 1 : -1);

  while (SUCCEEDED(hr) && !g_stop) {
    DXGI_OUTDUPL_FRAME_INFO info; IDXGIResource* resource = nullptr;
    HRESULT r = dup->AcquireNextFrame(100, &info, &resource);
    const LONGLONG acquired = tick();
    if (r == DXGI_ERROR_WAIT_TIMEOUT) { InterlockedIncrement(&g_timeouts); continue; }
    if (r == DXGI_ERROR_ACCESS_LOST) {
      // The desktop changed (resolution, a full-screen switch, the lock screen): start the duplication again.
      InterlockedIncrement(&g_lost);
      drop(dup); drop(staging);
      for (int i = 0; i < 20 && !g_stop && FAILED(output1->DuplicateOutput(device, &dup)); i++) Sleep(100);
      if (!dup) { fail("duplication lost", r); break; }
      continue;
    }
    if (FAILED(r)) { fail("AcquireNextFrame", r); break; }
    if (info.LastPresentTime.QuadPart == 0) {
      InterlockedIncrement(&g_pointerOnly); // only the pointer moved; the image is unchanged
    } else {
      InterlockedIncrement(&g_images);
      InterlockedExchangeAdd(&g_accumulated, (LONG)info.AccumulatedFrames);
      ID3D11Texture2D* image = nullptr;
      double code = -1; LONGLONG readable = 0;
      if (SUCCEEDED(resource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&image))) {
        D3D11_TEXTURE2D_DESC td; image->GetDesc(&td);
        if (!staging) {
          D3D11_TEXTURE2D_DESC sd = {}; sd.Width = W; sd.Height = 1; sd.MipLevels = 1; sd.ArraySize = 1; sd.Format = td.Format;
          sd.SampleDesc.Count = 1; sd.Usage = D3D11_USAGE_STAGING; sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
          device->CreateTexture2D(&sd, nullptr, &staging);
        }
        const bool fits = g_cfg.x >= 0 && g_cfg.y >= 0 && (UINT)(g_cfg.x + W) <= td.Width && (UINT)g_cfg.y < td.Height;
        const bool bytes = td.Format == DXGI_FORMAT_B8G8R8A8_UNORM || td.Format == DXGI_FORMAT_R8G8B8A8_UNORM || td.Format == DXGI_FORMAT_B8G8R8X8_UNORM;
        D3D11_MAPPED_SUBRESOURCE m;
        if (staging && fits && bytes) {
          // One row of pixels through the middle of the cells, copied to memory this code can read.
          D3D11_BOX box = { (UINT)g_cfg.x, (UINT)g_cfg.y, 0, (UINT)(g_cfg.x + W), (UINT)g_cfg.y + 1, 1 };
          context->CopySubresourceRegion(staging, 0, 0, 0, 0, image, 0, &box);
          if (SUCCEEDED(context->Map(staging, 0, D3D11_MAP_READ, 0, &m))) {
            readable = tick();
            const unsigned char* p = (const unsigned char*)m.pData;
            const int n = g_cfg.cells;
            int lum[64];
            for (int i = 0; i < n && i < 64; i++) { const unsigned char* q = p + 4 * (int)((i + 0.5) * g_cfg.cell); lum[i] = q[0] + q[1] + q[2]; }
            const int hi = (lum[0] + lum[n - 1]) / 2, lo = (lum[1] + lum[n - 2]) / 2;
            if (hi - lo >= 240) {
              const int mid = (hi + lo) / 2;
              unsigned long long v = 0;
              for (int i = 2; i < n - 2; i++) v = v * 2 + (lum[i] > mid ? 1 : 0);
              code = (double)(v & 0xFFFFF); // the time the frame was drawn, modulo 2^20 ms
            }
            context->Unmap(staging, 0);
          }
        }
        drop(image);
      }
      if (code < 0) InterlockedIncrement(&g_unreadable);
      else if (g_count < MAX_ROWS) {
        Row& row = g_rows[g_count];
        row.acquired = toMs(acquired); row.presented = toMs(info.LastPresentTime.QuadPart); row.readable = toMs(readable); row.code = code;
        InterlockedIncrement(&g_count);
      }
    }
    drop(resource);
    dup->ReleaseFrame();
  }
  if (FAILED(hr)) InterlockedExchange(&g_state, -1);
  drop(staging); drop(dup); drop(context); drop(device); drop(output1); drop(output); drop(adapter); drop(factory);
  return 0;
}

// px,py: a point of the desktop inside the monitor to watch. x,y: where the row of cells starts on
// that monitor (the row to read). cell: width of one cell; cells: how many. All in physical pixels.
// Returns 1 when capturing has started, -1 when it could not (see cap_error).
EXPORT int cap_start(int px, int py, int x, int y, int cell, int cells) {
  if (g_thread) return -1;
  if (cells < 8 || cells > 64 || cell < 2) { snprintf(g_error, sizeof g_error, "bad arguments"); return -1; }
  initClock();
  if (!g_rows) g_rows = (Row*)HeapAlloc(GetProcessHeap(), 0, sizeof(Row) * MAX_ROWS);
  if (!g_rows) return -1;
  g_cfg = { px, py, x, y, cell, cells };
  g_count = 0; g_stop = 0; g_state = 0; g_images = g_pointerOnly = g_timeouts = g_unreadable = g_accumulated = g_lost = 0; g_error[0] = 0;
  g_thread = CreateThread(nullptr, 0, run, nullptr, 0, nullptr);
  if (!g_thread) return -1;
  for (int i = 0; i < 300 && g_state == 0; i++) Sleep(10);
  return g_state == 1 ? 1 : -1;
}
// Copies the rows gathered so far: four numbers each (handed over, presented, readable, time code).
EXPORT int cap_rows(double* out, int max) {
  int n = g_count; if (n > max) n = max;
  for (int i = 0; i < n; i++) { out[i * 4] = g_rows[i].acquired; out[i * 4 + 1] = g_rows[i].presented; out[i * 4 + 2] = g_rows[i].readable; out[i * 4 + 3] = g_rows[i].code; }
  return n;
}
// Eight numbers: images, pointer-only updates, timeouts, unreadable, images Windows composed in all, times the duplication was lost, refresh rate, pixel format.
EXPORT void cap_stats(double* out) {
  out[0] = g_images; out[1] = g_pointerOnly; out[2] = g_timeouts; out[3] = g_unreadable; out[4] = g_accumulated; out[5] = g_lost; out[6] = g_refresh; out[7] = g_format;
}
EXPORT double cap_now(void) { initClock(); return toMs(tick()); }
EXPORT const char* cap_error(void) { return g_error; }
EXPORT void cap_stop(void) {
  if (!g_thread) return;
  InterlockedExchange(&g_stop, 1);
  WaitForSingleObject(g_thread, 3000);
  CloseHandle(g_thread);
  g_thread = nullptr;
}
