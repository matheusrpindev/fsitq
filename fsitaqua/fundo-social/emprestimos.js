// emprestimos.js - Empréstimo de equipamentos (Fundo Social)
//
// Carregado depois de script.js e usa os mesmos dados e helpers de lá (itens,
// movimentacoes, calcularSaldos, esc, toast, confirmar, carregarScript...).
//
// Banco de dados:
//   emprestimos/{id} {
//     data (AAAA-MM-DD ou null), nome, telefone, endereco, bairro, responsavel, obs,
//     itens: [{ itemId, nome, unidade, qtd, situacao, resolvidoEm }],
//     aberto (true enquanto algum item estiver EM_USO),
//     contatos: [{ data, resultado, obs, usuarioId, usuarioNome }],
//     origem: 'sistema' | 'planilha', planilha: { aba, linha, status, dataOriginal },
//     usuarioId, usuarioNome, criadoEm, atualizadoEm
//   }
//
// Os equipamentos são itens do estoque com "emprestimo: true". Emprestar lança uma
// SAIDA (motivo 'Empréstimo') e devolver lança uma ENTRADA (motivo 'Devolução de
// empréstimo') em estoque_movimentacoes, com lote = id do empréstimo. Assim o saldo
// do item é o que está disponível no galpão.
//
// Empréstimos importados da planilha não lançam saída: o equipamento já estava fora
// do galpão quando o inventário foi contado. Quando um deles é devolvido, a entrada
// é lançada normalmente.

const EMP_COLLECTION = 'emprestimos';
const EMP_POR_PAGINA = 40;
const DIAS_SEM_CONTATO = 90;
const MOTIVO_EMPRESTIMO = 'Empréstimo';
const MOTIVO_DEVOLUCAO = 'Devolução de empréstimo';
const CATEGORIA_EQUIPAMENTOS = 'Equipamentos';
const NAO_INFORMADO = 'Equipamento não informado';

const SITUACOES_ITEM = {
    EM_USO: { label: 'Em uso', badge: 'badge-warning', icone: 'ph-hourglass-medium' },
    DEVOLVIDO: { label: 'Devolvido', badge: 'badge-success', icone: 'ph-check-circle' },
    DOADO: { label: 'Ficou com a pessoa', badge: 'badge-info', icone: 'ph-hand-heart' },
    NAO_LOCALIZADO: { label: 'Não localizado', badge: 'badge-danger', icone: 'ph-question' }
};

const RESULTADOS_CONTATO = {
    EM_USO: 'Atendeu: ainda está usando',
    VAI_DEVOLVER: 'Atendeu: vai devolver',
    NAO_ATENDEU: 'Não atendeu',
    SEM_TELEFONE: 'Sem telefone',
    TELEFONE_ERRADO: 'Telefone errado',
    SEM_INFORMACAO: 'Sem informação'
};

let emprestimos = [];
let empCarregado = false;
let empFiltros = { busca: '', situacao: 'aberto', itemId: '', ano: '', semContato: false };
let empLimite = EMP_POR_PAGINA;
let empDetalheId = null;
let empDetalheEsperando = false; // aberto logo após gravar, antes do registro chegar do banco

// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------
function itensEmprestaveis() {
    return itens.filter(i => i.ativo !== false && i.emprestimo === true);
}

function itensEmUso(e) {
    return (e.itens || []).filter(i => i.situacao === 'EM_USO');
}

function ultimoContato(e) {
    const lista = e.contatos || [];
    return lista.length ? lista[lista.length - 1] : null;
}

function diasDesde(iso) {
    if (!iso) return Infinity;
    const [a, m, d] = iso.split('-').map(Number);
    return Math.floor((Date.now() - new Date(a, m - 1, d).getTime()) / 86400000);
}

// Aberto e sem ligação (ou sem retirada, se nunca ligaram) há mais de 90 dias
function semContatoRecente(e) {
    if (!e.aberto) return false;
    const ultimo = ultimoContato(e);
    return diasDesde((ultimo && ultimo.data) || e.data) > DIAS_SEM_CONTATO;
}

function emprestadoPorItem() {
    const emUso = {};
    emprestimos.forEach(e => itensEmUso(e).forEach(i => {
        const chave = i.itemId || 'nome:' + normalizar(i.nome);
        emUso[chave] = (emUso[chave] || 0) + Number(i.qtd || 0);
    }));
    return emUso;
}

function qtdTexto(i) {
    return `${formatarQtd(i.qtd)} ${esc(i.nome)}`;
}

function badgeSituacaoItem(situacao) {
    const s = SITUACOES_ITEM[situacao] || SITUACOES_ITEM.EM_USO;
    return `<span class="badge ${s.badge}"><i class="ph ${s.icone}"></i> ${s.label}</span>`;
}

function badgeEmprestimo(e) {
    if (e.aberto) return '<span class="badge badge-warning"><i class="ph ph-hourglass-medium"></i> Em aberto</span>';
    return '<span class="badge badge-neutral"><i class="ph ph-check"></i> Encerrado</span>';
}

function linkTelefone(tel) {
    if (!tel) return '-';
    const digitos = String(tel).replace(/\D/g, '');
    return digitos.length >= 8 ? `<a href="tel:${esc(digitos)}">${esc(tel)}</a>` : esc(tel);
}

function getEmprestimo(id) {
    return emprestimos.find(e => e.id === id);
}

function usuarioAtual() {
    const user = getCurrentUser();
    return { usuarioId: user.id, usuarioNome: user.name || user.email };
}

function erroEmprestimo(err) {
    if (err && err.code === 'permission-denied') {
        return 'Sem permissão para salvar o empréstimo. As regras do Firestore precisam liberar a coleção de empréstimos.';
    }
    return 'Não foi possível salvar. Verifique sua conexão e tente novamente.';
}

// ----------------------------------------------------
// CARGA DE DADOS
// ----------------------------------------------------
function ouvirEmprestimos() {
    db.collection(EMP_COLLECTION).onSnapshot((snap) => {
        emprestimos = snap.docs
            .map(d => {
                const e = { id: d.id, ...d.data({ serverTimestamps: 'estimate' }) };
                e.criadoMs = e.criadoEm && e.criadoEm.toMillis ? e.criadoEm.toMillis() : 0;
                return e;
            })
            .sort((a, b) => (b.data || '').localeCompare(a.data || '') || b.criadoMs - a.criadoMs);
        empCarregado = true;
        renderEmprestimos();
        if (empDetalheId) renderDetalhe();
    }, (err) => {
        console.error('Erro ao acessar empréstimos:', err);
        empCarregado = true;
        const aviso = document.getElementById('aviso-erro');
        aviso.querySelector('span').textContent = err.code === 'permission-denied'
            ? 'Sem permissão para ler os empréstimos. As regras do Firestore precisam liberar a coleção "emprestimos".'
            : 'Não foi possível carregar os empréstimos. Verifique sua conexão e recarregue a página.';
        aviso.classList.add('show');
        renderEmprestimos();
    });
}

