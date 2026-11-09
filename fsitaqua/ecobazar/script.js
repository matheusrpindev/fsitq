// script.js - EcoBazar (van itinerante) com Firebase
//
// Depende de ../auth.js, que inicializa o Firebase (auth, db), mantém o perfil
// do usuário logado (initAuth, getCurrentUser, canManageAccess) e diz quais
// módulos do portal estão ativos.
//
// Como funciona: o EcoBazar é uma van que fica cerca de uma semana em cada bairro
// (uma "parada"). Na parada, o munícipe é cadastrado (nome, telefone, bairro), traz
// recicláveis (câmbio) e recebe EcoCash; com o EcoCash leva produtos da loja da van.
// Quando a parada é encerrada, o EcoCash que sobrou expira e os cadastros daquela
// parada somem da tela — mas continuam no banco e na planilha.
//
// Banco de dados:
//   ecobazar_paradas/{id}     { bairro, local, inicio, fimPrevisto (AAAA-MM-DD), ativa,
//                               encerradaEm, encerradaPor, usuarioId, usuarioNome, criadoEm }
//   ecobazar_municipes/{id}   { nome, telefone, bairro, paradaId, usuarioId, usuarioNome, criadoEm }
//   ecobazar_materiais/{id}   { nome, unidade, qtdBase, valor, criadoEm }
//                             regra: a cada "qtdBase" unidades, "valor" EcoCash
//   ecobazar_operacoes/{id}   { tipo: CAMBIO | LOJA | ESTOQUE, data, paradaId,
//                               municipeId, municipeNome (câmbio e loja), origem (entrada),
//                               obs, itens: [{ id, nome, unidade, qtd, eco }], total,
//                               usuarioId, usuarioNome, criadoEm }
//   O saldo de EcoCash do munícipe = câmbios − trocas na loja dele (só vale na parada).
//   Os produtos são itens do estoque único do portal (estoque_itens com 'Bazar' em
//   "areas" e o preço em "valorEco"); troca na loja e entrada de produto também gravam
//   em estoque_movimentacoes (area 'Bazar', lote = id da operação).
//
// Só Administrador/Gestor abre e encerra paradas, cadastra materiais e produtos e
// exclui lançamentos e munícipes; os demais níveis atendem (munícipes, câmbio, loja,
// entrada de produto).

const AREA = 'Bazar';
const AREA_LEGADA = 'Fundo Social';
const PARADAS_COLLECTION = 'ecobazar_paradas';
const MUNICIPES_COLLECTION = 'ecobazar_municipes';
const MATERIAIS_COLLECTION = 'ecobazar_materiais';
const OPERACOES_COLLECTION = 'ecobazar_operacoes';
const ITENS_COLLECTION = 'estoque_itens';
const MOV_COLLECTION = 'estoque_movimentacoes';
const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js';
const POR_PAGINA = 50;
const DIAS_PARADA = 7;

// Regras que o protótipo já usava
const MATERIAIS_PADRAO = [
    { nome: 'Tampinhas plásticas', unidade: 'kg', qtdBase: 1, valor: 1 },
    { nome: 'Caixas Tetra Pak', unidade: 'un', qtdBase: 20, valor: 1 }
];

const TIPOS = {
    CAMBIO: { label: 'Câmbio', badge: 'badge-success', icone: 'ph-recycle' },
    LOJA: { label: 'Loja', badge: 'badge-coin', icone: 'ph-shopping-bag' },
    ESTOQUE: { label: 'Entrada de produto', badge: 'badge-info', icone: 'ph-arrow-circle-down' }
};

let paradas = [];
let municipes = [];
let materiais = [];
let itens = [];
let movimentacoes = [];
let operacoes = [];
let contas = new Map();          // munícipe -> { recebido, trocado, saldo, doado, produtos }
let iniciado = false;
let filtros = filtrosVazios();
let filtroParadaDefinido = false;
let limiteLista = POR_PAGINA;
const municipeSel = { cam: '', loj: '' };
let cadastroDestino = '';        // 'cam' ou 'loj': seleciona o munícipe recém-cadastrado

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

function soDigitos(texto) {
    return String(texto || '').replace(/\D/g, '');
}

function formatarTelefone(valor) {
    const d = soDigitos(valor).slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function isoDe(d) {
    const c = new Date(d);
    c.setMinutes(c.getMinutes() - c.getTimezoneOffset());
    return c.toISOString().slice(0, 10);
}

function hojeISO() {
    return isoDe(new Date());
}

function somarDias(iso, dias) {
    const [a, m, d] = iso.split('-').map(Number);
    return isoDe(new Date(a, m - 1, d + dias));
}

function formatarData(iso) {
    if (!iso) return '-';
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
}

function formatarDataCurta(iso) {
    return iso ? formatarData(iso).slice(0, 5) : '-';
}

function formatarQtd(n) {
    return Number(n || 0).toLocaleString('pt-BR');
}

function plural(n, singular, pluralTexto) {
    return `${formatarQtd(n)} ${n === 1 ? singular : pluralTexto}`;
}

function eco(n, sinal = '') {
    return `<span class="eco ${sinal === '−' ? 'neg' : ''}"><i class="ph-fill ph-coins"></i>${sinal}${formatarQtd(n)}</span>`;
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

function getMaterial(id) { return materiais.find(m => m.id === id); }
function getItem(id) { return itens.find(i => i.id === id); }
function getParada(id) { return paradas.find(p => p.id === id); }
function getMunicipe(id) { return municipes.find(m => m.id === id); }

// Produtos da loja = itens do estoque único marcados para o Bazar
function produtosDaLoja(incluirInativos = false) {
    return itens.filter(i => areasDoItem(i).includes(AREA) && (incluirInativos || i.ativo !== false));
}

// ---------- Paradas e munícipes ----------
function paradaAtiva() {
    return paradas.find(p => p.ativa) || null;
}

// A parada que as telas resumem: a atual ou, sem van parada, a última
function paradaFoco() {
    return paradaAtiva() || paradas[0] || null;
}

function nomeParada(id) {
    const p = getParada(id);
    return p ? `${p.bairro} (${formatarDataCurta(p.inicio)})` : '';
}

function municipesDaParada(paradaId) {
    return municipes.filter(m => m.paradaId === paradaId);
}

function municipesAtivos() {
    const ativa = paradaAtiva();
    return ativa ? municipesDaParada(ativa.id) : [];
}

// Munícipe escolhido no câmbio/loja ainda vale (existe e é da parada atual)?
function municipeValido(prefixo) {
    const m = getMunicipe(municipeSel[prefixo]);
    const ativa = paradaAtiva();
    return m && ativa && m.paradaId === ativa.id ? m : null;
}

function opsDaParada(paradaId) {
    return operacoes.filter(o => o.paradaId === paradaId);
}

function contaDe(id) {
    return contas.get(id) || { recebido: 0, trocado: 0, saldo: 0, doado: new Map(), produtos: 0 };
}

function calcularContas() {
    const mapa = new Map();
    operacoes.forEach(o => {
        if (!o.municipeId || (o.tipo !== 'CAMBIO' && o.tipo !== 'LOJA')) return;
        const c = mapa.get(o.municipeId) || { recebido: 0, trocado: 0, saldo: 0, doado: new Map(), produtos: 0 };
        if (o.tipo === 'CAMBIO') {
            c.recebido += Number(o.total || 0);
            (o.itens || []).forEach(i => {
                const d = c.doado.get(i.id) || { nome: i.nome, unidade: i.unidade, qtd: 0 };
                d.qtd += Number(i.qtd || 0);
                c.doado.set(i.id, d);
            });
        } else {
            c.trocado += Number(o.total || 0);
            c.produtos += (o.itens || []).reduce((t, i) => t + Number(i.qtd || 0), 0);
        }
        c.saldo = c.recebido - c.trocado;
        mapa.set(o.municipeId, c);
    });
    return mapa;
}

function textoDoado(conta) {
    return [...conta.doado.values()].map(d => `${formatarQtd(d.qtd)} ${d.unidade} ${d.nome}`).join(', ');
}

// ---------- Estoque ----------
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

// EcoCash de um material: só conta blocos completos (ex.: 45 caixas a cada 20 = 2 EcoCash)
function ecoDoMaterial(material, qtd) {
    const base = Math.max(1, Number(material.qtdBase || 1));
    return Math.floor(qtd / base) * Number(material.valor || 0);
}

function textoRegra(m) {
    return `A cada ${formatarQtd(m.qtdBase)} ${m.unidade} = ${plural(Number(m.valor), 'EcoCash', 'EcoCash')}`;
}

function textoItensOp(op) {
    return (op.itens || []).map(i => `${formatarQtd(i.qtd)} ${i.unidade} ${i.nome}`).join(', ');
}

function mensagemErro(err) {
    if (err && err.code === 'permission-denied') {
        return 'Sem permissão para salvar no EcoBazar. Fale com um administrador.';
    }
    return 'Não foi possível salvar. Verifique sua conexão e tente novamente.';
}

function vazio(colspan, icone, texto) {
    return `<tr><td colspan="${colspan}" class="vazio"><i class="ph ${icone}"></i>${texto}</td></tr>`;
}

function vazioFeed(icone, texto) {
    return `<li class="vazio" style="display:block"><i class="ph ${icone}"></i>${texto}</li>`;
}

function vazioGrid(icone, texto) {
    return `<div class="vazio" style="grid-column: 1 / -1;"><i class="ph ${icone}"></i>${texto}</div>`;
}

function textoSemCadastro(oque, aba) {
    return ehGestor()
        ? `Nenhum ${oque} cadastrado. Cadastre na aba <a href="#" onclick="switchTab('${aba}'); return false;">${aba === 'materiais' ? 'Materiais de troca' : 'Produtos da loja'}</a>.`
        : `Nenhum ${oque} cadastrado ainda. Peça a um gestor para cadastrar.`;
}

// ----------------------------------------------------
// TOAST E MODAIS
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
        alert('Você não tem acesso ao EcoBazar.');
        window.location.href = '../index.html';
        return;
    }
    if (typeof isModuleActive === 'function' && !isModuleActive(AREA) && !isOwner(user)) {
        alert('O módulo EcoBazar está desativado no momento.');
        window.location.href = '../index.html';
        return;
    }
    if (iniciado) return;
    iniciado = true;

    document.getElementById('user-name').textContent = user.name || user.email;
    document.getElementById('user-role').textContent = user.role || '';
    document.getElementById('user-avatar').textContent = iniciais(user.name || user.email);
    document.body.classList.toggle('is-gestor', canManageAccess(user));

    ['cam-data', 'loj-data', 'ent-data'].forEach(id => document.getElementById(id).value = hojeISO());
    cancelarEdicaoParada();
    ['cam', 'loj'].forEach(montarPicker);
    ['cam', 'loj', 'ent'].forEach(adicionarLinha);
    ouvirDados();
});

