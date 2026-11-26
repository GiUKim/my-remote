// Shell operations Pangmote needs natively on Windows. Built by native/build.js into
// host/bin/shellops.dll and loaded through koffi by the host (and the client app).
//
//   int so_drop(const wchar_t *paths, int effects, int timeoutMs)
//     Drops files and folders onto whatever is under the mouse pointer right now, the way a
//     person's drag-and-drop does: the program there gets DragEnter, DragOver and Drop with the
//     shell's own data object for the items, so a folder window, a folder icon in it, the desktop,
//     a mail or chat window each do what they do with a local drop.
//     paths: absolute paths separated by '\n', all in the same folder. effects: the DROPEFFECT
//     bits offered (1 copy, 2 move). Returns the effect the target reported (0 = it took nothing
//     or nothing there takes files), or an error: -1 bad arguments, -2 the shell could not
//     describe the items, -3 OLE failed, -4 timed out, -5 the press could not be caught (another
//     topmost window lies over the pointer; nothing was pressed).
//   const char *so_error(void)   text of the last error
//   const char *so_debug(void)   what the last drop saw (for the self-test and the log)
//   int so_caret(int *out, int timeoutMs)
//     Where the text caret of the program in front is, through UI Automation (see below).
//
// How: the drag runs on a thread of its own (OLE wants a single-threaded apartment with a message
// loop), which the call waits for. Drop targets take nothing from a drag without a mouse button
// held, and the drag loop reads the real button state, so the left button is pressed - but onto a
// tiny, almost invisible window of ours put right under the pointer, which takes the mouse
// (capture) and then lets clicks through; so the program under the pointer never gets a click,
// only the drag with the button held. After the target has answered twice the button is let go
// and the drop follows, exactly as when a person lets go. A second thread keeps the loop turning
// by posting it mouse moves (nothing else moves the pointer meanwhile) and presses Escape for it if
// the target never answers. The button is always let go again while we still hold the mouse.
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <ole2.h>
#include <shlobj.h>
#include <stdio.h>
#include <string>
#include <vector>

#define EXPORT extern "C" __declspec(dllexport)

static char lastError[256] = "";
static char debugText[256] = "";
static void fail(const char *what, HRESULT hr) { snprintf(lastError, sizeof lastError, "%s (0x%08lx)", what, (unsigned long)hr); }

namespace {

void button(bool down) {
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dwFlags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  SendInput(1, &in, sizeof in);
}
// Puts the pointer at a point of the virtual desktop (exactly; no acceleration applies).
void moveTo(POINT p) {
  const int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dx = (LONG)(((p.x - vx) * 65535LL) / (vw > 1 ? vw - 1 : 1));
  in.mi.dy = (LONG)(((p.y - vy) * 65535LL) / (vh > 1 ? vh - 1 : 1));
  in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  SendInput(1, &in, sizeof in);
}

class Source final : public IDropSource {
 public:
  explicit Source(DWORD timeoutMs) : deadline_(GetTickCount64() + timeoutMs), pressedAt_(GetTickCount64()) { GetCursorPos(&home_); }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IDropSource)) { *ppv = static_cast<IDropSource *>(this); AddRef(); return S_OK; }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return (ULONG)InterlockedIncrement(&refs_); }
  ULONG STDMETHODCALLTYPE Release() override { return (ULONG)InterlockedDecrement(&refs_); } // lives on the drag thread's stack

  HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL escape, DWORD keyState) override {
    const bool held = (keyState & MK_LBUTTON) != 0, late = GetTickCount64() > deadline_;
    if (calls < 24) keys[calls] = escape ? 'E' : held ? 'L' : '-';
    calls++;
    switch (state) {
      case Pressed:
        if (escape || late) { timedOut = late && !escape; moveTo(home_); button(false); state = Giving; return S_OK; }
        // Let go once the target, seeing the button held, has said twice in a row that it takes
        // the items (it may need a few rounds to decide), or after a while if it never does (then
        // the drop is refused and nothing happens).
        if (held && (accepts >= 2 || GetTickCount64() - pressedAt_ > 600)) { state = Letting; moveTo(home_); button(false); }
        return S_OK;
      case Letting:
        if (!held) return DRAGDROP_S_DROP;
        if (late) { timedOut = true; return DRAGDROP_S_CANCEL; }
        return S_OK;
      case Giving:
      default:
        return !held || GetTickCount64() > deadline_ + 1000 ? DRAGDROP_S_CANCEL : S_OK;
    }
  }
  HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD effect) override {
    if (seenCount < 24) seen[seenCount] = (char)('0' + (effect & 7));
    seenCount++;
    accepts = effect & (DROPEFFECT_COPY | DROPEFFECT_MOVE) ? accepts + 1 : 0;
    return DRAGDROP_S_USEDEFAULTCURSORS;
  }
  bool pressedButNotLetGo() const { return state == Pressed; }

  enum State : LONG { Pressed, Letting, Giving };
  volatile State state = Pressed; // the button is pressed before the drag starts (see catchPress); the pump reads it
  int accepts = 0, calls = 0, seenCount = 0;
  bool timedOut = false;
  char keys[25] = "", seen[25] = "";

  POINT home() const { return home_; }

 private:
  LONG refs_ = 1;
  ULONGLONG deadline_, pressedAt_;
  POINT home_{};
};

