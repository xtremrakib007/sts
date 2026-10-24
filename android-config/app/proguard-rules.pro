# ProGuard rules for STFM Sales APK
# Keep Capacitor bridge intact
-keep class com.getcapacitor.** { *; }
-keep class com.sairah.stfm.** { *; }

# Keep Firebase classes
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }

# Keep JavaScript interface methods
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep Cordova plugin classes
-keep public class * extends org.apache.cordova.CordovaPlugin

# Suppress warnings for missing classes
-dontwarn okhttp3.**
-dontwarn okio.**
