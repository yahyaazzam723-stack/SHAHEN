// ICallback.aidl
package woyou.aidlservice.jiuiv5;

// واجهة استدعاء نتيجة تنفيذ أوامر الطباعة
interface ICallback {
    oneway void onRunResult(boolean isSuccess);
    oneway void onReturnString(String result);
    oneway void onRaiseException(int code, String msg);
    oneway void onPrintResult(int code, String msg);
}