// ----------------------------------------------------
// LISTA, INDICADORES E EQUIPAMENTOS
// ----------------------------------------------------
function renderEmprestimos() {
    if (!document.getElementById('view-emprestimos')) return;
    const saldos = calcularSaldos();
    const emUso = emprestadoPorItem();
    const equipamentos = itensEmprestaveis();
    const abertos = emprestimos.filter(e => e.aberto);

    document.getElementById('emp-kpi-abertos').textContent = formatarQtd(abertos.length);
    document.getElementById('emp-kpi-abertos-hint').textContent = `de ${formatarQtd(emprestimos.length)} registrados`;
    const unidadesFora = abertos.reduce((s, e) => s + itensEmUso(e).reduce((t, i) => t + Number(i.qtd || 0), 0), 0);
    document.getElementById('emp-kpi-fora').textContent = formatarQtd(unidadesFora);
    const disponiveis = equipamentos.reduce((s, i) => s + Math.max(0, saldos[i.id] || 0), 0);
    document.getElementById('emp-kpi-disponiveis').textContent = formatarQtd(disponiveis);
    const semContato = abertos.filter(semContatoRecente).length;
    document.getElementById('emp-kpi-contato').textContent = formatarQtd(semContato);
    document.getElementById('emp-kpi-contato-icon').className = `kpi-icon ${semContato ? 'warning' : 'success'}`;

    // Equipamentos: disponível no galpão x emprestado
    const grade = document.getElementById('emp-equipamentos');
    if (!equipamentos.length) {
        grade.innerHTML = `<div class="vazio" style="grid-column: 1 / -1;"><i class="ph ph-wheelchair"></i>${ehGestor()
            ? 'Nenhum equipamento cadastrado. Importe a planilha ou marque "Pode ser emprestado" na aba <a href="#" onclick="switchTab(\'itens\'); return false;">Itens</a>.'
            : 'Nenhum equipamento cadastrado ainda. Peça a um gestor para cadastrar.'}</div>`;
    } else {
        grade.innerHTML = equipamentos.map(i => {
            const saldo = saldos[i.id] || 0;
            const fora = emUso[i.id] || 0;
            return `
                <button type="button" class="equip-card ${saldo <= 0 ? 'is-empty' : ''}" onclick="filtrarEquipamento('${esc(i.id)}')" title="Ver empréstimos de ${esc(i.nome)}">
                    <span class="equip-nome">${esc(i.nome)}</span>
                    <span class="equip-num"><strong>${formatarQtd(Math.max(0, saldo))}</strong> disponíve${saldo === 1 ? 'l' : 'is'}</span>
                    <span class="equip-sub">${formatarQtd(fora)} emprestado${fora === 1 ? '' : 's'}</span>
                </button>`;
        }).join('');
    }

    renderOpcoesEmprestimo();
    renderListaEmprestimos();
    renderLinhasEmprestimo();
    renderSugestoesEmprestimo();
}

function renderOpcoesEmprestimo() {
    const selItem = document.getElementById('emp-f-item');
    const nomes = new Map();
    itensEmprestaveis().forEach(i => nomes.set(i.id, i.nome));
    emprestimos.forEach(e => (e.itens || []).forEach(i => { if (i.itemId && !nomes.has(i.itemId)) nomes.set(i.itemId, i.nome); }));
    selItem.innerHTML = '<option value="">Todos</option>' + [...nomes]
        .sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'))
        .map(([id, nome]) => `<option value="${esc(id)}">${esc(nome)}</option>`).join('');
    selItem.value = nomes.has(empFiltros.itemId) ? empFiltros.itemId : '';

    const anos = [...new Set(emprestimos.map(e => (e.data || '').slice(0, 4)).filter(Boolean))].sort().reverse();
    const selAno = document.getElementById('emp-f-ano');
    selAno.innerHTML = '<option value="">Todos</option>' + anos.map(a => `<option>${a}</option>`).join('') +
        (emprestimos.some(e => !e.data) ? '<option value="sem">Sem data</option>' : '');
    selAno.value = empFiltros.ano;

    document.getElementById('emp-f-busca').value = empFiltros.busca;
    document.getElementById('emp-f-contato').checked = empFiltros.semContato;
    document.querySelectorAll('#emp-f-situacao button').forEach(b => b.classList.toggle('active', b.dataset.situacao === empFiltros.situacao));
}

function aplicarFiltrosEmprestimo() {
    empFiltros.busca = document.getElementById('emp-f-busca').value;
    empFiltros.itemId = document.getElementById('emp-f-item').value;
    empFiltros.ano = document.getElementById('emp-f-ano').value;
    empFiltros.semContato = document.getElementById('emp-f-contato').checked;
    empLimite = EMP_POR_PAGINA;
    renderListaEmprestimos();
}

function definirSituacaoEmprestimo(situacao) {
    empFiltros.situacao = situacao;
    document.querySelectorAll('#emp-f-situacao button').forEach(b => b.classList.toggle('active', b.dataset.situacao === situacao));
    empLimite = EMP_POR_PAGINA;
    renderListaEmprestimos();
}

