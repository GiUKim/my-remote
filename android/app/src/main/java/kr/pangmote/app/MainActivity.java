package kr.pangmote.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Pangmote for Android: a phone controls a PC (the user's plan, 2026-11-26). A thin shell around the same loader and
 * client page that browsers and the desktop client app run, in the system's WebView:
 * - the list of PCs (assets/web/home.html, window.mrApp) and, for the PC opened, a WebView of its own with the loader
 *   (assets/web/loader.html, copied from pangmote-client.html at build time), both served from an https origin of the
 *   app's own (ORIGIN, answered here, never fetched): a secure context (WebRTC, WebCrypto) with storage that stays. The
 *   page comes from the host as everywhere else, so what a phone can do is updated with the host;
 * - a PC is added with the QR code of a host window's card "휴대폰 추가" (ScanActivity, or the phone's camera opening the
 *   link: App Links for https://giukim.github.io/p): the loader is given the one-time code in it, the page asks the host
 *   for a device token on it (mrShell.qrPairing), and the token the host gives over the session's own connection is kept
 *   encrypted (HostStore); from then on the PC is opened with the token alone (mrShell.bootDevice). The key is never in
 *   the QR code and never kept here; "접속 키로 접속" types it each time;
 * - the page of a session gets window.mrShell (a few of the desktop client app's calls, made on window.mrAndroid): only
 *   for its own PC, and a token only from a session that a QR code started;
 * - the whole screen is the picture (the system bars hidden), the screen stays on, turning or folding the phone keeps the
 *   session, the keyboard's height shrinks the page (which keeps the picture's size and moves the text caret above it).
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net"; // reserved for apps' own assets, never a real site
    static final String ORIGIN = "https://" + HOST;
    static final String QR_HOST = "giukim.github.io";
    private static final int REQ_SCAN = 7;

    private FrameLayout root;
    private WebView home;
    private WebView session;
    private Session current;
    private HostStore store;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenDone;
    private int imeBottom, cutL, cutT, cutR, cutB;

    /** What the open session is for: a PC of the list, one being added with a QR code, or a key typed in. */
    private static final class Session {
        final String hostId;   // null: a key typed in (nothing kept)
        final String qrCode;   // the one-time code of a QR code: this session may receive a token
        volatile boolean paired;
        Session(String hostId, String qrCode) { this.hostId = hostId; this.qrCode = qrCode; }
    }

    /** The one-time code of a host window's QR code ("https://giukim.github.io/p#1.<12 characters>"), or null. */
    static String codeFrom(String text) {
        if (text == null) return null;
        Uri u = Uri.parse(text.trim());
        String path = u.getPath();
        if (!"https".equals(u.getScheme()) || !QR_HOST.equals(u.getHost()) || !("/p".equals(path) || "/p/".equals(path))) return null;
        String f = u.getFragment();
        if (f == null || !f.startsWith("1.")) return null;
        String code = f.substring(2).toUpperCase(Locale.ROOT);
        return code.matches("[0-9A-Z]{12}") ? code : null;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setNavigationBarColor(Color.BLACK);
        store = new HostStore(this);
        store.dropUnpaired();
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(0x14, 0x17, 0x1c));
        setContentView(root);
        // The keyboard and the display cutout: the pages get the space they leave (edge to edge is the rule from
        // Android 15 on, so the insets are applied here).
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            imeBottom = insets.getInsets(WindowInsets.Type.ime()).bottom;
            android.graphics.Insets cut = insets.getInsets(WindowInsets.Type.displayCutout());
            cutL = cut.left; cutT = cut.top; cutR = cut.right; cutB = cut.bottom;
            fit(home);
            fit(session);
            return WindowInsets.CONSUMED;
        });
        home = webView(false, null);
        root.addView(home, full());
        home.loadUrl(ORIGIN + "/web/home.html");
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }
        immersive();
        handle(getIntent());
    }

    private static FrameLayout.LayoutParams full() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private void fit(WebView w) {
        if (w == null) return;
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) w.getLayoutParams();
        if (lp == null) return;
        lp.setMargins(cutL, cutT, cutR, Math.max(imeBottom, cutB));
        w.setLayoutParams(lp);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    /** A QR code's link opened by the phone's camera (App Links). */
    private void handle(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return;
        String code = codeFrom(intent.getData().toString());
        setIntent(new Intent(this, MainActivity.class)); // used once: a restart does not add it again
        if (code != null) startQr(code);
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == REQ_SCAN && result == RESULT_OK && data != null) {
            String code = data.getStringExtra(ScanActivity.EXTRA_CODE);
            if (code != null) startQr(code);
        }
    }

    // ---- the WebViews -----------------------------------------------------------------------------------------------

    private WebView webView(boolean forSession, Session s) {
        WebView w = new WebView(this);
        w.setBackgroundColor(Color.rgb(0x14, 0x17, 0x1c));
        WebSettings ws = w.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false); // the host's sound plays without a tap of its own
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setTextZoom(100);
        ws.setSupportMultipleWindows(false);
        w.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                return asset(u.getPath(), forSession);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                // A link a page opens (help, reporting a problem): the phone's browser, never this window.
                String scheme = u.getScheme();
                if ("https".equals(scheme) || "http".equals(scheme)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                }
                return true;
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest req) { req.deny(); } // no camera, no microphone for a page

            // The page's fullscreen (a phone shows the picture full screen anyway): the element's view over everything.
            @Override
            public void onShowCustomView(View view, CustomViewCallback done) {
                if (fullscreenView != null) { done.onCustomViewHidden(); return; }
                fullscreenView = view;
                fullscreenDone = done;
                root.addView(view, full());
                immersive();
            }

            @Override
            public void onHideCustomView() { leaveFullscreen(); }
        });
        if (forSession) w.addJavascriptInterface(new SessionBridge(s), "mrAndroid");
        else w.addJavascriptInterface(new HomeBridge(), "mrApp");
        return w;
    }

    /**
     * One of the app's own files (assets/web/...), never anything else: no path leaves that folder. The loader of a session
     * gets window.mrShell first (SHIM), made on that session's window.mrAndroid.
     */
    private WebResourceResponse asset(String path, boolean forSession) {
        if (path == null || !path.startsWith("/web/") || path.contains("..") || path.contains("\\")) return notFound();
        String name = path.substring(1);
        String mime = name.endsWith(".html") ? "text/html" : name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css"
            : name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".png") ? "image/png" : name.endsWith(".txt") ? "text/plain" : "application/octet-stream";
        try {
            InputStream in = getAssets().open(name);
            if (forSession && name.equals("web/loader.html")) {
                String html = new String(readAll(in), StandardCharsets.UTF_8);
                int at = html.indexOf("<head>");
                html = at < 0 ? "<script>" + SHIM + "</script>" + html : html.substring(0, at + 6) + "<script>" + SHIM + "</script>" + html.substring(at + 6);
                in = new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8));
            }
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse(mime, "utf-8", 200, "OK", headers, in);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] b = new byte[16384];
        for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
        in.close();
        return out.toByteArray();
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), null);
    }

    /**
     * window.mrShell for the page of a session: the calls of the desktop client app's bridge that make sense here, made on
     * window.mrAndroid (whose answers are plain strings and booleans). The loader and the page look for these by name.
     * fullscreenAll and screens are there because the page calls them on any app (the phone is full screen anyway).
     */
    private static final String SHIM = "(function(){var A=window.mrAndroid;if(!A)return;"
        + "var J=function(s){try{return s?JSON.parse(s):null}catch(e){return null}};"
        + "var S={lang:function(){return A.lang()},setLang:function(){return Promise.resolve()},onLang:function(){},"
        + "fullscreenAll:function(){return Promise.resolve(true)},"
        + "screens:function(){return Promise.resolve([{id:0,left:0,top:0,width:screen.width,height:screen.height,primary:true}])},"
        + "home:function(){A.home();return Promise.resolve()},"
        + "hostInfo:function(o){A.hostInfo(JSON.stringify(o||{}));return Promise.resolve()},"
        + "qrPairing:function(){return Promise.resolve(A.qrPairing())},"
        + "deviceHello:function(){return Promise.resolve(J(A.deviceHello()))},"
        + "devicePaired:function(d){return Promise.resolve(A.devicePaired(JSON.stringify(d||{})))},"
        + "deviceVerified:function(fp){return Promise.resolve(A.deviceVerified(String(fp||'')))}};"
        + "if(A.hasDevice())S.bootDevice=function(){return Promise.resolve(J(A.bootDevice()))};"
        + "window.mrShell=S;})();";

    // ---- moving between the list and a session ------------------------------------------------------------------

    private void openSession(Session s, String fragment) {
        closeSession();
        current = s;
        session = webView(true, s);
        root.addView(session, full());
        fit(session);
        home.setVisibility(View.GONE);
        session.loadUrl(ORIGIN + "/web/loader.html" + fragment);
    }

    private void openHost(String hostId) {
        if (store.device(hostId) == null) return;
        openSession(new Session(hostId, null), "#auto");
    }

    private void startQr(String code) {
        openSession(new Session(store.addPending(), code), "#k=" + code + "&auto");
    }

    private void startKey() {
        openSession(new Session(null, null), "");
    }

    private void closeSession() {
        if (session != null) {
            root.removeView(session);
            session.destroy();
            session = null;
        }
        current = null;
    }

    private void goHome() {
        closeSession();
        store.dropUnpaired(); // a QR code that did not end in a token adds nothing
        home.setVisibility(View.VISIBLE);
        home.evaluateJavascript("window.refresh&&refresh()", null);
        hideKeyboard();
    }

    private void hideKeyboard() {
        InputMethodManager imm = getSystemService(InputMethodManager.class);
        if (imm != null) imm.hideSoftInputFromWindow(root.getWindowToken(), 0);
    }

    private void leaveFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        if (fullscreenDone != null) fullscreenDone.onCustomViewHidden();
        fullscreenDone = null;
        immersive();
    }

    /** The picture gets the whole screen: the system bars come back for a moment with a swipe from the edge. */
    private void immersive() {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c); // turned or folded: the WebView lays the page out anew, the session stays
        immersive();
    }

    /** Back: from a session to the list once the person says so (a stray swipe must not end it); from the list, out. */
    private void back() {
        if (fullscreenView != null) { leaveFullscreen(); return; }
        if (session == null) {
            if (home.canGoBack()) home.goBack(); // from the licences' page back to the list
            else finish();
            return;
        }
        new AlertDialog.Builder(this)
            .setMessage(R.string.leave_question)
            .setPositiveButton(R.string.leave, (d, w) -> goHome())
            .setNegativeButton(R.string.stay, null)
            .show();
    }

    // Before Android 13 (minSdk 30) back still comes here; from 13 on the callback registered in onCreate takes it.
    @SuppressWarnings("deprecation")
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override
    public void onBackPressed() { back(); }

    @Override
    protected void onDestroy() {
        closeSession();
        if (home != null) { root.removeView(home); home.destroy(); home = null; }
        super.onDestroy();
    }

    private String version() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
    }

    /** The phone's name as its owner set it ("Galaxy Z Flip6"), else its maker and model: shown in the host's devices. */
    private String phoneName() {
        String n = null;
        try { n = Settings.Global.getString(getContentResolver(), Settings.Global.DEVICE_NAME); } catch (Exception ignored) { }
        if (n == null || n.trim().isEmpty()) n = Build.MANUFACTURER + " " + Build.MODEL;
        n = n.trim();
        return n.length() > 60 ? n.substring(0, 60) : n;
    }

    // ---- the bridges ------------------------------------------------------------------------------------------------

    /** What the page of one session may ask of the app (window.mrAndroid): only about its own PC. */
    private final class SessionBridge {
        private final Session s;
        SessionBridge(Session s) { this.s = s; }

        @JavascriptInterface public String lang() { return Locale.getDefault().toLanguageTag(); }

        @JavascriptInterface public void home() { runOnUiThread(() -> { if (current == s) goHome(); }); }

        @JavascriptInterface public boolean hasDevice() { return s.hostId != null && s.qrCode == null && store.device(s.hostId) != null; }

        /** The PC's token for the loader (a PC of the list); never in a session a QR code or a typed key started. */
        @JavascriptInterface public String bootDevice() {
            if (s.hostId == null || s.qrCode != null) return "";
            JSONObject d = store.device(s.hostId);
            return d == null ? "" : d.toString();
        }

        @JavascriptInterface public boolean qrPairing() { return s.qrCode != null && !s.paired; }

        /** What this phone says about itself when it asks a host for a token (only a session a QR code started asks). */
        @JavascriptInterface public String deviceHello() {
            if (s.qrCode == null || s.paired) return "";
            try {
                return new JSONObject().put("pc", phoneName()).put("os", "android").put("osName", "Android " + Build.VERSION.RELEASE)
                    .put("app", version()).put("install", store.installId()).toString();
            } catch (Exception e) {
                return "";
            }
        }

        /** The token the host gave over the session's own connection: kept for this PC, once. */
        @JavascriptInterface public boolean devicePaired(String json) {
            if (s.qrCode == null || s.paired || s.hostId == null) return false;
            try {
                JSONObject d = new JSONObject(json);
                boolean ok = store.setDevice(s.hostId, d.optString("id"), d.optString("secret"));
                if (ok) s.paired = true;
                return ok;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface public boolean deviceVerified(String fp) {
            if (s.hostId == null || !s.paired) return false;
            store.setVerified(s.hostId);
            return true;
        }

        /** What the PC said it is (its offer): the list shows it. */
        @JavascriptInterface public void hostInfo(String json) {
            if (s.hostId == null) return;
            try {
                JSONObject o = new JSONObject(json);
                store.info(s.hostId, o.optString("pc"), o.optString("os"), o.optString("name"), o.optBoolean("connected"));
            } catch (Exception ignored) { }
        }

        /** The keyboard for the page's focused text field (after a tap that put a text caret on the host). */
        @JavascriptInterface public void showKeyboard() {
            runOnUiThread(() -> {
                if (session == null || current != s) return;
                session.requestFocus();
                InputMethodManager imm = getSystemService(InputMethodManager.class);
                if (imm != null) imm.showSoftInput(session, 0);
            });
        }

        @JavascriptInterface public String version() { return MainActivity.this.version(); }
    }

    /** What the list's page may ask of the app (window.mrApp). Names and systems of the PCs, never a secret. */
    private final class HomeBridge {
        @JavascriptInterface public String list() { return store.publicList().toString(); }

        @JavascriptInterface public String strings() {
            try {
                JSONObject o = new JSONObject();
                int[] ids = { R.string.home_empty, R.string.home_how, R.string.home_scan, R.string.home_key, R.string.home_last,
                    R.string.home_never, R.string.home_rename, R.string.home_remove, R.string.home_remove_q, R.string.ok,
                    R.string.cancel, R.string.licenses };
                String[] keys = { "empty", "how", "scan", "key", "last", "never", "rename", "remove", "removeQ", "ok", "cancel", "licenses" };
                for (int i = 0; i < ids.length; i++) o.put(keys[i], getString(ids[i]));
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface public String lang() { return Locale.getDefault().toLanguageTag(); }
        @JavascriptInterface public String version() { return MainActivity.this.version(); }
        @JavascriptInterface public void open(String id) { runOnUiThread(() -> openHost(String.valueOf(id))); }
        @JavascriptInterface public void scan() { runOnUiThread(() -> startActivityForResult(new Intent(MainActivity.this, ScanActivity.class), REQ_SCAN)); }
        @JavascriptInterface public void withKey() { runOnUiThread(MainActivity.this::startKey); }
        @JavascriptInterface public void rename(String id, String name) { store.rename(String.valueOf(id), String.valueOf(name)); }
        @JavascriptInterface public void remove(String id) { store.remove(String.valueOf(id)); }
    }
}