struct Job {
  std::vector<std::wstring> paths;
  DWORD effects = DROPEFFECT_COPY;
  DWORD timeoutMs = 3000;
  int result = -3;
};

// Keeps the drag loop turning: it only looks again when the pointer moves, and so do some targets
// (Explorer's item view), as a hand always moves a little. While the button is held, the pointer
// goes one pixel right and back every 20 ms - real moves, which only the window holding the mouse
// (ours, then the drag loop's) receives. Posted fake moves would not do: they carry no position.
struct Pump { DWORD thread; HANDLE stop; DWORD limitMs; Source *source; };
DWORD WINAPI pumpThread(void *arg) {
  Pump *p = static_cast<Pump *>(arg);
  const ULONGLONG start = GetTickCount64();
  bool escaped = false;
  for (int n = 0; WaitForSingleObject(p->stop, 20) == WAIT_TIMEOUT; n++) {
    if (p->source->state == Source::Pressed) { POINT q = p->source->home(); q.x += (n & 1) ? 0 : 1; moveTo(q); }
    if (!escaped && GetTickCount64() - start > p->limitMs) { PostThreadMessageW(p->thread, WM_KEYDOWN, VK_ESCAPE, 0); escaped = true; }
  }
  return 0;
}

// The window that takes the press: 8x8 px at the pointer, topmost, never activated, alpha 1/255.
bool pressed = false;
LRESULT CALLBACK catcherProc(HWND w, UINT m, WPARAM wp, LPARAM lp) {
  if (m == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
  if (m == WM_LBUTTONDOWN) { pressed = true; SetCapture(w); return 0; }
  return DefWindowProcW(w, m, wp, lp);
}
// Presses the left button onto a window of ours under the pointer and keeps the mouse there; then
// lets clicks through it, so that the drag loop finds the real window under the pointer. Returns
// the window (destroy it afterwards) or null when the press could not be caught (nothing pressed).
HWND catchPress() {
  static ATOM cls = 0;
  HINSTANCE inst = GetModuleHandleW(nullptr);
  if (!cls) {
    WNDCLASSW wc{};
    wc.lpfnWndProc = catcherProc;
    wc.hInstance = inst;
    wc.lpszClassName = L"PangmoteDropCatcher";
    cls = RegisterClassW(&wc);
    if (!cls) { fail("RegisterClass", HRESULT_FROM_WIN32(GetLastError())); return nullptr; }
  }
  POINT pt{};
  GetCursorPos(&pt);
  HWND w = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_LAYERED, L"PangmoteDropCatcher", L"", WS_POPUP,
                           pt.x - 4, pt.y - 4, 8, 8, nullptr, nullptr, inst, nullptr);
  if (!w) { fail("CreateWindow", HRESULT_FROM_WIN32(GetLastError())); return nullptr; }
  SetLayeredWindowAttributes(w, 0, 1, LWA_ALPHA);
  ShowWindow(w, SW_SHOWNOACTIVATE);
  if (WindowFromPoint(pt) != w) { fail("another window lies over the pointer", E_FAIL); DestroyWindow(w); return nullptr; }
  pressed = false;
  button(true);
  const ULONGLONG until = GetTickCount64() + 500;
  MSG msg;
  while (!pressed && GetTickCount64() < until) {
    if (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
    else MsgWaitForMultipleObjects(0, nullptr, FALSE, 10, QS_ALLINPUT);
  }
  if (!pressed) { button(false); fail("the press did not arrive", E_FAIL); DestroyWindow(w); return nullptr; }
  SetWindowLongW(w, GWL_EXSTYLE, GetWindowLongW(w, GWL_EXSTYLE) | WS_EX_TRANSPARENT); // clicks go through it from now on
  return w;
}

// The data object the shell itself hands over for these items (CF_HDROP, shell ID lists, ...).
IDataObject *shellData(const std::vector<std::wstring> &paths, IShellFolder **folderOut, std::vector<PIDLIST_ABSOLUTE> &abs) {
  for (const auto &p : paths) {
    PIDLIST_ABSOLUTE pidl = nullptr;
    HRESULT hr = SHParseDisplayName(p.c_str(), nullptr, &pidl, 0, nullptr);
    if (FAILED(hr) || !pidl) { fail("SHParseDisplayName", hr); return nullptr; }
    abs.push_back(pidl);
  }
  IShellFolder *folder = nullptr;
  PCUITEMID_CHILD first = nullptr;
  HRESULT hr = SHBindToParent(abs[0], IID_IShellFolder, reinterpret_cast<void **>(&folder), &first);
  if (FAILED(hr) || !folder) { fail("SHBindToParent", hr); return nullptr; }
  std::vector<PCUITEMID_CHILD> children;
  for (auto pidl : abs) children.push_back(ILFindLastID(pidl));
  IDataObject *data = nullptr;
  hr = folder->GetUIObjectOf(nullptr, (UINT)children.size(), children.data(), IID_IDataObject, nullptr, reinterpret_cast<void **>(&data));
  if (FAILED(hr) || !data) { fail("GetUIObjectOf", hr); folder->Release(); return nullptr; }
  *folderOut = folder;
  return data;
}

DWORD WINAPI dragThread(void *arg) {
  Job *job = static_cast<Job *>(arg);
  HRESULT hr = OleInitialize(nullptr);
  if (FAILED(hr)) { fail("OleInitialize", hr); job->result = -3; return 0; }
  MSG msg;
  PeekMessageW(&msg, nullptr, WM_USER, WM_USER, PM_NOREMOVE); // this thread gets a message queue
  std::vector<PIDLIST_ABSOLUTE> abs;
  IShellFolder *folder = nullptr;
  IDataObject *data = shellData(job->paths, &folder, abs);
  HWND catcher = data ? catchPress() : nullptr;
  if (!data) job->result = -2;
  else if (!catcher) job->result = -5;
  else {
    Source source(job->timeoutMs);
    Pump pump{ GetCurrentThreadId(), CreateEventW(nullptr, TRUE, FALSE, nullptr), job->timeoutMs + 500, &source };
    HANDLE pumper = pump.stop ? CreateThread(nullptr, 0, pumpThread, &pump, 0, nullptr) : nullptr;
    DWORD effect = DROPEFFECT_NONE;
    hr = DoDragDrop(data, &source, job->effects, &effect);
    if (source.pressedButNotLetGo()) { SetCapture(catcher); moveTo(source.home()); button(false); } // never leave the button down; the release goes to our window
    MSG drain;
    while (PeekMessageW(&drain, nullptr, WM_MOUSEFIRST, WM_MOUSELAST, PM_REMOVE)) {} // the release, if it is still queued here
    ReleaseCapture();
    if (pump.stop) SetEvent(pump.stop);
    if (pumper) { WaitForSingleObject(pumper, 2000); CloseHandle(pumper); }
    if (pump.stop) CloseHandle(pump.stop);
    { POINT now{}, h = source.home(); GetCursorPos(&now); if (now.x != h.x || now.y != h.y) moveTo(h); } // the pointer ends where it was
    if (hr == DRAGDROP_S_DROP) job->result = (int)effect;
    else if (hr == DRAGDROP_S_CANCEL) job->result = source.timedOut ? -4 : 0;
    else { fail("DoDragDrop", hr); job->result = -3; }
    POINT pt{};
    GetCursorPos(&pt);
    HWND under = WindowFromPoint(pt);
    char cls[64] = "";
    if (under) GetClassNameA(under, cls, sizeof cls);
    snprintf(debugText, sizeof debugText, "hr=0x%08lx effect=%lu answers=%s keys=%s under=%s", (unsigned long)hr, (unsigned long)effect, source.seen, source.keys, cls);
  }
  if (catcher) DestroyWindow(catcher);
  if (data) data->Release();
  if (folder) folder->Release();
  for (auto pidl : abs) CoTaskMemFree(pidl);
  OleUninitialize();
  return 0;
}

} // namespace

