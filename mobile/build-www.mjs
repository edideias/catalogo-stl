// Monta mobile/www a partir do app desktop (mesmo código do renderer e do editor).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..', 'app');
const www = path.join(here, 'www');
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
fs.cpSync(path.join(app, 'renderer'), path.join(www, 'renderer'), { recursive: true });
fs.cpSync(path.join(app, 'vendor'), path.join(www, 'vendor'), { recursive: true });
fs.mkdirSync(path.join(www, 'fonts'), { recursive: true });
for (const f of ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']) fs.copyFileSync(path.join(here, 'fonts', f), path.join(www, 'fonts', f));
fs.copyFileSync(path.join(here, 'src', 'mobile-api.js'), path.join(www, 'renderer', 'mobile-api.js'));
fs.copyFileSync(path.join(here, 'src', 'mobile.js'), path.join(www, 'renderer', 'mobile.js'));
fs.copyFileSync(path.join(here, 'src', 'mobile.css'), path.join(www, 'renderer', 'mobile.css'));

let html = fs.readFileSync(path.join(www, 'renderer', 'index.html'), 'utf8');
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">');
html = html.replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="mobile.css">\n<script src="mobile-api.js"></script>');
// mobile.js precisa rodar depois do DOM do cabeçalho existir: vai no fim do body
html = html.replace('</body>', '<script src="mobile.js"></script>\n</body>');
fs.writeFileSync(path.join(www, 'renderer', 'index.html'), html);
// worker.html e demais ficam como estão
fs.writeFileSync(path.join(www, 'index.html'), '<!doctype html><meta charset="utf-8"><script>location.replace("renderer/index.html");</script>');
console.log('www pronto');
