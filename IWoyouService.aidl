// IWoyouService.aidl
// واجهة AIDL العامة والموثَّقة رسمياً (Sunmi-compatible) لطابعة نقاط البيع المدمجة
// المسار يجب أن يبقى كما هو بالضبط: aidl/woyou/aidlservice/jiuiv5/IWoyouService.aidl
package woyou.aidlservice.jiuiv5;

import woyou.aidlservice.jiuiv5.ICallback;
import android.graphics.Bitmap;

interface IWoyouService
{
    void updateFirmware();
    int getFirmwareStatus();
    String getServiceVersion();
    void printerInit(in ICallback callback);
    void printerSelfChecking(in ICallback callback);
    String getPrinterSerialNo();
    String getPrinterVersion();
    String getPrinterModal();
    void getPrintedLength(in ICallback callback);
    void lineWrap(int n, in ICallback callback);

    // طباعة باستخدام أوامر ESC/POS الخام مباشرة
    void sendRAWData(in byte[] data, in ICallback callback);

    // 0=يسار، 1=وسط، 2=يمين
    void setAlignment(int alignment, in ICallback callback);
    void setFontName(String typeface, in ICallback callback);
    void setFontSize(float fontsize, in ICallback callback);

    // طباعة نص عادي
    void printText(String text, in ICallback callback);
    void printTextWithFont(String text, String typeface, float fontsize, in ICallback callback);

    void printColumnsText(in String[] colsTextArr, in int[] colsWidthArr, in int[] colsAlign, in ICallback callback);

    // طباعة شعار/صورة (الحد الأقصى لعرض الصورة 384 بكسل)
    void printBitmap(in Bitmap bitmap, in ICallback callback);

    // طباعة باركود أحادي البعد
    void printBarCode(String data, int symbology, int height, int width, int textposition, in ICallback callback);

    // طباعة رمز QR — هذا ما تحتاجه لنظام نقاط الشاهين بالدفع عبر QR لاحقاً
    void printQRCode(String data, int modulesize, int errorlevel, in ICallback callback);

    void printOriginalText(String text, in ICallback callback);
    void commitPrinterBuffer();
    void enterPrinterBuffer(in boolean clean);
    void exitPrinterBuffer(in boolean commit);
    void printColumnsString(in String[] colsTextArr, in int[] colsWidthArr, in int[] colsAlign, in ICallback callback);
    void printBitmapCustom(in Bitmap bitmap, in int type, in ICallback callback);
}