function filtrarEquipamento(itemId) {
    empFiltros = { ...empFiltros, itemId, situacao: 'aberto' };
    renderOpcoesEmprestimo();
    renderListaEmprestimos();
    document.getElementById('emp-lista-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function limparFiltrosEmprestimo() {
    empFiltros = { busca: '', situacao: 'aberto', itemId: '', ano: '', semContato: false };
    empLimite = EMP_POR_PAGINA;
    renderOpcoesEmprestimo();
    renderListaEmprestimos();
}

function emprestimosFiltrados() {
    const f = empFiltros;
    const busca = normalizar(f.busca);
    return emprestimos.filter(e => {
        if (f.situacao === 'aberto' && !e.aberto) return false;
        if (f.situacao === 'encerrado' && e.aberto) return false;
        if (f.itemId && !(e.itens || []).some(i => i.itemId === f.itemId)) return false;
        if (f.ano === 'sem' && e.data) return false;
        if (f.ano && f.ano !== 'sem' && (e.data || '').slice(0, 4) !== f.ano) return false;
        if (f.semContato && !semContatoRecente(e)) return false;
        if (busca) {
            const campos = [e.nome, e.telefone, e.endereco, e.bairro, e.responsavel, e.obs, ...(e.itens || []).map(i => i.nome)];
            const digitos = busca.replace(/\D/g, '');
            const achou = campos.some(v => normalizar(v).includes(busca)) ||
                (digitos.length >= 4 && String(e.telefone || '').replace(/\D/g, '').includes(digitos));
            if (!achou) return false;
        }
        return true;
    });
}

function renderListaEmprestimos() {
    const lista = emprestimosFiltrados();
    const tbody = document.getElementById('table-emprestimos');
    document.getElementById('emp-contagem').textContent = `${formatarQtd(lista.length)} empréstimo${lista.length === 1 ? '' : 's'}`;

    if (!lista.length) {
        tbody.innerHTML = vazio(6, emprestimos.length ? 'ph-funnel-x' : 'ph-wheelchair',
            !empCarregado ? 'Carregando...' : emprestimos.length ? 'Nenhum empréstimo com esses filtros.' : 'Nenhum empréstimo registrado ainda.');
    } else {
        tbody.innerHTML = lista.slice(0, empLimite).map(linhaEmprestimo).join('');
    }
    const restantes = lista.length - empLimite;
    document.getElementById('emp-mais').innerHTML = restantes > 0
        ? `<button class="btn btn-secondary btn-sm" onclick="empLimite += EMP_POR_PAGINA; renderListaEmprestimos()">Mostrar mais (${formatarQtd(restantes)} restantes)</button>`
        : '';
}

function linhaEmprestimo(e) {
    const ultimo = ultimoContato(e);
    const equipamentos = (e.itens || []).map(i => {
        const s = SITUACOES_ITEM[i.situacao] || SITUACOES_ITEM.EM_USO;
        return `<span class="badge ${s.badge}" title="${esc(s.label)}"><i class="ph ${s.icone}"></i> ${qtdTexto(i)}</span>`;
    }).join(' ');
    const alerta = semContatoRecente(e) ? ' <i class="ph ph-phone-x alerta-contato" title="Sem contato há mais de 90 dias"></i>' : '';
    return `
        <tr class="clicavel" onclick="abrirDetalhe('${esc(e.id)}')">
            <td class="nowrap num">${e.data ? formatarData(e.data) : '<small>sem data</small>'}</td>
            <td><strong>${esc(e.nome)}</strong><span class="cell-sub">${esc(e.telefone || 'sem telefone')}</span></td>
            <td>${esc(e.bairro || '-')}${e.endereco ? `<span class="cell-sub">${esc(e.endereco)}</span>` : ''}</td>
            <td class="equip-badges">${equipamentos || '-'}</td>
            <td>${ultimo ? `${esc(RESULTADOS_CONTATO[ultimo.resultado] || ultimo.resultado)}<span class="cell-sub">${ultimo.data ? formatarData(ultimo.data) : 'sem data'}${ultimo.usuarioNome ? ' · ' + esc(ultimo.usuarioNome) : ''}</span>` : '<small>nenhum</small>'}${alerta}</td>
            <td class="right"><button class="icon-btn" title="Abrir" onclick="event.stopPropagation(); abrirDetalhe('${esc(e.id)}')"><i class="ph ph-caret-right"></i></button></td>
        </tr>`;
}

function renderSugestoesEmprestimo() {
    const preencher = (id, valores) => {
        const unicos = [...new Set(valores.map(v => String(v || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        document.getElementById(id).innerHTML = unicos.map(v => `<option value="${esc(v)}"></option>`).join('');
    };
    preencher('lista-emp-nomes', emprestimos.map(e => e.nome));
    preencher('lista-emp-bairros', emprestimos.map(e => e.bairro));
}

// ----------------------------------------------------
// NOVO EMPRÉSTIMO
// ----------------------------------------------------
function opcoesEquipamentos(selecionado) {
    const lista = itensEmprestaveis();
    if (!lista.length) return '<option value="">Nenhum equipamento cadastrado</option>';
    const saldos = calcularSaldos();
    return '<option value="">Selecione o equipamento...</option>' + lista.map(i =>
        `<option value="${esc(i.id)}" ${i.id === selecionado ? 'selected' : ''}>${esc(i.nome)} (${formatarQtd(Math.max(0, saldos[i.id] || 0))} disponíve${(saldos[i.id] || 0) === 1 ? 'l' : 'is'})</option>`
    ).join('');
}

function adicionarLinhaEmprestimo() {
    const box = document.getElementById('emp-linhas');
    const linha = document.createElement('div');
    linha.className = 'line';
    linha.innerHTML = `
        <select class="form-control linha-item" aria-label="Equipamento" onchange="renderLinhasEmprestimo()">${opcoesEquipamentos('')}</select>
        <div class="qty">
            <input type="number" class="form-control linha-qtd" aria-label="Quantidade" min="1" step="1" value="1" oninput="renderLinhasEmprestimo()">
            <span class="linha-unidade"></span>
        </div>
        <button type="button" class="icon-btn danger" title="Remover" onclick="removerLinhaEmprestimo(this)"><i class="ph ph-x"></i></button>
        <div class="line-info"></div>`;
    box.appendChild(linha);
    renderLinhasEmprestimo();
    if (box.children.length > 1) linha.querySelector('select').focus();
}

function removerLinhaEmprestimo(botao) {
    const box = document.getElementById('emp-linhas');
    if (box.children.length === 1) {
        box.querySelector('.linha-item').value = '';
        box.querySelector('.linha-qtd').value = 1;
    } else {
        botao.closest('.line').remove();
    }
    renderLinhasEmprestimo();
}

function lerLinhasEmprestimo() {
    return [...document.querySelectorAll('#emp-linhas .line')].map(el => ({
        el,
        itemId: el.querySelector('.linha-item').value,
        qtd: parseInt(el.querySelector('.linha-qtd').value, 10)
    }));
}

function renderLinhasEmprestimo() {
    const box = document.getElementById('emp-linhas');
    if (!box) return;
    if (!box.children.length) { adicionarLinhaEmprestimo(); return; }
    const saldos = calcularSaldos();
    const linhas = lerLinhasEmprestimo();
    const pedido = {};
    linhas.forEach(l => { if (l.itemId && l.qtd > 0) pedido[l.itemId] = (pedido[l.itemId] || 0) + l.qtd; });

    linhas.forEach(l => {
        const select = l.el.querySelector('.linha-item');
        select.innerHTML = opcoesEquipamentos(l.itemId);
        if (l.itemId && !itensEmprestaveis().some(i => i.id === l.itemId)) select.value = '';
        const item = getItem(select.value);
        l.el.querySelector('.linha-unidade').textContent = item ? item.unidade : '';
        const info = l.el.querySelector('.line-info');
        info.className = 'line-info';
        info.textContent = '';
        if (item) {
            const saldo = saldos[item.id] || 0;
            info.textContent = `Disponível no galpão: ${formatarQtd(Math.max(0, saldo))} ${item.unidade}`;
            if ((pedido[item.id] || 0) > saldo) {
                info.textContent += ' — não há essa quantidade disponível';
                info.classList.add('erro');
            }
        }
    });

    const validas = linhas.filter(l => l.itemId && l.qtd > 0).length;
    document.getElementById('emp-resumo').textContent = validas
        ? `${formatarQtd(validas)} equipamento${validas === 1 ? '' : 's'} neste empréstimo.`
        : 'Escolha pelo menos um equipamento.';
    const semEquip = !itensEmprestaveis().length;
    document.getElementById('emp-sem-equip').style.display = semEquip ? '' : 'none';
}

// Ao escolher um nome que já pegou emprestado antes, completa o que estiver em branco
function preencherPessoaConhecida() {
    const nome = normalizar(document.getElementById('emp-nome').value);
    if (!nome) return;
    const anterior = emprestimos.find(e => normalizar(e.nome) === nome);
    if (!anterior) return;
    [['emp-telefone', 'telefone'], ['emp-endereco', 'endereco'], ['emp-bairro', 'bairro']].forEach(([id, campo]) => {
        const el = document.getElementById(id);
        if (!el.value.trim() && anterior[campo]) el.value = anterior[campo];
    });
    const abertos = emprestimos.filter(e => e.aberto && normalizar(e.nome) === nome);
    const aviso = document.getElementById('emp-pessoa-aviso');
    if (abertos.length) {
        aviso.innerHTML = `<i class="ph ph-info"></i> Esta pessoa já está com ${abertos.map(e => itensEmUso(e).map(qtdTexto).join(', ')).join('; ')}.`;
        aviso.style.display = '';
    } else {
        aviso.style.display = 'none';
    }
}

function ligarFormEmprestimo() {
    const form = document.getElementById('form-emprestimo');
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const linhas = lerLinhasEmprestimo().filter(l => l.itemId);
        if (!linhas.length) {
            toast('Escolha pelo menos um equipamento.', 'erro');
            return;
        }
        if (linhas.some(l => !(l.qtd > 0))) {
            toast('Informe quantidades inteiras maiores que zero.', 'erro');
            return;
        }
        const pedido = {};
        linhas.forEach(l => pedido[l.itemId] = (pedido[l.itemId] || 0) + l.qtd);
        const saldos = calcularSaldos();
        const faltando = Object.entries(pedido).filter(([id, qtd]) => qtd > (saldos[id] || 0));
        if (faltando.length) {
            await avisar('Equipamento indisponível', '<ul>' + faltando.map(([id, qtd]) => {
                const item = getItem(id);
                return `<li><strong>${esc(item.nome)}</strong>: pedido ${formatarQtd(qtd)}, disponível ${formatarQtd(Math.max(0, saldos[id] || 0))}</li>`;
            }).join('') + '</ul><p style="margin-top:.6rem">Se o galpão tem esse equipamento, registre a quantidade na aba <strong>Inventário</strong> antes de emprestar.</p>');
            return;
        }

        const valor = (id) => document.getElementById(id).value.trim();
        const user = usuarioAtual();
        const ref = db.collection(EMP_COLLECTION).doc();
        const data = valor('emp-data');
        const nome = valor('emp-nome');
        const itensEmp = Object.entries(pedido).map(([itemId, qtd]) => {
            const item = getItem(itemId);
            return { itemId, nome: item.nome, unidade: item.unidade || '', qtd, situacao: 'EM_USO', resolvidoEm: null };
        });
        const emprestimo = {
            data,
            nome,
            telefone: valor('emp-telefone'),
            endereco: valor('emp-endereco'),
            bairro: valor('emp-bairro'),
            responsavel: valor('emp-responsavel'),
            obs: valor('emp-obs'),
            itens: itensEmp,
            aberto: true,
            contatos: [],
            origem: 'sistema',
            ...user,
            criadoEm: firebase.firestore.FieldValue.serverTimestamp(),
            atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
        };

        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            const batch = db.batch();
            batch.set(ref, emprestimo);
            itensEmp.forEach(i => batch.set(db.collection(MOV_COLLECTION).doc(), montarMovimentacao({
                tipo: 'SAIDA',
                itemId: i.itemId,
                qtd: i.qtd,
                data,
                origemDestino: nome,
                motivo: MOTIVO_EMPRESTIMO,
                obs: 'Empréstimo',
                lote: ref.id
            })));
            await batch.commit();
            form.reset();
            document.getElementById('emp-data').value = hojeISO();
            document.getElementById('emp-linhas').innerHTML = '';
            document.getElementById('emp-pessoa-aviso').style.display = 'none';
            adicionarLinhaEmprestimo();
            toast(`Empréstimo registrado para ${nome}.`);
            switchTab('emprestimos');
            abrirDetalhe(ref.id);
        } catch (err) {
            console.error('Erro ao registrar empréstimo:', err);
            toast(erroEmprestimo(err), 'erro');
        } finally {
            btn.disabled = false;
        }
    });
}

// ----------------------------------------------------
// DETALHE DO EMPRÉSTIMO
// ----------------------------------------------------
function abrirDetalhe(id) {
    empDetalheId = id;
    empDetalheEsperando = !getEmprestimo(id);
    renderDetalhe();
    abrirOverlay('modal-detalhe');
}

function fecharDetalhe() {
    empDetalheId = null;
    fecharOverlay('modal-detalhe');
}

function renderDetalhe() {
    const e = getEmprestimo(empDetalheId);
    const corpo = document.getElementById('detalhe-corpo');
    if (!e) {
        if (empDetalheEsperando) {
            document.getElementById('detalhe-titulo').textContent = 'Carregando...';
            document.getElementById('detalhe-badge').innerHTML = '';
            corpo.innerHTML = '';
            document.getElementById('detalhe-devolver').style.display = 'none';
        } else if (empDetalheId) {
            fecharDetalhe(); // foi excluído
        }
        return;
    }
    empDetalheEsperando = false;
    const linhaInfo = (rotulo, valor) => `<div><dt>${rotulo}</dt><dd>${valor || '-'}</dd></div>`;
    const contatos = [...(e.contatos || [])].reverse();
    const temEmUso = itensEmUso(e).length > 0;

    document.getElementById('detalhe-titulo').textContent = e.nome;
    document.getElementById('detalhe-badge').innerHTML = badgeEmprestimo(e);
    corpo.innerHTML = `
        <dl class="info-grid">
            ${linhaInfo('Retirada', e.data ? formatarData(e.data) : 'sem data')}
            ${linhaInfo('Telefone', linkTelefone(e.telefone))}
            ${linhaInfo('Endereço', esc(e.endereco))}
            ${linhaInfo('Bairro', esc(e.bairro))}
            ${linhaInfo('Responsável', esc(e.responsavel))}
            ${linhaInfo('Registrado por', esc(e.usuarioNome) + (e.origem === 'planilha' ? ' <small>(importado da planilha)</small>' : ''))}
        </dl>
        ${e.obs ? `<p class="detalhe-obs"><i class="ph ph-note"></i> ${esc(e.obs)}</p>` : ''}
        ${e.planilha ? `<p class="hint">Planilha: aba ${esc(e.planilha.aba)}, linha ${esc(e.planilha.linha)}${e.planilha.status ? `, status "${esc(e.planilha.status)}"` : ''}${e.planilha.dataOriginal ? `, data original "${esc(e.planilha.dataOriginal)}"` : ''}.</p>` : ''}

        <h4 class="detalhe-sub"><i class="ph ph-wheelchair"></i> Equipamentos</h4>
        <div class="table-wrap">
            <table>
                <tbody>
                    ${(e.itens || []).map(i => `
                        <tr>
                            <td><strong>${qtdTexto(i)}</strong></td>
                            <td>${badgeSituacaoItem(i.situacao)}</td>
                            <td class="right"><small>${[i.resolvidoEm ? formatarData(i.resolvidoEm) : '', i.resolvidoPor, i.obs].filter(Boolean).map(esc).join(' · ')}</small></td>
                        </tr>`).join('') || vazio(3, 'ph-wheelchair', 'Nenhum equipamento.')}
                </tbody>
            </table>
        </div>

        <h4 class="detalhe-sub"><i class="ph ph-phone"></i> Contatos</h4>
        <ul class="feed contatos">
            ${contatos.length ? contatos.map(c => `
                <li>
                    <div class="feed-icon"><i class="ph ${['NAO_ATENDEU', 'SEM_TELEFONE', 'TELEFONE_ERRADO'].includes(c.resultado) ? 'ph-phone-x' : 'ph-phone'}"></i></div>
                    <div class="feed-body">
                        <div class="feed-title">${esc(RESULTADOS_CONTATO[c.resultado] || c.resultado)}</div>
                        <div class="feed-sub">${[c.data ? formatarData(c.data) : 'sem data', c.usuarioNome].filter(Boolean).map(esc).join(' · ')}${c.obs ? ' — ' + esc(c.obs) : ''}</div>
                    </div>
                </li>`).join('') : '<li class="vazio" style="display:block"><i class="ph ph-phone"></i>Nenhum contato registrado.</li>'}
        </ul>`;

    document.getElementById('detalhe-devolver').style.display = temEmUso ? '' : 'none';
}

function abrirOverlay(id) {
    const el = document.getElementById(id);
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
}

function fecharOverlay(id) {
    const el = document.getElementById(id);
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
}

// Esc fecha a janela de cima (o modal de confirmação cuida de si mesmo)
document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || document.getElementById('modal').classList.contains('open')) return;
    if (document.getElementById('modal-acao').classList.contains('open')) fecharAcao();
    else if (document.getElementById('modal-detalhe').classList.contains('open')) fecharDetalhe();
});