EXPORT int so_drop(const wchar_t *paths, int effects, int timeoutMs) {
  lastError[0] = 0;
  debugText[0] = 0;
  if (!paths || !*paths) { fail("no paths", E_INVALIDARG); return -1; }
  Job job;
  std::wstring cur;
  for (const wchar_t *p = paths;; ++p) {
    if (*p == L'\n' || *p == 0) { if (!cur.empty()) job.paths.push_back(cur); cur.clear(); if (!*p) break; }
    else cur += *p;
  }
  if (job.paths.empty() || job.paths.size() > 10000) { fail("bad path list", E_INVALIDARG); return -1; }
  job.effects = (DWORD)effects & (DROPEFFECT_COPY | DROPEFFECT_MOVE);
  if (!job.effects) job.effects = DROPEFFECT_COPY;
  job.timeoutMs = timeoutMs > 0 && timeoutMs <= 60000 ? (DWORD)timeoutMs : 3000;
  HANDLE th = CreateThread(nullptr, 0, dragThread, &job, 0, nullptr);
  if (!th) { fail("CreateThread", HRESULT_FROM_WIN32(GetLastError())); return -3; }
  WaitForSingleObject(th, INFINITE); // bounded: the source gives up after timeoutMs and the pump presses Escape
  CloseHandle(th);
  return job.result;
}

