package kr.pangmote.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;

/**
 * Scans the QR code of a host window's card "휴대폰 추가" (the user's design, 2026-11-26): the back camera's picture,
 * full screen, and each frame's brightness given to ZXing's QR reader (Apache-2.0). The camera is asked for when this
 * screen first opens (and only then), never in the background; nothing is kept or sent: the one code it finds that is a
 * Pangmote QR code goes back to MainActivity, which opens the PC with it.
 */
public class ScanActivity extends Activity {
    static final String EXTRA_CODE = "code";
    private static final int REQ_CAMERA = 1;

    private TextureView view;
    private TextView hint;
    private HandlerThread thread;
    private Handler handler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader reader;
    private Size preview;
    private volatile boolean done;
    private final QRCodeReader qr = new QRCodeReader();
    private final Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        view = new TextureView(this);
        root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // A square to aim with.
        View aim = new View(this);
        GradientDrawable frame = new GradientDrawable();
        frame.setStroke(dp(3), Color.WHITE);
        frame.setCornerRadius(dp(16));
        aim.setBackground(frame);
        FrameLayout.LayoutParams ap = new FrameLayout.LayoutParams(dp(240), dp(240), Gravity.CENTER);
        root.addView(aim, ap);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(dp(20), dp(16), dp(20), dp(28));
        panel.setBackgroundColor(Color.argb(200, 20, 23, 28));
        hint = new TextView(this);
        hint.setTextColor(Color.WHITE);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        hint.setGravity(Gravity.CENTER);
        hint.setText(R.string.scan_hint);
        panel.addView(hint);
        Button cancel = new Button(this);
        cancel.setText(R.string.cancel);
        cancel.setOnClickListener((v) -> { setResult(RESULT_CANCELED); finish(); });
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cp.topMargin = dp(12);
        panel.addView(cancel, cp);
        root.addView(panel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));
        setContentView(root);
        view.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> transform());
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    @Override
    protected void onResume() {
        super.onResume();
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) start();
        else requestPermissions(new String[] { Manifest.permission.CAMERA }, REQ_CAMERA);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code != REQ_CAMERA) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) start();
        else hint.setText(R.string.scan_no_camera);
    }

    @Override
    protected void onPause() {
        stop();
        super.onPause();
    }

    private void start() {
        if (thread != null) return;
        thread = new HandlerThread("scan");
        thread.start();
        handler = new Handler(thread.getLooper());
        if (view.isAvailable()) open();
        else view.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) { open(); }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) { transform(); }
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture st) { return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture st) { }
        });
    }

    private void stop() {
        try { if (session != null) session.close(); } catch (Exception ignored) { }
        try { if (camera != null) camera.close(); } catch (Exception ignored) { }
        try { if (reader != null) reader.close(); } catch (Exception ignored) { }
        session = null; camera = null; reader = null;
        if (thread != null) { thread.quitSafely(); thread = null; handler = null; }
    }

    private void open() {
        if (handler == null || camera != null) return;
        try {
            CameraManager m = getSystemService(CameraManager.class);
            String id = null;
            CameraCharacteristics chars = null;
            for (String c : m.getCameraIdList()) {
                CameraCharacteristics cc = m.getCameraCharacteristics(c);
                Integer facing = cc.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) { id = c; chars = cc; break; }
            }
            if (id == null) { hint.setText(R.string.scan_no_camera); return; }
            StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            preview = near(map.getOutputSizes(SurfaceTexture.class), 1280 * 720);
            Size scan = near(map.getOutputSizes(ImageFormat.YUV_420_888), 1280 * 720);
            reader = ImageReader.newInstance(scan.getWidth(), scan.getHeight(), ImageFormat.YUV_420_888, 2);
            reader.setOnImageAvailableListener(this::frame, handler);
            runOnUiThread(this::transform);
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
            m.openCamera(id, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice cam) { camera = cam; session(cam); }
                @Override public void onDisconnected(CameraDevice cam) { cam.close(); camera = null; }
                @Override public void onError(CameraDevice cam, int error) { cam.close(); camera = null; }
            }, handler);
        } catch (CameraAccessException | RuntimeException e) {
            hint.setText(R.string.scan_no_camera);
        }
    }

    /** The size nearest to `pixels` among those the camera offers. */
    private static Size near(Size[] sizes, int pixels) {
        Size best = sizes[0];
        for (Size s : sizes) if (Math.abs(s.getWidth() * s.getHeight() - pixels) < Math.abs(best.getWidth() * best.getHeight() - pixels)) best = s;
        return best;
    }

    @SuppressWarnings("deprecation") // createCaptureSession(List): the plain way, still there in every version
    private void session(CameraDevice cam) {
        try {
            SurfaceTexture st = view.getSurfaceTexture();
            if (st == null || reader == null) return;
            st.setDefaultBufferSize(preview.getWidth(), preview.getHeight());
            Surface shown = new Surface(st);
            CaptureRequest.Builder b = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            b.addTarget(shown);
            b.addTarget(reader.getSurface());
            b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            cam.createCaptureSession(Arrays.asList(shown, reader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession s) {
                    session = s;
                    try { s.setRepeatingRequest(b.build(), null, handler); } catch (Exception ignored) { }
                }
                @Override public void onConfigureFailed(CameraCaptureSession s) { runOnUiThread(() -> hint.setText(R.string.scan_no_camera)); }
            }, handler);
        } catch (Exception e) {
            runOnUiThread(() -> hint.setText(R.string.scan_no_camera));
        }
    }

    /** One frame's brightness (the Y plane) to the QR reader. */
    private void frame(ImageReader r) {
        Image img;
        try { img = r.acquireLatestImage(); } catch (Exception e) { return; }
        if (img == null) return;
        try {
            if (done) return;
            Image.Plane y = img.getPlanes()[0];
            ByteBuffer buf = y.getBuffer();
            int stride = y.getRowStride(), w = img.getWidth(), h = img.getHeight();
            byte[] data = new byte[stride * h];
            buf.get(data, 0, Math.min(buf.remaining(), data.length));
            PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(data, stride, h, 0, 0, w, h, false);
            try {
                Result res = qr.decode(new BinaryBitmap(new HybridBinarizer(src)), hints);
                found(res.getText());
            } catch (Exception ignored) {
                // nothing readable in this frame
            } finally {
                qr.reset();
            }
        } finally {
            img.close();
        }
    }

    private void found(String text) {
        String code = MainActivity.codeFrom(text);
        if (code == null) { runOnUiThread(() -> hint.setText(R.string.scan_not_ours)); return; }
        if (done) return;
        done = true;
        runOnUiThread(() -> {
            setResult(RESULT_OK, new Intent().putExtra(EXTRA_CODE, code));
            finish();
        });
    }

    /** The camera's picture fills the screen, upright and in its own proportions. */
    private void transform() {
        if (preview == null || view.getWidth() == 0) return;
        int vw = view.getWidth(), vh = view.getHeight();
        int rot = getDisplay() != null ? getDisplay().getRotation() : Surface.ROTATION_0;
        Matrix m = new Matrix();
        float cx = vw / 2f, cy = vh / 2f;
        if (rot == Surface.ROTATION_90 || rot == Surface.ROTATION_270) {
            RectF viewRect = new RectF(0, 0, vw, vh);
            RectF bufRect = new RectF(0, 0, preview.getHeight(), preview.getWidth());
            bufRect.offset(cx - bufRect.centerX(), cy - bufRect.centerY());
            m.setRectToRect(viewRect, bufRect, Matrix.ScaleToFit.FILL);
            float s = Math.max((float) vh / preview.getHeight(), (float) vw / preview.getWidth());
            m.postScale(s, s, cx, cy);
            m.postRotate(90 * (rot - 2), cx, cy);
        } else {
            // Upright: the camera's picture comes turned to the screen, preview.height wide and preview.width high.
            float bw = preview.getHeight(), bh = preview.getWidth(), s = Math.max(vw / bw, vh / bh);
            m.setScale(bw * s / vw, bh * s / vh, cx, cy);
            if (rot == Surface.ROTATION_180) m.postRotate(180, cx, cy);
        }
        view.setTransform(m);
    }
}
