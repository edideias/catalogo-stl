// Menu lateral (gaveta) e botão "voltar" do Android.
(function () {
  const root = document.documentElement;
  const top = document.getElementById('top');
  const btn = document.createElement('button');
  btn.id = 'btnMenu'; btn.textContent = '☰'; btn.title = 'Pastas e tags';
  top.insertBefore(btn, top.firstChild);
  const back = document.createElement('div');
  back.id = 'drawerBack';
  document.body.appendChild(back);
  const setDrawer = (on) => root.classList.toggle('drawer', on);
  btn.onclick = () => setDrawer(!root.classList.contains('drawer'));
  back.onclick = () => setDrawer(false);
  document.getElementById('side').addEventListener('click', (ev) => {
    if (ev.target.closest('.item') && !ev.target.closest('.caret')) setTimeout(() => setDrawer(false), 150);
  });

  // botão voltar: fecha editor > visualizador > menu
  const viewer = document.getElementById('viewer');
  const editor = document.getElementById('editor');
  let pushed = 0;
  const visible = (el) => !el.hidden;
  const push = () => { history.pushState({ layer: pushed + 1 }, ''); pushed++; };
  new MutationObserver(() => { if (visible(viewer) && pushed < 1) push(); else if (!visible(viewer) && !visible(editor) && pushed > 0) { pushed = 0; } }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => { if (visible(editor) && pushed < 2) push(); }).observe(editor, { attributes: true, attributeFilter: ['hidden'] });
  btn.addEventListener('click', () => { if (root.classList.contains('drawer') && pushed < 1) { /* sem histórico extra para o menu */ } });
  window.addEventListener('popstate', () => {
    if (pushed > 0) pushed--;
    if (visible(document.getElementById('dlg'))) { document.getElementById('dlgCancel').click(); return; }
    if (visible(editor)) { document.getElementById('edClose').click(); if (!visible(editor)) return; }
    else if (visible(viewer)) { document.getElementById('vClose').click(); }
    else if (root.classList.contains('drawer')) setDrawer(false);
  });
})();