EXPORT const char *so_error(void) { return lastError; }
EXPORT const char *so_debug(void) { return debugText; }

// ---- the text caret of the program in front, through UI Automation ------------------------------------------
// For a phone controlling this PC (2026-11-26, the user's wish): a tap that puts a text caret somewhere brings the
// phone's keyboard up. Programs with a classic edit field have a system caret, which the host reads itself
// (GetGUIThreadInfo); Chrome, Edge, Electron apps, the Start menu's search and others draw their own and say where
// it is only through UI Automation - the same thing Windows' own touch keyboard asks before it comes up.
//
//   int so_caret(int *out, int timeoutMs)
//     out[0..3]: the caret's left, top, width and height on the desktop (physical pixels), or the field's box
//     when the program gives no caret rectangle (out[6] = 1 then); out[4]: the focused element's control type;
//     out[5]: 1 when its text cannot be changed. Returns 1: the focus is in an editable text field (an edit, or
//     a document whose value can be changed); 0: the focus is somewhere else; -1: no focus could be read; -2: UI
//     Automation could not be started; -3: the program in front did not answer within timeoutMs (the question
//     then finishes on its own thread and is forgotten).
namespace caret {

// Our own declarations of the few UI Automation interfaces used: mingw-w64 8's uiautomationclient.h has none.
// The methods stand in the interfaces' own order (UIAutomationClient.idl); one that is never called is declared
// without its parameters, only to hold its place in the table.
struct Range : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE Clone(Range **out) = 0;                    // 0
  virtual HRESULT STDMETHODCALLTYPE Compare_() = 0;                            // 1
  virtual HRESULT STDMETHODCALLTYPE CompareEndpoints_() = 0;                   // 2
  virtual HRESULT STDMETHODCALLTYPE ExpandToEnclosingUnit(int unit) = 0;      // 3 (TextUnit_Character = 0)
  virtual HRESULT STDMETHODCALLTYPE FindAttribute_() = 0;                      // 4
  virtual HRESULT STDMETHODCALLTYPE FindText_() = 0;                           // 5
  virtual HRESULT STDMETHODCALLTYPE GetAttributeValue_() = 0;                  // 6
  virtual HRESULT STDMETHODCALLTYPE GetBoundingRectangles(SAFEARRAY **out) = 0; // 7 (doubles: left, top, width, height, ...)
};
struct Ranges : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE get_Length(int *n) = 0;                    // 0
  virtual HRESULT STDMETHODCALLTYPE GetElement(int i, Range **out) = 0;        // 1
};
struct Text : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE RangeFromPoint_() = 0;                     // 0
  virtual HRESULT STDMETHODCALLTYPE RangeFromChild_() = 0;                     // 1
  virtual HRESULT STDMETHODCALLTYPE GetSelection(Ranges **out) = 0;            // 2
  virtual HRESULT STDMETHODCALLTYPE GetVisibleRanges_() = 0;                   // 3
  virtual HRESULT STDMETHODCALLTYPE get_DocumentRange_() = 0;                  // 4
  virtual HRESULT STDMETHODCALLTYPE get_SupportedTextSelection_() = 0;         // 5
};
struct Text2 : Text {
  virtual HRESULT STDMETHODCALLTYPE RangeFromAnnotation_() = 0;                // 6
  virtual HRESULT STDMETHODCALLTYPE GetCaretRange(BOOL *active, Range **out) = 0; // 7
};
struct Element : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE SetFocus_() = 0;                           // 0
  virtual HRESULT STDMETHODCALLTYPE GetRuntimeId_() = 0;                       // 1
  virtual HRESULT STDMETHODCALLTYPE FindFirst_() = 0;                          // 2
  virtual HRESULT STDMETHODCALLTYPE FindAll_() = 0;                            // 3
  virtual HRESULT STDMETHODCALLTYPE FindFirstBuildCache_() = 0;                // 4
  virtual HRESULT STDMETHODCALLTYPE FindAllBuildCache_() = 0;                  // 5
  virtual HRESULT STDMETHODCALLTYPE BuildUpdatedCache_() = 0;                  // 6
  virtual HRESULT STDMETHODCALLTYPE GetCurrentPropertyValue(int id, VARIANT *out) = 0; // 7
  virtual HRESULT STDMETHODCALLTYPE GetCurrentPropertyValueEx_() = 0;          // 8
  virtual HRESULT STDMETHODCALLTYPE GetCachedPropertyValue_() = 0;             // 9
  virtual HRESULT STDMETHODCALLTYPE GetCachedPropertyValueEx_() = 0;           // 10
  virtual HRESULT STDMETHODCALLTYPE GetCurrentPatternAs(int id, REFIID riid, void **out) = 0; // 11
};
struct Automation : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE CompareElements_() = 0;                    // 0
  virtual HRESULT STDMETHODCALLTYPE CompareRuntimeIds_() = 0;                  // 1
  virtual HRESULT STDMETHODCALLTYPE GetRootElement_() = 0;                     // 2
  virtual HRESULT STDMETHODCALLTYPE ElementFromHandle_() = 0;                  // 3
  virtual HRESULT STDMETHODCALLTYPE ElementFromPoint_() = 0;                   // 4
  virtual HRESULT STDMETHODCALLTYPE GetFocusedElement(Element **out) = 0;      // 5
};
const CLSID CLSID_CUIAutomation_ = { 0xff48dba4, 0x60ef, 0x4201, { 0xaa, 0x87, 0x54, 0x10, 0x3e, 0xef, 0x59, 0x4e } };
const IID IID_IUIAutomation_ = { 0x30cbe57d, 0xd9d0, 0x452a, { 0xab, 0x13, 0x7a, 0xc5, 0xac, 0x48, 0x25, 0xee } };
const IID IID_TextPattern_ = { 0x32eba289, 0x3583, 0x42c9, { 0x9c, 0x59, 0x3b, 0x6d, 0x9a, 0x1e, 0x9b, 0x6a } };
const IID IID_TextPattern2_ = { 0x506a921a, 0xfcc9, 0x409f, { 0xb2, 0x3b, 0x37, 0xeb, 0x74, 0x10, 0x68, 0x72 } };
enum { TextPatternId = 10014, TextPattern2Id = 10024, BoundingRectangle = 30001, ControlType = 30003,
       IsValuePatternAvailable = 30043, ValueIsReadOnly = 30046, EditControl = 50004, DocumentControl = 50030 };

