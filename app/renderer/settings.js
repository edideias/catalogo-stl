// Tela de Configurações (desktop e celular)
const LS = {
  get(k, d) { try { const v = localStorage.getItem('cfg_' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('cfg_' + k, JSON.stringify(v)); } catch (_) {} },
};

export function applySavedSettings({ state, $ }) {
  const card = LS.get('card', null);
  if (card) { document.documentElement.style.setProperty('--card', card + 'px'); const z = $('#zoom'); if (z) z.value = card; }
  const sort = LS.get('sort', null);
  if (sort) { state.sort = sort; $('#sort').value = sort; }
  if (LS.get('autoSpin', true) === false) $('#vSpin').classList.remove('on');
}

export function initSettings(ctx) {
  const { api, state, $, esc, fmtNum, dialog, setStatus, refreshAll } = ctx;
  const root = document.getElementById('settings');
  const mobile = document.documentElement.classList.contains('mobile');

  function rootCount(r) {
    let n = 0;
    for (const e of state.entries.values()) if (e.kind === 'stl' && e.root === r && !e.missing) n++;
    return n;
  }

  function render() {
    const roots = state.roots.stl || [];
    const card = LS.get('card', mobile ? 150 : 190);
    const sort = LS.get('sort', 'name');
    const spin = LS.get('autoSpin', true);
    root.innerHTML = `
    <div class="setBox">
      <div class="setHead"><h2>⚙ Configurações</h2><button id="setClose" class="primary">Pronto</button></div>

      <section>
        <h3>📁 Pastas do catálogo</h3>
        ${mobile ? '<p class="muted">O Android pede a sua autorização na hora de escolher a pasta. Ao permitir, o app pode <b>ler, editar, mover e apagar</b> arquivos somente dentro dela — nada fora.</p>' : ''}
        <div id="setRoots">${roots.length ? roots.map((r, i) => `
          <div class="setRoot"><div class="rn"><b>${esc(r.replace(/^\//, '').split(/[\\/]/).pop() || r)}</b><div class="muted small">${esc(r)} · ${fmtNum(rootCount(r))} arquivos</div></div>
            <button data-rescan="${i}">⟳ Atualizar</button><button data-rm="${i}" class="danger">Remover</button></div>`).join('') : '<p class="muted">Nenhuma pasta ainda. Toque em “Adicionar pasta” e escolha onde estão seus STL.</p>'}</div>
        <div class="row"><button id="setAdd" class="primary big">＋ Adicionar pasta</button><button id="setRescanAll">⟳ Atualizar todas</button></div>
      </section>

      <section>
        <h3>🎨 Visual</h3>
        <label class="setRow">Tamanho das miniaturas <b id="setCardVal">${card}px</b></label>
        <input id="setCard" type="range" min="100" max="320" value="${card}" style="width:100%">
        <label class="setRow">Ordenar por padrão
          <select id="setSort">${[['name', 'Nome A–Z'], ['nameDesc', 'Nome Z–A'], ['new', 'Mais recentes'], ['old', 'Mais antigos'], ['big', 'Maiores (arquivo)'], ['small', 'Menores (arquivo)'], ['dim', 'Maior dimensão'], ['tris', 'Mais triângulos']].map(([v, t]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="setRow chk"><input id="setSpin" type="checkbox" ${spin ? 'checked' : ''}> Girar o modelo sozinho ao abrir</label>
      </section>

      <section>
        <h3>🖼 Miniaturas</h3>
        <div class="col">
          <button id="setRegenErr">Tentar de novo as que deram erro</button>
          <button id="setRegenAll">Refazer todas as miniaturas</button>
        </div>
      </section>

      <section>
        <h3>🧹 Manutenção</h3>
        <div class="col">
          <button id="setDup">Procurar arquivos duplicados</button>
          <button id="setMissing">Limpar itens ausentes do catálogo</button>
          <button id="setCsv">Exportar lista do catálogo (CSV)</button>
        </div>
      </section>

      <section>
        <h3>ℹ Sobre</h3>
        <p class="muted small">Catálogo STL — catalogar, visualizar e editar arquivos 3D.<br>Seus arquivos ficam onde estão; o catálogo guarda só tags, notas e miniaturas.</p>
      </section>
    </div>`;
    wire();
  }

  function wire() {
    const q = (s) => root.querySelector(s);
    q('#setClose').onclick = close;
    q('#setAdd').onclick = async () => {
      const p = await api.addRoot('stl');
      if (p) { setStatus('Procurando arquivos…', null); api.scan('stl', [p]); render(); }
    };
    q('#setRescanAll').onclick = () => { setStatus('Procurando arquivos…', null); api.scan('stl'); close(); };
    root.querySelectorAll('[data-rescan]').forEach((b) => { b.onclick = () => { setStatus('Procurando arquivos…', null); api.scan('stl', [state.roots.stl[+b.dataset.rescan]]); close(); }; });
    root.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = async () => {
        const r = state.roots.stl[+b.dataset.rm];
        const ok = await dialog({ title: 'Remover pasta do catálogo?', body: '<p>A pasta sai do catálogo (tags e notas dos arquivos dela serão perdidas). Os arquivos <b>não</b> são apagados.</p>', ok: 'Remover' });
        if (!ok) return;
        await api.removeRoot('stl', r);
        state.folder = null;
        setTimeout(render, 150);
      };
    });
    q('#setCard').oninput = (e) => {
      const v = +e.target.value;
      LS.set('card', v);
      document.documentElement.style.setProperty('--card', v + 'px');
      const z = $('#zoom'); if (z) z.value = v;
      q('#setCardVal').textContent = v + 'px';
    };
    q('#setSort').onchange = (e) => { LS.set('sort', e.target.value); state.sort = e.target.value; $('#sort').value = e.target.value; refreshAll(); };
    q('#setSpin').onchange = (e) => { LS.set('autoSpin', e.target.checked); $('#vSpin').classList.toggle('on', e.target.checked); };
    q('#setRegenErr').onclick = () => { api.thumbRegen(false); setStatus('Tentando de novo…', 0); close(); };
    q('#setRegenAll').onclick = async () => {
      const ok = await dialog({ title: 'Refazer todas as miniaturas?', body: '<p>Pode demorar se o catálogo for grande. O app continua utilizável enquanto isso.</p>', ok: 'Refazer' });
      if (ok) { api.thumbRegen(true); setStatus('Refazendo miniaturas…', 0); close(); }
    };
    q('#setDup').onclick = () => { close(); $('#btnDup').click(); };
    q('#setMissing').onclick = async () => { const n = await api.clearMissing('stl'); setStatus(n + ' item(ns) ausente(s) removido(s) do catálogo', 1); };
    q('#setCsv').onclick = async () => { const p = await api.exportCsv('stl'); if (p) setStatus('Catálogo exportado: ' + p, 1); };
  }

  function open() { render(); root.hidden = false; }
  function close() { root.hidden = true; }
  $('#btnSettings').onclick = open;
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !root.hidden && document.getElementById('dlg').hidden) close(); });
  state.openSettings = open;
  // re-renderiza a lista de pastas quando algo muda
  setInterval(() => { if (!root.hidden && document.getElementById('dlg').hidden && !root.querySelector('input:focus,select:focus')) { const y = root.querySelector('.setBox').scrollTop; const keep = root.querySelector('#setRoots'); if (keep) { render(); root.querySelector('.setBox').scrollTop = y; } } }, 4000);
}