function ouvirDados() {
    const carregado = { paradas: false, municipes: false, materiais: false, itens: false, movs: false, ops: false };
    const marcar = (chave) => {
        carregado[chave] = true;
        if (Object.values(carregado).every(Boolean)) document.body.classList.add('dados-prontos');
    };
    const porNome = (a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR');
    const comData = (d) => {
        const o = { id: d.id, ...d.data({ serverTimestamps: 'estimate' }) };
        o.criadoMs = o.criadoEm ? o.criadoEm.toMillis() : 0;
        return o;
    };
    const ouvir = (colecao, chave, aplicar) => db.collection(colecao).onSnapshot((snap) => {
        aplicar(snap.docs);
        marcar(chave);
        renderTudo();
    }, erroFirestore);

    ouvir(PARADAS_COLLECTION, 'paradas', docs => {
        paradas = docs.map(comData).sort((a, b) => (b.inicio || '').localeCompare(a.inicio || '') || b.criadoMs - a.criadoMs);
    });
    ouvir(MUNICIPES_COLLECTION, 'municipes', docs => { municipes = docs.map(comData).sort(porNome); });
    ouvir(MATERIAIS_COLLECTION, 'materiais', docs => { materiais = docs.map(d => ({ id: d.id, ...d.data() })).sort(porNome); });
    ouvir(ITENS_COLLECTION, 'itens', docs => { itens = docs.map(d => ({ id: d.id, ...d.data() })).sort(porNome); });
    ouvir(MOV_COLLECTION, 'movs', docs => { movimentacoes = docs.map(d => ({ id: d.id, ...d.data() })); });
    ouvir(OPERACOES_COLLECTION, 'ops', docs => {
        operacoes = docs.map(comData).sort((a, b) => (b.data || '').localeCompare(a.data || '') || b.criadoMs - a.criadoMs);
    });
}

function erroFirestore(err) {
    console.error('Erro ao acessar o EcoBazar:', err);
    const aviso = document.getElementById('aviso-erro');
    aviso.querySelector('span').textContent = err.code === 'permission-denied'
        ? 'Sem permissão para acessar o EcoBazar no Firebase. As regras do Firestore precisam liberar as coleções do EcoBazar.'
        : 'Não foi possível carregar o EcoBazar. Verifique sua conexão e recarregue a página.';
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
const ABAS_GESTOR = ['paradas', 'materiais', 'produtos'];

function switchTab(tabId) {
    if (ABAS_GESTOR.includes(tabId) && !ehGestor()) tabId = 'dashboard';
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`view-${tabId}`).classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');
    window.scrollTo({ top: 0 });
}

function renderTudo() {
    contas = calcularContas();
    if (!filtroParadaDefinido && paradas.length) {
        // O histórico abre na parada atual
        filtros.paradaId = paradaAtiva() ? paradaAtiva().id : '';
        filtroParadaDefinido = true;
    }
    renderParadaAtual();
    renderDashboard();
    renderOpcoesFiltro();
    renderHistorico();
    renderMunicipes();
    ['cam', 'loj'].forEach(renderPicker);
    ['cam', 'loj', 'ent'].forEach(renderLinhas);
    renderTabelaPrecos();
    renderFeedTipo('CAMBIO', 'feed-cambio');
    renderFeedTipo('LOJA', 'feed-loja');
    renderEstoque();
    renderParadas();
    renderMateriais();
    renderProdutos();
    renderSugestoes();
}

// ----------------------------------------------------
// PARADA ATUAL (barra lateral, avisos e cartão da visão geral)
// ----------------------------------------------------
function renderParadaAtual() {
    const ativa = paradaAtiva();
    const ultima = paradas[0];
    document.body.classList.toggle('sem-parada-ativa', !ativa);

    const pill = document.getElementById('van-pill');
    pill.className = `van-pill ${ativa ? '' : 'parada-off'}`;
    pill.innerHTML = ativa
        ? `<i class="ph-fill ph-map-pin"></i><div><strong>${esc(ativa.bairro)}</strong>até ${formatarData(ativa.fimPrevisto)}</div>`
        : '<i class="ph-fill ph-van"></i><div><strong>Van sem parada</strong>nenhum bairro ativo</div>';

    const atrasada = ativa && ativa.fimPrevisto && hojeISO() > ativa.fimPrevisto;
    const card = document.getElementById('dash-parada');
    card.className = `parada-card ${ativa ? '' : 'off'}`;
    card.innerHTML = ativa
        ? `<div class="parada-icon"><i class="ph-fill ph-map-pin"></i></div>
           <div class="parada-info">
               <span>Van em</span>
               <strong>${esc(ativa.bairro)}</strong>
               <small>${ativa.local ? esc(ativa.local) + ' · ' : ''}desde ${formatarData(ativa.inicio)} · saída prevista ${formatarData(ativa.fimPrevisto)}</small>
               ${atrasada ? '<div class="atrasada"><i class="ph ph-clock-countdown"></i> Passou da saída prevista: encerre a parada ao sair do bairro</div>' : ''}
           </div>
           <button class="btn btn-secondary so-gestor" onclick="encerrarParada('${esc(ativa.id)}')"><i class="ph ph-flag-checkered"></i> Encerrar parada</button>`
        : `<div class="parada-icon"><i class="ph ph-van"></i></div>
           <div class="parada-info">
               <span>Van sem parada ativa</span>
               <strong>${ultima ? `Última: ${esc(ultima.bairro)}` : 'Nenhuma parada ainda'}</strong>
               <small>${ultima ? `encerrada em ${formatarData(ultima.encerradaEm)} · ` : ''}câmbio e loja ficam fechados até a próxima parada</small>
           </div>
           <button class="btn btn-secondary so-gestor" onclick="switchTab('paradas')"><i class="ph ph-map-pin-plus"></i> Iniciar parada</button>`;

    const aviso = vazioGrid('ph-van', ehGestor()
        ? 'A van não está em nenhum bairro. Inicie uma parada em <a href="#" onclick="switchTab(\'paradas\'); return false;">Paradas da van</a> para cadastrar munícipes e fazer câmbio e trocas.'
        : 'A van não está em nenhum bairro agora. Peça a um gestor para iniciar a parada.');
    ['mun-sem-parada', 'cam-sem-parada', 'loj-sem-parada'].forEach(id => document.getElementById(id).innerHTML = aviso);
}

// ----------------------------------------------------
// VISÃO GERAL
// ----------------------------------------------------
function renderDashboard() {
    const foco = paradaFoco();
    const ativa = paradaAtiva();
    const ops = foco ? opsDaParada(foco.id) : [];
    const cambios = ops.filter(o => o.tipo === 'CAMBIO');
    const trocas = ops.filter(o => o.tipo === 'LOJA');
    const soma = (lista) => lista.reduce((t, o) => t + Number(o.total || 0), 0);
    const pessoas = foco ? municipesDaParada(foco.id) : [];
    const comCambio = new Set(cambios.map(o => o.municipeId));

    document.getElementById('dash-subtitulo').textContent = ativa
        ? `Resumo da parada atual: ${ativa.bairro}.`
        : foco ? `Resumo da última parada: ${foco.bairro} (encerrada).` : 'Nenhuma parada registrada ainda.';
    document.getElementById('kpi-gerado').textContent = formatarQtd(soma(cambios));
    document.getElementById('kpi-gerado-hint').textContent = `em ${plural(cambios.length, 'câmbio', 'câmbios')}`;
    document.getElementById('kpi-gasto').textContent = formatarQtd(soma(trocas));
    document.getElementById('kpi-gasto-hint').textContent = `em ${plural(trocas.length, 'troca', 'trocas')}`;
    document.getElementById('kpi-circulando-label').textContent = ativa || !foco ? 'Em circulação' : 'Expirou na saída';
    document.getElementById('kpi-circulando').textContent = formatarQtd(soma(cambios) - soma(trocas));
    document.getElementById('kpi-circulando-hint').textContent = ativa || !foco ? 'saldo dos munícipes; expira na saída' : 'EcoCash que não foi trocado';
    document.getElementById('kpi-municipes').textContent = formatarQtd(pessoas.length);
    document.getElementById('kpi-municipes-hint').textContent = `${formatarQtd(pessoas.filter(m => comCambio.has(m.id)).length)} já trouxeram recicláveis`;

    // Recicláveis da parada, por material (inclui materiais já excluídos que tiveram câmbio)
    const totais = new Map(materiais.map(m => [m.id, { nome: m.nome, unidade: m.unidade, qtd: 0, eco: 0 }]));
    cambios.forEach(o => (o.itens || []).forEach(i => {
        const t = totais.get(i.id) || { nome: i.nome, unidade: i.unidade, qtd: 0, eco: 0 };
        t.qtd += Number(i.qtd || 0);
        t.eco += Number(i.eco || 0);
        totais.set(i.id, t);
    }));
    const linhas = [...totais.values()].sort((a, b) => b.eco - a.eco || a.nome.localeCompare(b.nome, 'pt-BR'));
    document.getElementById('dash-materiais').innerHTML = linhas.length
        ? linhas.map(t => `
            <div class="material-row">
                <div class="material-icon"><i class="ph ph-recycle"></i></div>
                <div><strong>${esc(t.nome)}</strong><small>${eco(t.eco)} entregues</small></div>
                <div class="material-qty">${formatarQtd(t.qtd)}<small>${esc(t.unidade)}</small></div>
            </div>`).join('')
        : `<div class="vazio"><i class="ph ph-recycle"></i>${textoSemCadastro('material', 'materiais')}</div>`;

    const recentes = ops.slice(0, 8);
    document.getElementById('feed-recentes').innerHTML = recentes.length
        ? recentes.map(itemFeed).join('')
        : vazioFeed('ph-tray', 'Nenhum atendimento nesta parada ainda.');

    const saldos = calcularSaldos();
    const produtos = produtosDaLoja();
    document.getElementById('dash-produtos').innerHTML = produtos.length
        ? produtos.map(p => cardProduto(p, saldos[p.id] || 0)).join('')
        : vazioGrid('ph-storefront', textoSemCadastro('produto', 'produtos'));
}

function cardProduto(item, saldo) {
    const sit = situacaoItem(item, saldo);
    const min = Number(item.estoqueMinimo || 0);
    // A barra enche até o dobro do mínimo (cheia = folga confortável)
    const pct = min > 0 ? Math.max(0, Math.min(100, saldo / (min * 2) * 100)) : (saldo > 0 ? 100 : 0);
    const preco = Number(item.valorEco || 0);
    return `
        <div class="stock-card ${sit.classe}">
            <div class="stock-top">
                ${preco > 0 ? `<span class="chip coin"><i class="ph-fill ph-coins"></i> ${formatarQtd(preco)} EcoCash</span>` : '<span class="chip muted">Sem preço</span>'}
                ${sit.nivel === 'ok' ? '' : sit.badge}
            </div>
            <h3>${esc(item.nome)}</h3>
            <div class="stock-value"><strong>${formatarQtd(saldo)}</strong><span>${esc(item.unidade)}</span></div>
            <div class="meter"><span style="width: ${pct.toFixed(0)}%"></span></div>
            <div class="stock-foot">
                <span>${min > 0 ? `Mínimo: ${formatarQtd(min)}` : 'Sem mínimo definido'}</span>
                <button class="link-btn" onclick="verHistorico({ itemId: '${esc(item.id)}', paradaId: '' })">Histórico <i class="ph ph-caret-right"></i></button>
            </div>
        </div>`;
}

function valorOp(op) {
    if (op.tipo === 'CAMBIO') return eco(op.total, '+');
    if (op.tipo === 'LOJA') return eco(op.total, '−');
    return `<span class="feed-qty qty-pos">${plural((op.itens || []).length, 'produto', 'produtos')}</span>`;
}

function itemFeed(op) {
    const tipo = TIPOS[op.tipo] || TIPOS.ESTOQUE;
    const detalhe = [tipo.label, op.municipeNome || op.origem, formatarData(op.data), op.usuarioNome].filter(Boolean).map(esc).join(' · ');
    const titulo = esc(textoItensOp(op));
    return `
        <li>
            <div class="feed-icon ${esc(op.tipo)}"><i class="ph ${tipo.icone}"></i></div>
            <div class="feed-body">
                <div class="feed-title truncate" title="${titulo}">${titulo}</div>
                <div class="feed-sub" title="${detalhe}">${detalhe}</div>
            </div>
            <div class="feed-qty">${valorOp(op)}</div>
        </li>`;
}

function renderFeedTipo(tipo, feedId) {
    const ativa = paradaAtiva();
    const lista = ativa ? opsDaParada(ativa.id).filter(o => o.tipo === tipo).slice(0, 8) : [];
    document.getElementById(feedId).innerHTML = lista.length
        ? lista.map(itemFeed).join('')
        : vazioFeed('ph-tray', 'Nada lançado nesta parada ainda.');
}

// ----------------------------------------------------
// HISTÓRICO (FILTROS, LISTA)
// ----------------------------------------------------
function filtrosVazios() {
    return { periodo: 'tudo', de: '', ate: '', tipo: '', paradaId: '', itemId: '', usuario: '', busca: '', municipeId: '' };
}

const CAMPOS_FILTRO = { paradaId: 'f-parada', itemId: 'f-item', usuario: 'f-usuario', busca: 'f-busca', de: 'f-de', ate: 'f-ate' };

function renderOpcoesFiltro() {
    const preencher = (id, opcoes, rotuloTodos) => {
        document.getElementById(id).innerHTML = `<option value="">${rotuloTodos}</option>` +
            opcoes.map(([valor, texto]) => `<option value="${esc(valor)}">${esc(texto)}</option>`).join('');
    };
    preencher('f-parada', paradas.map(p => [p.id, `${p.bairro} · ${formatarData(p.inicio)}${p.ativa ? ' (atual)' : ''}`]), 'Todas as paradas');
    // Materiais e produtos atuais, mais os que só existem no histórico (excluídos)
    const nomes = new Map();
    materiais.forEach(m => nomes.set(m.id, `${m.nome} (material)`));
    produtosDaLoja(true).forEach(p => nomes.set(p.id, `${p.nome} (produto)`));
    operacoes.forEach(o => (o.itens || []).forEach(i => {
        if (!nomes.has(i.id)) nomes.set(i.id, `${i.nome} (${o.tipo === 'CAMBIO' ? 'material' : 'produto'}, excluído)`);
    }));
    preencher('f-item', [...nomes].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR')), 'Todos');
    const usuarios = new Map(operacoes.map(o => [o.usuarioId, o.usuarioNome]));
    preencher('f-usuario', [...usuarios].filter(([id]) => id).sort((a, b) => (a[1] || '').localeCompare(b[1] || '', 'pt-BR')), 'Todos');
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
    renderHistorico();
}

function intervaloDoPeriodo(periodo) {
    const hoje = new Date();
    const y = hoje.getFullYear(), m = hoje.getMonth();
    return {
        hoje: [hojeISO(), hojeISO()],
        '7dias': [isoDe(new Date(y, m, hoje.getDate() - 6)), hojeISO()],
        mes: [isoDe(new Date(y, m, 1)), hojeISO()],
        mesPassado: [isoDe(new Date(y, m - 1, 1)), isoDe(new Date(y, m, 0))],
        ano: [isoDe(new Date(y, 0, 1)), hojeISO()],
        tudo: ['', '']
    }[periodo] || ['', ''];
}

function definirPeriodo(periodo) {
    [filtros.de, filtros.ate] = intervaloDoPeriodo(periodo);
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
    renderHistorico();
}

// Abre o Histórico já filtrado. Sem "paradaId", fica na parada atual.
function verHistorico(parcial) {
    const ativa = paradaAtiva();
    filtros = { ...filtrosVazios(), paradaId: ativa ? ativa.id : '', ...parcial };
    if (parcial.periodo) [filtros.de, filtros.ate] = intervaloDoPeriodo(parcial.periodo);
    limiteLista = POR_PAGINA;
    sincronizarCamposFiltro();
    renderHistorico();
    switchTab('historico');
}

function contarFiltrosAtivos() {
    let n = 0;
    if (filtros.de || filtros.ate) n++;
    ['tipo', 'paradaId', 'itemId', 'usuario', 'busca', 'municipeId'].forEach(k => { if (filtros[k]) n++; });
    return n;
}

function opsFiltradas() {
    const f = filtros;
    const busca = normalizar(f.busca);
    return operacoes.filter(o => {
        if (f.de && (o.data || '') < f.de) return false;
        if (f.ate && (o.data || '') > f.ate) return false;
        if (f.tipo && o.tipo !== f.tipo) return false;
        if (f.paradaId && o.paradaId !== f.paradaId) return false;
        if (f.municipeId && o.municipeId !== f.municipeId) return false;
        if (f.itemId && !(o.itens || []).some(i => i.id === f.itemId)) return false;
        if (f.usuario && o.usuarioId !== f.usuario) return false;
        if (busca && ![o.municipeNome, o.origem, o.obs, o.usuarioNome, textoItensOp(o)].some(v => normalizar(v).includes(busca))) return false;
        return true;
    });
}

function renderHistorico() {
    const lista = opsFiltradas();
    const ativos = contarFiltrosAtivos();
    const contagem = document.getElementById('filtro-contagem');
    contagem.textContent = ativos;
    contagem.style.display = ativos ? '' : 'none';

    const doTipo = (t) => lista.filter(o => o.tipo === t);
    const soma = (l) => l.reduce((t, o) => t + Number(o.total || 0), 0);
    const mun = getMunicipe(filtros.municipeId);
    document.getElementById('hist-resumo').innerHTML = `
        ${filtros.municipeId ? `<span class="summary-pill"><i class="ph ph-user"></i> <strong>${esc(mun ? mun.nome : 'Munícipe')}</strong></span>` : ''}
        <span class="summary-pill"><i class="ph ph-list-numbers"></i> <strong>${formatarQtd(lista.length)}</strong> lançamentos</span>
        <span class="summary-pill"><i class="ph ph-recycle" style="color: var(--success)"></i> <strong>${formatarQtd(doTipo('CAMBIO').length)}</strong> câmbios · ${eco(soma(doTipo('CAMBIO')))} entregues</span>
        <span class="summary-pill"><i class="ph ph-shopping-bag" style="color: var(--coin)"></i> <strong>${formatarQtd(doTipo('LOJA').length)}</strong> trocas · ${eco(soma(doTipo('LOJA')))} trocados</span>
        <span class="summary-pill"><i class="ph ph-arrow-circle-down" style="color: var(--info)"></i> <strong>${formatarQtd(doTipo('ESTOQUE').length)}</strong> entradas de produto</span>
        ${filtros.de || filtros.ate ? `<span class="summary-pill"><i class="ph ph-calendar-blank"></i> ${filtros.de ? formatarData(filtros.de) : 'início'} a ${filtros.ate ? formatarData(filtros.ate) : 'hoje'}</span>` : ''}`;

    document.getElementById('table-historico').innerHTML = lista.length
        ? lista.slice(0, limiteLista).map(linhaHistorico).join('')
        : vazio(8, 'ph-funnel-x', operacoes.length ? 'Nenhum lançamento com esses filtros.' : 'Nenhum lançamento registrado.');

    const restantes = lista.length - limiteLista;
    document.getElementById('hist-mais').innerHTML = restantes > 0
        ? `<button class="btn btn-secondary btn-sm" onclick="mostrarMais()">Mostrar mais (${formatarQtd(restantes)} restantes)</button>`
        : '';
}

function linhaHistorico(op) {
    const tipo = TIPOS[op.tipo] || TIPOS.ESTOQUE;
    return `
        <tr>
            <td class="nowrap num">${formatarData(op.data)}</td>
            <td><span class="badge ${tipo.badge}"><i class="ph ${tipo.icone}"></i> ${tipo.label}</span></td>
            <td><span class="itens-op">${esc(textoItensOp(op))}</span></td>
            <td class="right nowrap">${op.tipo === 'ESTOQUE' ? '-' : valorOp(op)}</td>
            <td>${esc(op.municipeNome || op.origem || '-')}${op.obs ? `<span class="cell-sub">${esc(op.obs)}</span>` : ''}</td>
            <td><small>${esc(nomeParada(op.paradaId) || '-')}</small></td>
            <td><small>${esc(op.usuarioNome || '')}</small></td>
            <td class="so-gestor right">
                <button class="icon-btn danger" title="Excluir lançamento" onclick="excluirOperacao('${esc(op.id)}')"><i class="ph ph-trash"></i></button>
            </td>
        </tr>`;
}

function mostrarMais() {
    limiteLista += POR_PAGINA;
    renderHistorico();
}

// Só Administrador/Gestor exclui; leva junto as baixas/entradas de estoque do lançamento
async function excluirOperacao(id) {
    const op = operacoes.find(o => o.id === id);
    if (!op || !ehGestor()) return;
    const tipo = (TIPOS[op.tipo] || TIPOS.ESTOQUE).label;
    const ligadas = movimentacoes.filter(m => m.lote === id);
    const confirmou = await confirmar({
        titulo: 'Excluir lançamento?',
        html: `<p>${tipo} de ${formatarData(op.data)}${op.municipeNome ? ` (${esc(op.municipeNome)})` : ''}: <strong>${esc(textoItensOp(op))}</strong>.</p>
               ${op.municipeId ? '<p style="margin-top:.5rem">O saldo de EcoCash do munícipe será recalculado.</p>' : ''}
               ${ligadas.length ? '<p style="margin-top:.5rem">O estoque dos produtos será recalculado.</p>' : ''}`,
        botao: 'Excluir',
        perigo: true,
        icone: 'ph-trash'
    });
    if (!confirmou) return;
    try {
        const batch = db.batch();
        batch.delete(db.collection(OPERACOES_COLLECTION).doc(id));
        ligadas.forEach(m => batch.delete(db.collection(MOV_COLLECTION).doc(m.id)));
        await batch.commit();
        toast('Lançamento excluído.');
    } catch (err) {
        console.error('Erro ao excluir lançamento:', err);
        toast(mensagemErro(err), 'erro');
    }
}

// ----------------------------------------------------
// MUNÍCIPES (só os da parada atual aparecem)
// ----------------------------------------------------
function renderMunicipes() {
    const ativa = paradaAtiva();
    document.getElementById('mun-subtitulo').textContent = ativa
        ? `Cadastrados na parada de ${ativa.bairro}. O cadastro e o EcoCash valem até a van sair do bairro.`
        : 'Cadastro de quem troca recicláveis na parada atual.';
    const pessoas = municipesAtivos();
    const termo = normalizar(document.getElementById('mun-busca').value);
    const digitos = soDigitos(termo);
    const visiveis = pessoas.filter(m => !termo
        || normalizar(m.nome).includes(termo)
        || (digitos.length >= 3 && soDigitos(m.telefone).includes(digitos)));
    const circulando = pessoas.reduce((t, m) => t + contaDe(m.id).saldo, 0);

    document.getElementById('mun-resumo').innerHTML = `
        <span class="summary-pill"><i class="ph ph-users"></i> <strong>${formatarQtd(pessoas.length)}</strong> munícipes</span>
        <span class="summary-pill"><i class="ph ph-coins" style="color: var(--coin)"></i> ${eco(circulando)} em circulação</span>
        ${termo ? `<span class="summary-pill"><i class="ph ph-magnifying-glass"></i> <strong>${formatarQtd(visiveis.length)}</strong> encontrados</span>` : ''}`;

    document.getElementById('table-municipes').innerHTML = !pessoas.length
        ? vazio(7, 'ph-users', 'Ninguém cadastrado nesta parada ainda.')
        : !visiveis.length
            ? vazio(7, 'ph-magnifying-glass', `Ninguém encontrado. <a href="#" onclick="abrirCadastroMunicipe({ nome: document.getElementById('mun-busca').value }); return false;">Cadastrar agora</a>`)
            : visiveis.map(m => {
                const c = contaDe(m.id);
                const doado = textoDoado(c);
                return `
                    <tr>
                        <td class="nowrap">
                            <div style="display:flex; gap:.6rem; align-items:center">
                                <div class="mini-avatar">${esc(iniciais(m.nome))}</div>
                                <div><strong>${esc(m.nome)}</strong><span class="cell-sub">${esc(m.telefone || '-')}</span></div>
                            </div>
                        </td>
                        <td>${esc(m.bairro || '-')}</td>
                        <td>${doado ? `<small>${esc(doado)}</small>` : '<small>-</small>'}</td>
                        <td class="right">${eco(c.recebido)}</td>
                        <td class="right">${eco(c.trocado)}</td>
                        <td class="right saldo-forte">${eco(c.saldo)}</td>
                        <td class="right nowrap">
                            <span class="acoes-mun">
                                <button class="icon-btn" title="Câmbio" onclick="atenderMunicipe('cam', '${esc(m.id)}')"><i class="ph ph-recycle"></i></button>
                                <button class="icon-btn" title="Troca na loja" onclick="atenderMunicipe('loj', '${esc(m.id)}')"><i class="ph ph-shopping-bag"></i></button>
                                <button class="icon-btn" title="Extrato" onclick="verHistorico({ municipeId: '${esc(m.id)}' })"><i class="ph ph-list-magnifying-glass"></i></button>
                                <button class="icon-btn" title="Editar" onclick="abrirCadastroMunicipe({ id: '${esc(m.id)}' })"><i class="ph ph-pencil-simple"></i></button>
                                <button class="icon-btn danger so-gestor" title="Excluir" onclick="excluirMunicipe('${esc(m.id)}')"><i class="ph ph-trash"></i></button>
                            </span>
                        </td>
                    </tr>`;
            }).join('');
}

function atenderMunicipe(prefixo, id) {
    municipeSel[prefixo] = id;
    renderPicker(prefixo);
    renderLinhas(prefixo);
    switchTab(prefixo === 'cam' ? 'cambio' : 'loja');
}

// Cadastro (e edição) pelo modal; "opcoes.destino" = câmbio/loja que pediu o cadastro
function abrirCadastroMunicipe(opcoes = {}) {
    const ativa = paradaAtiva();
    const m = opcoes.id ? getMunicipe(opcoes.id) : null;
    if (!ativa && !m) {
        toast('Não há parada ativa. Um gestor precisa iniciar a parada da van.', 'erro');
        return;
    }
    cadastroDestino = opcoes.destino || '';
    document.getElementById('municipe-id').value = m ? m.id : '';
    document.getElementById('municipe-nome').value = m ? m.nome : (opcoes.nome || '').trim();
    document.getElementById('municipe-telefone').value = m ? m.telefone : '';
    document.getElementById('municipe-bairro').value = m ? m.bairro : ativa.bairro;
    document.getElementById('municipe-titulo').textContent = m ? 'Editar munícipe' : 'Cadastrar munícipe';
    document.getElementById('municipe-sub').textContent = m
        ? `Cadastro da parada de ${getParada(m.paradaId)?.bairro || '-'}.`
        : `Vale enquanto a van estiver em ${ativa.bairro}. Depois o cadastro sai da tela, mas fica guardado.`;
    const overlay = document.getElementById('modal-municipe');
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    const nome = document.getElementById('municipe-nome');
    setTimeout(() => (nome.value ? document.getElementById('municipe-telefone') : nome).focus(), 50);
}

function fecharCadastroMunicipe() {
    const overlay = document.getElementById('modal-municipe');
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    cadastroDestino = '';
}

document.getElementById('modal-municipe').addEventListener('click', (e) => {
    if (e.target.id === 'modal-municipe') fecharCadastroMunicipe();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('modal-municipe').classList.contains('open')) fecharCadastroMunicipe();
});
document.getElementById('municipe-telefone').addEventListener('input', (e) => {
    e.target.value = formatarTelefone(e.target.value);
});

document.getElementById('form-municipe').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('municipe-id').value;
    const atual = id ? getMunicipe(id) : null;
    const ativa = paradaAtiva();
    const dados = {
        nome: document.getElementById('municipe-nome').value.trim().replace(/\s+/g, ' '),
        telefone: formatarTelefone(document.getElementById('municipe-telefone').value),
        bairro: document.getElementById('municipe-bairro').value.trim()
    };
    if (soDigitos(dados.telefone).length < 10) {
        toast('Informe o telefone com DDD.', 'erro');
        return;
    }
    const paradaId = atual ? atual.paradaId : ativa && ativa.id;
    if (!paradaId) {
        toast('Não há parada ativa.', 'erro');
        return;
    }
    const repetido = municipesDaParada(paradaId).find(m => m.id !== id && soDigitos(m.telefone) === soDigitos(dados.telefone));
    if (repetido) {
        toast(`Esse telefone já está cadastrado para ${repetido.nome} nesta parada.`, 'erro');
        return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
        if (atual) {
            await db.collection(MUNICIPES_COLLECTION).doc(id).update(dados);
            toast('Cadastro atualizado.');
        } else {
            const user = getCurrentUser();
            const ref = db.collection(MUNICIPES_COLLECTION).doc();
            const destino = cadastroDestino;
            await ref.set({
                ...dados,
                paradaId,
                usuarioId: user.id,
                usuarioNome: user.name || user.email,
                criadoEm: firebase.firestore.FieldValue.serverTimestamp()
            });
            if (destino) {
                municipeSel[destino] = ref.id;
                renderPicker(destino);
                renderLinhas(destino);
            }
            document.getElementById('mun-busca').value = '';
            toast(`${dados.nome} cadastrado.`);
        }
        fecharCadastroMunicipe();
    } catch (err) {
        console.error('Erro ao salvar munícipe:', err);
        toast(mensagemErro(err), 'erro');
    } finally {
        btn.disabled = false;
    }
});