// The first rectangle of a SAFEARRAY of doubles (left, top, width, height, ...), which is let go of here.
bool firstRect(SAFEARRAY *sa, int *out) {
  if (!sa) return false;
  bool ok = false;
  LONG lo = 0, hi = -1;
  double *d = nullptr;
  if (SafeArrayGetDim(sa) == 1 && SUCCEEDED(SafeArrayGetLBound(sa, 1, &lo)) && SUCCEEDED(SafeArrayGetUBound(sa, 1, &hi))
      && hi - lo + 1 >= 4 && SUCCEEDED(SafeArrayAccessData(sa, (void **)&d)) && d) {
    out[0] = (int)d[0]; out[1] = (int)d[1]; out[2] = (int)d[2]; out[3] = (int)d[3];
    ok = d[3] > 0;
    SafeArrayUnaccessData(sa);
  }
  SafeArrayDestroy(sa);
  return ok;
}
// A caret is an empty range, which many programs give no rectangle: then the character next to it.
bool rangeRect(Range *r, int *out) {
  SAFEARRAY *sa = nullptr;
  if (SUCCEEDED(r->GetBoundingRectangles(&sa)) && firstRect(sa, out)) return true;
  Range *c = nullptr;
  if (FAILED(r->Clone(&c)) || !c) return false;
  sa = nullptr;
  bool ok = SUCCEEDED(c->ExpandToEnclosingUnit(0)) && SUCCEEDED(c->GetBoundingRectangles(&sa)) && firstRect(sa, out);
  c->Release();
  if (ok) out[2] = 2; // the caret stands at the character's left edge
  return ok;
}
bool boolOf(Element *el, int id) {
  VARIANT v;
  VariantInit(&v);
  bool on = SUCCEEDED(el->GetCurrentPropertyValue(id, &v)) && v.vt == VT_BOOL && v.boolVal != VARIANT_FALSE;
  VariantClear(&v);
  return on;
}

