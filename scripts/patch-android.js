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
if (!manifest.includes('android.permission.CAMERA')) {
  manifest = manifest.replace(/<application\b/, '    <uses-permission android:name="android.permission.CAMERA" />\n    <application');
}
if (!manifest.includes('android.permission.WRITE_EXTERNAL_STORAGE')) {
  manifest = manifest.replace(/<application\b/, '    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />\n    <application');
}
fs.writeFileSync(manifestPath, manifest);


const { execFileSync } = require('child_process');
const iconSvg = path.join(__dirname, '..', 'assets', 'aurelia-icon.svg');
const resDir = path.join(appDir, 'res');
const providerBlock = `if (!manifest.includes('androidx.core.content.FileProvider')) {
  manifest = manifest.replace('</application>', '    <provider android:name="androidx.core.content.FileProvider" android:authorities="\${applicationId}.fileprovider" android:exported="false" android:grantUriPermissions="true"><meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/aurelia_file_paths" /></provider></application>');
}
fs.mkdirSync(path.join(resDir, 'xml'), { recursive: true });
fs.writeFileSync(path.join(resDir, 'xml', 'aurelia_file_paths.xml'), '<?xml version="1.0" encoding="utf-8"?><paths xmlns:android="http://schemas.android.com/apk/res/android"><cache-path name="shared" path="shared/" /></paths>');
`;
eval(providerBlock);

if (fs.existsSync(iconSvg)) {
  const densities = { 'mdpi':48, 'hdpi':72, 'xhdpi':96, 'xxhdpi':144, 'xxxhdpi':192 };
  for (const [density, size] of Object.entries(densities)) {
    const dir = path.join(resDir, 'mipmap-' + density);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
      const target = path.join(dir, name + '.png');
      execFileSync(process.execPath, ['-e', 'const sharp=require(\"sharp\"); sharp(process.argv[1]).resize(+process.argv[3],+process.argv[3]).png().toFile(process.argv[2]).then(()=>{}).catch(e=>{console.error(e);process.exit(1)})', iconSvg, target, String(size)]);
    }
  }
  console.log('Generated Aurelia PMS launcher icons for all Android densities.');
}

const javaDir = path.join(appDir, 'java', 'com', 'aurelia', 'pms');
fs.mkdirSync(javaDir, { recursive: true });