// ----------------------------------------------------
// JANELA DE AÇÃO (devolução, contato, edição, importação)
// ----------------------------------------------------
let acaoAoEnviar = null;

function abrirAcao({ titulo, icone = 'ph-pencil-simple', corpo, botao = 'Salvar', aoEnviar, largo = false }) {
    document.getElementById('acao-titulo').textContent = titulo;
    document.getElementById('acao-icone').innerHTML = `<i class="ph ${icone}"></i>`;
    document.getElementById('acao-corpo').innerHTML = corpo;
    document.getElementById('acao-ok').innerHTML = botao;
    document.getElementById('acao-ok').disabled = false;
    document.getElementById('form-acao').classList.toggle('largo', largo);
    acaoAoEnviar = aoEnviar;
    abrirOverlay('modal-acao');
    const primeiro = document.querySelector('#acao-corpo input:not([type=hidden]), #acao-corpo select, #acao-corpo textarea');
    if (primeiro) primeiro.focus();
}

function fecharAcao() {
    acaoAoEnviar = null;
    fecharOverlay('modal-acao');
}

function ligarFormAcao() {
    document.getElementById('form-acao').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!acaoAoEnviar) return;
        const btn = document.getElementById('acao-ok');
        btn.disabled = true;
        try {
            const fechar = await acaoAoEnviar();
            if (fechar !== false) fecharAcao();
        } catch (err) {
            console.error('Erro ao salvar:', err);
            toast(erroEmprestimo(err), 'erro');
        } finally {
            btn.disabled = false;
        }
    });
    document.getElementById('modal-acao').addEventListener('click', (ev) => {
        if (ev.target.id === 'modal-acao') fecharAcao();
    });
    document.getElementById('modal-detalhe').addEventListener('click', (ev) => {
        if (ev.target.id === 'modal-detalhe') fecharDetalhe();
    });
}

