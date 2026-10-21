package com.example.qrrecv;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;

import com.herohan.uvcapp.CameraException;
import com.herohan.uvcapp.CameraHelper;
import com.herohan.uvcapp.ICameraHelper;
import com.serenegiant.usb.Size;
import com.serenegiant.usb.UVCCamera;
import com.serenegiant.utils.UVCUtils;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/** USB Host/UVC 입력. WebView의 Camera2 목록에 없는 캡쳐보드도 직접 연다. */
final class UsbCapture {
    private final Activity activity;
    private final WebView web;
    private final UsbManager manager;
    private final Handler main = new Handler(Looper.getMainLooper());
    private ICameraHelper camera;
    private String selectedId;
    private volatile boolean destroyed;
    private boolean watching;
    private volatile AtomicBoolean frameInFlight;
    private volatile int frameSession;

    UsbCapture(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        manager = (UsbManager) activity.getSystemService(Context.USB_SERVICE);
        UVCUtils.init(activity.getApplication());
    }

    private static boolean isVideo(UsbDevice device) {
        if (device.getDeviceClass() == UsbConstants.USB_CLASS_VIDEO) return true;
        // HDMI 캡쳐보드는 장치 클래스가 0 또는 239인 복합 장치인 경우가 많다.
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            if (device.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_VIDEO) return true;
        }
        return false;
    }

    private static String id(UsbDevice device) {
        return "usb:" + device.getDeviceName();
    }

    private List<UsbDevice> devices() {
        List<UsbDevice> result = new ArrayList<>();
        if (manager != null) {
            for (UsbDevice d : manager.getDeviceList().values()) {
                if (isVideo(d)) result.add(d);
            }
        }
        result.sort(Comparator.comparing(UsbDevice::getDeviceName));
        return result;
    }

    // USB 권한이 없어도 목록을 만든다. 권한은 사용자가 입력을 열 때 요청한다.
    String deviceList() {
        JSONArray result = new JSONArray();
        for (UsbDevice device : devices()) {
            try {
                String name = device.getProductName();
                if (name == null || name.trim().isEmpty()) name = "USB 비디오";
                result.put(new JSONObject().put("id", id(device))
                        .put("label", name + String.format(" [%04X:%04X]", device.getVendorId(), device.getProductId())
                                + " (USB 캡쳐보드/카메라)"));
            } catch (JSONException e) {
                throw new IllegalStateException(e);
            }
        }
        return result.toString();
    }

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction()) && selectedId != null) {
                boolean present = false;
                for (UsbDevice device : devices()) if (selectedId.equals(id(device))) present = true;
                if (!present) stop();
            }
            javascript("window.onUsbDevicesChanged && window.onUsbDevicesChanged()");
        }
    };

    void watch() {
        if (watching || destroyed) return;
        IntentFilter filter = new IntentFilter(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else activity.registerReceiver(receiver, filter);
        watching = true;
        javascript("window.onUsbDevicesChanged && window.onUsbDevicesChanged()");
    }

    void unwatch() {
        stop();
        if (watching) activity.unregisterReceiver(receiver);
        watching = false;
    }

    void error(int session, String message) {
        javascript("window.onUsbError && window.onUsbError(" + session + "," + JSONObject.quote(message) + ")");
    }

    void start(String deviceId, int session) {
        stop();
        if (destroyed) return;
        UsbDevice found = null;
        for (UsbDevice device : devices()) if (deviceId.equals(id(device))) found = device;
        if (found == null) {
            error(session, "USB 캡쳐보드가 연결되어 있지 않습니다. OTG 연결을 확인하세요.");
            return;
        }
        final UsbDevice device = found;
        final ICameraHelper helper;
        try {
            helper = new CameraHelper();
        } catch (Exception | LinkageError e) {
            Log.e("UsbCapture", "UVC 초기화 실패", e);
            error(session, "이 기기에서 USB 비디오를 초기화하지 못했습니다: " + e.getMessage());
            return;
        }
        camera = helper;
        selectedId = deviceId;
        helper.setVideoCaptureConfig(helper.getVideoCaptureConfig().setAudioCaptureEnable(false));
        helper.setStateCallback(new ICameraHelper.StateCallback() {
            // 라이브러리의 권한 창은 onPause를 일으킬 수 있다. onStop에서만 해제한다.
            private boolean current() { return !destroyed && camera == helper; }
            private void fail(String message) {
                if (!current()) return;
                stop();
                error(session, message);
            }
            @Override public void onAttach(UsbDevice attached) { /* 사용자가 고른 장치만 연다. */ }
            @Override public void onDeviceOpen(UsbDevice opened, boolean firstOpen) {
                if (current()) helper.openCamera(new Size(UVCCamera.UVC_VS_FRAME_MJPEG,
                        1280, 720, 30, Collections.singletonList(30)));
            }
            @Override public void onCameraOpen(UsbDevice opened) {
                if (!current()) return;
                Size size = previewSize(helper.getSupportedSizeList(), helper.getPreviewSize());
                if (size == null) { fail("캡쳐보드의 영상 크기를 확인하지 못했습니다."); return; }
                helper.setPreviewSize(size);
                final int width = size.width, height = size.height;
                // 한 프레임의 인식이 끝나기 전에는 다음 프레임을 WebView에 쌓지 않는다.
                AtomicBoolean inFlight = new AtomicBoolean();
                frameInFlight = inFlight;
                frameSession = session;
                helper.setFrameCallback(new com.serenegiant.usb.IFrameCallback() {
                    private long lastFrame;
                    @Override public void onFrame(ByteBuffer frame) {
                        long now = SystemClock.elapsedRealtime();
                        if (now - lastFrame < 80 || !inFlight.compareAndSet(false, true)) return;
                        lastFrame = now;
                        try {
                            ByteBuffer input = frame.duplicate();
                            input.clear();
                            int length = width * height * 3 / 2;
                            if (input.remaining() < length) { inFlight.set(false); return; }
                            byte[] pixels = new byte[length];
                            input.get(pixels);
                            ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
                            boolean ok = new YuvImage(pixels, ImageFormat.NV21, width, height, null)
                                    .compressToJpeg(new Rect(0, 0, width, height), 90, jpeg);
                            if (!ok) { inFlight.set(false); return; }
                            String data = Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP);
                            main.post(() -> {
                                if (!current()) { inFlight.set(false); return; }
                                web.evaluateJavascript("window.onUsbFrame ? window.onUsbFrame(" + session
                                        + "," + JSONObject.quote(data) + "," + width + "," + height + ") : false",
                                        value -> { if (!"true".equals(value)) inFlight.set(false); });
                            });
                        } catch (Exception e) {
                            inFlight.set(false);
                            Log.w("UsbCapture", "USB 프레임 변환 실패", e);
                        }
                    }
                }, UVCCamera.PIXEL_FORMAT_NV21);
                helper.startPreview();
                javascript("window.onUsbStarted && window.onUsbStarted(" + session + "," + width + "," + height + ")");
            }
            @Override public void onCameraClose(UsbDevice closed) {
                fail("USB 영상 연결이 종료되었습니다. 다시 켜세요.");
            }
            @Override public void onDeviceClose(UsbDevice closed) {
                fail("USB 연결이 종료되었습니다. 캡쳐보드를 다시 연결하세요.");
            }
            @Override public void onDetach(UsbDevice detached) {
                if (device.equals(detached)) fail("USB 캡쳐보드가 분리되었습니다.");
            }
            @Override public void onCancel(UsbDevice cancelled) {
                fail("USB 접근이 허용되지 않았습니다. 다시 켜고 접근 권한을 허용하세요.");
            }
            @Override public void onError(UsbDevice failed, CameraException e) {
                Log.e("UsbCapture", "USB 카메라 열기 실패", e);
                fail("USB 영상을 열지 못했습니다. 다른 카메라 앱을 닫고 다시 연결하세요.");
            }
        });
        // selectDevice 내부에서 UsbManager.requestPermission을 호출한다.
        helper.selectDevice(device);
    }

    private static Size previewSize(List<Size> sizes, Size fallback) {
        Size best = null;
        long score = Long.MAX_VALUE;
        if (sizes != null) for (Size size : sizes) {
            if (size.width <= 0 || size.height <= 0 || (size.width & 1) != 0 || (size.height & 1) != 0) continue;
            // QR 식별력을 확보하면서 USB 대역폭과 WebView 프레임 복사 비용을 제한한다.
            long area = (long) size.width * size.height;
            long candidate = Math.abs(area - 1280L * 720)
                    + (area > 1920L * 1080 ? 100_000_000L : 0)
                    + (size.type == UVCCamera.UVC_VS_FRAME_MJPEG ? 0 : 10_000_000L);
            if (candidate < score) { best = size; score = candidate; }
        }
        if (best == null) return fallback;
        Size selected = best.clone();
        if (selected.fpsList != null && !selected.fpsList.isEmpty()) {
            selected.fps = selected.fpsList.stream().filter(fps -> fps <= 30)
                    .max(Integer::compareTo).orElse(Collections.min(selected.fpsList));
        }
        return selected;
    }

    void stop() {
        ICameraHelper old = camera;
        camera = null;
        selectedId = null;
        if (old != null) old.release();
    }

    void frameDone(int session) {
        AtomicBoolean pending = frameInFlight;
        if (session == frameSession && pending != null) pending.set(false);
    }

    void destroy() {
        unwatch();
        destroyed = true;
    }

    private void javascript(String script) {
        main.post(() -> { if (!destroyed) web.evaluateJavascript(script, null); });
    }
}