async function excluirMunicipe(id) {
    const m = getMunicipe(id);
    if (!m || !ehGestor()) return;
    const c = contaDe(id);
    const confirmou = await confirmar({
        titulo: `Excluir ${m.nome}?`,
        html: `<p>O cadastro é apagado.${c.recebido || c.trocado ? ' Os câmbios e trocas dele continuam no histórico, com o nome.' : ''}</p>
               ${c.saldo > 0 ? `<p style="margin-top:.5rem">Ele ainda tem <strong>${formatarQtd(c.saldo)} EcoCash</strong>, que deixam de existir.</p>` : ''}`,
        botao: 'Excluir',
        perigo: true,
        icone: 'ph-trash'
    });
    if (!confirmou) return;
    try {
        await db.collection(MUNICIPES_COLLECTION).doc(id).delete();
        toast('Cadastro excluído.');
    } catch (err) {
        console.error('Erro ao excluir munícipe:', err);
        toast(mensagemErro(err), 'erro');
    }
}

// ---------- Escolha do munícipe no câmbio e na loja ----------
function montarPicker(prefixo) {
    const caixa = document.getElementById(`${prefixo}-picker`);
    caixa.innerHTML = `
        <div class="picker-busca">
            <div class="search">
                <i class="ph ph-magnifying-glass"></i>
                <input type="search" id="${prefixo}-mun-busca" class="form-control" placeholder="Buscar pelo nome ou telefone..." autocomplete="off">
            </div>
            <div class="picker-list" id="${prefixo}-mun-lista"></div>
        </div>
        <div class="picker-selected" id="${prefixo}-mun-sel" hidden></div>`;
    const busca = document.getElementById(`${prefixo}-mun-busca`);
    busca.addEventListener('input', () => renderPickerLista(prefixo));
    busca.addEventListener('focus', () => renderPickerLista(prefixo));
    busca.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const primeiro = document.querySelector(`#${prefixo}-mun-lista .picker-item`);
            if (primeiro) primeiro.click();
        }
        if (e.key === 'Escape') fecharPickerLista(prefixo);
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest(`#${prefixo}-picker`)) fecharPickerLista(prefixo);
    });
}

