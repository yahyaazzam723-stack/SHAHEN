package com.shaheenexpress.restaurant;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.appcompat.app.AppCompatActivity;

/**
 * MainActivity.java — مثال كامل لتشغيل موقع بوابة المطعم داخل WebView مع جسر
 * الطباعة الصامتة المتصل بالطابعة الداخلية. هذا يستبدل وظيفة "Website 2 APK
 * Builder Pro" — يحتاج مشروع Android Studio حقيقي.
 */
public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private PrinterBridge printerBridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main); // يحتوي فقط على <WebView android:id="@+id/webview" .../>

        webView = findViewById(R.id.webview);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);   // مطلوب لعمل localStorage/sessionStorage بشكل صحيح
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // ===== الاتصال بالطابعة الداخلية مرة واحدة عند بدء التطبيق ويبقى الاتصال فعالاً =====
        printerBridge = new PrinterBridge(this, webView);

        // ===== الجسر الأهم: يجعل window.AndroidPrinter متاحاً داخل صفحة الويب نفسها =====
        webView.addJavascriptInterface(printerBridge, "AndroidPrinter");

        // رابط موقع بوابة المطعم — استبدله برابطك الفعلي
        webView.loadUrl("https://your-domain.com/restaurant_portal.html");
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (webView != null) webView.destroy();
    }
}
