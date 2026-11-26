package kr.pangmote.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Pangmote for Android: a phone controls a PC (the user's plan, 2026-11-26). The app is a thin shell around the same
 * loader and client page that browsers and the desktop client app run, in the system's WebView:
 * - the loader (pangmote-client.html, put into the app's assets at build time) is served from an https origin of the
 *   app's own (ORIGIN, intercepted here, never fetched from the network), so that the page is a secure context (WebRTC,
 *   WebCrypto) and keeps its storage; the loader fetches the client page from the host as everywhere else, so the page
 *   comes with the host and is updated with it;
 * - the whole screen is the picture (the system bars hidden, back with a swipe), the screen stays on while the app is
 *   in front, and turning the phone or folding it does not end the session (the activity handles those changes);
 * - the keyboard's insets shrink the page, so the page knows what the keyboard leaves of the window (it keeps the
 *   picture's size and moves the text caret above it: revealCaret in client.template.html);
 * - window.mrAndroid: the page asks for the keyboard (showKeyboard), which a WebView may not bring up by itself for a
 *   focus that comes a moment after a tap.
 * Nothing else is given to the page yet: device tokens, the list of PCs and the other powers of the desktop client app
 * come with the page signature check, as there (client/pagecheck.js).
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net"; // reserved for apps' own assets, never a real site
    static final String ORIGIN = "https://" + HOST;
    private WebView web;
    private FrameLayout root;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenDone;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setNavigationBarColor(Color.BLACK);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(0x14, 0x17, 0x1c));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // The keyboard and the display cutout: the page gets the space they leave (edge to edge is the rule from
        // Android 15 on, so the insets are applied here).
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
            android.graphics.Insets cut = insets.getInsets(WindowInsets.Type.displayCutout());
            web.setPadding(0, 0, 0, 0);
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) web.getLayoutParams();
            lp.setMargins(cut.left, cut.top, cut.right, Math.max(ime, cut.bottom));
            web.setLayoutParams(lp);
            return WindowInsets.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // the host's sound plays without a tap of its own
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setSupportMultipleWindows(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                return asset(u.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                // A link the page opens (help, reporting a problem): the phone's browser, never this window.
                String scheme = u.getScheme();
                if ("https".equals(scheme) || "http".equals(scheme)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest req) { req.deny(); } // no camera, no microphone

            // The page's fullscreen (a phone shows the picture full screen anyway): the element's view over everything.
            @Override
            public void onShowCustomView(View view, CustomViewCallback done) {
                if (fullscreenView != null) { done.onCustomViewHidden(); return; }
                fullscreenView = view;
                fullscreenDone = done;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                immersive();
            }

            @Override
            public void onHideCustomView() { leaveFullscreen(); }
        });
        web.addJavascriptInterface(new Bridge(), "mrAndroid");

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::askToLeave);
        }
        if (state != null) web.restoreState(state);
        else web.loadUrl(ORIGIN + "/web/loader.html");
        immersive();
    }

    /** One of the app's own files (assets/web/...), never anything else: no path leaves that folder. */
    private WebResourceResponse asset(String path) {
        if (path == null || !path.startsWith("/web/") || path.contains("..") || path.contains("\\")) return notFound();
        String name = path.substring(1);
        String mime = name.endsWith(".html") ? "text/html" : name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css"
            : name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".png") ? "image/png" : "application/octet-stream";
        try {
            InputStream in = getAssets().open(name);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse(mime, "utf-8", 200, "OK", headers, in);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), null);
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

    /** Back closes the app only when the person says so: a stray swipe must not end the session. */
    private void askToLeave() {
        if (fullscreenView != null) { leaveFullscreen(); return; }
        new AlertDialog.Builder(this)
            .setMessage(R.string.leave_question)
            .setPositiveButton(R.string.leave, (d, w) -> finish())
            .setNegativeButton(R.string.stay, null)
            .show();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() { askToLeave(); } // before Android 13

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** What the page may ask of the app (window.mrAndroid). Nothing here reads or keeps anything of the page's. */
    private final class Bridge {
        /** The keyboard for the page's focused text field (after a tap that put a text caret on the host). */
        @JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(() -> {
                if (web == null) return;
                web.requestFocus();
                InputMethodManager imm = getSystemService(InputMethodManager.class);
                if (imm != null) imm.showSoftInput(web, 0);
            });
        }

        @JavascriptInterface
        public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
        }
    }
}