function renderPickerLista(prefixo) {
    const busca = document.getElementById(`${prefixo}-mun-busca`);
    const termo = normalizar(busca.value);
    const digitos = soDigitos(termo);
    const achados = municipesAtivos().filter(m => !termo
        || normalizar(m.nome).includes(termo)
        || (digitos.length >= 3 && soDigitos(m.telefone).includes(digitos))).slice(0, 8);
    const lista = document.getElementById(`${prefixo}-mun-lista`);
    lista.innerHTML = (achados.length
        ? achados.map(m => `
            <button type="button" class="picker-item" onclick="selecionarMunicipe('${prefixo}', '${esc(m.id)}')">
                <div class="mini-avatar">${esc(iniciais(m.nome))}</div>
                <div class="pi-body"><strong>${esc(m.nome)}</strong><small>${esc(m.telefone || '')}</small></div>
                ${eco(contaDe(m.id).saldo)}
            </button>`).join('')
        : `<div class="picker-vazio">${termo ? 'Ninguém encontrado com esse nome.' : 'Ninguém cadastrado nesta parada ainda.'}</div>`)
        + `<button type="button" class="picker-item novo" onclick="novoMunicipePeloPicker('${prefixo}')">
               <i class="ph ph-user-plus"></i> ${termo ? `Cadastrar "${esc(busca.value.trim())}"` : 'Cadastrar novo munícipe'}
           </button>`;
    lista.classList.add('open');
}

function fecharPickerLista(prefixo) {
    document.getElementById(`${prefixo}-mun-lista`).classList.remove('open');
}

function novoMunicipePeloPicker(prefixo) {
    fecharPickerLista(prefixo);
    abrirCadastroMunicipe({ nome: document.getElementById(`${prefixo}-mun-busca`).value, destino: prefixo });
}

function selecionarMunicipe(prefixo, id) {
    municipeSel[prefixo] = id;
    document.getElementById(`${prefixo}-mun-busca`).value = '';
    fecharPickerLista(prefixo);
    renderPicker(prefixo);
    renderLinhas(prefixo);
}

function limparMunicipe(prefixo) {
    municipeSel[prefixo] = '';
    renderPicker(prefixo);
    renderLinhas(prefixo);
    document.getElementById(`${prefixo}-mun-busca`).focus();
}

