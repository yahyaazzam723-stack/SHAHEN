# جسر الطباعة الصامتة لجهاز Sewell V2 (متوافق مع AIDL على طراز Sunmi)

## ما هذا؟
هذا مشروع Android Studio حقيقي (ليس أداة تحويل موقع لتطبيق) يربط موقع بوابة
المطعم مباشرة بخدمة الطابعة الداخلية في الجهاز، عبر AIDL — بدون أي نافذة طباعة
من نظام أندرويد على الإطلاق.

⚠️ **مهم جداً:** هذا لا يعمل مع "Website 2 APK Builder Pro" — تلك الأداة لا تسمح
بإضافة كود Java/AIDL مخصَّص. تحتاج مشروع Android Studio منفصل (أو مطوّر Android
يدمج هذه الملفات في مشروع جديد). إن لم يتوفر مطوّر لديك، يمكن الاستعانة بمطوّر
مستقل (Fiverr/Upwork) لمدة ساعة إلى ساعتين فقط — هذا المشروع جاهز ومكتمل، لا
يحتاج بحثاً أو تطويراً إضافياً، فقط تجميعاً (Build) وتأكيداً أن الجهاز يدعم نفس
واجهة AIDL هذه فعلياً.

## بنية الملفات
```
app/
├── src/main/
│   ├── aidl/woyou/aidlservice/jiuiv5/
│   │   ├── IWoyouService.aidl   ← لا تغيّر اسم الحزمة (package) إطلاقاً
│   │   └── ICallback.aidl
│   ├── java/com/shaheenexpress/restaurant/
│   │   ├── PrinterBridge.java
│   │   └── MainActivity.java
│   ├── res/layout/activity_main.xml   ← فقط WebView بكامل الشاشة
│   └── AndroidManifest.xml
```

## AndroidManifest.xml — الصلاحيات المطلوبة
```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

<application
    android:usesCleartextTraffic="false"
    ...>
    <activity android:name=".MainActivity"
        android:exported="true"
        android:screenOrientation="portrait">
        <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent-filter>
    </activity>
</application>
```
لا حاجة لأي صلاحية Bluetooth/USB خاصة — التواصل مع الطابعة الداخلية يتم بالكامل
عبر AIDL (وهو تواصل بين عمليات داخل نظام أندرويد نفسه، لا عبر منفذ فعلي).

## activity_main.xml
```xml
<?xml version="1.0" encoding="utf-8"?>
<WebView xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/webview"
    android:layout_width="match_parent"
    android:layout_height="match_parent" />
```

## خطوات التجميع (Build)
1. أنشئ مشروع Android Studio جديد (Empty Activity، الحد الأدنى API 21 يكفي لأندرويد 7.1.1).
2. ضع ملفات `aidl/` و `java/` في المسارات المذكورة أعلاه بالضبط.
3. عدّل `webView.loadUrl(...)` في `MainActivity.java` لرابط موقعك الفعلي.
4. شغّل **Build → Rebuild Project** — يجب أن تتولّد فئات `IWoyouService` و
   `ICallback` تلقائياً من ملفات AIDL.
5. ثبّت التطبيق على نفس جهاز Sewell V2 وجرّب.

## ربط جانب الموقع (JavaScript) — تم تنفيذه بالفعل في `restaurant_portal.html`
الموقع يستدعي:
```js
if (window.AndroidPrinter) {
    window.AndroidPrinter.printReceipt(receiptText);
}
```
ويستقبل نتيجة الطباعة (نجاح/فشل) عبر:
```js
window.onAndroidPrinterEvent = function(status, message) {
    // status: connected | disconnected | print_success | print_failed | error
};
```

## ⚠️ نقطة عدم تأكد صادقة
لا يمكن ضمان أن جهاز Sewell V2 يستخدم **نفس** واجهة AIDL هذه بالضبط (تطابق
الاسم `woyou.aidlservice.jiuiv5` حرفياً) قبل التجربة الفعلية — هذه الواجهة
موثّقة علناً من Sunmi، وكثير من أجهزة POS الاقتصادية المعتمدة على نفس شريحة
MT6739 تستنسخها للتوافق، لكن هذا **ليس مؤكَّداً 100%** لهذا الجهاز تحديداً إلا
بالتجربة المباشرة على الجهاز نفسه.

إذا فشل الاتصال بالخدمة (`onServiceConnected` لا يُستدعى أبداً)، فهذا يعني أن
الجهاز يستخدم واجهة AIDL مختلفة تماماً، ويحتاج الأمر فحص ملفات النظام في الجهاز
(عبر ADB: `adb shell dumpsys package | grep -i print` للبحث عن اسم الخدمة
الحقيقي المثبَّتة على هذا الجهاز بالضبط) لتصحيح اسم الحزمة (`SERVICE_PACKAGE`)
والإجراء (`SERVICE_ACTION`) في `PrinterBridge.java`.