function campoData(id, rotulo, valor = hojeISO()) {
    return `<div class="field"><label for="${id}">${rotulo}</label><input type="date" id="${id}" class="form-control" value="${esc(valor || '')}" required></div>`;
}

// ---------- Devolução ----------
function abrirDevolucao() {
    const e = getEmprestimo(empDetalheId);
    if (!e) return;
    const pendentes = (e.itens || []).map((i, idx) => ({ ...i, idx })).filter(i => i.situacao === 'EM_USO');
    if (!pendentes.length) return;
    abrirAcao({
        titulo: 'Registrar devolução',
        icone: 'ph-arrow-u-down-left',
        botao: '<i class="ph ph-check-circle"></i> Registrar',
        corpo: `
            <p class="modal-body">Equipamentos de <strong>${esc(e.nome)}</strong>. O que voltar para o galpão entra de novo no estoque.</p>
            ${campoData('dev-data', 'Data')}
            <div class="dev-itens">
                ${pendentes.map(i => `
                    <div class="dev-item">
                        <span><strong>${qtdTexto(i)}</strong></span>
                        <select class="form-control sm" data-idx="${i.idx}" aria-label="O que aconteceu com ${esc(i.nome)}">
                            <option value="DEVOLVIDO" selected>Devolvido</option>
                            <option value="EM_USO">Continua em uso</option>
                            <option value="DOADO">Ficou com a pessoa</option>
                            <option value="NAO_LOCALIZADO">Não localizado</option>
                        </select>
                    </div>`).join('')}
            </div>
            <div class="field"><label for="dev-obs">Observação (opcional)</label><input type="text" id="dev-obs" class="form-control" placeholder="Ex: devolvido pela filha"></div>`,
        aoEnviar: () => salvarDevolucao(e.id)
    });
}

async function salvarDevolucao(id) {
    const e = getEmprestimo(id);
    if (!e) return;
    const data = document.getElementById('dev-data').value;
    const obs = document.getElementById('dev-obs').value.trim();
    const user = usuarioAtual();
    const novos = (e.itens || []).map(i => ({ ...i }));
    const mudancas = [];
    document.querySelectorAll('.dev-itens select').forEach(sel => {
        const i = novos[Number(sel.dataset.idx)];
        if (sel.value !== 'EM_USO') {
            i.situacao = sel.value;
            i.resolvidoEm = data;
            i.resolvidoPor = user.usuarioNome;
            if (obs) i.obs = obs;
            mudancas.push(i);
        }
    });
    if (!mudancas.length) {
        toast('Nada mudou: todos continuam em uso.', 'info');
        return false;
    }
    const batch = db.batch();
    const atualizacao = {
        itens: novos,
        aberto: novos.some(i => i.situacao === 'EM_USO'),
        atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
    };
    batch.update(db.collection(EMP_COLLECTION).doc(id), atualizacao);
    mudancas.filter(i => i.situacao === 'DEVOLVIDO' && i.itemId && getItem(i.itemId)).forEach(i => {
        batch.set(db.collection(MOV_COLLECTION).doc(), montarMovimentacao({
            tipo: 'ENTRADA',
            itemId: i.itemId,
            qtd: Number(i.qtd),
            data,
            origemDestino: `Devolução · ${e.nome}`,
            motivo: MOTIVO_DEVOLUCAO,
            obs: obs || 'Devolução de empréstimo',
            lote: id
        }));
    });
    await batch.commit();
    toast(atualizacao.aberto ? 'Devolução parcial registrada.' : 'Devolução registrada. Empréstimo encerrado.');
}

// ---------- Contato ----------
function abrirContato() {
    const e = getEmprestimo(empDetalheId);
    if (!e) return;
    abrirAcao({
        titulo: 'Registrar contato',
        icone: 'ph-phone',
        corpo: `
            <p class="modal-body">Ligação ou mensagem para <strong>${esc(e.nome)}</strong> (${linkTelefone(e.telefone)}).</p>
            ${campoData('cont-data', 'Data')}
            <div class="field">
                <label for="cont-resultado">Resultado</label>
                <select id="cont-resultado" class="form-control" required>
                    ${Object.entries(RESULTADOS_CONTATO).map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}
                </select>
            </div>
            <div class="field"><label for="cont-obs">Observação (opcional)</label><input type="text" id="cont-obs" class="form-control" placeholder="Ex: filha atendeu, devolve semana que vem"></div>`,
        aoEnviar: async () => {
            const contato = {
                data: document.getElementById('cont-data').value,
                resultado: document.getElementById('cont-resultado').value,
                obs: document.getElementById('cont-obs').value.trim(),
                ...usuarioAtual()
            };
            await db.collection(EMP_COLLECTION).doc(e.id).update({
                contatos: [...(e.contatos || []), contato],
                atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
            });
            toast('Contato registrado.');
        }
    });
}

// ---------- Edição dos dados ----------
function abrirEdicao() {
    const e = getEmprestimo(empDetalheId);
    if (!e) return;
    const campo = (id, rotulo, valor, extra = '') =>
        `<div class="field"><label for="${id}">${rotulo}</label><input type="text" id="${id}" class="form-control" value="${esc(valor || '')}" ${extra}></div>`;
    abrirAcao({
        titulo: 'Editar dados',
        icone: 'ph-pencil-simple',
        largo: true,
        corpo: `
            <div class="form-grid">
                <div class="field"><label for="ed-data">Data da retirada</label><input type="date" id="ed-data" class="form-control" value="${esc(e.data || '')}"></div>
                ${campo('ed-nome', 'Nome', e.nome, 'required')}
                ${campo('ed-telefone', 'Telefone', e.telefone, 'inputmode="tel"')}
                ${campo('ed-endereco', 'Endereço', e.endereco)}
                ${campo('ed-bairro', 'Bairro', e.bairro, 'list="lista-emp-bairros"')}
                ${campo('ed-responsavel', 'Responsável', e.responsavel)}
            </div>
            ${campo('ed-obs', 'Observação', e.obs)}
            <p class="hint">Para mudar os equipamentos, use "Registrar devolução" ou exclua e registre de novo.</p>`,
        aoEnviar: async () => {
            const v = (id) => document.getElementById(id).value.trim();
            await db.collection(EMP_COLLECTION).doc(e.id).update({
                data: v('ed-data') || null,
                nome: v('ed-nome'),
                telefone: v('ed-telefone'),
                endereco: v('ed-endereco'),
                bairro: v('ed-bairro'),
                responsavel: v('ed-responsavel'),
                obs: v('ed-obs'),
                atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
            });
            toast('Dados atualizados.');
        }
    });
}

// ---------- Exclusão (só Administrador/Gestor) ----------
async function excluirEmprestimo() {
    const e = getEmprestimo(empDetalheId);
    if (!e || !ehGestor()) return;
    const movs = movimentacoes.filter(m => m.lote === e.id);
    const confirmou = await confirmar({
        titulo: 'Excluir empréstimo?',
        html: `<p>Empréstimo de <strong>${esc(e.nome)}</strong>${e.data ? ` em ${formatarData(e.data)}` : ''}.</p>
               ${movs.length ? `<p style="margin-top:.5rem">Os ${formatarQtd(movs.length)} lançamentos de estoque dele também serão excluídos e o saldo será recalculado.</p>` : ''}`,
        botao: 'Excluir',
        perigo: true,
        icone: 'ph-trash'
    });
    if (!confirmou) return;
    try {
        const batch = db.batch();
        batch.delete(db.collection(EMP_COLLECTION).doc(e.id));
        movs.forEach(m => batch.delete(db.collection(MOV_COLLECTION).doc(m.id)));
        await batch.commit();
        fecharDetalhe();
        toast('Empréstimo excluído.');
    } catch (err) {
        console.error('Erro ao excluir empréstimo:', err);
        toast(erroEmprestimo(err), 'erro');
    }
}

