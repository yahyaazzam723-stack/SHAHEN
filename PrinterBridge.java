package com.shaheenexpress.restaurant;

/**
 * PrinterBridge.java
 * ============================================================================
 * جسر الطباعة الصامتة الحقيقي — يتصل مباشرة بخدمة الطابعة الداخلية المدمجة عبر
 * AIDL (التواصل لا يمر إطلاقاً عبر نظام Android Print Manager، ولذلك لا تظهر
 * أي نافذة طباعة أو معاينة أو اختيار طابعة أو حجم ورق على الإطلاق).
 *
 * هذا الملف يُستخدَم داخل مشروع Android Studio حقيقي (لا يعمل مع أدوات تحويل
 * المواقع الجاهزة مثل Website 2 APK Builder Pro، لأنها لا تسمح بإضافة كود Java
 * مخصَّص أو AIDL خاص بالمشروع).
 * ============================================================================
 */

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;
import android.os.RemoteException;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import woyou.aidlservice.jiuiv5.ICallback;
import woyou.aidlservice.jiuiv5.IWoyouService;

public class PrinterBridge {

    private static final String TAG = "ShaheenPrinterBridge";
    private static final String SERVICE_PACKAGE = "woyou.aidlservice.jiuiv5";
    private static final String SERVICE_ACTION  = "woyou.aidlservice.jiuiv5.IWoyouService";

    private IWoyouService woyouService;
    private final Context appContext;
    private final WebView webView; // مرجع لإعادة استدعاء جافاسكريبت بنتيجة الطباعة (نجاح/فشل)

    public PrinterBridge(Context context, WebView webView) {
        this.appContext = context.getApplicationContext();
        this.webView = webView;
        connectPrinterService();
    }

    // ===== الاتصال بخدمة الطابعة عند بدء تشغيل التطبيق — يبقى الاتصال فعالاً طوال عمل التطبيق =====
    private final ServiceConnection connService = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            woyouService = IWoyouService.Stub.asInterface(service);
            Log.i(TAG, "✅ تم الاتصال بخدمة الطابعة الداخلية بنجاح");
            notifyWeb("connected", "تم الاتصال بالطابعة بنجاح");
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            woyouService = null;
            Log.w(TAG, "⚠️ انقطع الاتصال بخدمة الطابعة — جارٍ إعادة المحاولة");
            notifyWeb("disconnected", "انقطع الاتصال بالطابعة");
            // إعادة محاولة الاتصال تلقائياً بعد ثانيتين
            new android.os.Handler(android.os.Looper.getMainLooper())
                    .postDelayed(PrinterBridge.this::connectPrinterService, 2000);
        }
    };

    public void connectPrinterService() {
        try {
            Intent intent = new Intent();
            intent.setPackage(SERVICE_PACKAGE);
            intent.setAction(SERVICE_ACTION);
            appContext.startService(intent);
            appContext.bindService(intent, connService, Context.BIND_AUTO_CREATE);
        } catch (Exception e) {
            Log.e(TAG, "🔥 فشل الاتصال بخدمة الطابعة: " + e.getMessage());
            notifyWeb("error", "فشل الاتصال بخدمة الطابعة: " + e.getMessage());
        }
    }

    // ===========================================================================
    // ===== الدالة الرئيسية المستدعاة من جافاسكريبت — طباعة صامتة كاملة بدون أي نافذة =====
    // الاستدعاء من الموقع: window.AndroidPrinter.printReceipt(jsonReceiptText)
    // ===========================================================================
    @JavascriptInterface
    public void printReceipt(final String receiptText) {
        if (woyouService == null) {
            Log.e(TAG, "❌ محاولة طباعة قبل اتصال الخدمة — إعادة محاولة الاتصال");
            notifyWeb("print_failed", "الطابعة غير متصلة حالياً، أعد المحاولة بعد ثوانٍ");
            connectPrinterService();
            return;
        }
        try {
            ICallback callback = new ICallback.Stub() {
                @Override public void onRunResult(boolean isSuccess) throws RemoteException {
                    if (isSuccess) notifyWeb("print_success", "تمت الطباعة بنجاح");
                    else notifyWeb("print_failed", "فشلت الطباعة — تحقق من الورق أو غطاء الطابعة");
                }
                @Override public void onReturnString(String result) throws RemoteException {}
                @Override public void onRaiseException(int code, String msg) throws RemoteException {
                    notifyWeb("print_failed", "خطأ من الطابعة (" + code + "): " + msg);
                }
                @Override public void onPrintResult(int code, String msg) throws RemoteException {
                    if (code != 1) notifyWeb("print_failed", "حالة الطابعة غير جيدة (" + code + "): " + msg);
                }
            };

            // محاذاة الوسط لاسم المطعم والشعار
            woyouService.setAlignment(1, null);
            woyouService.printText(receiptText, callback);
            // قص الورق تلقائياً بعد الطباعة (أمر ESC/POS قياسي: GS V 0)
            woyouService.sendRAWData(new byte[]{0x1D, 0x56, 0x00}, null);
        } catch (RemoteException e) {
            Log.e(TAG, "🔥 خطأ أثناء إرسال أمر الطباعة: " + e.getMessage());
            notifyWeb("print_failed", "خطأ أثناء إرسال أمر الطباعة: " + e.getMessage());
        }
    }

    // طباعة رمز QR (يُستخدَم لاحقاً لنظام الدفع بنقاط الشاهين)
    @JavascriptInterface
    public void printQRCode(final String qrData) {
        if (woyouService == null) { notifyWeb("print_failed", "الطابعة غير متصلة"); return; }
        try {
            woyouService.printQRCode(qrData, 8, 2, null);
            woyouService.lineWrap(2, null);
        } catch (RemoteException e) {
            notifyWeb("print_failed", "فشل طباعة رمز QR: " + e.getMessage());
        }
    }

    @JavascriptInterface
    public boolean isPrinterConnected() {
        return woyouService != null;
    }

    // إعادة استدعاء جافاسكريبت بنتيجة العملية — يربط مباشرة بدالة موجودة في restaurant_portal.html
    private void notifyWeb(final String status, final String message) {
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript(
                "if (window.onAndroidPrinterEvent) window.onAndroidPrinterEvent('" +
                        status.replace("'", "") + "','" + message.replace("'", "").replace("\n", " ") + "');",
                null));
    }
}
