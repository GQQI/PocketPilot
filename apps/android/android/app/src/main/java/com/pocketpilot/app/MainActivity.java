package com.pocketpilot.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

/**
 * Hardware back stays inside the web app (chat → sessions → home).
 * The activity finishes only when the page returns "exit" from home.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView view = getBridge() == null ? null : getBridge().getWebView();
                if (view == null) {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    return;
                }
                view.evaluateJavascript(
                    "(function(){try{if(typeof window.__pocketpilotBack==='function')return window.__pocketpilotBack();}catch(e){}return 'exit';})()",
                    value -> {
                        if (value != null && value.contains("exit")) {
                            runOnUiThread(() -> {
                                setEnabled(false);
                                getOnBackPressedDispatcher().onBackPressed();
                            });
                        }
                    }
                );
            }
        });
    }
}
