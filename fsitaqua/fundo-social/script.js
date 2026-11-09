// script.js - Estoque (Fundo Social) com Firebase
//
// Depende de ../auth.js, que inicializa o Firebase (auth, db), mantém o perfil
// do usuário logado (initAuth, getCurrentUser, canManageAccess) e lista as
// áreas liberadas no portal (ORGANS).
//
// Banco de dados — um estoque único para todas as áreas do portal:
//   estoque_itens/{id}          { nome, categoria, unidade, estoqueMinimo, ativo,
//                                 areas: ['Fundo Social', ...], criadoEm }
//   estoque_movimentacoes/{id}  { tipo: ENTRADA | SAIDA | AJUSTE, area, itemId, itemNome,
//                                 unidade, qtd, data (AAAA-MM-DD), origemDestino, motivo,
//                                 obs, contado, lote, usuarioId, usuarioNome, criadoEm }
//
// Só Administrador/Gestor cadastra itens e decide em quais áreas aparecem; os demais
// níveis só controlam quantidade (entrada, saída, inventário) e nem veem a aba Itens.
//
// Cada item existe uma vez só; "areas" diz em quais telas ele aparece. O saldo é a
// soma de TODAS as movimentações do item, de qualquer área, então uma saída lançada
// em uma tela baixa o saldo em todas. "area" guarda qual tela fez o lançamento e
// "lote" agrupa os itens lançados juntos num mesmo formulário.
// Documentos criados antes desses campos existirem contam como do Fundo Social.

const AREA = 'Fundo Social';
const AREA_LEGADA = 'Fundo Social';
const ITENS_COLLECTION = 'estoque_itens';
const MOV_COLLECTION = 'estoque_movimentacoes';
const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js';
const POR_PAGINA = 50;

// Itens sugeridos a partir das colunas da planilha "RECEBIDOS 2026"
const ITENS_PADRAO = [
    { nome: 'Cesta Básica', categoria: 'Alimentos', unidade: 'un' },
    { nome: 'Macarrão', categoria: 'Alimentos', unidade: 'pct' },
    { nome: 'Leite', categoria: 'Alimentos', unidade: 'L' },
    { nome: 'Cobertor', categoria: 'Agasalho', unidade: 'un' },
    { nome: 'Fralda Infantil P', categoria: 'Fraldas', unidade: 'un' },
    { nome: 'Fralda Infantil M', categoria: 'Fraldas', unidade: 'un' },
    { nome: 'Fralda Infantil G', categoria: 'Fraldas', unidade: 'un' },
    { nome: 'Fralda Infantil XG', categoria: 'Fraldas', unidade: 'un' },
    { nome: 'Produtos de Limpeza', categoria: 'Limpeza', unidade: 'cx' },
    { nome: 'Produtos de Higiene', categoria: 'Higiene', unidade: 'un' },
    { nome: 'Diversos', categoria: 'Diversos', unidade: 'un' }
];

const MOTIVOS_SAIDA = ['Doação', 'Ação social', 'Transferência', 'Perda ou vencimento', 'Outro'];

const TIPOS = {
    ENTRADA: { label: 'Entrada', badge: 'badge-success', icone: 'ph-arrow-down-left', classeQtd: 'qty-pos' },
    SAIDA: { label: 'Saída', badge: 'badge-danger', icone: 'ph-arrow-up-right', classeQtd: 'qty-neg' },
    AJUSTE: { label: 'Ajuste', badge: 'badge-info', icone: 'ph-scales', classeQtd: 'qty-adj' }
};

let itens = [];
let movimentacoes = [];
let iniciado = false;
let filtros = filtrosVazios();
let limiteLista = POR_PAGINA;
let categoriaDash = '';

// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------
function esc(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

function normalizar(texto) {
    return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function isoDe(d) {
    const c = new Date(d);
    c.setMinutes(c.getMinutes() - c.getTimezoneOffset());
    return c.toISOString().slice(0, 10);
}

function hojeISO() {
    return isoDe(new Date());
}

function formatarData(iso) {
    if (!iso) return '-';
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
}

function formatarQtd(n) {
    return Number(n || 0).toLocaleString('pt-BR');
}

function qtdComSinal(m) {
    const n = Number(m.qtd || 0);
    if (m.tipo === 'ENTRADA') return `+${formatarQtd(n)}`;
    if (m.tipo === 'SAIDA') return `−${formatarQtd(n)}`;
    return `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatarQtd(Math.abs(n))}`;
}

function itensTexto(n) {
    return `${formatarQtd(n)} ${n === 1 ? 'item' : 'itens'}`;
}

function iniciais(nome) {
    return String(nome || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
}

function ehGestor() {
    return canManageAccess(getCurrentUser());
}

function areasDoItem(item) {
    return Array.isArray(item.areas) && item.areas.length ? item.areas : [AREA_LEGADA];
}

function areaDaMov(m) {
    return m.area || AREA_LEGADA;
}

function getItem(id) {
    return itens.find(i => i.id === id);
}

function itensDaArea() {
    return itens.filter(i => i.ativo !== false && areasDoItem(i).includes(AREA));
}

// Movimentações dos itens que aparecem nesta área (vindas de qualquer área)
function movsDaArea() {
    return movimentacoes.filter(m => {
        const item = getItem(m.itemId);
        return !item || areasDoItem(item).includes(AREA);
    });
}

function categoriasDe(lista) {
    return [...new Set(lista.map(i => i.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function calcularSaldos() {
    const saldos = {};
    movimentacoes.forEach(m => {
        const sinal = m.tipo === 'SAIDA' ? -1 : 1;
        saldos[m.itemId] = (saldos[m.itemId] || 0) + sinal * Number(m.qtd || 0);
    });
    return saldos;
}

function situacaoItem(item, saldo) {
    const min = Number(item.estoqueMinimo || 0);
    if (saldo <= 0) {
        return { nivel: 'zerado', classe: 'is-empty', badge: '<span class="badge badge-danger"><i class="ph ph-x-circle"></i> Sem estoque</span>' };
    }
    if (min > 0 && saldo <= min) {
        return { nivel: 'baixo', classe: 'is-low', badge: '<span class="badge badge-warning"><i class="ph ph-warning"></i> Estoque baixo</span>' };
    }
    return { nivel: 'ok', classe: '', badge: '<span class="badge badge-success"><i class="ph ph-check-circle"></i> OK</span>' };
}

function mensagemErro(err) {
    if (err && err.code === 'permission-denied') {
        return 'Sem permissão para salvar no estoque. Fale com um administrador.';
    }
    return 'Não foi possível salvar. Verifique sua conexão e tente novamente.';
}

function textoSemItens() {
    return ehGestor()
        ? 'Nenhum item cadastrado. Comece pela aba <a href="#" onclick="switchTab(\'itens\'); return false;">Itens</a>.'
        : 'Nenhum item cadastrado ainda. Peça a um gestor para cadastrar os itens.';
}

function vazio(colspan, icone, texto) {
    return `<tr><td colspan="${colspan}" class="vazio"><i class="ph ${icone}"></i>${texto}</td></tr>`;
}

// ----------------------------------------------------
// TOAST E MODAL DE CONFIRMAÇÃO
// ----------------------------------------------------
function toast(msg, tipo = 'sucesso') {
    const icones = { sucesso: 'ph-check-circle', erro: 'ph-warning-circle', info: 'ph-info' };
    const el = document.createElement('div');
    el.className = `toast ${tipo}`;
    el.innerHTML = `<i class="ph-fill ${icones[tipo] || icones.info}"></i><span>${esc(msg)}</span>`;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => {
        el.classList.add('saindo');
        setTimeout(() => el.remove(), 300);
    }, tipo === 'erro' ? 6000 : 3500);
}

// Abre o modal e resolve true (confirmou) ou false (cancelou). "html" já deve vir escapado.
function confirmar({ titulo, html = '', botao = 'Confirmar', perigo = false, icone = 'ph-question', soAviso = false }) {
    const overlay = document.getElementById('modal');
    const ok = document.getElementById('modal-ok');
    const cancelar = document.getElementById('modal-cancelar');
    document.getElementById('modal-titulo').textContent = titulo;
    document.getElementById('modal-corpo').innerHTML = html;
    document.getElementById('modal-icone').className = `modal-icon ${perigo ? 'perigo' : ''}`;
    document.getElementById('modal-icone').innerHTML = `<i class="ph ${icone}"></i>`;
    ok.textContent = botao;
    ok.className = `btn ${perigo ? 'btn-danger' : 'btn-primary'}`;
    cancelar.style.display = soAviso ? 'none' : '';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    ok.focus();

    return new Promise(resolve => {
        const fechar = (resposta) => {
            overlay.classList.remove('open');
            overlay.setAttribute('aria-hidden', 'true');
            ok.onclick = cancelar.onclick = overlay.onclick = null;
            document.removeEventListener('keydown', teclado);
            resolve(resposta);
        };
        const teclado = (e) => { if (e.key === 'Escape') fechar(false); };
        ok.onclick = () => fechar(true);
        cancelar.onclick = () => fechar(false);
        overlay.onclick = (e) => { if (e.target === overlay) fechar(false); };
        document.addEventListener('keydown', teclado);
    });
}

function avisar(titulo, html) {
    return confirmar({ titulo, html, botao: 'Entendi', icone: 'ph-warning', perigo: true, soAviso: true });
}

// ----------------------------------------------------
// AUTENTICAÇÃO E CARGA DE DADOS
// ----------------------------------------------------
initAuth(() => {
    const user = getCurrentUser();
    if (!user || user.mustChangePassword) {
        window.location.href = '../index.html#login';
        return;
    }
    if (!canManageAccess(user) && !(user.organs || []).includes(AREA)) {
        alert('Você não tem acesso ao Fundo Social.');
        window.location.href = '../index.html';
        return;
    }
    if (typeof isModuleActive === 'function' && !isModuleActive(AREA) && !isOwner(user)) {
        alert('O módulo Fundo Social está desativado no momento.');
        window.location.href = '../index.html';
        return;
    }
    if (iniciado) return;
    iniciado = true;

    document.getElementById('user-name').textContent = user.name || user.email;
    document.getElementById('user-role').textContent = user.role || '';
    document.getElementById('user-avatar').textContent = iniciais(user.name || user.email);
    document.body.classList.toggle('is-gestor', canManageAccess(user));

    ['ent-data', 'sai-data', 'inv-data'].forEach(id => document.getElementById(id).value = hojeISO());
    document.getElementById('sai-motivo').innerHTML = MOTIVOS_SAIDA.map(m => `<option>${esc(m)}</option>`).join('');
    adicionarLinha('ent');
    adicionarLinha('sai');
    ouvirDados();
});

function ouvirDados() {
    const carregado = { itens: false, movs: false };
    const marcar = (chave) => {
        carregado[chave] = true;
        if (carregado.itens && carregado.movs) document.body.classList.add('dados-prontos');
    };

    db.collection(ITENS_COLLECTION).onSnapshot((snap) => {
        itens = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
        marcar('itens');
        renderTudo();
    }, erroFirestore);

    db.collection(MOV_COLLECTION).onSnapshot((snap) => {
        movimentacoes = snap.docs
            .map(d => {
                const m = { id: d.id, ...d.data({ serverTimestamps: 'estimate' }) };
                m.criadoMs = m.criadoEm ? m.criadoEm.toMillis() : 0;
                return m;
            })
            .sort((a, b) => (b.data || '').localeCompare(a.data || '') || b.criadoMs - a.criadoMs);
        marcar('movs');
        renderTudo();
    }, erroFirestore);
}

function erroFirestore(err) {
    console.error('Erro ao acessar o estoque:', err);
    const aviso = document.getElementById('aviso-erro');
    aviso.querySelector('span').textContent = err.code === 'permission-denied'
        ? 'Sem permissão para acessar o estoque no Firebase. As regras do Firestore precisam liberar as coleções do estoque.'
        : 'Não foi possível carregar o estoque. Verifique sua conexão e recarregue a página.';
    aviso.classList.add('show');
    document.body.classList.add('dados-prontos');
}

async function sair() {
    await auth.signOut();
    window.location.href = '../index.html#login';
}

// ----------------------------------------------------
// NAVEGAÇÃO
// ----------------------------------------------------
function switchTab(tabId) {
    if (tabId === 'itens' && !ehGestor()) tabId = 'dashboard';
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`view-${tabId}`).classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');
    window.scrollTo({ top: 0 });
}

function renderTudo() {
    renderDashboard();
    renderOpcoesFiltro();
    renderMovimentacoes();
    renderLinhas('ent');
    renderLinhas('sai');
    renderFeedTipo('ENTRADA', 'feed-entradas');
    renderFeedTipo('SAIDA', 'feed-saidas');
    renderInventario();
    renderItens();
    renderSugestoes();
}

// ----------------------------------------------------
// VISÃO GERAL
// ----------------------------------------------------
function renderDashboard() {
    const saldos = calcularSaldos();
    const ativos = itensDaArea();
    const alertas = ativos
        .map(i => ({ item: i, saldo: saldos[i.id] || 0, sit: situacaoItem(i, saldos[i.id] || 0) }))
        .filter(x => x.sit.nivel !== 'ok')
        .sort((a, b) => (a.sit.nivel === 'zerado' ? 0 : 1) - (b.sit.nivel === 'zerado' ? 0 : 1) || a.saldo - b.saldo);
    const mes = hojeISO().slice(0, 7);
    const doMes = movsDaArea().filter(m => (m.data || '').startsWith(mes));
    const categorias = categoriasDe(ativos);

    document.getElementById('kpi-itens').textContent = formatarQtd(ativos.length);
    document.getElementById('kpi-itens-hint').textContent = `${categorias.length} categoria${categorias.length === 1 ? '' : 's'}`;
    document.getElementById('kpi-alerta').textContent = formatarQtd(alertas.length);
    document.getElementById('kpi-alerta-hint').textContent = alertas.length ? 'sem estoque ou abaixo do mínimo' : 'tudo em ordem';
    document.getElementById('kpi-alerta-icon').className = `kpi-icon ${alertas.length ? 'warning' : 'success'}`;
    document.getElementById('kpi-entradas').textContent = formatarQtd(doMes.filter(m => m.tipo === 'ENTRADA').length);
    document.getElementById('kpi-saidas').textContent = formatarQtd(doMes.filter(m => m.tipo === 'SAIDA').length);

    // Chips de categoria
    if (categoriaDash && !categorias.includes(categoriaDash)) categoriaDash = '';
    document.getElementById('dash-categorias').innerHTML = ['', ...categorias].map(c =>
        `<button class="chip-btn ${c === categoriaDash ? 'active' : ''}" onclick="filtrarCategoriaDash('${esc(c)}')">${c ? esc(c) : 'Todas'}</button>`
    ).join('');

    // Cards de estoque
    const busca = normalizar(document.getElementById('dash-busca').value);
    const soAlerta = document.getElementById('dash-alerta').checked;
    const visiveis = ativos.filter(i => {
        if (categoriaDash && i.categoria !== categoriaDash) return false;
        if (busca && !normalizar(`${i.nome} ${i.categoria}`).includes(busca)) return false;
        if (soAlerta && situacaoItem(i, saldos[i.id] || 0).nivel === 'ok') return false;
        return true;
    });
    const cards = document.getElementById('cards-estoque');
    if (ativos.length === 0) {
        cards.innerHTML = `<div class="vazio" style="grid-column: 1 / -1;"><i class="ph ph-package"></i>${textoSemItens()}</div>`;
    } else if (visiveis.length === 0) {
        cards.innerHTML = `<div class="vazio" style="grid-column: 1 / -1;"><i class="ph ph-magnifying-glass"></i>Nenhum item encontrado.</div>`;
    } else {
        cards.innerHTML = visiveis.map(item => cardEstoque(item, saldos[item.id] || 0)).join('');
    }

    // Últimas movimentações e alertas
    const recentes = movsDaArea().slice(0, 8);
    document.getElementById('feed-recentes').innerHTML = recentes.length
        ? recentes.map(itemFeed).join('')
        : `<li class="vazio" style="display:block"><i class="ph ph-tray"></i>Nenhuma movimentação ainda.</li>`;

    document.getElementById('feed-alertas').innerHTML = alertas.length
        ? alertas.slice(0, 8).map(({ item, saldo, sit }) => `
            <li>
                <div class="feed-icon alerta-${sit.nivel}"><i class="ph ${sit.nivel === 'zerado' ? 'ph-x-circle' : 'ph-warning'}"></i></div>
                <div class="feed-body">
                    <div class="feed-title">${esc(item.nome)}</div>
                    <div class="feed-sub">${sit.nivel === 'zerado' ? 'Sem estoque' : `Mínimo: ${formatarQtd(item.estoqueMinimo)} ${esc(item.unidade)}`}</div>
                </div>
                <div class="feed-qty ${sit.nivel === 'zerado' ? 'qty-neg' : ''}">${formatarQtd(saldo)} <small>${esc(item.unidade)}</small></div>
            </li>`).join('')
        : `<li class="vazio" style="display:block"><i class="ph ph-check-circle"></i>Nenhum item em alerta.</li>`;
}

function cardEstoque(item, saldo) {
    const sit = situacaoItem(item, saldo);
    const min = Number(item.estoqueMinimo || 0);
    // A barra enche até o dobro do mínimo (cheia = folga confortável)
    const pct = min > 0 ? Math.max(0, Math.min(100, saldo / (min * 2) * 100)) : (saldo > 0 ? 100 : 0);
    return `
        <div class="stock-card ${sit.classe}">
            <div class="stock-top">
                <span class="chip ${item.categoria ? '' : 'muted'}">${esc(item.categoria || 'Sem categoria')}</span>
                ${sit.nivel === 'ok' ? '' : sit.badge}
            </div>
            <h3>${esc(item.nome)}</h3>
            <div class="stock-value"><strong>${formatarQtd(saldo)}</strong><span>${esc(item.unidade)}</span></div>
            <div class="meter"><span style="width: ${pct.toFixed(0)}%"></span></div>
            <div class="stock-foot">
                <span>${min > 0 ? `Mínimo: ${formatarQtd(min)}` : 'Sem mínimo definido'}</span>
                <button class="link-btn" onclick="verMovimentacoes({ itemId: '${esc(item.id)}' })">Extrato <i class="ph ph-caret-right"></i></button>
            </div>
        </div>`;
}

function itemFeed(m) {
    const tipo = TIPOS[m.tipo] || TIPOS.AJUSTE;
    const detalhe = [m.origemDestino, formatarData(m.data), m.usuarioNome].filter(Boolean).map(esc).join(' · ');
    return `
        <li>
            <div class="feed-icon ${esc(m.tipo)}"><i class="ph ${tipo.icone}"></i></div>
            <div class="feed-body">
                <div class="feed-title">${esc(m.itemNome)}</div>
                <div class="feed-sub" title="${detalhe}">${detalhe}</div>
            </div>
            <div class="feed-qty ${tipo.classeQtd}">${qtdComSinal(m)} <small>${esc(m.unidade)}</small></div>
        </li>`;
}

function filtrarCategoriaDash(categoria) {
    categoriaDash = categoria;
    renderDashboard();
}

// ----------------------------------------------------
// MOVIMENTAÇÕES (FILTROS, LISTA, EXPORTAÇÃO)
// ----------------------------------------------------
function filtrosVazios() {
    return { periodo: 'tudo', de: '', ate: '', tipo: '', itemId: '', categoria: '', local: '', motivo: '', usuario: '', area: '', busca: '' };
}

const CAMPOS_FILTRO = { itemId: 'f-item', categoria: 'f-categoria', local: 'f-local', motivo: 'f-motivo', usuario: 'f-usuario', area: 'f-area', busca: 'f-busca', de: 'f-de', ate: 'f-ate' };

function renderOpcoesFiltro() {
    const movs = movsDaArea();
    const preencher = (id, opcoes, rotuloTodos) => {
        const select = document.getElementById(id);
        select.innerHTML = `<option value="">${rotuloTodos}</option>` +
            opcoes.map(([valor, texto]) => `<option value="${esc(valor)}">${esc(texto)}</option>`).join('');
    };
    const itensFiltro = itens.filter(i => areasDoItem(i).includes(AREA));
    preencher('f-item', itensFiltro.map(i => [i.id, i.nome + (i.ativo === false ? ' (inativo)' : '')]), 'Todos os itens');
    preencher('f-categoria', categoriasDe(itensFiltro).map(c => [c, c]), 'Todas');
    preencher('f-motivo', MOTIVOS_SAIDA.map(m => [m, m]), 'Todos');
    const usuarios = new Map(movs.map(m => [m.usuarioId, m.usuarioNome]));
    preencher('f-usuario', [...usuarios].filter(([id]) => id).sort((a, b) => (a[1] || '').localeCompare(b[1] || '', 'pt-BR')), 'Todos');
    const areas = [...new Set(movs.map(areaDaMov))].sort();
    preencher('f-area', areas.map(a => [a, a]), 'Todas');
    document.getElementById('f-area-campo').style.display = areas.length > 1 ? '' : 'none';
    sincronizarCamposFiltro();
}

function sincronizarCamposFiltro() {
    Object.entries(CAMPOS_FILTRO).forEach(([chave, id]) => document.getElementById(id).value = filtros[chave]);
    document.querySelectorAll('#filtro-periodos .chip-btn').forEach(b => b.classList.toggle('active', b.dataset.periodo === filtros.periodo));
    document.querySelectorAll('#filtro-tipos button').forEach(b => b.classList.toggle('active', b.dataset.tipo === filtros.tipo));
}

// Lê os campos da tela; "datasManuais" = o usuário mexeu nas datas (período vira personalizado)
function aplicarFiltros(datasManuais = false) {
    Object.entries(CAMPOS_FILTRO).forEach(([chave, id]) => filtros[chave] = document.getElementById(id).value);
    if (datasManuais) filtros.periodo = 'personalizado';
    limiteLista = POR_PAGINA;
    sincronizarCamposFiltro();
    renderMovimentacoes();
}

function definirPeriodo(periodo) {
    const hoje = new Date();
    const y = hoje.getFullYear(), m = hoje.getMonth();
    const intervalos = {
        hoje: [hojeISO(), hojeISO()],
        '7dias': [isoDe(new Date(y, m, hoje.getDate() - 6)), hojeISO()],
        mes: [isoDe(new Date(y, m, 1)), hojeISO()],
        mesPassado: [isoDe(new Date(y, m - 1, 1)), isoDe(new Date(y, m, 0))],
        ano: [isoDe(new Date(y, 0, 1)), hojeISO()],
        tudo: ['', '']
    };
    [filtros.de, filtros.ate] = intervalos[periodo];
    filtros.periodo = periodo;
    document.getElementById('f-de').value = filtros.de;
    document.getElementById('f-ate').value = filtros.ate;
    aplicarFiltros();
}

function definirTipo(tipo) {
    filtros.tipo = tipo;
    aplicarFiltros();
}

function limparFiltros() {
    filtros = filtrosVazios();
    limiteLista = POR_PAGINA;
    sincronizarCamposFiltro();
    renderMovimentacoes();
}

// Abre Movimentações já filtrada (ex.: extrato de um item, todas as saídas)
function verMovimentacoes(parcial) {
    filtros = { ...filtrosVazios(), ...parcial };
    limiteLista = POR_PAGINA;
    sincronizarCamposFiltro();
    renderMovimentacoes();
    switchTab('movimentacoes');
}

function contarFiltrosAtivos() {
    const vazios = filtrosVazios();
    let n = 0;
    if (filtros.de || filtros.ate) n++;
    ['tipo', 'itemId', 'categoria', 'local', 'motivo', 'usuario', 'area', 'busca'].forEach(k => { if (filtros[k] !== vazios[k]) n++; });
    return n;
}

function movsFiltradas() {
    const f = filtros;
    const local = normalizar(f.local);
    const busca = normalizar(f.busca);
    return movsDaArea().filter(m => {
        if (f.de && (m.data || '') < f.de) return false;
        if (f.ate && (m.data || '') > f.ate) return false;
        if (f.tipo && m.tipo !== f.tipo) return false;
        if (f.itemId && m.itemId !== f.itemId) return false;
        if (f.categoria && (getItem(m.itemId)?.categoria || '') !== f.categoria) return false;
        if (f.motivo && (m.motivo || '') !== f.motivo) return false;
        if (f.usuario && m.usuarioId !== f.usuario) return false;
        if (f.area && areaDaMov(m) !== f.area) return false;
        if (local && !normalizar(m.origemDestino).includes(local)) return false;
        if (busca && ![m.itemNome, m.origemDestino, m.obs, m.motivo, m.usuarioNome].some(v => normalizar(v).includes(busca))) return false;
        return true;
    });
}

function renderMovimentacoes() {
    const lista = movsFiltradas();
    const ativos = contarFiltrosAtivos();
    const contagem = document.getElementById('filtro-contagem');
    contagem.textContent = ativos;
    contagem.style.display = ativos ? '' : 'none';

    // Faixa de resumo
    const porTipo = (t) => lista.filter(m => m.tipo === t).length;
    document.getElementById('mov-resumo').innerHTML = `
        <span class="summary-pill"><i class="ph ph-list-numbers"></i> <strong>${formatarQtd(lista.length)}</strong> lançamentos</span>
        <span class="summary-pill"><i class="ph ph-arrow-down-left" style="color: var(--success)"></i> <strong>${formatarQtd(porTipo('ENTRADA'))}</strong> entradas</span>
        <span class="summary-pill"><i class="ph ph-arrow-up-right" style="color: var(--danger)"></i> <strong>${formatarQtd(porTipo('SAIDA'))}</strong> saídas</span>
        <span class="summary-pill"><i class="ph ph-scales" style="color: var(--info)"></i> <strong>${formatarQtd(porTipo('AJUSTE'))}</strong> ajustes</span>
        ${filtros.de || filtros.ate ? `<span class="summary-pill"><i class="ph ph-calendar-blank"></i> ${filtros.de ? formatarData(filtros.de) : 'início'} a ${filtros.ate ? formatarData(filtros.ate) : 'hoje'}</span>` : ''}`;

    // Resumo por item (somas por unidade de cada item)
    const resumo = new Map();
    lista.forEach(m => {
        const r = resumo.get(m.itemId) || { nome: m.itemNome, unidade: m.unidade, ENTRADA: 0, SAIDA: 0, AJUSTE: 0 };
        r[m.tipo] += Number(m.qtd || 0);
        resumo.set(m.itemId, r);
    });
    const linhasResumo = [...resumo.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    document.getElementById('table-resumo-itens').innerHTML = linhasResumo.length
        ? linhasResumo.map(r => {
            const resultado = r.ENTRADA - r.SAIDA + r.AJUSTE;
            return `<tr>
                <td><strong>${esc(r.nome)}</strong></td>
                <td class="right num qty-pos">${r.ENTRADA ? '+' + formatarQtd(r.ENTRADA) : '-'}</td>
                <td class="right num qty-neg">${r.SAIDA ? '−' + formatarQtd(r.SAIDA) : '-'}</td>
                <td class="right num qty-adj">${r.AJUSTE ? (r.AJUSTE > 0 ? '+' : '−') + formatarQtd(Math.abs(r.AJUSTE)) : '-'}</td>
                <td class="right num"><strong>${resultado > 0 ? '+' : resultado < 0 ? '−' : ''}${formatarQtd(Math.abs(resultado))}</strong> <small>${esc(r.unidade)}</small></td>
            </tr>`;
        }).join('')
        : vazio(5, 'ph-tray', 'Nada no período.');

    // Lista paginada
    const tbody = document.getElementById('table-movimentacoes');
    tbody.innerHTML = lista.length
        ? lista.slice(0, limiteLista).map(linhaMovimentacao).join('')
        : vazio(8, 'ph-funnel-x', movimentacoes.length ? 'Nenhuma movimentação com esses filtros.' : 'Nenhuma movimentação registrada.');

    const restantes = lista.length - limiteLista;
    document.getElementById('mov-mais').innerHTML = restantes > 0
        ? `<button class="btn btn-secondary btn-sm" onclick="mostrarMais()">Mostrar mais (${formatarQtd(restantes)} restantes)</button>`
        : '';
}

function linhaMovimentacao(m) {
    const tipo = TIPOS[m.tipo] || TIPOS.AJUSTE;
    const extras = [];
    if (m.motivo) extras.push(esc(m.motivo));
    if (m.tipo === 'AJUSTE') extras.push(`contado: ${formatarQtd(m.contado)}`);
    if (areaDaMov(m) !== AREA) extras.push(`área: ${esc(areaDaMov(m))}`);
    return `
        <tr>
            <td class="nowrap num">${formatarData(m.data)}</td>
            <td><span class="badge ${tipo.badge}"><i class="ph ${tipo.icone}"></i> ${tipo.label}</span></td>
            <td class="nowrap"><strong>${esc(m.itemNome)}</strong></td>
            <td class="right nowrap num ${tipo.classeQtd}"><strong>${qtdComSinal(m)}</strong> <small>${esc(m.unidade)}</small></td>
            <td>${esc(m.origemDestino || '-')}${extras.length ? `<span class="cell-sub">${extras.join(' · ')}</span>` : ''}</td>
            <td>${esc(m.obs || '')}</td>
            <td><small>${esc(m.usuarioNome || '')}</small></td>
            <td class="so-gestor right">
                <button class="icon-btn danger" title="Excluir lançamento" onclick="excluirMovimentacao('${esc(m.id)}')"><i class="ph ph-trash"></i></button>
            </td>
        </tr>`;
}

function mostrarMais() {
    limiteLista += POR_PAGINA;
    renderMovimentacoes();
}

function carregarScript(src) {
    if (document.querySelector(`script[src="${src}"]`)) {
        return window.ExcelJS ? Promise.resolve() : new Promise(r => setTimeout(r, 500));
    }
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Falha ao carregar ' + src));
        document.head.appendChild(s);
    });
}

async function exportarExcel() {
    const lista = movsFiltradas();
    if (!lista.length) {
        toast('Nenhuma movimentação para exportar com esses filtros.', 'info');
        return;
    }
    try {
        await carregarScript(EXCELJS_URL);
        const wb = new ExcelJS.Workbook();
        const estiloCabecalho = (ws) => {
            ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B4C7E' } };
            ws.views = [{ state: 'frozen', ySplit: 1 }];
        };

        const ws = wb.addWorksheet('Movimentações');
        ws.columns = [
            { header: 'Data', key: 'data', width: 12 },
            { header: 'Tipo', key: 'tipo', width: 10 },
            { header: 'Item', key: 'item', width: 26 },
            { header: 'Categoria', key: 'categoria', width: 14 },
            { header: 'Quantidade', key: 'qtd', width: 12 },
            { header: 'Unidade', key: 'unidade', width: 9 },
            { header: 'Origem / destino', key: 'local', width: 32 },
            { header: 'Motivo', key: 'motivo', width: 18 },
            { header: 'Observação', key: 'obs', width: 40 },
            { header: 'Área', key: 'area', width: 14 },
            { header: 'Lançado por', key: 'usuario', width: 24 }
        ];
        lista.forEach(m => ws.addRow({
            data: formatarData(m.data),
            tipo: (TIPOS[m.tipo] || TIPOS.AJUSTE).label,
            item: m.itemNome,
            categoria: getItem(m.itemId)?.categoria || '',
            qtd: m.tipo === 'SAIDA' ? -Number(m.qtd) : Number(m.qtd),
            unidade: m.unidade,
            local: m.origemDestino || '',
            motivo: m.motivo || '',
            obs: m.obs || '',
            area: areaDaMov(m),
            usuario: m.usuarioNome || ''
        }));
        estiloCabecalho(ws);
        ws.autoFilter = { from: 'A1', to: 'K1' };

        const saldos = calcularSaldos();
        const wsSaldo = wb.addWorksheet('Saldo atual');
        wsSaldo.columns = [
            { header: 'Item', key: 'item', width: 26 },
            { header: 'Categoria', key: 'categoria', width: 14 },
            { header: 'Saldo', key: 'saldo', width: 10 },
            { header: 'Unidade', key: 'unidade', width: 9 },
            { header: 'Mínimo', key: 'minimo', width: 10 },
            { header: 'Situação', key: 'situacao', width: 16 }
        ];
        itensDaArea().forEach(i => {
            const saldo = saldos[i.id] || 0;
            const nivel = situacaoItem(i, saldo).nivel;
            wsSaldo.addRow({
                item: i.nome, categoria: i.categoria || '', saldo, unidade: i.unidade,
                minimo: Number(i.estoqueMinimo || 0),
                situacao: nivel === 'zerado' ? 'Sem estoque' : nivel === 'baixo' ? 'Estoque baixo' : 'OK'
            });
        });
        estiloCabecalho(wsSaldo);

        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `estoque-movimentacoes-${hojeISO()}.xlsx`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        toast(`Planilha gerada com ${formatarQtd(lista.length)} lançamentos.`);
    } catch (err) {
        console.error('Erro ao exportar:', err);
        toast('Não foi possível gerar a planilha. Verifique a conexão.', 'erro');
    }
}

// Só Administrador/Gestor exclui lançamentos (a lixeira nem aparece para os demais)
async function excluirMovimentacao(id) {
    const m = movimentacoes.find(x => x.id === id);
    if (!m || !ehGestor()) return;
    const tipo = (TIPOS[m.tipo] || TIPOS.AJUSTE).label;
    const confirmou = await confirmar({
        titulo: 'Excluir lançamento?',
        html: `<p>${tipo} de <strong>${qtdComSinal(m)} ${esc(m.unidade)}</strong> de <strong>${esc(m.itemNome)}</strong> em ${formatarData(m.data)}.</p>
               <p style="margin-top:.5rem">O saldo do item será recalculado em todas as áreas.</p>`,
        botao: 'Excluir',
        perigo: true,
        icone: 'ph-trash'
    });
    if (!confirmou) return;
    try {
        await db.collection(MOV_COLLECTION).doc(id).delete();
        toast('Lançamento excluído.');
    } catch (err) {
        console.error('Erro ao excluir movimentação:', err);
        toast(mensagemErro(err), 'erro');
    }
}

// ----------------------------------------------------
// LANÇAMENTOS (ENTRADA / SAÍDA COM VÁRIOS ITENS)
// ----------------------------------------------------
function opcoesItens(selecionado) {
    const ativos = itensDaArea();
    if (!ativos.length) return `<option value="">${ehGestor() ? 'Cadastre itens na aba Itens' : 'Nenhum item cadastrado'}</option>`;
    return '<option value="">Selecione o item...</option>' + ativos.map(i =>
        `<option value="${esc(i.id)}" ${i.id === selecionado ? 'selected' : ''}>${esc(i.nome)}</option>`
    ).join('');
}

function adicionarLinha(prefixo) {
    const box = document.getElementById(`${prefixo}-linhas`);
    const linha = document.createElement('div');
    linha.className = 'line';
    linha.innerHTML = `
        <select class="form-control linha-item" aria-label="Item" onchange="renderLinhas('${prefixo}')">${opcoesItens('')}</select>
        <div class="qty">
            <input type="number" class="form-control linha-qtd" aria-label="Quantidade" min="1" step="1" value="1" oninput="renderLinhas('${prefixo}')">
            <span class="linha-unidade"></span>
        </div>
        <button type="button" class="icon-btn danger" title="Remover item" onclick="removerLinha(this, '${prefixo}')"><i class="ph ph-x"></i></button>
        <div class="line-info"></div>`;
    box.appendChild(linha);
    renderLinhas(prefixo);
    if (box.children.length > 1) linha.querySelector('select').focus();
}

function removerLinha(botao, prefixo) {
    const box = document.getElementById(`${prefixo}-linhas`);
    if (box.children.length === 1) {
        box.querySelector('.linha-item').value = '';
        box.querySelector('.linha-qtd').value = 1;
    } else {
        botao.closest('.line').remove();
    }
    renderLinhas(prefixo);
}

function lerLinhas(prefixo) {
    return [...document.querySelectorAll(`#${prefixo}-linhas .line`)].map(el => ({
        el,
        itemId: el.querySelector('.linha-item').value,
        qtd: parseInt(el.querySelector('.linha-qtd').value, 10)
    }));
}

// Atualiza opções, unidade, saldo disponível e o resumo do formulário
function renderLinhas(prefixo) {
    const saldos = calcularSaldos();
    const linhas = lerLinhas(prefixo);
    const pedidoPorItem = {};
    linhas.forEach(l => { if (l.itemId && l.qtd > 0) pedidoPorItem[l.itemId] = (pedidoPorItem[l.itemId] || 0) + l.qtd; });

    linhas.forEach(l => {
        const select = l.el.querySelector('.linha-item');
        select.innerHTML = opcoesItens(l.itemId);
        if (l.itemId && !getItem(l.itemId)) select.value = '';
        const item = getItem(select.value);
        l.el.querySelector('.linha-unidade').textContent = item ? item.unidade : '';
        const info = l.el.querySelector('.line-info');
        info.className = 'line-info';
        info.textContent = '';
        if (item && prefixo === 'sai') {
            const saldo = saldos[item.id] || 0;
            info.textContent = `Disponível: ${formatarQtd(saldo)} ${item.unidade}`;
            if ((pedidoPorItem[item.id] || 0) > saldo) {
                info.textContent += ' — quantidade maior que o saldo';
                info.classList.add('erro');
            }
        }
    });

    const validas = linhas.filter(l => l.itemId && l.qtd > 0).length;
    document.getElementById(`${prefixo}-resumo`).textContent = validas
        ? `${itensTexto(validas)} neste lançamento.`
        : 'Escolha pelo menos um item.';
}

function montarMovimentacao(dados) {
    const user = getCurrentUser();
    const item = getItem(dados.itemId);
    return {
        ...dados,
        area: AREA,
        itemNome: item.nome,
        unidade: item.unidade || '',
        usuarioId: user.id,
        usuarioNome: user.name || user.email,
        criadoEm: firebase.firestore.FieldValue.serverTimestamp()
    };
}

function ligarFormLancamento(prefixo, tipo) {
    const form = document.getElementById(prefixo === 'ent' ? 'form-entrada' : 'form-saida');
    const campo = (nome) => document.getElementById(`${prefixo}-${nome}`);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const linhas = lerLinhas(prefixo).filter(l => l.itemId);
        if (!linhas.length) {
            toast('Escolha pelo menos um item.', 'erro');
            return;
        }
        if (linhas.some(l => !(l.qtd > 0))) {
            toast('Informe quantidades inteiras maiores que zero.', 'erro');
            return;
        }

        if (tipo === 'SAIDA') {
            const saldos = calcularSaldos();
            const pedido = {};
            linhas.forEach(l => pedido[l.itemId] = (pedido[l.itemId] || 0) + l.qtd);
            const faltando = Object.entries(pedido).filter(([id, qtd]) => qtd > (saldos[id] || 0));
            if (faltando.length) {
                await avisar('Estoque insuficiente', '<ul>' + faltando.map(([id, qtd]) => {
                    const item = getItem(id);
                    return `<li><strong>${esc(item.nome)}</strong>: pedido ${formatarQtd(qtd)}, disponível ${formatarQtd(saldos[id] || 0)} ${esc(item.unidade)}</li>`;
                }).join('') + '</ul>');
                return;
            }
        }

        const comuns = {
            tipo,
            data: campo('data').value,
            origemDestino: campo('local').value.trim(),
            obs: campo('obs').value.trim()
        };
        if (tipo === 'SAIDA') comuns.motivo = campo('motivo').value;

        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            const batch = db.batch();
            const lote = linhas.length > 1 ? db.collection(MOV_COLLECTION).doc().id : null;
            linhas.forEach(l => {
                const dados = { ...comuns, itemId: l.itemId, qtd: l.qtd };
                if (lote) dados.lote = lote;
                batch.set(db.collection(MOV_COLLECTION).doc(), montarMovimentacao(dados));
            });
            await batch.commit();

            // Mantém data e origem/destino para facilitar vários lançamentos seguidos
            campo('obs').value = '';
            document.getElementById(`${prefixo}-linhas`).innerHTML = '';
            adicionarLinha(prefixo);
            toast(`${tipo === 'ENTRADA' ? 'Entrada' : 'Saída'} registrada (${itensTexto(linhas.length)}).`);
        } catch (err) {
            console.error('Erro ao registrar movimentação:', err);
            toast(mensagemErro(err), 'erro');
        } finally {
            btn.disabled = false;
        }
    });
}

ligarFormLancamento('ent', 'ENTRADA');
ligarFormLancamento('sai', 'SAIDA');

function renderFeedTipo(tipo, feedId) {
    const lista = movsDaArea().filter(m => m.tipo === tipo).slice(0, 8);
    document.getElementById(feedId).innerHTML = lista.length
        ? lista.map(itemFeed).join('')
        : `<li class="vazio" style="display:block"><i class="ph ph-tray"></i>Nada lançado ainda.</li>`;
}

function renderSugestoes() {
    const movs = movsDaArea();
    const preencher = (id, valores) => {
        const unicos = [...new Set(valores.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        document.getElementById(id).innerHTML = unicos.map(v => `<option value="${esc(v)}"></option>`).join('');
    };
    preencher('lista-origens', movs.filter(m => m.tipo === 'ENTRADA').map(m => m.origemDestino));
    preencher('lista-destinos', movs.filter(m => m.tipo === 'SAIDA').map(m => m.origemDestino));
    preencher('lista-locais', movs.filter(m => m.tipo !== 'AJUSTE').map(m => m.origemDestino));
    preencher('lista-categorias', itens.map(i => i.categoria));
}

// ----------------------------------------------------
// INVENTÁRIO
// ----------------------------------------------------
function renderInventario() {
    const saldos = calcularSaldos();
    const tbody = document.getElementById('table-inventario');
    // Preserva o que já foi digitado quando chega atualização do Firestore
    const digitado = {};
    tbody.querySelectorAll('.inv-input').forEach(inp => digitado[inp.dataset.itemId] = inp.value);

    const ativos = [...itensDaArea()].sort((a, b) =>
        (a.categoria || '').localeCompare(b.categoria || '', 'pt-BR') || a.nome.localeCompare(b.nome, 'pt-BR'));
    if (!ativos.length) {
        tbody.innerHTML = vazio(5, 'ph-package', textoSemItens());
        return;
    }
    tbody.innerHTML = ativos.map(item => `
        <tr data-busca="${esc(normalizar(`${item.nome} ${item.categoria}`))}">
            <td><strong>${esc(item.nome)}</strong></td>
            <td><span class="chip ${item.categoria ? '' : 'muted'}">${esc(item.categoria || '-')}</span></td>
            <td class="right num">${formatarQtd(saldos[item.id] || 0)} <small>${esc(item.unidade)}</small></td>
            <td><input type="number" min="0" step="1" class="form-control inv-input" data-item-id="${esc(item.id)}"
                       aria-label="Quantidade contada de ${esc(item.nome)}" value="${esc(digitado[item.id] || '')}" oninput="atualizarDiferenca(this)"></td>
            <td class="right num inv-diff" id="diff-${esc(item.id)}"></td>
        </tr>`).join('');
    tbody.querySelectorAll('.inv-input').forEach(atualizarDiferenca);
    filtrarInventario();
}

function filtrarInventario() {
    const termo = normalizar(document.getElementById('inv-busca').value);
    document.querySelectorAll('#table-inventario tr[data-busca]').forEach(tr => {
        tr.style.display = !termo || tr.dataset.busca.includes(termo) ? '' : 'none';
    });
}

function atualizarDiferenca(input) {
    const cel = document.getElementById(`diff-${input.dataset.itemId}`);
    if (input.value === '') {
        cel.textContent = '';
        cel.className = 'right num inv-diff';
    } else {
        const diff = parseInt(input.value, 10) - (calcularSaldos()[input.dataset.itemId] || 0);
        cel.textContent = diff === 0 ? 'confere' : `${diff > 0 ? '+' : '−'}${formatarQtd(Math.abs(diff))}`;
        cel.className = `right num inv-diff ${diff > 0 ? 'diff-pos' : diff < 0 ? 'diff-neg' : 'diff-ok'}`;
    }
    const preenchidos = [...document.querySelectorAll('.inv-input')].filter(i => i.value !== '').length;
    document.getElementById('inv-resumo').textContent = preenchidos
        ? `${itensTexto(preenchidos)} contado${preenchidos > 1 ? 's' : ''}.`
        : '';
}

document.getElementById('form-inventario').addEventListener('submit', async (e) => {
    e.preventDefault();
    const saldos = calcularSaldos();
    const data = document.getElementById('inv-data').value;
    const obs = document.getElementById('inv-obs').value.trim() || 'Contagem de inventário';

    const ajustes = [];
    for (const inp of document.querySelectorAll('.inv-input')) {
        if (inp.value === '') continue;
        const contado = parseInt(inp.value, 10);
        if (!(contado >= 0)) {
            toast('Informe quantidades inteiras a partir de zero.', 'erro');
            return;
        }
        const diff = contado - (saldos[inp.dataset.itemId] || 0);
        if (diff !== 0) ajustes.push({ itemId: inp.dataset.itemId, contado, diff });
    }

    if (!ajustes.length) {
        toast('A contagem confere com o sistema. Nada a ajustar.', 'info');
        return;
    }
    const confirmou = await confirmar({
        titulo: 'Registrar ajustes de inventário?',
        html: '<ul>' + ajustes.map(a => {
            const item = getItem(a.itemId);
            return `<li><strong>${esc(item.nome)}</strong>: ${a.diff > 0 ? '+' : '−'}${formatarQtd(Math.abs(a.diff))} ${esc(item.unidade)} (contado ${formatarQtd(a.contado)})</li>`;
        }).join('') + '</ul>',
        botao: 'Registrar',
        icone: 'ph-clipboard-text'
    });
    if (!confirmou) return;

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
        const batch = db.batch();
        ajustes.forEach(a => {
            batch.set(db.collection(MOV_COLLECTION).doc(), montarMovimentacao({
                tipo: 'AJUSTE',
                itemId: a.itemId,
                qtd: a.diff,
                contado: a.contado,
                data,
                origemDestino: 'Inventário',
                obs
            }));
        });
        await batch.commit();
        document.querySelectorAll('.inv-input').forEach(inp => inp.value = '');
        document.getElementById('inv-obs').value = '';
        renderInventario();
        toast(`${ajustes.length} ajuste${ajustes.length > 1 ? 's' : ''} registrado${ajustes.length > 1 ? 's' : ''}.`);
    } catch (err) {
        console.error('Erro ao salvar inventário:', err);
        toast(mensagemErro(err), 'erro');
    } finally {
        btn.disabled = false;
    }
});

// ----------------------------------------------------
// ITENS (CADASTRO ÚNICO, COM ÁREAS) — SÓ ADMINISTRADOR/GESTOR
// ----------------------------------------------------
// Todas as áreas do portal (ativas ou não), para não perder a área de um item
// quando o módulo dela estiver desativado
function areasDisponiveis() {
    if (typeof ALL_ORGANS !== 'undefined') return ALL_ORGANS;
    return typeof ORGANS !== 'undefined' && ORGANS.length ? ORGANS : [AREA];
}

function renderCheckboxAreas(marcadas) {
    const ativa = (a) => typeof isModuleActive !== 'function' || isModuleActive(a);
    document.getElementById('item-areas').innerHTML = areasDisponiveis().map(a => `
        <label class="check">
            <input type="checkbox" name="item-area" value="${esc(a)}" ${marcadas.includes(a) ? 'checked' : ''}>
            ${esc(a)}${ativa(a) ? '' : ' <small>(desativado)</small>'}
        </label>`).join('');
}

function renderItens() {
    if (!ehGestor()) return;
    const saldos = calcularSaldos();
    document.getElementById('painel-itens-padrao').style.display = itens.length === 0 ? '' : 'none';
    if (!document.getElementById('item-id').value) renderCheckboxAreas([AREA]);

    const todas = document.getElementById('itens-todas-areas').checked;
    const lista = todas ? itens : itens.filter(i => areasDoItem(i).includes(AREA));
    const tbody = document.getElementById('table-itens');
    if (!lista.length) {
        tbody.innerHTML = vazio(7, 'ph-package', 'Nenhum item cadastrado.');
        return;
    }
    tbody.innerHTML = lista.map(item => {
        const ativo = item.ativo !== false;
        const saldo = saldos[item.id] || 0;
        return `
            <tr class="${ativo ? '' : 'inativo'}">
                <td><strong>${esc(item.nome)}</strong><span class="cell-sub">${esc(item.unidade)}</span></td>
                <td>${item.categoria ? `<span class="chip">${esc(item.categoria)}</span>` : '-'}</td>
                <td>${areasDoItem(item).map(a => `<span class="chip muted">${esc(a)}</span>`).join(' ')}</td>
                <td class="right num">${formatarQtd(item.estoqueMinimo)}</td>
                <td class="right num"><strong>${formatarQtd(saldo)}</strong></td>
                <td>${ativo ? situacaoItem(item, saldo).badge : '<span class="badge badge-neutral">Inativo</span>'}</td>
                <td class="right nowrap">
                    <button class="icon-btn" title="Extrato" onclick="verMovimentacoes({ itemId: '${esc(item.id)}' })"><i class="ph ph-list-magnifying-glass"></i></button>
                    <button class="icon-btn" title="Editar" onclick="editarItem('${esc(item.id)}')"><i class="ph ph-pencil-simple"></i></button>
                    <button class="icon-btn ${ativo ? 'danger' : ''}" title="${ativo ? 'Desativar' : 'Reativar'}" onclick="alternarAtivo('${esc(item.id)}')">
                        <i class="ph ${ativo ? 'ph-eye-slash' : 'ph-eye'}"></i>
                    </button>
                </td>
            </tr>`;
    }).join('');
}

function editarItem(id) {
    const item = getItem(id);
    if (!item || !ehGestor()) return;
    document.getElementById('item-id').value = item.id;
    document.getElementById('item-nome').value = item.nome;
    document.getElementById('item-categoria').value = item.categoria || '';
    document.getElementById('item-unidade').value = item.unidade || '';
    document.getElementById('item-minimo').value = item.estoqueMinimo || 0;
    renderCheckboxAreas(areasDoItem(item));
    document.getElementById('item-form-titulo').innerHTML = `<i class="ph ph-pencil-simple"></i> Editar: ${esc(item.nome)}`;
    document.getElementById('item-cancelar').style.display = '';
    document.getElementById('form-item').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelarEdicaoItem() {
    document.getElementById('form-item').reset();
    document.getElementById('item-id').value = '';
    document.getElementById('item-form-titulo').innerHTML = '<i class="ph ph-plus-circle"></i> Novo item';
    document.getElementById('item-cancelar').style.display = 'none';
    renderCheckboxAreas([AREA]);
}

document.getElementById('form-item').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ehGestor()) return;
    const id = document.getElementById('item-id').value;
    const dados = {
        nome: document.getElementById('item-nome').value.trim(),
        categoria: document.getElementById('item-categoria').value.trim(),
        unidade: document.getElementById('item-unidade').value.trim(),
        estoqueMinimo: Math.max(0, parseInt(document.getElementById('item-minimo').value, 10) || 0)
    };
    if (itens.some(i => i.id !== id && normalizar(i.nome) === normalizar(dados.nome))) {
        toast(`Já existe um item chamado "${dados.nome}".`, 'erro');
        return;
    }
    dados.areas = [...document.querySelectorAll('input[name="item-area"]:checked')].map(c => c.value);
    if (!dados.areas.length) {
        toast('Marque pelo menos uma área.', 'erro');
        return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
        if (id) {
            await db.collection(ITENS_COLLECTION).doc(id).update(dados);
        } else {
            await db.collection(ITENS_COLLECTION).add({
                ...dados,
                ativo: true,
                criadoEm: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
        cancelarEdicaoItem();
        toast(id ? 'Item atualizado.' : 'Item cadastrado.');
    } catch (err) {
        console.error('Erro ao salvar item:', err);
        toast(mensagemErro(err), 'erro');
    } finally {
        btn.disabled = false;
    }
});

async function alternarAtivo(id) {
    const item = getItem(id);
    if (!item || !ehGestor()) return;
    const ativo = item.ativo !== false;
    if (ativo) {
        const confirmou = await confirmar({
            titulo: `Desativar "${item.nome}"?`,
            html: '<p>O item some das telas de lançamento em todas as áreas, mas o histórico é mantido. Dá para reativar depois.</p>',
            botao: 'Desativar',
            perigo: true,
            icone: 'ph-eye-slash'
        });
        if (!confirmou) return;
    }
    try {
        await db.collection(ITENS_COLLECTION).doc(id).update({ ativo: !ativo });
        toast(ativo ? 'Item desativado.' : 'Item reativado.');
    } catch (err) {
        console.error('Erro ao alterar item:', err);
        toast(mensagemErro(err), 'erro');
    }
}

async function criarItensPadrao() {
    if (!ehGestor()) return;
    const existentes = new Set(itens.map(i => normalizar(i.nome)));
    const novos = ITENS_PADRAO.filter(i => !existentes.has(normalizar(i.nome)));
    if (!novos.length) return;
    try {
        const batch = db.batch();
        novos.forEach(i => batch.set(db.collection(ITENS_COLLECTION).doc(), {
            ...i,
            estoqueMinimo: 0,
            ativo: true,
            areas: [AREA],
            criadoEm: firebase.firestore.FieldValue.serverTimestamp()
        }));
        await batch.commit();
        toast(`${novos.length} itens criados.`);
    } catch (err) {
        console.error('Erro ao criar itens padrão:', err);
        toast(mensagemErro(err), 'erro');
    }
}
