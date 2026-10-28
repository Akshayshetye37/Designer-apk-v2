const fs = require('fs');
const path = require('path');

const androidDir = path.join(__dirname, '..', 'android');
const appDir = path.join(androidDir, 'app', 'src', 'main');
const manifestPath = path.join(appDir, 'AndroidManifest.xml');
if (!fs.existsSync(manifestPath)) throw new Error('AndroidManifest.xml not found; run npx cap add android first.');

let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('android.permission.INTERNET')) {
  manifest = manifest.replace('<manifest', '<manifest\n    xmlns:tools="http://schemas.android.com/tools"');
  manifest = manifest.replace(/<application\b/, '    <uses-permission android:name="android.permission.INTERNET" />\n    <application');
}
if (!manifest.includes('android.permission.READ_EXTERNAL_STORAGE')) {
  manifest = manifest.replace(/<application\b/, '    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />\n    <application');
}
if (!manifest.includes('android.permission.WRITE_EXTERNAL_STORAGE')) {
  manifest = manifest.replace(/<application\b/, '    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />\n    <application');
}
fs.writeFileSync(manifestPath, manifest);

const javaDir = path.join(appDir, 'java', 'com', 'aurelia', 'pms');
fs.mkdirSync(javaDir, { recursive: true });
const javaPath = path.join(javaDir, 'MainActivity.java');
const java = String.raw\`
package com.aurelia.pms;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;
import com.getcapacitor.BridgeActivity;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {
  private static final int PICK_BACKUP_FOLDER = 7101;
  private static final int CREATE_BACKUP_FILE = 7102;
  private String folderRequestId = "";
  private String pendingFileRequestId = "";
  private byte[] pendingBytes = new byte[0];
  private SharedPreferences prefs;

  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    prefs = getSharedPreferences("aurelia_storage", MODE_PRIVATE);
    bridge.getWebView().addJavascriptInterface(new AureliaBridge(), "AureliaNative");
  }

  private void js(String script) {
    runOnUiThread(() -> {
      if (bridge != null && bridge.getWebView() != null) bridge.getWebView().evaluateJavascript(script, null);
    });
  }
  private static String q(String value) { return JSONObject.quote(value == null ? "" : value); }
  private void folderResult(String id, boolean ok, String message) {
    js("window.aureliaNativeBackupFolderResult && window.aureliaNativeBackupFolderResult(" + q(id) + "," + ok + "," + q(message) + ")");
  }
  private void backupResult(String id, boolean ok, String error) {
    js("window.aureliaNativeDeviceBackupResult && window.aureliaNativeDeviceBackupResult(" + q(id) + "," + ok + "," + q(error) + ")");
  }

  private boolean writeToSelectedFolder(String name, String payload) {
    String saved = prefs.getString("backup_tree_uri", null);
    if (saved == null || saved.isEmpty()) return false;
    Uri tree = Uri.parse(saved);
    Uri root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    try {
      Uri file = DocumentsContract.createDocument(getContentResolver(), root, "application/json", name);
      if (file == null) return false;
      try (OutputStream out = getContentResolver().openOutputStream(file, "wt")) {
        if (out == null) return false;
        out.write(payload.getBytes(StandardCharsets.UTF_8));
        out.flush();
        return true;
      }
    } catch (Exception e) { return false; }
  }

  private void saveDocument(String id, String name, String mime, byte[] bytes) {
    pendingFileRequestId = id == null ? "" : id;
    pendingBytes = bytes == null ? new byte[0] : bytes;
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
    intent.putExtra(Intent.EXTRA_TITLE, name == null || name.isEmpty() ? "backup.json" : name);
    startActivityForResult(intent, CREATE_BACKUP_FILE);
  }

  private class AureliaBridge {
    @JavascriptInterface public void postMessage(String raw) {
      try {
        JSONObject obj = new JSONObject(raw);
        String type = obj.optString("type", "");
        String requestId = obj.optString("requestId", "");
        if ("chooseDeviceBackupFolder".equals(type)) {
          runOnUiThread(() -> {
            folderRequestId = requestId;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(intent, PICK_BACKUP_FOLDER);
          });
        } else if ("deviceBackupStatus".equals(type)) {
          boolean selected = !prefs.getString("backup_tree_uri", "").isEmpty();
          js("window.aureliaNativeDeviceBackupStatusResult && window.aureliaNativeDeviceBackupStatusResult(" + q(requestId) + "," + selected + ")");
        } else if ("backupDeviceNow".equals(type)) {
          String name = obj.optString("name", "aurelia-backup.json");
          String payload = obj.optString("payload", "");
          runOnUiThread(() -> backupResult(requestId, writeToSelectedFolder(name, payload),
            prefs.getString("backup_tree_uri", "").isEmpty() ? "Choose a backup folder first." : "Could not write backup to selected folder."));
        } else if ("saveFile".equals(type)) {
          byte[] bytes = Base64.decode(obj.optString("data", ""), Base64.DEFAULT);
          String name = obj.optString("name", "backup.json");
          String mime = obj.optString("mime", "application/octet-stream");
          runOnUiThread(() -> saveDocument(requestId, name, mime, bytes));
        }
      } catch (Exception ignored) { }
    }
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode == PICK_BACKUP_FOLDER) {
      if (resultCode == RESULT_OK && data != null && data.getData() != null) {
        Uri uri = data.getData();
        try {
          getContentResolver().takePersistableUriPermission(uri, data.getFlags() &
            (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
          prefs.edit().putString("backup_tree_uri", uri.toString()).apply();
          String label = uri.getLastPathSegment();
          folderResult(folderRequestId, true, label == null ? "Selected folder" : label);
        } catch (Exception e) { folderResult(folderRequestId, false, "Could not retain access to selected folder"); }
      } else folderResult(folderRequestId, false, "No folder selected");
    } else if (requestCode == CREATE_BACKUP_FILE) {
      if (resultCode == RESULT_OK && data != null && data.getData() != null) {
        try (OutputStream out = getContentResolver().openOutputStream(data.getData(), "wt")) {
          if (out == null) throw new IllegalStateException("Could not open selected file");
          out.write(pendingBytes);
          out.flush();
          js("window.aureliaNativeFileSaveResult && window.aureliaNativeFileSaveResult(" + q(pendingFileRequestId) + ",true,'')");
        } catch (Exception e) {
          js("window.aureliaNativeFileSaveResult && window.aureliaNativeFileSaveResult(" + q(pendingFileRequestId) + ",false," + q(e.getMessage()) + ")");
        }
      } else js("window.aureliaNativeFileSaveResult && window.aureliaNativeFileSaveResult(" + q(pendingFileRequestId) + ",false,'Save cancelled')");
      pendingBytes = new byte[0];
    }
  }
}
\`;
fs.writeFileSync(javaPath, java);
console.log('Installed SAF folder picker, persistent folder access, backup writing, individual-file save picker, and manifest permissions.');
