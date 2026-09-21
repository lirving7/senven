package com.jobpilot.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * JobPilot Android WebView 壳（debug 用途）。
 *
 * 关键能力：
 * 1. WebView 加载 BuildConfig.APP_URL（本机/局域网服务）
 * 2. 启用 Cookie + DOM Storage —— 会话登录态依赖 Cookie
 * 3. 支持 <input type="file"> —— 简历/头像上传核心功能
 * 4. 支持 PDF 等二进制下载 —— 简历 PDF 导出
 * 5. 返回键优先回退 WebView 历史
 * 6. 主框架加载失败时显示可重试的错误页
 * 7. 状态保存/恢复 —— 进程被回收重建后保留页面
 * 8. Android 15 (API 35) edge-to-edge：内容不被系统栏遮挡
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final String TAG = "JobPilotWebView";
    private static final Uri APP_URI = Uri.parse(BuildConfig.APP_URL);

    private WebView webView;
    private View errorView;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        CookieManager cookieManager = CookieManager.getInstance();
        // setAcceptCookie 是全局（application-wide）API，与具体 WebView 实例无关。
        cookieManager.setAcceptCookie(true);

        webView = new WebView(this);
        // 第 3 方 Cookie 关闭：本服务不需要。
        // 注意：setAcceptThirdPartyCookies 是 per-WebView API。Chromium 的实现
        // （com.android.webview.chromium.CookieManagerAdapter#setAcceptThirdPartyCookies）
        // 方法体为 `webView.getSettings().setAcceptThirdPartyCookies(accept);`，不做判空。
        // 因此它必须在 WebView 实例创建之后、传入真实实例调用；传 null（或在本行之前
        // 调用）会抛 NullPointerException，从 onCreate 逃逸导致进程崩溃 —— 即"启动即闪退"。
        cookieManager.setAcceptThirdPartyCookies(webView, false);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                String host = uri.getHost();
                int port = uri.getPort();
                if (("http".equals(scheme) || "https".equals(scheme)) && host != null) {
                    String appHost = APP_URI.getHost();
                    int appPort = APP_URI.getPort();
                    boolean sameHost = appHost != null && appHost.equalsIgnoreCase(host);
                    boolean samePort =
                        appPort == port
                        || (appPort == -1 && port == -1)
                        || (appPort == 80 && "http".equals(scheme))
                        || (appPort == 443 && "https".equals(scheme));
                    if (sameHost && samePort) {
                        return false;
                    }
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER);
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        // PDF / 二进制下载
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(
                String url,
                String userAgent,
                String contentDisposition,
                String mimetype,
                long contentLength
            ) {
                Log.i(TAG, "Download start: " + mimetype + " " + url);
                try {
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    // 把会话 Cookie 一起带上（与 WebView 共用 CookieJar）
                    String cookie = CookieManager.getInstance().getCookie(url);
                    if (cookie != null) {
                        req.addRequestHeader("Cookie", cookie);
                    }
                    req.setMimeType(mimetype);
                    req.setDescription(getString(R.string.app_name) + " 下载");
                    String fileName = URLUtil.guessFileName(url, contentDisposition, mimetype);
                    req.setTitle(fileName);
                    req.allowScanningByMediaScanner();
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm != null) {
                        dm.enqueue(req);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Download failed", e);
                }
            }
        });

        // Android 15 (API 35) edge-to-edge：状态栏 / 导航栏不遮挡内容
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            webView.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
        }

        errorView = buildErrorView();

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(errorView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        errorView.setVisibility(View.GONE);

        setContentView(root);
        if (savedInstanceState == null) {
            webView.loadUrl(BuildConfig.APP_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private View buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(48, 64, 48, 64);
        box.setGravity(android.view.Gravity.CENTER_HORIZONTAL);

        TextView title = new TextView(this);
        title.setText("无法连接到 JobPilot 服务");
        title.setTextSize(18);
        title.setPadding(0, 0, 0, 16);

        TextView desc = new TextView(this);
        desc.setText(
            "请确认：\n" +
            "1. 电脑已启动 next dev（端口 3000）\n" +
            "2. 手机与电脑在同一 WiFi / 同一局域网\n" +
            "3. 当前请求地址：" + BuildConfig.APP_URL
        );
        desc.setTextSize(14);
        desc.setPadding(0, 0, 0, 24);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.loadUrl(BuildConfig.APP_URL);
        });

        box.addView(title);
        box.addView(desc);
        box.addView(retry);
        return box;
    }

    private void showError() {
        webView.setVisibility(View.GONE);
        errorView.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE_CHOOSER) return;
        if (filePathCallback == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            String dataString = data.getDataString();
            if (dataString != null) {
                results = new Uri[]{Uri.parse(dataString)};
            } else if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            }
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 保证会话 Cookie 落盘
        CookieManager.getInstance().flush();
    }
}