// ----------------------------------------------------
// EXPORTAR EXCEL (uma aba por ano, como a planilha original)
// ----------------------------------------------------
async function exportarEmprestimos() {
    const lista = emprestimosFiltrados();
    if (!lista.length) {
        toast('Nenhum empréstimo para exportar com esses filtros.', 'info');
        return;
    }
    try {
        await carregarScript(EXCELJS_URL);
        const wb = new ExcelJS.Workbook();
        const estilo = (ws) => {
            ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B4C7E' } };
            ws.views = [{ state: 'frozen', ySplit: 1 }];
        };
        const nomesEquip = [...new Set(lista.flatMap(e => (e.itens || []).map(i => i.nome)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

        const porAno = new Map();
        lista.forEach(e => {
            const ano = (e.data || '').slice(0, 4) || 'Sem data';
            if (!porAno.has(ano)) porAno.set(ano, []);
            porAno.get(ano).push(e);
        });
        [...porAno.keys()].sort().forEach(ano => {
            const ws = wb.addWorksheet(ano);
            ws.columns = [
                { header: 'Data', key: 'data', width: 12 },
                { header: 'Nome', key: 'nome', width: 34 },
                { header: 'Telefone', key: 'telefone', width: 17 },
                { header: 'Endereço', key: 'endereco', width: 34 },
                { header: 'Bairro', key: 'bairro', width: 20 },
                ...nomesEquip.map((n, k) => ({ header: n, key: 'eq' + k, width: Math.max(10, n.length + 2) })),
                { header: 'Situação', key: 'situacao', width: 36 },
                { header: 'Último contato', key: 'contato', width: 34 },
                { header: 'Responsável', key: 'responsavel', width: 22 },
                { header: 'Observação', key: 'obs', width: 44 }
            ];
            [...porAno.get(ano)].sort((a, b) => (a.data || '').localeCompare(b.data || '')).forEach(e => {
                const linha = {
                    data: e.data ? formatarData(e.data) : '',
                    nome: e.nome,
                    telefone: e.telefone || '',
                    endereco: e.endereco || '',
                    bairro: e.bairro || '',
                    situacao: (e.itens || []).map(i => `${i.nome}: ${(SITUACOES_ITEM[i.situacao] || SITUACOES_ITEM.EM_USO).label}${i.resolvidoEm ? ' em ' + formatarData(i.resolvidoEm) : ''}`).join('; '),
                    responsavel: e.responsavel || '',
                    obs: e.obs || ''
                };
                const ultimo = ultimoContato(e);
                linha.contato = ultimo ? `${ultimo.data ? formatarData(ultimo.data) : 'sem data'} · ${RESULTADOS_CONTATO[ultimo.resultado] || ultimo.resultado}${ultimo.usuarioNome ? ' · ' + ultimo.usuarioNome : ''}` : '';
                nomesEquip.forEach((n, k) => {
                    const qtd = (e.itens || []).filter(i => i.nome === n).reduce((s, i) => s + Number(i.qtd || 0), 0);
                    if (qtd) linha['eq' + k] = qtd;
                });
                ws.addRow(linha);
            });
            estilo(ws);
            ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
        });

        const wsCont = wb.addWorksheet('Contatos');
        wsCont.columns = [
            { header: 'Data', key: 'data', width: 12 },
            { header: 'Munícipe', key: 'nome', width: 34 },
            { header: 'Telefone', key: 'telefone', width: 17 },
            { header: 'Resultado', key: 'resultado', width: 28 },
            { header: 'Observação', key: 'obs', width: 44 },
            { header: 'Quem ligou', key: 'por', width: 22 }
        ];
        lista.flatMap(e => (e.contatos || []).map(c => ({ e, c })))
            .sort((a, b) => (b.c.data || '').localeCompare(a.c.data || ''))
            .forEach(({ e, c }) => wsCont.addRow({
                data: c.data ? formatarData(c.data) : '', nome: e.nome, telefone: e.telefone || '',
                resultado: RESULTADOS_CONTATO[c.resultado] || c.resultado, obs: c.obs || '', por: c.usuarioNome || ''
            }));
        estilo(wsCont);

        const saldos = calcularSaldos();
        const emUso = emprestadoPorItem();
        const wsEq = wb.addWorksheet('Equipamentos');
        wsEq.columns = [
            { header: 'Equipamento', key: 'nome', width: 26 },
            { header: 'Disponível no galpão', key: 'disp', width: 20 },
            { header: 'Emprestado', key: 'fora', width: 12 }
        ];
        itensEmprestaveis().forEach(i => wsEq.addRow({ nome: i.nome, disp: Math.max(0, saldos[i.id] || 0), fora: emUso[i.id] || 0 }));
        estilo(wsEq);

        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `emprestimos-${hojeISO()}.xlsx`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        toast(`Planilha gerada com ${formatarQtd(lista.length)} empréstimos.`);
    } catch (err) {
        console.error('Erro ao exportar empréstimos:', err);
        toast('Não foi possível gerar a planilha. Verifique a conexão.', 'erro');
    }
}

// ----------------------------------------------------
// IMPORTAR A PLANILHA ANTIGA (só Administrador/Gestor)
// ----------------------------------------------------
// Lê as abas com nome de ano (2022, 2023...). Cabeçalho: DATA, NOME, TELEFONE,
// ENDEREÇO, BAIRRO, uma coluna por equipamento, STATUS, OBSERVAÇÃO. Linhas de
// total e de legenda (sem nome ou sem equipamento) ficam de fora. O id de cada
// empréstimo vem da aba e da linha, então importar de novo pula o que já entrou.

function valorCelula(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
        if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
        if ('result' in v) return valorCelula(v.result);
        if ('text' in v) return v.text;
        if ('error' in v) return null;
    }
    return v;
}

function textoCelula(v) {
    const valor = valorCelula(v);
    if (valor === null) return '';
    if (valor instanceof Date) return formatarData(isoDeUTC(valor));
    return String(valor).replace(/\s+/g, ' ').trim();
}

function isoDeUTC(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Devolve { iso, original } — "original" só quando a data foi corrigida ou deduzida
function lerDataPlanilha(v, anoAba) {
    const valor = valorCelula(v);
    if (valor === null || valor === '') return { iso: null, original: '' };
    let a, m, d, original = '';
    if (valor instanceof Date) {
        a = valor.getUTCFullYear(); m = valor.getUTCMonth() + 1; d = valor.getUTCDate();
    } else {
        const txt = String(valor).trim();
        const partes = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
        const mes = MESES.indexOf(normalizar(txt));
        if (partes) {
            d = +partes[1]; m = +partes[2]; a = +partes[3] < 100 ? 2000 + +partes[3] : +partes[3];
        } else if (mes >= 0 && anoAba) {
            a = anoAba; m = mes + 1; d = 1; original = txt;
        } else {
            return { iso: null, original: txt };
        }
    }
    // Ano diferente do da aba: vale o da aba (ex.: aba 2022 com datas digitadas como 2023)
    if (anoAba && a !== anoAba) {
        original = original || `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}`;
        a = anoAba;
    }
    return { iso: `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, original };
}

function nomeEquipamento(cabecalho) {
    const t = String(cabecalho).toLowerCase().replace(/\s+/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
}

function chaveEquipamento(nome) {
    return normalizar(nome).replace(/s$/, '');
}

// Status da planilha -> situação dos equipamentos e resultado da última ligação
function interpretarStatus(statusBruto, obs) {
    const st = normalizar(statusBruto).replace(/\s+/g, ' ');
    const o = normalizar(obs);
    let situacao = 'EM_USO';
    let contato = null;
    if (st === 'devolvido' || st === 'devolvida') situacao = 'DEVOLVIDO';
    else if (st === 'doacao' || st === 'isento') situacao = 'DOADO';
    else if (st === 'em uso') contato = 'EM_USO';
    else if (st === 'a devolver') contato = 'VAI_DEVOLVER';
    else if (st === 's/i') contato = 'SEM_INFORMACAO';
    else if (st === 'n/a') contato = 'NAO_ATENDEU';
    else if (st === 's/t') contato = 'SEM_TELEFONE';
    else if (!st && /^devolv(id[oa]s?|eu) em/.test(o)) situacao = 'DEVOLVIDO';

    if (contato && contato !== 'EM_USO' && contato !== 'VAI_DEVOLVER') {
        if (o.includes('telefone errado')) contato = 'TELEFONE_ERRADO';
        else if (o.includes('sem telefone')) contato = 'SEM_TELEFONE';
        else if (o.includes('nao atendeu')) contato = 'NAO_ATENDEU';
    }
    return { situacao, contato };
}

// "DEVOLVIDO EM: 16/12/2022", "DEVOLVEU EM: 17/06", "DEVOLVIDA EM: 01/2026", "26/03/25".
// Sem ano: o da retirada (ou o seguinte, se ficaria antes da retirada).
function dataDevolucao(texto, dataRetirada) {
    const t = normalizar(texto);
    const m = t.match(/devolv(?:id[oa]s?|eu)\s+em:?\s*(\d{1,2})\/(\d{1,4})(?:\/(\d{2,4}))?/);
    if (!m) return null;
    let d, mes, a;
    if (!m[3] && m[2].length === 4) { d = 1; mes = +m[1]; a = +m[2]; }
    else {
        d = +m[1]; mes = +m[2];
        a = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null;
    }
    if (!(mes >= 1 && mes <= 12 && d >= 1 && d <= 31)) return null;
    const iso = (ano) => `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!a) {
        if (!dataRetirada) return null;
        a = Number(dataRetirada.slice(0, 4));
        if (iso(a) < dataRetirada) a++;
    }
    return iso(a);
}

// Observação que diz qual equipamento voltou: "CADEIRA DE BANHO DEVOLVIDA EM: 19/02/2026",
// "ANDADOR E CADEIRA DE BANHO DEVOLVIDOS EM: 01/2026"
function devolvidoNaObs(obs, nomeItem) {
    const t = normalizar(obs);
    const k = t.search(/devolvid/);
    return k > 0 && t.slice(0, k).includes(chaveEquipamento(nomeItem));
}

function limparTelefone(tel) {
    const t = String(tel || '').trim();
    if (!t || /^x+$/i.test(t) || t === '-' || /localizado|n\/i/i.test(t)) return '';
    return t.replace(/\s{2,}/g, ' / ');
}

function limparTexto(t) {
    const s = String(t || '').trim();
    return /^(n\/i|n\/a|-)$/i.test(s) ? '' : s;
}

function capitalizarNome(t) {
    return String(t || '').toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
}

function lerPlanilhaEmprestimos(wb) {
    const registros = [];
    const ignoradas = [];
    const equipamentos = new Map(); // chave -> nome bonito

    wb.worksheets.forEach(ws => {
        const anoAba = /^\d{4}$/.test(ws.name.trim()) ? Number(ws.name.trim()) : null;
        if (!anoAba) return;

        // Cabeçalho: a primeira linha (até a 6ª) que tem "NOME"
        let linhaCab = 0;
        for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
            const row = ws.getRow(r);
            for (let c = 1; c <= row.cellCount; c++) {
                if (normalizar(textoCelula(row.getCell(c).value)) === 'nome') { linhaCab = r; break; }
            }
            if (linhaCab) break;
        }
        if (!linhaCab) return;

        const col = {};
        const colEquip = [];
        const cab = ws.getRow(linhaCab);
        for (let c = 1; c <= cab.cellCount; c++) {
            const h = normalizar(textoCelula(cab.getCell(c).value));
            if (!h) continue;
            if (h === 'data') col.data = c;
            else if (h === 'nome') col.nome = c;
            else if (h === 'telefone') col.telefone = c;
            else if (h.startsWith('endereco')) col.endereco = c;
            else if (h === 'bairro') col.bairro = c;
            else if (h === 'status') col.status = c;
            else if (h.startsWith('observ')) col.obs = c;
            else {
                const nome = nomeEquipamento(textoCelula(cab.getCell(c).value));
                const chave = chaveEquipamento(nome);
                if (!equipamentos.has(chave)) equipamentos.set(chave, nome);
                colEquip.push({ c, chave });
            }
        }

        // Rodapé "ÚLTIMA LIGAÇÃO: dd/mm/aaaa (NOME)": data e quem ligou
        let ultimaLigacao = null;
        ws.eachRow((row) => {
            row.eachCell((cell) => {
                const m = normalizar(textoCelula(cell.value)).match(/ultima ligacao:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:\(([^)]+)\))?/i);
                if (m) ultimaLigacao = { data: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, por: capitalizarNome(m[4] || '') };
            });
        });

        for (let r = linhaCab + 1; r <= ws.rowCount; r++) {
            const row = ws.getRow(r);
            // Célula mesclada só vale na primeira (as outras repetem o mesmo texto)
            const cel = (c) => {
                if (!c) return null;
                const cell = row.getCell(c);
                return cell.isMerged && cell.master && cell.master.address !== cell.address ? null : cell.value;
            };
            const nome = textoCelula(cel(col.nome));
            const itensLinha = colEquip.map(({ c, chave }) => {
                const n = Number(valorCelula(row.getCell(c).value));
                return n > 0 ? { chave, qtd: Math.round(n) } : null;
            }).filter(Boolean);
            const temAlgo = [col.data, col.nome, col.telefone, col.status].some(c => textoCelula(cel(c)));
            if (!nome || /^ultima liga/.test(normalizar(nome))) {
                const anotacao = !nome && textoCelula(cel(col.data || 1));
                if (anotacao && anotacao.length > 30) ignoradas.push({ aba: ws.name, linha: r, motivo: 'anotação', texto: anotacao });
                else if (nome || itensLinha.length) ignoradas.push({ aba: ws.name, linha: r, motivo: nome ? 'rodapé' : 'linha de total, sem nome' });
                continue;
            }
            // Sem equipamento marcado, mas com nome e outros dados: entra como "não informado"
            if (!itensLinha.length && !temAlgo) continue;
            const semEquipamento = !itensLinha.length;
            if (semEquipamento) itensLinha.push({ chave: null, qtd: 1 });
            const status = textoCelula(cel(col.status));
            const obs = textoCelula(cel(col.obs));
            const { iso, original } = lerDataPlanilha(cel(col.data), anoAba);
            const { situacao, contato } = interpretarStatus(status, obs);
            const resolvidoEm = situacao === 'DEVOLVIDO' ? dataDevolucao(obs, iso) : null;
            const contatos = [];
            if (contato) {
                const dataLig = ultimaLigacao && (!iso || iso <= ultimaLigacao.data) ? ultimaLigacao : null;
                contatos.push({
                    data: dataLig ? dataLig.data : null,
                    resultado: contato,
                    obs: 'Importado da planilha',
                    usuarioId: null,
                    usuarioNome: dataLig ? dataLig.por : ''
                });
            }
            registros.push({
                id: `planilha-${ws.name.trim()}-${r}`,
                aba: ws.name.trim(),
                linha: r,
                data: iso,
                dataOriginal: original,
                nome,
                telefone: limparTelefone(textoCelula(cel(col.telefone))),
                endereco: limparTexto(textoCelula(cel(col.endereco))),
                bairro: limparTexto(textoCelula(cel(col.bairro))),
                status,
                obs,
                itens: itensLinha.map(i => {
                    // Status em branco, mas a observação diz que este equipamento voltou
                    if (situacao === 'EM_USO' && !status && i.chave && devolvidoNaObs(obs, equipamentos.get(i.chave))) {
                        return { ...i, situacao: 'DEVOLVIDO', resolvidoEm: dataDevolucao(obs, iso) };
                    }
                    return { ...i, situacao, resolvidoEm };
                }),
                semEquipamento,
                contatos
            });
        }
    });
    return { registros, ignoradas, equipamentos };
}

