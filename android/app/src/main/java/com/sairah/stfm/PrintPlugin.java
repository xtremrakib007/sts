package com.sairah.stfm;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Prints an HTML document with Android's print framework (printers and
 * "Save as PDF"), inside the app. JS: Capacitor.Plugins.StfmPrint.print({ html, name }).
 */
@CapacitorPlugin(name = "StfmPrint")
public class PrintPlugin extends Plugin {

    // Held until the print job has been handed to PrintManager, so the
    // off-screen WebView is not garbage collected while it renders.
    private WebView printView;

    @PluginMethod
    public void print(PluginCall call) {
        final String html = call.getString("html");
        final String name = call.getString("name", "Invoice");
        if (html == null || html.isEmpty()) {
            call.reject("html is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                WebView view = new WebView(getActivity());
                printView = view;
                view.setWebViewClient(new WebViewClient() {
                    private boolean started = false;

                    @Override
                    public void onPageFinished(WebView v, String url) {
                        if (started) return;
                        started = true;
                        PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                        if (pm == null) {
                            call.reject("Printing is not available on this device");
                            return;
                        }
                        PrintAttributes attrs = new PrintAttributes.Builder()
                                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                .build();
                        pm.print(name, v.createPrintDocumentAdapter(name), attrs);
                        printView = null;
                        call.resolve();
                    }
                });
                view.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
            } catch (Exception e) {
                call.reject("Could not print: " + e.getMessage());
            }
        });
    }
}