const appModuleDir = path.join(androidDir, 'app');
const appGradleGroovy = path.join(appModuleDir, 'build.gradle');
const appGradleKts = path.join(appModuleDir, 'build.gradle.kts');
if (fs.existsSync(appGradleGroovy)) {
  let gradle = fs.readFileSync(appGradleGroovy, 'utf8');
  if (!gradle.includes('com.google.mlkit:text-recognition:')) {
    gradle = gradle.replace(/dependencies\s*\{/, match => match + "\n    implementation 'com.google.mlkit:text-recognition:16.0.1'");
    fs.writeFileSync(appGradleGroovy, gradle);
  }
} else if (fs.existsSync(appGradleKts)) {
  let gradle = fs.readFileSync(appGradleKts, 'utf8');
  if (!gradle.includes('com.google.mlkit:text-recognition:')) {
    gradle = gradle.replace(/dependencies\s*\{/, match => match + '\n    implementation("com.google.mlkit:text-recognition:16.0.1")');
    fs.writeFileSync(appGradleKts, gradle);
  }
}

const javaPath = path.join(javaDir, 'MainActivity.java');
const java = String.raw`
package com.aurelia.pms;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.Manifest;
import android.content.pm.PackageManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;
import com.getcapacitor.BridgeActivity;
import java.io.OutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
  private static final int PICK_BACKUP_FOLDER = 7101;
  private static final int CREATE_BACKUP_FILE = 7102;
  private static final int REQUEST_CAMERA_PERMISSION = 7103;
  private String cameraPermissionRequestId = "";
  private String folderRequestId = "";
  private String pendingFileRequestId = "";
  private byte[] pendingBytes = new byte[0];
  private boolean pendingIsBackup = false;
  private SharedPreferences prefs;
  private final ExecutorService backupExecutor = Executors.newSingleThreadExecutor();

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

  private static String sha256(byte[] bytes) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
    StringBuilder out = new StringBuilder();
    for (byte b : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
    return out.toString();
  }
  private byte[] readDocument(Uri uri) throws Exception {
    try (InputStream in = getContentResolver().openInputStream(uri);
         java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
      if (in == null) throw new IllegalStateException("Could not read saved backup for verification");
      byte[] buffer = new byte[16384]; int count;
      while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
      return out.toByteArray();
    }
  }
  private void writeDocument(Uri uri, byte[] bytes) throws Exception {
    try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
      if (out == null) throw new IllegalStateException("Could not open backup destination");
      out.write(bytes); out.flush();
    }
  }
  private String writeToSelectedFolder(String name, String payload, String requestId) {
    String saved = prefs.getString("backup_tree_uri", null);
    if (saved == null || saved.isEmpty()) return "No backup folder permission is saved.";
    Uri tree = Uri.parse(saved);
    Uri root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
    Uri stage = null, published = null;
    String stageName = "." + name + ".staging-" + requestId.replaceAll("[^A-Za-z0-9_-]", "");
    try {
      stage = DocumentsContract.createDocument(getContentResolver(), root, "application/json", stageName);
      if (stage == null) throw new IllegalStateException("Could not create staging backup in the selected folder.");
      writeDocument(stage, bytes);
      if (!sha256(bytes).equals(sha256(readDocument(stage)))) throw new IllegalStateException("Staging backup failed SHA-256 read-back verification.");
      published = DocumentsContract.createDocument(getContentResolver(), root, "application/json", name);
      if (published == null) throw new IllegalStateException("Could not publish the verified backup.");
      writeDocument(published, bytes);
      if (!sha256(bytes).equals(sha256(readDocument(published)))) throw new IllegalStateException("Published backup failed SHA-256 read-back verification.");
      try { DocumentsContract.deleteDocument(getContentResolver(), stage); } catch (Exception ignored) { }
      return null;
    } catch (Exception e) {
      if (published != null) try { DocumentsContract.deleteDocument(getContentResolver(), published); } catch (Exception ignored) { }
      if (stage != null) try { DocumentsContract.deleteDocument(getContentResolver(), stage); } catch (Exception ignored) { }
      return e.getMessage() == null ? "Backup write or verification failed." : e.getMessage();
    }
  }
  private void saveDocument(String id, String name, String mime, byte[] bytes, boolean isBackup) {
    pendingFileRequestId = id == null ? "" : id;
    pendingIsBackup = isBackup;
    pendingBytes = bytes == null ? new byte[0] : bytes;
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
    intent.putExtra(Intent.EXTRA_TITLE, name == null || name.isEmpty() ? "backup.json" : name);
    startActivityForResult(intent, CREATE_BACKUP_FILE);
  }

  private java.io.File photoDir() {
    java.io.File dir = new java.io.File(getFilesDir(), "aurelia_photo_archive");
    if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Could not create private photo archive");
    return dir;
  }
  private java.io.File photoFile(String key) {
    if (key == null || !key.matches("[A-Za-z0-9_-]{1,120}")) throw new IllegalArgumentException("Invalid photo key");
    return new java.io.File(photoDir(), key + ".txt");
  }
  private void photoResult(String id, boolean ok, String payload) {
    js("window.aureliaNativePhotoResult && window.aureliaNativePhotoResult(" + q(id) + "," + ok + "," + q(payload) + ")");
  }
  private String readText(java.io.File file) throws Exception {
    try (java.io.FileInputStream in = new java.io.FileInputStream(file);
         java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int count;
      while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
      return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
  }
  private void writeText(java.io.File file, String value) throws Exception {
    try (java.io.FileOutputStream out = new java.io.FileOutputStream(file)) {
      out.write(value.getBytes(StandardCharsets.UTF_8));
      out.flush();
      out.getFD().sync();
    }
  }

  private void printHtmlDocument(String html, String title) {
    try {
      android.webkit.WebView printView = new android.webkit.WebView(MainActivity.this);
      printView.setWebViewClient(new android.webkit.WebViewClient() {
        @Override public void onPageFinished(android.webkit.WebView view, String url) {
          try {
            android.print.PrintManager manager = (android.print.PrintManager) getSystemService(PRINT_SERVICE);
            android.print.PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(title);
            manager.print(title, adapter, new android.print.PrintAttributes.Builder().setMediaSize(android.print.PrintAttributes.MediaSize.ISO_A4).setResolution(new android.print.PrintAttributes.Resolution("aurelia", "Aurelia", 300, 300)).setMinMargins(android.print.PrintAttributes.Margins.NO_MARGINS).build());
          } catch (Exception ignored) { }
        }
      });
      printView.loadDataWithBaseURL(null, "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>body{font-family:Arial,sans-serif;color:#222;margin:18px}img{max-width:100%;height:auto}table{width:100%;border-collapse:collapse}td,th{padding:7px;border-bottom:1px solid #ddd;text-align:left} .noprint,button{display:none!important}</style></head><body>" + html + "</body></html>", "text/html", "UTF-8", null);
    } catch (Exception ignored) { }
  }

  private void shareImageFile(String name, String mime, byte[] bytes, String phone) {
    try {
      java.io.File dir = new java.io.File(getCacheDir(), "shared");
      if (!dir.exists()) dir.mkdirs();
      String safeName = name == null ? "invoice.png" : name.replaceAll("[^A-Za-z0-9._-]", "_");
      java.io.File file = new java.io.File(dir, safeName);
      try (java.io.FileOutputStream out = new java.io.FileOutputStream(file)) { out.write(bytes); out.flush(); }
      Uri uri = androidx.core.content.FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", file);
      Intent send = new Intent(Intent.ACTION_SEND);
      send.setType(mime == null ? "image/png" : mime);
      send.putExtra(Intent.EXTRA_STREAM, uri);
      send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      if (phone != null && !phone.isEmpty()) send.putExtra("jid", phone.replaceAll("\\D", "") + "@s.whatsapp.net");
      startActivity(Intent.createChooser(send, "Share invoice"));
    } catch (Exception e) {
      try { saveDocument("share-fallback", name, mime, bytes, false); } catch (Exception ignored) { }
    }
  }

  private class AureliaBridge {
    @JavascriptInterface public void postMessage(String raw) {
      String type = "", requestId = "";
      try {
        JSONObject obj = new JSONObject(raw);
        type = obj.optString("type", "");
        requestId = obj.optString("requestId", "");
        if ("photoStore".equals(type)) {
          String key = obj.optString("key", "");
          String data = obj.optString("data", "");
          if (!data.startsWith("data:image/")) throw new IllegalArgumentException("Invalid photo data");
          writeText(photoFile(key), data);
          photoResult(requestId, true, "stored");
        } else if ("photoLoad".equals(type)) {
          String key = obj.optString("key", "");
          java.io.File file = photoFile(key);
          if (!file.isFile()) photoResult(requestId, false, "Original photo not found on this device");
          else photoResult(requestId, true, readText(file));
        } else if ("photoArchive".equals(type)) {
          JSONObject archive = new JSONObject();
          java.io.File[] files = photoDir().listFiles((dir, name) -> name.endsWith(".txt"));
          if (files != null) for (java.io.File file : files) {
            String key = file.getName().substring(0, file.getName().length() - 4);
            archive.put(key, readText(file));
          }
          photoResult(requestId, true, archive.toString());
        } else if ("photoRestore".equals(type)) {
          JSONObject archive = obj.optJSONObject("archive");
          if (archive == null) throw new IllegalArgumentException("Invalid photo archive");
          java.util.LinkedHashMap<String, String> incoming = new java.util.LinkedHashMap<>();
          java.util.LinkedHashMap<String, String> previous = new java.util.LinkedHashMap<>();
          java.util.LinkedHashMap<String, java.io.File> staged = new java.util.LinkedHashMap<>();
          java.io.File stageDir = new java.io.File(photoDir(), ".restore-" + System.currentTimeMillis());
          if (!stageDir.mkdirs()) throw new IllegalStateException("Could not create photo restore staging area");
          try {
            java.util.Iterator<String> keys = archive.keys();
            while (keys.hasNext()) {
              String key = keys.next(), data = archive.optString(key, "");
              if (key == null || !key.matches("[A-Za-z0-9_-]{1,120}") || !data.startsWith("data:image/")) throw new IllegalArgumentException("Invalid archived image or photo key");
              incoming.put(key, data);
              java.io.File target = photoFile(key);
              previous.put(key, target.isFile() ? readText(target) : null);
              java.io.File temp = new java.io.File(stageDir, key + ".txt");
              writeText(temp, data);
              if (!data.equals(readText(temp))) throw new IllegalStateException("Staged photo verification failed for " + key);
              staged.put(key, temp);
            }
            for (java.util.Map.Entry<String, java.io.File> entry : staged.entrySet()) {
              String data = readText(entry.getValue());
              writeText(photoFile(entry.getKey()), data);
              if (!data.equals(readText(photoFile(entry.getKey())))) throw new IllegalStateException("Restored photo verification failed for " + entry.getKey());
            }
            photoResult(requestId, true, "restored");
          } catch (Exception restoreError) {
            Exception rollbackError = null;
            for (java.util.Map.Entry<String, String> entry : previous.entrySet()) {
              try {
                java.io.File target = photoFile(entry.getKey());
                if (entry.getValue() == null) { if (target.exists() && !target.delete()) throw new IllegalStateException("Could not remove partially restored photo " + entry.getKey()); }
                else writeText(target, entry.getValue());
              } catch (Exception e) { rollbackError = e; }
            }
            if (rollbackError != null) throw new IllegalStateException("Photo restore failed and rollback was incomplete: " + rollbackError.getMessage(), restoreError);
            throw restoreError;
          } finally {
            java.io.File[] stagedFiles = stageDir.listFiles();
            if (stagedFiles != null) for (java.io.File stagedFile : stagedFiles) try { stagedFile.delete(); } catch (Exception ignored) { }
            try { stageDir.delete(); } catch (Exception ignored) { }
          }
        } else if ("requestCameraPermission".equals(type)) {
          runOnUiThread(() -> {
            cameraPermissionRequestId = requestId;
            if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
              js("window.aureliaCameraPermissionResult && window.aureliaCameraPermissionResult(" + q(requestId) + ",true)");
            } else {
              ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA_PERMISSION);
            }
          });
        } else if ("chooseDeviceBackupFolder".equals(type)) {
          runOnUiThread(() -> {
            folderRequestId = requestId;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(intent, PICK_BACKUP_FOLDER);
          });
        } else if ("recognizeId".equals(type)) {
          String imageData = obj.optString("data", "");
          byte[] imageBytes = Base64.decode(imageData, Base64.DEFAULT);
          Bitmap bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length);
          if (bitmap == null) throw new IllegalArgumentException("Could not decode ID image");
          InputImage image = InputImage.fromBitmap(bitmap, 0);
          TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
          recognizer.process(image)
            .addOnSuccessListener(result -> {
              JSONObject payload = new JSONObject();
              try { payload.put("status", "OK"); payload.put("text", result.getText()); payload.put("imageWidth", bitmap.getWidth()); payload.put("imageHeight", bitmap.getHeight()); org.json.JSONArray lineItems = new org.json.JSONArray(); for (com.google.mlkit.vision.text.Text.TextBlock block : result.getTextBlocks()) { for (com.google.mlkit.vision.text.Text.Line line : block.getLines()) { android.graphics.Rect box = line.getBoundingBox(); JSONObject item = new JSONObject(); item.put("text", line.getText()); if (box != null) { item.put("left", box.left); item.put("top", box.top); item.put("right", box.right); item.put("bottom", box.bottom); } item.put("confidence", line.getConfidence()); item.put("rotation", line.getAngle()); lineItems.put(item); } } payload.put("lines", lineItems); } catch (Exception ignored) { }
              js("window.aureliaNativeOcrResult && window.aureliaNativeOcrResult(" + q(requestId) + "," + q(payload.toString()) + ")");
              bitmap.recycle();
              recognizer.close();
            })
            .addOnFailureListener(error -> {
              JSONObject payload = new JSONObject();
              try { payload.put("status", "ERROR"); payload.put("message", error == null ? "Text recognition failed" : String.valueOf(error.getMessage())); } catch (Exception ignored) { }
              js("window.aureliaNativeOcrResult && window.aureliaNativeOcrResult(" + q(requestId) + "," + q(payload.toString()) + ")");
              bitmap.recycle();
              recognizer.close();
            });
        } else if ("deviceBackupStatus".equals(type)) {
          boolean selected = !prefs.getString("backup_tree_uri", "").isEmpty();
          js("window.aureliaNativeDeviceBackupStatusResult && window.aureliaNativeDeviceBackupStatusResult(" + q(requestId) + "," + selected + ")");
        } else if ("backupDeviceNow".equals(type)) {
          final String name = obj.optString("name", "aurelia-backup.json");
          final String payload = obj.optString("payload", "");
          final String folderUri = prefs.getString("backup_tree_uri", "");
          if (folderUri.isEmpty()) {
            runOnUiThread(() -> saveDocument(requestId, name, "application/json", payload.getBytes(StandardCharsets.UTF_8), true));
          } else {
            backupExecutor.execute(() -> {
              String error = writeToSelectedFolder(name, payload, requestId);
              backupResult(requestId, error == null, error == null ? "" : error);
            });
          }
        } else if ("openUrl".equals(type)) {
          String url = obj.optString("url", "");
          runOnUiThread(() -> { try { Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url)); startActivity(intent); } catch (Exception e) { js("window.aureliaNativeActionResult && window.aureliaNativeActionResult(" + q(requestId) + ",false," + q("Could not open link") + ")"); } });
        } else if ("shareText".equals(type)) {
          String title = obj.optString("title", "Share");
          String text = obj.optString("text", "");
          runOnUiThread(() -> { try { Intent intent = new Intent(Intent.ACTION_SEND); intent.setType("text/plain"); intent.putExtra(Intent.EXTRA_TEXT, text); startActivity(Intent.createChooser(intent, title)); } catch (Exception e) { js("window.aureliaNativeActionResult && window.aureliaNativeActionResult(" + q(requestId) + ",false," + q("Sharing is unavailable") + ")"); } });
        } else if ("printInvoice".equals(type)) {
          String html = obj.optString("html", "");
          runOnUiThread(() -> printHtmlDocument(html, obj.optString("title", "Aurelia PMS invoice")));
        } else if ("shareInvoicePng".equals(type) || "shareImage".equals(type)) {
          String name = obj.optString("name", "invoice.png");
          String mime = obj.optString("mime", "image/png");
          byte[] bytes = Base64.decode(obj.optString("data", ""), Base64.DEFAULT);
          runOnUiThread(() -> shareImageFile(name, mime, bytes, obj.optString("phone", "")));
        } else if ("saveFile".equals(type)) {
          byte[] bytes = Base64.decode(obj.optString("data", ""), Base64.DEFAULT);
          String name = obj.optString("name", "backup.json");
          String mime = obj.optString("mime", "application/octet-stream");
          runOnUiThread(() -> saveDocument(requestId, name, mime, bytes, false));
        }
      } catch (Exception error) {
        String message = error.getMessage() == null ? "Native backup operation failed." : error.getMessage();
        if ("photoStore".equals(type) || "photoLoad".equals(type) || "photoArchive".equals(type) || "photoRestore".equals(type)) photoResult(requestId, false, message);
        else if ("backupDeviceNow".equals(type)) backupResult(requestId, false, message);
        else if ("deviceBackupStatus".equals(type)) js("window.aureliaNativeDeviceBackupStatusResult && window.aureliaNativeDeviceBackupStatusResult(" + q(requestId) + ",false)");
      }
    }
  }

  @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode == REQUEST_CAMERA_PERMISSION) {
      boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
      js("window.aureliaCameraPermissionResult && window.aureliaCameraPermissionResult(" + q(cameraPermissionRequestId) + "," + granted + ")");
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
        try {
          Uri destination = data.getData();
          byte[] expected = pendingBytes;
          writeDocument(destination, expected);
          if (pendingIsBackup && !sha256(expected).equals(sha256(readDocument(destination)))) throw new IllegalStateException("Saved backup failed SHA-256 read-back verification.");
          if (pendingIsBackup) backupResult(pendingFileRequestId, true, "");
          else js("window.aureliaNativeFileSaveResult && window.aureliaNativeFileSaveResult(" + q(pendingFileRequestId) + ",true,'')");
        } catch (Exception e) {
          if (pendingIsBackup) backupResult(pendingFileRequestId, false, e.getMessage());
          else js("window.aureliaNativeFileSaveResult && window.aureliaNativeFileSaveResult(" + q(pendingFileRequestId) + ",false," + q(e.getMessage()) + ")");
        }
      } else if (pendingIsBackup) backupResult(pendingFileRequestId, false, "Save cancelled");
      else js("window.aureliaNativeFileSaveResult && window.aureliaNativeFileSaveResult(" + q(pendingFileRequestId) + ",false,'Save cancelled')");
      pendingBytes = new byte[0];
      pendingIsBackup = false;
    }
  }
}
`;
fs.writeFileSync(javaPath, java);
console.log('Installed SAF folder picker, persistent folder access, backup writing, individual-file save picker, and manifest permissions.');