function escolherPlanilhaEmprestimos() {
    if (!ehGestor()) return;
    const input = document.getElementById('emp-arquivo');
    input.value = '';
    input.click();
}

async function importarPlanilhaEmprestimos(input) {
    const arquivo = input.files && input.files[0];
    if (!arquivo || !ehGestor()) return;
    let lido;
    try {
        await carregarScript(EXCELJS_URL);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await arquivo.arrayBuffer());
        lido = lerPlanilhaEmprestimos(wb);
    } catch (err) {
        console.error('Erro ao ler planilha:', err);
        toast('Não foi possível ler a planilha. Confira se é um arquivo .xlsx.', 'erro');
        return;
    }
    const { registros, ignoradas, equipamentos } = lido;
    if (!registros.length) {
        await avisar('Nada para importar', '<p>Não achei abas com nome de ano (2022, 2023...) e cabeçalho com NOME na planilha.</p>');
        return;
    }

    const jaImportados = new Set(emprestimos.map(e => e.id));
    const novos = registros.filter(r => !jaImportados.has(r.id));
    const repetidos = registros.length - novos.length;

    // Equipamentos: usa o item do estoque com o mesmo nome; cria os que faltam
    const porChave = new Map(itens.map(i => [chaveEquipamento(i.nome), i]));
    const criar = [...equipamentos].filter(([chave]) => !porChave.has(chave)).map(([, nome]) => nome);
    const marcar = [...equipamentos].map(([chave]) => porChave.get(chave)).filter(i => i && i.emprestimo !== true);

    const porAba = {};
    novos.forEach(r => porAba[r.aba] = (porAba[r.aba] || 0) + 1);
    const abertos = novos.filter(r => r.itens.some(i => i.situacao === 'EM_USO')).length;
    const corrigidas = novos.filter(r => r.dataOriginal).length;
    const semData = novos.filter(r => !r.data).length;
    const semEquip = novos.filter(r => r.semEquipamento).length;
    const puladas = ignoradas.filter(i => !i.texto);

    abrirAcao({
        titulo: 'Importar planilha de empréstimos',
        icone: 'ph-microsoft-excel-logo',
        largo: true,
        botao: novos.length ? `<i class="ph ph-upload-simple"></i> Importar ${formatarQtd(novos.length)}` : 'Fechar',
        corpo: `
            <div class="modal-body">
                <p><strong>${esc(arquivo.name)}</strong></p>
                <ul>
                    <li><strong>${formatarQtd(novos.length)}</strong> empréstimos novos${Object.keys(porAba).length ? ` (${Object.entries(porAba).map(([a, n]) => `${esc(a)}: ${n}`).join(', ')})` : ''}</li>
                    <li><strong>${formatarQtd(abertos)}</strong> ainda com algum equipamento fora; <strong>${formatarQtd(novos.length - abertos)}</strong> encerrados</li>
                    ${repetidos ? `<li>${formatarQtd(repetidos)} já foram importados antes e serão pulados</li>` : ''}
                    ${criar.length ? `<li>Equipamentos que serão criados no estoque: <strong>${criar.map(esc).join(', ')}</strong></li>` : ''}
                    ${marcar.length ? `<li>Itens do estoque que passam a aparecer em Empréstimos: ${marcar.map(i => esc(i.nome)).join(', ')}</li>` : ''}
                    ${corrigidas ? `<li>${formatarQtd(corrigidas)} datas com ano diferente da aba ou só com o mês: usei o ano da aba (a data original fica guardada)</li>` : ''}
                    ${semData ? `<li>${formatarQtd(semData)} sem data</li>` : ''}
                    ${semEquip ? `<li>${formatarQtd(semEquip)} sem nenhum equipamento marcado: entram como "${NAO_INFORMADO}"</li>` : ''}
                    ${puladas.length ? `<li>${formatarQtd(puladas.length)} linhas ignoradas (totais, legendas e rodapés): ${puladas.slice(0, 6).map(i => `${esc(i.aba)}, linha ${i.linha}`).join('; ')}${puladas.length > 6 ? '...' : ''}</li>` : ''}
                    ${ignoradas.filter(i => i.texto).map(i => `<li>Anotação na aba ${esc(i.aba)}, linha ${i.linha}, que não é um empréstimo e não será importada: <em>${esc(i.texto)}</em></li>`).join('')}
                </ul>
                <p style="margin-top:.6rem">A importação não mexe no saldo do estoque: conte os equipamentos do galpão em <strong>Inventário</strong> para saber quantos estão disponíveis.</p>
            </div>`,
        aoEnviar: async () => {
            if (!novos.length) return;
            await gravarImportacao(novos, criar, marcar, porChave);
            toast(`${formatarQtd(novos.length)} empréstimos importados.`);
        }
    });
}