function renderPicker(prefixo) {
    const m = municipeValido(prefixo);
    const busca = document.querySelector(`#${prefixo}-picker .picker-busca`);
    const sel = document.getElementById(`${prefixo}-mun-sel`);
    busca.hidden = !!m;
    sel.hidden = !m;
    if (m) {
        sel.innerHTML = `
            <div class="mini-avatar">${esc(iniciais(m.nome))}</div>
            <div class="pi-body"><strong>${esc(m.nome)}</strong><small>${esc(m.telefone || '')} · saldo ${formatarQtd(contaDe(m.id).saldo)} EcoCash</small></div>
            <button type="button" class="btn btn-ghost btn-sm" onclick="limparMunicipe('${prefixo}')"><i class="ph ph-arrows-left-right"></i> Trocar</button>`;
    } else if (document.getElementById(`${prefixo}-mun-lista`).classList.contains('open')) {
        renderPickerLista(prefixo);
    }
}

// ----------------------------------------------------
// LINHAS DE LANÇAMENTO (câmbio = materiais; loja e entrada = produtos)
// ----------------------------------------------------
const PREFIXOS = {
    cam: { lista: () => materiais, vazio: 'material', placeholder: 'Selecione o material...', comEco: true },
    loj: { lista: () => produtosDaLoja().filter(p => Number(p.valorEco) > 0), vazio: 'produto com preço', placeholder: 'Selecione o produto...', comEco: true },
    ent: { lista: () => produtosDaLoja(), vazio: 'produto', placeholder: 'Selecione o produto...', comEco: false }
};

function getOpcao(prefixo, id) {
    return PREFIXOS[prefixo].lista().find(x => x.id === id);
}

// Opções do select, sem o que já foi escolhido em outra linha
function opcoesLinha(prefixo, selecionado, usados) {
    const cfg = PREFIXOS[prefixo];
    const lista = cfg.lista();
    if (!lista.length) return `<option value="">Nenhum ${cfg.vazio} cadastrado</option>`;
    return `<option value="">${cfg.placeholder}</option>` + lista
        .filter(x => x.id === selecionado || !usados.has(x.id))
        .map(x => {
            const extra = prefixo === 'loj' ? ` — ${formatarQtd(x.valorEco)} EcoCash` : '';
            return `<option value="${esc(x.id)}" ${x.id === selecionado ? 'selected' : ''}>${esc(x.nome)}${extra}</option>`;
        }).join('');
}

