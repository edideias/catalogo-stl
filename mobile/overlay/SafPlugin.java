package com.edideias.catalogostl;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

@CapacitorPlugin(name = "Saf")
public class SafPlugin extends Plugin {
    private final AtomicInteger counter = new AtomicInteger(0);

    private ContentResolver cr() {
        return getContext().getContentResolver();
    }

    private File appFile(String name) {
        File f = new File(getContext().getFilesDir(), name);
        File p = f.getParentFile();
        if (p != null && !p.exists()) p.mkdirs();
        return f;
    }

    // ------------------------------------------------------------ escolher pasta
    @PluginMethod
    public void pickTree(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, i, "pickTreeResult");
    }

    @ActivityCallback
    private void pickTreeResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve();
            return;
        }
        Uri uri = result.getData().getData();
        try {
            cr().takePersistableUriPermission(uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception e) {
            try {
                cr().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) { }
        }
        String name = "Pasta";
        try {
            String docId = DocumentsContract.getTreeDocumentId(uri);
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(uri, docId);
            Cursor c = cr().query(docUri, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            if (c != null) {
                try {
                    if (c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
                } finally {
                    c.close();
                }
            }
        } catch (Exception ignored) { }
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        ret.put("name", name);
        call.resolve(ret);
    }

    // ------------------------------------------------------------ listar arquivos
    @PluginMethod
    public void listTree(final PluginCall call) {
        final String treeStr = call.getString("uri");
        final JSArray extArr = call.getArray("exts");
        if (treeStr == null) {
            call.reject("uri ausente");
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    java.util.List<String> exts = new java.util.ArrayList<String>();
                    if (extArr != null) {
                        for (int k = 0; k < extArr.length(); k++) exts.add(extArr.getString(k).toLowerCase(Locale.ROOT));
                    }
                    Uri tree = Uri.parse(treeStr);
                    String rootId = DocumentsContract.getTreeDocumentId(tree);
                    JSArray items = new JSArray();
                    int found = 0;
                    ArrayDeque<String[]> stack = new ArrayDeque<String[]>();
                    stack.push(new String[]{rootId, ""});
                    String[] proj = new String[]{
                            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                            DocumentsContract.Document.COLUMN_MIME_TYPE,
                            DocumentsContract.Document.COLUMN_SIZE,
                            DocumentsContract.Document.COLUMN_LAST_MODIFIED};
                    while (!stack.isEmpty()) {
                        String[] cur = stack.pop();
                        String docId = cur[0];
                        String rel = cur[1];
                        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
                        Cursor c = null;
                        try {
                            c = cr().query(children, proj, null, null, null);
                            if (c == null) continue;
                            Uri parentUri = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
                            while (c.moveToNext()) {
                                String id = c.getString(0);
                                String name = c.getString(1);
                                String mime = c.getString(2);
                                if (name == null || id == null) continue;
                                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                                    if (name.startsWith(".")) continue;
                                    stack.push(new String[]{id, rel + name + "/"});
                                } else {
                                    String lower = name.toLowerCase(Locale.ROOT);
                                    boolean ok = exts.isEmpty();
                                    for (String e : exts) {
                                        if (lower.endsWith(e)) {
                                            ok = true;
                                            break;
                                        }
                                    }
                                    if (!ok) continue;
                                    JSObject it = new JSObject();
                                    it.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                                    it.put("parent", parentUri.toString());
                                    it.put("rel", rel + name);
                                    it.put("name", name);
                                    it.put("size", c.isNull(3) ? 0 : c.getLong(3));
                                    it.put("mtime", c.isNull(4) ? 0 : c.getLong(4));
                                    items.put(it);
                                    found++;
                                    if (found % 200 == 0) {
                                        JSObject ev = new JSObject();
                                        ev.put("found", found);
                                        notifyListeners("scanProgress", ev);
                                    }
                                }
                            }
                        } catch (Exception ignored) {
                        } finally {
                            if (c != null) c.close();
                        }
                    }
                    JSObject ret = new JSObject();
                    ret.put("items", items);
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("Falha ao listar: " + e.getMessage());
                }
            }
        }).start();
    }

    // ------------------------------------------------------------ ler / gravar
    // Copia o conteúdo do documento para o cache e devolve o caminho (o JS lê por fetch, sem base64).
    @PluginMethod
    public void copyToCache(final PluginCall call) {
        final String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("uri ausente");
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File out = new File(getContext().getCacheDir(), "rd_" + counter.incrementAndGet() + ".bin");
                    InputStream in = cr().openInputStream(Uri.parse(uriStr));
                    if (in == null) {
                        call.reject("Não consegui abrir o arquivo");
                        return;
                    }
                    OutputStream os = new FileOutputStream(out);
                    try {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    } finally {
                        os.close();
                        in.close();
                    }
                    JSObject ret = new JSObject();
                    ret.put("path", out.getAbsolutePath());
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("Falha ao ler: " + e.getMessage());
                }
            }
        }).start();
    }

    @PluginMethod
    public void deleteCache(PluginCall call) {
        String p = call.getString("path");
        if (p != null) {
            File f = new File(p);
            if (f.getAbsolutePath().startsWith(getContext().getCacheDir().getAbsolutePath())) f.delete();
        }
        call.resolve();
    }

    private void writeStream(Uri uri, byte[] data, String mode) throws Exception {
        OutputStream os = cr().openOutputStream(uri, mode);
        if (os == null) throw new Exception("Não consegui abrir para escrita");
        try {
            os.write(data);
            os.flush();
        } finally {
            os.close();
        }
    }

    @PluginMethod
    public void writeUri(PluginCall call) {
        String uri = call.getString("uri");
        String b64 = call.getString("b64");
        if (uri == null || b64 == null) {
            call.reject("parâmetros ausentes");
            return;
        }
        try {
            writeStream(Uri.parse(uri), Base64.decode(b64, Base64.DEFAULT), "wt");
            call.resolve();
        } catch (Exception e) {
            call.reject("Falha ao gravar: " + e.getMessage());
        }
    }

    @PluginMethod
    public void createFile(PluginCall call) {
        String parent = call.getString("parent");
        String name = call.getString("name");
        String b64 = call.getString("b64");
        if (parent == null || name == null || b64 == null) {
            call.reject("parâmetros ausentes");
            return;
        }
        try {
            Uri created = DocumentsContract.createDocument(cr(), Uri.parse(parent), "application/octet-stream", name);
            if (created == null) {
                call.reject("Não consegui criar o arquivo nessa pasta");
                return;
            }
            writeStream(created, Base64.decode(b64, Base64.DEFAULT), "wt");
            String finalName = name;
            Cursor c = cr().query(created, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            if (c != null) {
                try {
                    if (c.moveToFirst() && c.getString(0) != null) finalName = c.getString(0);
                } finally {
                    c.close();
                }
            }
            JSObject ret = new JSObject();
            ret.put("uri", created.toString());
            ret.put("name", finalName);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Falha ao criar: " + e.getMessage());
        }
    }

    @PluginMethod
    public void renameDoc(PluginCall call) {
        String uri = call.getString("uri");
        String name = call.getString("name");
        if (uri == null || name == null) {
            call.reject("parâmetros ausentes");
            return;
        }
        try {
            Uri n = DocumentsContract.renameDocument(cr(), Uri.parse(uri), name);
            if (n == null) {
                call.reject("Não foi possível renomear");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("uri", n.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Falha ao renomear: " + e.getMessage());
        }
    }

    @PluginMethod
    public void deleteDoc(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("uri ausente");
            return;
        }
        try {
            boolean ok = DocumentsContract.deleteDocument(cr(), Uri.parse(uri));
            if (!ok) {
                call.reject("Não foi possível apagar");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Falha ao apagar: " + e.getMessage());
        }
    }

    @PluginMethod
    public void moveDoc(PluginCall call) {
        String uri = call.getString("uri");
        String srcParent = call.getString("srcParent");
        String destTree = call.getString("destTree");
        if (uri == null || srcParent == null || destTree == null) {
            call.reject("parâmetros ausentes");
            return;
        }
        try {
            Uri tree = Uri.parse(destTree);
            Uri dstParent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            Uri src = Uri.parse(uri);
            Uri n = null;
            try {
                n = DocumentsContract.moveDocument(cr(), src, Uri.parse(srcParent), dstParent);
            } catch (Exception ignored) { }
            if (n == null) {
                // fallback: copia e apaga o original
                String name = "arquivo.stl";
                String mime = "application/octet-stream";
                Cursor c = cr().query(src, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE}, null, null, null);
                if (c != null) {
                    try {
                        if (c.moveToFirst()) { if (c.getString(0) != null) name = c.getString(0); if (c.getString(1) != null) mime = c.getString(1); }
                    } finally { c.close(); }
                }
                n = DocumentsContract.createDocument(cr(), dstParent, mime, name);
                if (n == null) { call.reject("Não foi possível criar o arquivo no destino"); return; }
                try (InputStream in = cr().openInputStream(src); OutputStream out = cr().openOutputStream(n, "w")) {
                    byte[] buf = new byte[65536];
                    int r;
                    while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
                }
                if (!DocumentsContract.deleteDocument(cr(), src)) { call.reject("Copiado, mas não consegui apagar o original"); return; }
            }
            JSObject ret = new JSObject();
            ret.put("uri", n.toString());
            ret.put("parent", dstParent.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Falha ao mover: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------ cópias no armazenamento do app
    @PluginMethod
    public void copyUriToApp(PluginCall call) {
        String uri = call.getString("uri");
        String name = call.getString("name");
        if (uri == null || name == null) {
            call.reject("parâmetros ausentes");
            return;
        }
        try {
            InputStream in = cr().openInputStream(Uri.parse(uri));
            if (in == null) {
                call.reject("Não consegui abrir o arquivo");
                return;
            }
            OutputStream os = new FileOutputStream(appFile(name));
            try {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            } finally {
                os.close();
                in.close();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Falha na cópia: " + e.getMessage());
        }
    }

    @PluginMethod
    public void copyAppToUri(PluginCall call) {
        String uri = call.getString("uri");
        String name = call.getString("name");
        if (uri == null || name == null) {
            call.reject("parâmetros ausentes");
            return;
        }
        try {
            File f = appFile(name);
            if (!f.exists()) {
                call.reject("Cópia de segurança não encontrada");
                return;
            }
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            OutputStream os = cr().openOutputStream(Uri.parse(uri), "wt");
            if (os == null) {
                in.close();
                call.reject("Não consegui abrir para escrita");
                return;
            }
            try {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            } finally {
                os.close();
                in.close();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Falha na restauração: " + e.getMessage());
        }
    }

    @PluginMethod
    public void deleteApp(PluginCall call) {
        String name = call.getString("name");
        if (name != null) appFile(name).delete();
        call.resolve();
    }

    @PluginMethod
    public void writeApp(PluginCall call) {
        String name = call.getString("name");
        String b64 = call.getString("b64");
        String text = call.getString("text");
        if (name == null) {
            call.reject("nome ausente");
            return;
        }
        try {
            byte[] data = b64 != null ? Base64.decode(b64, Base64.DEFAULT) : (text != null ? text.getBytes("UTF-8") : new byte[0]);
            File f = appFile(name);
            File tmp = appFile(name + ".tmp");
            OutputStream os = new FileOutputStream(tmp);
            try {
                os.write(data);
            } finally {
                os.close();
            }
            if (f.exists()) f.delete();
            if (!tmp.renameTo(f)) throw new Exception("rename falhou");
            call.resolve();
        } catch (Exception e) {
            call.reject("Falha ao salvar: " + e.getMessage());
        }
    }

    @PluginMethod
    public void readApp(PluginCall call) {
        String name = call.getString("name");
        if (name == null) {
            call.reject("nome ausente");
            return;
        }
        try {
            File f = appFile(name);
            JSObject ret = new JSObject();
            if (!f.exists()) {
                call.resolve(ret);
                return;
            }
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            try {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            } finally {
                in.close();
            }
            ret.put("text", bo.toString("UTF-8"));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Falha ao ler: " + e.getMessage());
        }
    }

    @PluginMethod
    public void appDir(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("path", getContext().getFilesDir().getAbsolutePath());
        call.resolve(ret);
    }

    // ------------------------------------------------------------ compartilhar / abrir em outro app
    @PluginMethod
    public void shareUri(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("uri ausente");
            return;
        }
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("application/octet-stream");
            send.putExtra(Intent.EXTRA_STREAM, Uri.parse(uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Abrir / enviar para…");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Falha ao compartilhar: " + e.getMessage());
        }
    }

    @PluginMethod
    public void shareText(PluginCall call) {
        String name = call.getString("name");
        String text = call.getString("text");
        if (name == null || text == null) {
            call.reject("parâmetros ausentes");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), "share");
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, name);
            OutputStream os = new FileOutputStream(f);
            try {
                os.write(text.getBytes("UTF-8"));
            } finally {
                os.close();
            }
            Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/csv");
            send.putExtra(Intent.EXTRA_STREAM, u);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Enviar catálogo");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Falha ao exportar: " + e.getMessage());
        }
    }
}