int ask(int *out) {
  Automation *uia = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation_, nullptr, CLSCTX_INPROC_SERVER, IID_IUIAutomation_, (void **)&uia)) || !uia) return -2;
  Element *el = nullptr;
  int result = -1;
  if (SUCCEEDED(uia->GetFocusedElement(&el)) && el) {
    VARIANT v;
    VariantInit(&v);
    int type = SUCCEEDED(el->GetCurrentPropertyValue(ControlType, &v)) && v.vt == VT_I4 ? v.lVal : 0;
    VariantClear(&v);
    const bool hasValue = boolOf(el, IsValuePatternAvailable), readOnly = hasValue && boolOf(el, ValueIsReadOnly);
    out[4] = type;
    out[5] = readOnly ? 1 : 0;
    // A web page, a PDF, a help window are documents too, and have no value to change: only an edit, or a
    // document whose value can be changed, is a place to type.
    result = !readOnly && (type == EditControl || (type == DocumentControl && hasValue)) ? 1 : 0;
    if (result == 1) {
      bool placed = false;
      Text2 *t2 = nullptr;
      if (SUCCEEDED(el->GetCurrentPatternAs(TextPattern2Id, IID_TextPattern2_, (void **)&t2)) && t2) {
        BOOL active = FALSE;
        Range *r = nullptr;
        if (SUCCEEDED(t2->GetCaretRange(&active, &r)) && r) { placed = rangeRect(r, out); r->Release(); }
        t2->Release();
      }
      Text *t = nullptr;
      if (!placed && SUCCEEDED(el->GetCurrentPatternAs(TextPatternId, IID_TextPattern_, (void **)&t)) && t) {
        Ranges *rs = nullptr;
        int n = 0;
        if (SUCCEEDED(t->GetSelection(&rs)) && rs) {
          Range *r = nullptr;
          if (SUCCEEDED(rs->get_Length(&n)) && n > 0 && SUCCEEDED(rs->GetElement(0, &r)) && r) { placed = rangeRect(r, out); r->Release(); }
          rs->Release();
        }
        t->Release();
      }
      if (!placed) { // the field's own box
        VariantInit(&v);
        if (SUCCEEDED(el->GetCurrentPropertyValue(BoundingRectangle, &v)) && v.vt == (VT_ARRAY | VT_R8) && v.parray) {
          SAFEARRAY *sa = v.parray;
          v.vt = VT_EMPTY; // firstRect lets go of it
          if (firstRect(sa, out)) out[6] = 1;
        }
        VariantClear(&v);
      }
    }
    el->Release();
  }
  uia->Release();
  return result;
}

struct Job { LONG refs; int out[8]; int result; };
DWORD WINAPI thread(LPVOID p) {
  Job *job = (Job *)p;
  const HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  job->result = SUCCEEDED(co) ? ask(job->out) : -2;
  if (SUCCEEDED(co)) CoUninitialize();
  if (InterlockedDecrement(&job->refs) == 0) delete job;
  return 0;
}

} // namespace caret

EXPORT int so_caret(int *out, int timeoutMs) {
  if (!out) return -1;
  caret::Job *job = new caret::Job();
  job->refs = 2;
  job->result = -1;
  for (int &x : job->out) x = 0;
  HANDLE th = CreateThread(nullptr, 0, caret::thread, job, 0, nullptr);
  if (!th) { delete job; return -2; }
  const DWORD waited = WaitForSingleObject(th, timeoutMs > 0 && timeoutMs <= 10000 ? (DWORD)timeoutMs : 1500);
  CloseHandle(th);
  int result = -3;
  if (waited == WAIT_OBJECT_0) { result = job->result; for (int i = 0; i < 8; i++) out[i] = job->out[i]; }
  if (InterlockedDecrement(&job->refs) == 0) delete job;
  return result;
}