async function gravarImportacao(novos, criar, marcar, porChave) {
    const user = usuarioAtual();
    const ops = [];
    criar.forEach(nome => {
        const ref = db.collection(ITENS_COLLECTION).doc();
        const item = {
            nome,
            categoria: CATEGORIA_EQUIPAMENTOS,
            unidade: chaveEquipamento(nome) === 'muleta' ? 'par' : 'un',
            estoqueMinimo: 0,
            ativo: true,
            emprestimo: true,
            areas: [AREA],
            criadoEm: firebase.firestore.FieldValue.serverTimestamp()
        };
        porChave.set(chaveEquipamento(nome), { id: ref.id, ...item });
        ops.push(b => b.set(ref, item));
    });
    marcar.forEach(i => ops.push(b => b.update(db.collection(ITENS_COLLECTION).doc(i.id), { emprestimo: true })));

    novos.forEach(r => {
        const itensEmp = r.itens.map(i => {
            const item = i.chave ? porChave.get(i.chave) : null;
            return { itemId: item ? item.id : null, nome: item ? item.nome : NAO_INFORMADO, unidade: item ? item.unidade || '' : '', qtd: i.qtd, situacao: i.situacao, resolvidoEm: i.resolvidoEm };
        });
        const doc = {
            data: r.data,
            nome: r.nome,
            telefone: r.telefone,
            endereco: r.endereco,
            bairro: r.bairro,
            responsavel: '',
            obs: r.obs,
            itens: itensEmp,
            aberto: itensEmp.some(i => i.situacao === 'EM_USO'),
            contatos: r.contatos,
            origem: 'planilha',
            planilha: { aba: r.aba, linha: r.linha, status: r.status, dataOriginal: r.dataOriginal || '' },
            ...user,
            criadoEm: firebase.firestore.FieldValue.serverTimestamp(),
            atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
        };
        ops.push(b => b.set(db.collection(EMP_COLLECTION).doc(r.id), doc));
    });

    // Itens primeiro (os empréstimos apontam para eles); no máximo 400 escritas por lote
    for (let k = 0; k < ops.length; k += 400) {
        const batch = db.batch();
        ops.slice(k, k + 400).forEach(op => op(batch));
        await batch.commit();
    }
}

// ----------------------------------------------------
// INÍCIO
// ----------------------------------------------------
function iniciarEmprestimos() {
    document.getElementById('emp-data').value = hojeISO();
    ligarFormEmprestimo();
    ligarFormAcao();
    adicionarLinhaEmprestimo();
    ouvirEmprestimos();
}