function adicionarLinha(prefixo) {
    const box = document.getElementById(`${prefixo}-linhas`);
    const comEco = PREFIXOS[prefixo].comEco;
    const linha = document.createElement('div');
    linha.className = `line ${comEco ? 'eco-line' : ''}`;
    linha.innerHTML = `
        <select class="form-control linha-item" aria-label="Item" onchange="renderLinhas('${prefixo}')"></select>
        <div class="qty">
            <input type="number" class="form-control linha-qtd" aria-label="Quantidade" min="1" step="1" value="1" oninput="renderLinhas('${prefixo}')">
            <span class="linha-unidade"></span>
        </div>
        ${comEco ? '<div class="line-eco"></div>' : ''}
        <button type="button" class="icon-btn danger" title="Remover" onclick="removerLinha(this, '${prefixo}')"><i class="ph ph-x"></i></button>
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
        id: el.querySelector('.linha-item').value,
        qtd: parseInt(el.querySelector('.linha-qtd').value, 10)
    }));
}

function limparLinhas(prefixo) {
    document.getElementById(`${prefixo}-linhas`).innerHTML = '';
    adicionarLinha(prefixo);
}

// Atualiza opções, unidade, EcoCash por linha, saldo e o total do formulário
function renderLinhas(prefixo) {
    const linhas = lerLinhas(prefixo);
    const saldos = calcularSaldos();
    let total = 0;
    let validas = 0;
    let faltaEstoque = false;

    linhas.forEach(l => {
        const select = l.el.querySelector('.linha-item');
        const usados = new Set(linhas.filter(o => o !== l && o.id).map(o => o.id));
        select.innerHTML = opcoesLinha(prefixo, l.id, usados);
        const x = getOpcao(prefixo, select.value);
        l.el.querySelector('.linha-unidade').textContent = x ? x.unidade : '';
        const info = l.el.querySelector('.line-info');
        const celEco = l.el.querySelector('.line-eco');
        info.className = 'line-info';
        info.textContent = '';
        if (celEco) celEco.innerHTML = '';
        if (!x) return;
        const qtd = l.qtd > 0 ? l.qtd : 0;
        if (qtd > 0) validas++;

        if (prefixo === 'cam') {
            const valor = ecoDoMaterial(x, qtd);
            total += valor;
            celEco.innerHTML = eco(valor);
            const base = Number(x.qtdBase || 1);
            const sobra = qtd % base;
            info.textContent = textoRegra(x);
            if (base > 1 && sobra > 0) {
                info.textContent += ` · faltam ${formatarQtd(base - sobra)} ${x.unidade} para mais ${plural(Number(x.valor), 'EcoCash', 'EcoCash')}`;
            }
        } else if (prefixo === 'loj') {
            const valor = qtd * Number(x.valorEco || 0);
            total += valor;
            celEco.innerHTML = eco(valor);
            const saldo = saldos[x.id] || 0;
            info.textContent = `Na van: ${formatarQtd(saldo)} ${x.unidade}`;
            if (qtd > saldo) {
                info.textContent += ' — quantidade maior que o estoque';
                info.classList.add('erro');
                faltaEstoque = true;
            }
        } else {
            info.textContent = `Saldo atual: ${formatarQtd(saldos[x.id] || 0)} ${x.unidade}`;
        }
    });

    const resumo = document.getElementById(`${prefixo}-resumo`);
    if (prefixo === 'ent') {
        resumo.textContent = validas ? `${plural(validas, 'produto', 'produtos')} nesta entrada.` : 'Escolha pelo menos um produto.';
        return;
    }

    const m = municipeValido(prefixo);
    const saldoEco = m ? contaDe(m.id).saldo : 0;
    const semSaldo = prefixo === 'loj' && m && total > saldoEco;
    document.getElementById(`${prefixo}-total`).textContent = formatarQtd(total);
    document.getElementById(`${prefixo}-enviar`).disabled = !m || total <= 0 || faltaEstoque || semSaldo;
    resumo.classList.toggle('erro-texto', !!(semSaldo || faltaEstoque));
    if (!m) {
        resumo.textContent = 'Escolha ou cadastre o munícipe.';
    } else if (!validas) {
        resumo.textContent = prefixo === 'cam' ? 'Escolha o material e a quantidade recebida.' : `Saldo de ${m.nome}: ${plural(saldoEco, 'EcoCash', 'EcoCash')}.`;
    } else if (prefixo === 'cam' && total <= 0) {
        resumo.textContent = 'A quantidade ainda não completa nenhuma troca.';
    } else if (semSaldo) {
        resumo.textContent = `Saldo insuficiente: ${m.nome} tem ${plural(saldoEco, 'EcoCash', 'EcoCash')}.`;
    } else if (faltaEstoque) {
        resumo.textContent = 'Algum produto não tem estoque suficiente na van.';
    } else {
        resumo.textContent = prefixo === 'cam'
            ? `Saldo de ${m.nome} fica em ${plural(saldoEco + total, 'EcoCash', 'EcoCash')}.`
            : `Saldo de ${m.nome} fica em ${plural(saldoEco - total, 'EcoCash', 'EcoCash')}.`;
    }
}

function renderTabelaPrecos() {
    document.getElementById('cam-tabela').innerHTML = materiais.length
        ? materiais.map(m => `<span class="chip coin"><i class="ph-fill ph-coins"></i> ${esc(m.nome)}: ${esc(textoRegra(m).replace('A cada ', ''))}</span>`).join('')
        : `<p class="hint" style="margin:0">${textoSemCadastro('material', 'materiais')}</p>`;
}

function renderSugestoes() {
    const preencher = (id, valores) => {
        const unicos = [...new Set(valores.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        document.getElementById(id).innerHTML = unicos.map(v => `<option value="${esc(v)}"></option>`).join('');
    };
    preencher('lista-origens', operacoes.filter(o => o.tipo === 'ESTOQUE').map(o => o.origem));
    preencher('lista-bairros', [...paradas.map(p => p.bairro), ...municipes.map(m => m.bairro)]);
    preencher('lista-categorias', itens.map(i => i.categoria));
}

// Grava a operação e, para loja/entrada, as movimentações de estoque ligadas a ela (lote)
async function gravarOperacao(tipo, prefixo, linhasOp, extras) {
    const user = getCurrentUser();
    const campo = (nome) => document.getElementById(`${prefixo}-${nome}`);
    const data = campo('data').value;
    const obs = campo('obs').value.trim();
    const ativa = paradaAtiva();
    const opRef = db.collection(OPERACOES_COLLECTION).doc();
    const autor = { usuarioId: user.id, usuarioNome: user.name || user.email, criadoEm: firebase.firestore.FieldValue.serverTimestamp() };
    const total = linhasOp.reduce((t, i) => t + (i.eco || 0), 0);

    const batch = db.batch();
    batch.set(opRef, { tipo, data, obs, paradaId: ativa ? ativa.id : null, itens: linhasOp, total, ...extras, ...autor });
    if (tipo !== 'CAMBIO') {
        linhasOp.forEach(i => batch.set(db.collection(MOV_COLLECTION).doc(), {
            tipo: tipo === 'LOJA' ? 'SAIDA' : 'ENTRADA',
            area: AREA,
            itemId: i.id,
            itemNome: i.nome,
            unidade: i.unidade,
            qtd: i.qtd,
            data,
            // O nome do munícipe fica só no EcoBazar; no estoque do portal aparece o bairro
            origemDestino: tipo === 'LOJA' ? `EcoBazar · ${ativa ? ativa.bairro : ''}` : extras.origem,
            motivo: tipo === 'LOJA' ? 'Troca EcoCash' : '',
            obs,
            lote: opRef.id,
            ...autor
        }));
    }
    await batch.commit();
    campo('obs').value = '';
    limparLinhas(prefixo);
    return total;
}

function ligarFormulario(formId, prefixo, tipo) {
    const form = document.getElementById(formId);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const linhas = lerLinhas(prefixo).filter(l => l.id);
        if (!linhas.length) {
            toast('Escolha pelo menos um item.', 'erro');
            return;
        }
        if (linhas.some(l => !(l.qtd > 0))) {
            toast('Informe quantidades inteiras maiores que zero.', 'erro');
            return;
        }

        const extras = {};
        let municipe = null;
        if (tipo === 'ESTOQUE') {
            extras.origem = document.getElementById('ent-origem').value.trim();
        } else {
            municipe = municipeValido(prefixo);
            if (!municipe) {
                toast('Escolha o munícipe da parada atual.', 'erro');
                return;
            }
            extras.municipeId = municipe.id;
            extras.municipeNome = municipe.nome;
        }

        const saldos = calcularSaldos();
        const linhasOp = linhas.map(l => {
            const x = getOpcao(prefixo, l.id);
            const linha = { id: x.id, nome: x.nome, unidade: x.unidade || '', qtd: l.qtd };
            if (tipo === 'CAMBIO') linha.eco = ecoDoMaterial(x, l.qtd);
            if (tipo === 'LOJA') linha.eco = l.qtd * Number(x.valorEco || 0);
            return linha;
        });
        const total = linhasOp.reduce((t, i) => t + (i.eco || 0), 0);

        if (tipo === 'LOJA') {
            const faltando = linhasOp.filter(i => i.qtd > (saldos[i.id] || 0));
            if (faltando.length) {
                await avisar('Estoque insuficiente', '<ul>' + faltando.map(i =>
                    `<li><strong>${esc(i.nome)}</strong>: pedido ${formatarQtd(i.qtd)}, na van ${formatarQtd(saldos[i.id] || 0)} ${esc(i.unidade)}</li>`
                ).join('') + '</ul>');
                return;
            }
            const saldoEco = contaDe(municipe.id).saldo;
            if (total > saldoEco) {
                await avisar('Saldo insuficiente', `<p>${esc(municipe.nome)} tem <strong>${formatarQtd(saldoEco)} EcoCash</strong> e a troca custa ${formatarQtd(total)}.</p>`);
                return;
            }
        }
        if (tipo !== 'ESTOQUE' && total <= 0) {
            toast('A quantidade ainda não completa nenhuma troca.', 'erro');
            return;
        }

        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            await gravarOperacao(tipo, prefixo, linhasOp, extras);
            if (municipe) municipeSel[prefixo] = '';
            if (tipo === 'CAMBIO') toast(`Câmbio registrado: ${municipe.nome} recebeu ${plural(total, 'EcoCash', 'EcoCash')}.`);
            else if (tipo === 'LOJA') toast(`Troca registrada: ${plural(total, 'EcoCash', 'EcoCash')} descontados de ${municipe.nome}.`);
            else toast(`Entrada registrada (${plural(linhasOp.length, 'produto', 'produtos')}).`);
        } catch (err) {
            console.error('Erro ao registrar:', err);
            toast(mensagemErro(err), 'erro');
        } finally {
            btn.disabled = false;
            if (prefixo !== 'ent') renderPicker(prefixo);
            renderLinhas(prefixo);
        }
    });
}

ligarFormulario('form-cambio', 'cam', 'CAMBIO');
ligarFormulario('form-loja', 'loj', 'LOJA');
ligarFormulario('form-entrada', 'ent', 'ESTOQUE');

// ----------------------------------------------------
// ESTOQUE DA VAN
// ----------------------------------------------------
function renderEstoque() {
    const saldos = calcularSaldos();
    const busca = normalizar(document.getElementById('est-busca').value);
    const produtos = produtosDaLoja();
    const visiveis = produtos.filter(p => !busca || normalizar(`${p.nome} ${p.categoria}`).includes(busca));
    document.getElementById('cards-estoque').innerHTML = !produtos.length
        ? vazioGrid('ph-storefront', textoSemCadastro('produto', 'produtos'))
        : visiveis.length
            ? visiveis.map(p => cardProduto(p, saldos[p.id] || 0)).join('')
            : vazioGrid('ph-magnifying-glass', 'Nenhum produto encontrado.');
}

// ----------------------------------------------------
// PARADAS DA VAN — SÓ ADMINISTRADOR/GESTOR
// ----------------------------------------------------
function resumoParada(p) {
    const ops = opsDaParada(p.id);
    const soma = (t) => ops.filter(o => o.tipo === t).reduce((s, o) => s + Number(o.total || 0), 0);
    const entregue = soma('CAMBIO');
    const trocado = soma('LOJA');
    return { municipes: municipesDaParada(p.id).length, entregue, trocado, sobra: entregue - trocado };
}

function renderParadas() {
    if (!ehGestor()) return;
    const ativa = paradaAtiva();
    if (!document.getElementById('parada-id').value) {
        document.getElementById('parada-enviar').innerHTML = ativa
            ? '<i class="ph ph-map-pin"></i> Encerrar a atual e iniciar'
            : '<i class="ph ph-map-pin"></i> Iniciar parada';
        document.getElementById('parada-hint').textContent = ativa
            ? `A van está em ${ativa.bairro}. Iniciar outra parada encerra essa e o EcoCash de lá expira.`
            : 'A van fica em uma parada por vez.';
    }
    document.getElementById('table-paradas').innerHTML = paradas.length
        ? paradas.map(p => {
            const r = resumoParada(p);
            const fim = p.ativa ? `${formatarData(p.fimPrevisto)} <small>(prevista)</small>` : formatarData(p.encerradaEm);
            return `
                <tr>
                    <td><strong>${esc(p.bairro)}</strong>${p.local ? `<span class="cell-sub">${esc(p.local)}</span>` : ''}</td>
                    <td class="nowrap">${formatarData(p.inicio)} a ${fim}</td>
                    <td class="right num">${formatarQtd(r.municipes)}</td>
                    <td class="right">${eco(r.entregue)}</td>
                    <td class="right">${eco(r.trocado)}</td>
                    <td class="right">${eco(r.sobra)}<span class="cell-sub">${p.ativa ? 'em circulação' : 'expirou'}</span></td>
                    <td>${p.ativa ? '<span class="badge badge-success"><i class="ph-fill ph-map-pin"></i> Van aqui</span>' : '<span class="badge badge-neutral">Encerrada</span>'}</td>
                    <td class="right nowrap">
                        <button class="icon-btn" title="Histórico da parada" onclick="verHistorico({ paradaId: '${esc(p.id)}' })"><i class="ph ph-list-magnifying-glass"></i></button>
                        <button class="icon-btn" title="Editar" onclick="editarParada('${esc(p.id)}')"><i class="ph ph-pencil-simple"></i></button>
                        ${p.ativa ? `<button class="icon-btn danger" title="Encerrar parada" onclick="encerrarParada('${esc(p.id)}')"><i class="ph ph-flag-checkered"></i></button>` : ''}
                    </td>
                </tr>`;
        }).join('')
        : vazio(8, 'ph-map-pin', 'Nenhuma parada ainda. Cadastre a primeira acima.');
}

function editarParada(id) {
    const p = getParada(id);
    if (!p || !ehGestor()) return;
    document.getElementById('parada-id').value = p.id;
    document.getElementById('parada-bairro').value = p.bairro;
    document.getElementById('parada-local').value = p.local || '';
    document.getElementById('parada-inicio').value = p.inicio;
    document.getElementById('parada-fim').value = p.fimPrevisto;
    document.getElementById('parada-form-titulo').innerHTML = `<i class="ph ph-pencil-simple"></i> Editar parada: ${esc(p.bairro)}`;
    document.getElementById('parada-enviar').innerHTML = '<i class="ph ph-floppy-disk"></i> Salvar parada';
    document.getElementById('parada-hint').textContent = 'Os cadastros e lançamentos da parada continuam ligados a ela.';
    document.getElementById('parada-cancelar').style.display = '';
    document.getElementById('form-parada').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelarEdicaoParada() {
    document.getElementById('form-parada').reset();
    document.getElementById('parada-id').value = '';
    document.getElementById('parada-inicio').value = hojeISO();
    document.getElementById('parada-fim').value = somarDias(hojeISO(), DIAS_PARADA);
    document.getElementById('parada-form-titulo').innerHTML = '<i class="ph ph-map-pin-plus"></i> Nova parada';
    document.getElementById('parada-cancelar').style.display = 'none';
    renderParadas();
}

document.getElementById('parada-inicio').addEventListener('change', (e) => {
    if (!document.getElementById('parada-id').value && e.target.value) {
        document.getElementById('parada-fim').value = somarDias(e.target.value, DIAS_PARADA);
    }
});

function textoExpira(p) {
    const r = resumoParada(p);
    return r.sobra > 0
        ? `<p style="margin-top:.5rem"><strong>${formatarQtd(r.sobra)} EcoCash</strong> que os munícipes não trocaram vão expirar.</p>`
        : '';
}

document.getElementById('form-parada').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ehGestor()) return;
    const id = document.getElementById('parada-id').value;
    const dados = {
        bairro: document.getElementById('parada-bairro').value.trim(),
        local: document.getElementById('parada-local').value.trim(),
        inicio: document.getElementById('parada-inicio').value,
        fimPrevisto: document.getElementById('parada-fim').value
    };
    if (dados.fimPrevisto < dados.inicio) {
        toast('A saída prevista não pode ser antes da chegada.', 'erro');
        return;
    }
    const ativa = paradaAtiva();
    const user = getCurrentUser();
    if (!id && ativa) {
        const confirmou = await confirmar({
            titulo: `Encerrar ${ativa.bairro} e ir para ${dados.bairro}?`,
            html: `<p>Os munícipes de ${esc(ativa.bairro)} saem da tela (o cadastro fica guardado).</p>${textoExpira(ativa)}`,
            botao: 'Encerrar e iniciar',
            perigo: true,
            icone: 'ph-van'
        });
        if (!confirmou) return;
    }

    const btn = document.getElementById('parada-enviar');
    btn.disabled = true;
    try {
        if (id) {
            await db.collection(PARADAS_COLLECTION).doc(id).update(dados);
            toast('Parada atualizada.');
        } else {
            const batch = db.batch();
            if (ativa) batch.update(db.collection(PARADAS_COLLECTION).doc(ativa.id), dadosEncerramento(user));
            batch.set(db.collection(PARADAS_COLLECTION).doc(), {
                ...dados,
                ativa: true,
                usuarioId: user.id,
                usuarioNome: user.name || user.email,
                criadoEm: firebase.firestore.FieldValue.serverTimestamp()
            });
            await batch.commit();
            filtros.paradaId = '';
            filtroParadaDefinido = false;
            toast(`Van em ${dados.bairro}. Bom trabalho!`);
        }
        cancelarEdicaoParada();
    } catch (err) {
        console.error('Erro ao salvar parada:', err);
        toast(mensagemErro(err), 'erro');
    } finally {
        btn.disabled = false;
    }
});

function dadosEncerramento(user) {
    return { ativa: false, encerradaEm: hojeISO(), encerradaPor: user.name || user.email };
}

async function encerrarParada(id) {
    const p = getParada(id);
    if (!p || !p.ativa || !ehGestor()) return;
    const confirmou = await confirmar({
        titulo: `Encerrar a parada em ${p.bairro}?`,
        html: `<p>Câmbio e loja ficam fechados até a próxima parada e os munícipes daqui saem da tela (o cadastro fica guardado e vai para a planilha).</p>${textoExpira(p)}`,
        botao: 'Encerrar parada',
        perigo: true,
        icone: 'ph-flag-checkered'
    });
    if (!confirmou) return;
    try {
        await db.collection(PARADAS_COLLECTION).doc(id).update(dadosEncerramento(getCurrentUser()));
        ['cam', 'loj'].forEach(p => municipeSel[p] = '');
        toast(`Parada em ${p.bairro} encerrada.`);
    } catch (err) {
        console.error('Erro ao encerrar parada:', err);
        toast(mensagemErro(err), 'erro');
    }
}

// ----------------------------------------------------
// MATERIAIS DE TROCA — SÓ ADMINISTRADOR/GESTOR
// ----------------------------------------------------
function renderMateriais() {
    if (!ehGestor()) return;
    document.getElementById('painel-materiais-padrao').style.display = materiais.length === 0 ? '' : 'none';
    const foco = paradaFoco();
    const naParada = new Map();
    (foco ? opsDaParada(foco.id) : []).filter(o => o.tipo === 'CAMBIO').forEach(o => (o.itens || []).forEach(i => {
        const t = naParada.get(i.id) || { qtd: 0, eco: 0 };
        t.qtd += Number(i.qtd || 0);
        t.eco += Number(i.eco || 0);
        naParada.set(i.id, t);
    }));
    document.getElementById('table-materiais').innerHTML = materiais.length
        ? materiais.map(m => {
            const t = naParada.get(m.id) || { qtd: 0, eco: 0 };
            return `
                <tr>
                    <td><strong>${esc(m.nome)}</strong><span class="cell-sub">medido em ${esc(m.unidade)}</span></td>
                    <td><span class="chip coin"><i class="ph-fill ph-coins"></i> ${esc(textoRegra(m))}</span></td>
                    <td class="right num">${formatarQtd(t.qtd)} <small>${esc(m.unidade)}</small><span class="cell-sub">${eco(t.eco)}</span></td>
                    <td class="right nowrap">
                        <button class="icon-btn" title="Histórico" onclick="verHistorico({ itemId: '${esc(m.id)}' })"><i class="ph ph-list-magnifying-glass"></i></button>
                        <button class="icon-btn" title="Editar" onclick="editarMaterial('${esc(m.id)}')"><i class="ph ph-pencil-simple"></i></button>
                        <button class="icon-btn danger" title="Excluir" onclick="excluirMaterial('${esc(m.id)}')"><i class="ph ph-trash"></i></button>
                    </td>
                </tr>`;
        }).join('')
        : vazio(4, 'ph-coins', 'Nenhum material cadastrado.');
}

function atualizarUnidadeRegra() {
    document.getElementById('material-unidade-eco').textContent = document.getElementById('material-unidade').value.trim() || 'un';
}
document.getElementById('material-unidade').addEventListener('input', atualizarUnidadeRegra);

function editarMaterial(id) {
    const m = getMaterial(id);
    if (!m || !ehGestor()) return;
    document.getElementById('material-id').value = m.id;
    document.getElementById('material-nome').value = m.nome;
    document.getElementById('material-unidade').value = m.unidade;
    document.getElementById('material-base').value = m.qtdBase;
    document.getElementById('material-valor').value = m.valor;
    atualizarUnidadeRegra();
    document.getElementById('material-form-titulo').innerHTML = `<i class="ph ph-pencil-simple"></i> Editar: ${esc(m.nome)}`;
    document.getElementById('material-cancelar').style.display = '';
    document.getElementById('form-material').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelarEdicaoMaterial() {
    document.getElementById('form-material').reset();
    document.getElementById('material-id').value = '';
    document.getElementById('material-form-titulo').innerHTML = '<i class="ph ph-plus-circle"></i> Novo material';
    document.getElementById('material-cancelar').style.display = 'none';
    atualizarUnidadeRegra();
}

document.getElementById('form-material').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ehGestor()) return;
    const id = document.getElementById('material-id').value;
    const dados = {
        nome: document.getElementById('material-nome').value.trim(),
        unidade: document.getElementById('material-unidade').value.trim(),
        qtdBase: parseInt(document.getElementById('material-base').value, 10),
        valor: parseInt(document.getElementById('material-valor').value, 10)
    };
    if (!(dados.qtdBase >= 1) || !(dados.valor >= 1)) {
        toast('Use números inteiros a partir de 1 na regra de troca.', 'erro');
        return;
    }
    if (materiais.some(m => m.id !== id && normalizar(m.nome) === normalizar(dados.nome))) {
        toast(`Já existe um material chamado "${dados.nome}".`, 'erro');
        return;
    }
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
        if (id) {
            await db.collection(MATERIAIS_COLLECTION).doc(id).update(dados);
        } else {
            await db.collection(MATERIAIS_COLLECTION).add({ ...dados, criadoEm: firebase.firestore.FieldValue.serverTimestamp() });
        }
        cancelarEdicaoMaterial();
        toast(id ? 'Material atualizado.' : 'Material cadastrado.');
    } catch (err) {
        console.error('Erro ao salvar material:', err);
        toast(mensagemErro(err), 'erro');
    } finally {
        btn.disabled = false;
    }
});

async function excluirMaterial(id) {
    const m = getMaterial(id);
    if (!m || !ehGestor()) return;
    const usos = operacoes.filter(o => o.tipo === 'CAMBIO' && (o.itens || []).some(i => i.id === id)).length;
    const confirmou = await confirmar({
        titulo: `Excluir "${m.nome}"?`,
        html: `<p>O material deixa de aparecer no câmbio.</p>
               ${usos ? `<p style="margin-top:.5rem">Os ${plural(usos, 'câmbio', 'câmbios')} já registrados com ele continuam no histórico.</p>` : ''}`,
        botao: 'Excluir',
        perigo: true,
        icone: 'ph-trash'
    });
    if (!confirmou) return;
    try {
        await db.collection(MATERIAIS_COLLECTION).doc(id).delete();
        if (document.getElementById('material-id').value === id) cancelarEdicaoMaterial();
        toast('Material excluído.');
    } catch (err) {
        console.error('Erro ao excluir material:', err);
        toast(mensagemErro(err), 'erro');
    }
}

async function criarMateriaisPadrao() {
    if (!ehGestor()) return;
    const existentes = new Set(materiais.map(m => normalizar(m.nome)));
    const novos = MATERIAIS_PADRAO.filter(m => !existentes.has(normalizar(m.nome)));
    if (!novos.length) return;
    try {
        const batch = db.batch();
        novos.forEach(m => batch.set(db.collection(MATERIAIS_COLLECTION).doc(), {
            ...m,
            criadoEm: firebase.firestore.FieldValue.serverTimestamp()
        }));
        await batch.commit();
        toast(`${plural(novos.length, 'material criado', 'materiais criados')}.`);
    } catch (err) {
        console.error('Erro ao criar materiais:', err);
        toast(mensagemErro(err), 'erro');
    }
}

// ----------------------------------------------------
// PRODUTOS DA LOJA — SÓ ADMINISTRADOR/GESTOR
// (são itens do estoque único; aqui se define o preço em EcoCash)
// ----------------------------------------------------
function renderProdutos() {
    if (!ehGestor()) return;
    const saldos = calcularSaldos();
    const lista = produtosDaLoja(true);
    document.getElementById('table-produtos').innerHTML = lista.length
        ? lista.map(p => {
            const ativo = p.ativo !== false;
            const saldo = saldos[p.id] || 0;
            const preco = Number(p.valorEco || 0);
            const outras = areasDoItem(p).filter(a => a !== AREA);
            return `
                <tr class="${ativo ? '' : 'inativo'}">
                    <td><strong>${esc(p.nome)}</strong><span class="cell-sub">${esc(p.unidade)}${outras.length ? ` · também em ${esc(outras.join(', '))}` : ''}</span></td>
                    <td>${p.categoria ? `<span class="chip">${esc(p.categoria)}</span>` : '-'}</td>
                    <td class="right">${preco > 0 ? eco(preco) : '<span class="badge badge-warning">Definir preço</span>'}</td>
                    <td class="right num"><strong>${formatarQtd(saldo)}</strong></td>
                    <td>${ativo ? situacaoItem(p, saldo).badge : '<span class="badge badge-neutral">Inativo</span>'}</td>
                    <td class="right nowrap">
                        <button class="icon-btn" title="Histórico" onclick="verHistorico({ itemId: '${esc(p.id)}', paradaId: '' })"><i class="ph ph-list-magnifying-glass"></i></button>
                        <button class="icon-btn" title="Editar" onclick="editarProduto('${esc(p.id)}')"><i class="ph ph-pencil-simple"></i></button>
                        ${ativo
                            ? `<button class="icon-btn danger" title="Excluir da loja" onclick="excluirProduto('${esc(p.id)}')"><i class="ph ph-trash"></i></button>`
                            : `<button class="icon-btn" title="Reativar" onclick="reativarProduto('${esc(p.id)}')"><i class="ph ph-eye"></i></button>`}
                    </td>
                </tr>`;
        }).join('')
        : vazio(6, 'ph-tag', 'Nenhum produto cadastrado.');
}

const TEXTO_AREAS_PRODUTO = 'O produto aparece no EcoBazar. Para ele aparecer também em outra área, marque-a no cadastro de itens do Estoque.';

function editarProduto(id) {
    const p = getItem(id);
    if (!p || !ehGestor()) return;
    document.getElementById('produto-id').value = p.id;
    document.getElementById('produto-nome').value = p.nome;
    document.getElementById('produto-categoria').value = p.categoria || '';
    document.getElementById('produto-unidade').value = p.unidade || '';
    document.getElementById('produto-preco').value = p.valorEco || 1;
    document.getElementById('produto-minimo').value = p.estoqueMinimo || 0;
    const outras = areasDoItem(p).filter(a => a !== AREA);
    document.getElementById('produto-areas-info').textContent = outras.length
        ? `Este item também aparece em: ${outras.join(', ')}. Nome, unidade e mínimo mudam lá também; o saldo é o mesmo.`
        : TEXTO_AREAS_PRODUTO;
    document.getElementById('produto-form-titulo').innerHTML = `<i class="ph ph-pencil-simple"></i> Editar: ${esc(p.nome)}`;
    document.getElementById('produto-cancelar').style.display = '';
    document.getElementById('form-produto').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelarEdicaoProduto() {
    document.getElementById('form-produto').reset();
    document.getElementById('produto-id').value = '';
    document.getElementById('produto-areas-info').textContent = TEXTO_AREAS_PRODUTO;
    document.getElementById('produto-form-titulo').innerHTML = '<i class="ph ph-plus-circle"></i> Novo produto';
    document.getElementById('produto-cancelar').style.display = 'none';
}

document.getElementById('form-produto').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ehGestor()) return;
    const id = document.getElementById('produto-id').value;
    const dados = {
        nome: document.getElementById('produto-nome').value.trim(),
        categoria: document.getElementById('produto-categoria').value.trim(),
        unidade: document.getElementById('produto-unidade').value.trim(),
        valorEco: parseInt(document.getElementById('produto-preco').value, 10),
        estoqueMinimo: Math.max(0, parseInt(document.getElementById('produto-minimo').value, 10) || 0)
    };
    if (!(dados.valorEco >= 1)) {
        toast('O preço precisa ser um número inteiro a partir de 1.', 'erro');
        return;
    }
    const mesmoNome = itens.find(i => i.id !== id && normalizar(i.nome) === normalizar(dados.nome));
    const btn = e.target.querySelector('button[type="submit"]');

    // Item com o mesmo nome em outra área: usa o mesmo cadastro (saldo compartilhado)
    if (mesmoNome) {
        const naLoja = areasDoItem(mesmoNome).includes(AREA);
        if (id || naLoja) {
            toast(`Já existe um ${naLoja ? 'produto' : 'item'} chamado "${dados.nome}".`, 'erro');
            return;
        }
        const usar = await confirmar({
            titulo: `"${mesmoNome.nome}" já existe no estoque`,
            html: `<p>Ele está cadastrado em: <strong>${esc(areasDoItem(mesmoNome).join(', '))}</strong>.</p>
                   <p style="margin-top:.5rem">Colocar o mesmo item na loja? O saldo passa a ser compartilhado: uma troca no EcoBazar baixa o estoque lá também.</p>`,
            botao: 'Usar o mesmo item',
            icone: 'ph-link'
        });
        if (!usar) return;
        btn.disabled = true;
        try {
            await db.collection(ITENS_COLLECTION).doc(mesmoNome.id).update({
                areas: [...areasDoItem(mesmoNome), AREA],
                valorEco: dados.valorEco,
                ativo: true
            });
            cancelarEdicaoProduto();
            toast('Produto colocado na loja.');
        } catch (err) {
            console.error('Erro ao salvar produto:', err);
            toast(mensagemErro(err), 'erro');
        } finally {
            btn.disabled = false;
        }
        return;
    }

    btn.disabled = true;
    try {
        if (id) {
            await db.collection(ITENS_COLLECTION).doc(id).update(dados);
        } else {
            await db.collection(ITENS_COLLECTION).add({
                ...dados,
                areas: [AREA],
                ativo: true,
                criadoEm: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
        cancelarEdicaoProduto();
        toast(id ? 'Produto atualizado.' : 'Produto cadastrado.');
    } catch (err) {
        console.error('Erro ao salvar produto:', err);
        toast(mensagemErro(err), 'erro');
    } finally {
        btn.disabled = false;
    }
});

// Excluir da loja:
//  - item que também está em outra área: só sai da loja;
//  - item só da loja e sem nenhum lançamento: o cadastro é apagado;
//  - item só da loja com lançamentos: fica inativo, para não perder o histórico.
async function excluirProduto(id) {
    const p = getItem(id);
    if (!p || !ehGestor()) return;
    const outras = areasDoItem(p).filter(a => a !== AREA);
    const temHistorico = movimentacoes.some(m => m.itemId === id);
    const explicacao = outras.length
        ? `Ele sai da loja, mas continua em ${esc(outras.join(', '))} com o mesmo saldo.`
        : temHistorico
            ? 'Ele tem lançamentos, então fica inativo (some da loja) e o histórico é mantido. Dá para reativar depois.'
            : 'Ele não tem nenhum lançamento e será apagado.';
    const confirmou = await confirmar({
        titulo: `Excluir "${p.nome}" da loja?`,
        html: `<p>${explicacao}</p>`,
        botao: 'Excluir',
        perigo: true,
        icone: 'ph-trash'
    });
    if (!confirmou) return;
    try {
        const ref = db.collection(ITENS_COLLECTION).doc(id);
        if (outras.length) await ref.update({ areas: outras });
        else if (temHistorico) await ref.update({ ativo: false });
        else await ref.delete();
        if (document.getElementById('produto-id').value === id) cancelarEdicaoProduto();
        toast('Produto excluído da loja.');
    } catch (err) {
        console.error('Erro ao excluir produto:', err);
        toast(mensagemErro(err), 'erro');
    }
}

async function reativarProduto(id) {
    if (!ehGestor()) return;
    try {
        await db.collection(ITENS_COLLECTION).doc(id).update({ ativo: true });
        toast('Produto reativado.');
    } catch (err) {
        console.error('Erro ao reativar produto:', err);
        toast(mensagemErro(err), 'erro');
    }
}

// ----------------------------------------------------
// PLANILHAS (EXCEL)
// ----------------------------------------------------
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

function estiloCabecalho(ws) {
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
}

// Nome de aba no formato "(mm-aaaa) Bairro". O Excel não aceita "/" em nome de aba
// e limita a 31 caracteres; nomes repetidos ganham um número.
function nomeAba(texto, usados) {
    const limpo = texto.replace(/[\\/?*[\]:]/g, '-').slice(0, 31).trim();
    let nome = limpo;
    for (let n = 2; usados.has(nome.toLowerCase()); n++) nome = `${limpo.slice(0, 27)} (${n})`;
    usados.add(nome.toLowerCase());
    return nome;
}

function abaHistorico(wb, nome, lista) {
    const ws = wb.addWorksheet(nome);
    ws.columns = [
        { header: 'Data', key: 'data', width: 12 },
        { header: 'Tipo', key: 'tipo', width: 18 },
        { header: 'Material / produto', key: 'item', width: 28 },
        { header: 'Quantidade', key: 'qtd', width: 12 },
        { header: 'Unidade', key: 'unidade', width: 9 },
        { header: 'EcoCash', key: 'eco', width: 10 },
        { header: 'Munícipe / origem', key: 'pessoa', width: 28 },
        { header: 'Parada', key: 'parada', width: 24 },
        { header: 'Observação', key: 'obs', width: 32 },
        { header: 'Lançado por', key: 'usuario', width: 24 }
    ];
    // Uma linha por material/produto de cada lançamento
    lista.forEach(o => (o.itens || []).forEach(i => ws.addRow({
        data: formatarData(o.data),
        tipo: (TIPOS[o.tipo] || TIPOS.ESTOQUE).label,
        item: i.nome,
        qtd: Number(i.qtd),
        unidade: i.unidade,
        eco: o.tipo === 'ESTOQUE' ? null : (o.tipo === 'LOJA' ? -1 : 1) * Number(i.eco || 0),
        pessoa: o.municipeNome || o.origem || '',
        parada: nomeParada(o.paradaId),
        obs: o.obs || '',
        usuario: o.usuarioNome || ''
    })));
    estiloCabecalho(ws);
    ws.autoFilter = { from: 'A1', to: 'J1' };
}

// Uma aba por parada: munícipes com o que doaram, EcoCash recebido, trocado e saldo
function abaMunicipesDaParada(wb, nome, parada) {
    const ws = wb.addWorksheet(nome);
    const ops = opsDaParada(parada.id);
    const cols = new Map(materiais.map(m => [m.id, `${m.nome} (${m.unidade})`]));
    ops.filter(o => o.tipo === 'CAMBIO').forEach(o => (o.itens || []).forEach(i => {
        if (!cols.has(i.id)) cols.set(i.id, `${i.nome} (${i.unidade})`);
    }));
    ws.columns = [
        { header: 'Nome', key: 'nome', width: 30 },
        { header: 'Telefone', key: 'telefone', width: 17 },
        { header: 'Bairro', key: 'bairro', width: 22 },
        ...[...cols].map(([id, titulo]) => ({ header: `Doou: ${titulo}`, key: `m_${id}`, width: Math.max(14, titulo.length + 6) })),
        { header: 'Produtos trocados', key: 'produtos', width: 18 },
        { header: 'EcoCash recebido', key: 'recebido', width: 17 },
        { header: 'EcoCash trocado', key: 'trocado', width: 16 },
        { header: parada.ativa ? 'Saldo EcoCash' : 'Saldo (expirou)', key: 'saldo', width: 16 }
    ];
    const totais = { nome: 'TOTAL', produtos: 0, recebido: 0, trocado: 0, saldo: 0 };
    municipesDaParada(parada.id).forEach(m => {
        const c = contaDe(m.id);
        const linha = { nome: m.nome, telefone: m.telefone, bairro: m.bairro, produtos: c.produtos, recebido: c.recebido, trocado: c.trocado, saldo: c.saldo };
        cols.forEach((_, id) => {
            const q = c.doado.get(id)?.qtd || 0;
            linha[`m_${id}`] = q;
            totais[`m_${id}`] = (totais[`m_${id}`] || 0) + q;
        });
        ['produtos', 'recebido', 'trocado', 'saldo'].forEach(k => totais[k] += linha[k]);
        ws.addRow(linha);
    });
    ws.addRow(totais).font = { bold: true };
    estiloCabecalho(ws);
}

async function gerarPlanilha(nomeArquivo, montar) {
    try {
        await carregarScript(EXCELJS_URL);
        const wb = new ExcelJS.Workbook();
        montar(wb);
        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = nomeArquivo;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        return true;
    } catch (err) {
        console.error('Erro ao exportar:', err);
        toast('Não foi possível gerar a planilha. Verifique a conexão.', 'erro');
        return false;
    }
}

async function exportarFiltro() {
    const lista = opsFiltradas();
    if (!lista.length) {
        toast('Nenhum lançamento para exportar com esses filtros.', 'info');
        return;
    }
    if (await gerarPlanilha(`ecobazar-historico-filtrado-${hojeISO()}.xlsx`, wb => abaHistorico(wb, 'Histórico', lista))) {
        toast(`Planilha gerada com ${plural(lista.length, 'lançamento', 'lançamentos')}.`);
    }
}

// Tudo do EcoBazar num arquivo: paradas, uma aba de munícipes por parada,
// histórico, estoque da van e materiais de troca
async function exportarPlanilhaCompleta() {
    const ok = await gerarPlanilha(`ecobazar-${hojeISO()}.xlsx`, wb => {
        const usados = new Set();

        const wsParadas = wb.addWorksheet(nomeAba('Paradas', usados));
        wsParadas.columns = [
            { header: 'Bairro', key: 'bairro', width: 24 },
            { header: 'Ponto', key: 'local', width: 24 },
            { header: 'Chegada', key: 'inicio', width: 12 },
            { header: 'Saída prevista', key: 'fim', width: 14 },
            { header: 'Encerrada em', key: 'encerrada', width: 14 },
            { header: 'Situação', key: 'situacao', width: 12 },
            { header: 'Munícipes', key: 'municipes', width: 11 },
            { header: 'EcoCash entregue', key: 'entregue', width: 17 },
            { header: 'EcoCash trocado', key: 'trocado', width: 16 },
            { header: 'EcoCash em circulação / expirado', key: 'sobra', width: 30 }
        ];
        paradas.forEach(p => {
            const r = resumoParada(p);
            wsParadas.addRow({
                bairro: p.bairro, local: p.local || '', inicio: formatarData(p.inicio), fim: formatarData(p.fimPrevisto),
                encerrada: p.encerradaEm ? formatarData(p.encerradaEm) : '', situacao: p.ativa ? 'Van aqui' : 'Encerrada',
                municipes: r.municipes, entregue: r.entregue, trocado: r.trocado, sobra: r.sobra
            });
        });
        estiloCabecalho(wsParadas);

        paradas.forEach(p => {
            const [ano, mes] = (p.inicio || '').split('-');
            abaMunicipesDaParada(wb, nomeAba(`(${mes}-${ano}) ${p.bairro}`, usados), p);
        });

        abaHistorico(wb, nomeAba('Histórico', usados), operacoes);

        const saldos = calcularSaldos();
        const wsEstoque = wb.addWorksheet(nomeAba('Estoque da van', usados));
        wsEstoque.columns = [
            { header: 'Produto', key: 'item', width: 28 },
            { header: 'Categoria', key: 'categoria', width: 16 },
            { header: 'Preço (EcoCash)', key: 'preco', width: 15 },
            { header: 'Saldo', key: 'saldo', width: 10 },
            { header: 'Unidade', key: 'unidade', width: 9 },
            { header: 'Mínimo', key: 'minimo', width: 10 }
        ];
        produtosDaLoja().forEach(p => wsEstoque.addRow({
            item: p.nome, categoria: p.categoria || '', preco: Number(p.valorEco || 0),
            saldo: saldos[p.id] || 0, unidade: p.unidade, minimo: Number(p.estoqueMinimo || 0)
        }));
        estiloCabecalho(wsEstoque);

        const wsMateriais = wb.addWorksheet(nomeAba('Materiais de troca', usados));
        wsMateriais.columns = [
            { header: 'Material', key: 'nome', width: 28 },
            { header: 'Medido em', key: 'unidade', width: 12 },
            { header: 'A cada', key: 'base', width: 10 },
            { header: 'Vale (EcoCash)', key: 'valor', width: 14 }
        ];
        materiais.forEach(m => wsMateriais.addRow({ nome: m.nome, unidade: m.unidade, base: Number(m.qtdBase), valor: Number(m.valor) }));
        estiloCabecalho(wsMateriais);
    });
    if (ok) toast('Planilha completa gerada.');
}
