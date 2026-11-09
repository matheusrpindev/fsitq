const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
// Uso: (cd fsitaqua && python3 -m http.server 5500) e depois
//      node teste/emprestimos.js caminho/da/planilha-de-emprestimos.xlsx
// Troca o Firebase por um banco em memória (fake-firebase.js) e o login por
// fake-auth.js (?papel=gestor|assistente). Fotos e a planilha exportada vão para
// a pasta indicada em SAIDA (padrão: teste/saida, ignorada pelo git).
const DIR = __dirname;
const XLSX = process.argv[2];
if (!XLSX) { console.error('Informe o caminho da planilha de empréstimos.'); process.exit(1); }
const SAIDA = process.env.SAIDA || path.join(DIR, 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const BASE = 'http://localhost:5500/fundo-social/';
const shot = (p, n) => p.screenshot({ path: path.join(SAIDA, n + '.png'), fullPage: false });

async function abrir(browser, papel, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  const erros = [];
  page.on('pageerror', e => erros.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') erros.push('console: ' + m.text()); });
  await page.route('**/firebase-app-compat.js', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(DIR, 'fake-firebase.js'), 'utf8') }));
  await page.route(/firebase-(auth|firestore)-compat\.js/, r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route(/\/auth\.js/, r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(DIR, 'fake-auth.js'), 'utf8') }));
  await page.goto(BASE + '?papel=' + papel);
  await page.waitForSelector('body.dados-prontos');
  return { ctx, page, erros };
}
const store = (page, col) => page.evaluate(c => [...(window.__store[c] || new Map())].map(([id, d]) => ({ id, ...d })), col);
const saldo = (page, nome) => page.evaluate(n => { const i = itens.find(x => x.nome === n); return i ? (calcularSaldos()[i.id] || 0) : null; }, nome);
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const log = []; global.__log = log;
  const ok = (cond, msg) => { log.push((cond ? 'OK   ' : 'FALHA') + ' ' + msg); };

  // ---------------- GESTOR ----------------
  const { page, erros } = await abrir(browser, 'gestor'); global.__erros = erros; global.__page = page;
  await page.click('#tab-emprestimos');
  await shot(page, '01-vazio');

  // Importar
  await page.setInputFiles('#emp-arquivo', XLSX);
  await page.waitForSelector('#modal-acao.open', { timeout: 20000 });
  const previa = await page.innerText('#acao-corpo');
  log.push('--- PRÉVIA ---\n' + previa + '\n--------------');
  await shot(page, '02-previa');
  await page.click('#acao-ok');
  await page.waitForSelector('#modal-acao:not(.open)');
  await esperar(300);
  const emps = await store(page, 'emprestimos');
  const itensDb = await store(page, 'estoque_itens');
  const N = Number((previa.match(/(\d+) empréstimos novos/) || [])[1]);
  ok(emps.length === N && N > 0, `importou ${emps.length} empréstimos (prévia dizia ${N})`);
  log.push('sem equipamento: ' + emps.filter(e => e.itens.some(i => !i.itemId)).length);
  log.push('itens criados: ' + itensDb.map(i => `${i.nome} [${i.unidade}] emprestimo=${i.emprestimo}`).join('; '));
  const abertos = emps.filter(e => e.aberto).length;
  log.push(`abertos: ${abertos}, encerrados: ${emps.length - abertos}`);
  const cont = {}; emps.forEach(e => e.itens.forEach(i => cont[i.situacao] = (cont[i.situacao] || 0) + 1));
  log.push('situações dos itens: ' + JSON.stringify(cont));
  const res = {}; emps.forEach(e => (e.contatos || []).forEach(c => res[c.resultado + (c.data ? '@' + c.data : '@sem')] = (res[c.resultado + (c.data ? '@' + c.data : '@sem')] || 0) + 1));
  log.push('contatos importados: ' + JSON.stringify(res));
  const corr = emps.filter(e => e.planilha.dataOriginal).map(e => `${e.planilha.aba}/${e.planilha.linha} ${e.planilha.dataOriginal} -> ${e.data}`);
  log.push('datas corrigidas: ' + corr.length + ' ex: ' + corr.slice(0, 4).join(' | ') + ' ... ' + corr.slice(-3).join(' | '));
  const semTel = emps.filter(e => !e.telefone).length;
  log.push('sem telefone: ' + semTel);
  ok(await page.$$eval('#table-emprestimos tr.clicavel', t => t.length) > 0, 'lista mostra empréstimos em aberto');
  await shot(page, '03-lista');

  // Reimportar = nada novo
  await page.evaluate(() => { document.getElementById('emp-arquivo').value = ''; });
  await page.setInputFiles('#emp-arquivo', XLSX);
  await page.waitForSelector('#modal-acao.open', { timeout: 20000 });
  const previa2 = await page.innerText('#acao-corpo');
  ok(/0\s+empréstimos novos/.test(previa2) && previa2.includes(N + ' já foram importados'), 'reimportar pula todos');
  await page.click('#acao-ok');
  await page.waitForSelector('#modal-acao:not(.open)');
  ok((await store(page, 'emprestimos')).length === N, 'mesma quantidade após reimportar');

  // Inventário: contar equipamentos
  await page.click('#tab-inventario');
  const contagem = { 'Cadeira de rodas': 4, 'Cadeira de banho': 2, 'Muletas': 1 };
  for (const [nome, q] of Object.entries(contagem)) {
    const id = itensDb.find(i => i.nome === nome).id;
    await page.fill(`.inv-input[data-item-id="${id}"]`, String(q));
  }
  await page.click('#form-inventario button[type=submit]');
  await page.waitForSelector('#modal.open');
  await page.click('#modal-ok');
  await esperar(300);
  ok(await saldo(page, 'Cadeira de rodas') === 4, 'inventário: 4 cadeiras de rodas no galpão');

  await page.click('#tab-emprestimos');
  await esperar(100);
  log.push('KPIs: ' + await page.innerText('#view-emprestimos .kpi-grid').then(t => t.replace(/\n+/g, ' | ')));
  await shot(page, '04-com-estoque');

  // Novo empréstimo para quem já pegou antes
  await page.click('#tab-novo-emprestimo');
  const pessoa = emps.find(e => e.telefone && e.endereco);
  await page.fill('#emp-nome', pessoa.nome);
  await page.dispatchEvent('#emp-nome', 'change');
  ok(await page.inputValue('#emp-telefone') === pessoa.telefone, 'preencheu telefone de quem já pegou antes');
  const idRodas = itensDb.find(i => i.nome === 'Cadeira de rodas').id;
  const idBanho = itensDb.find(i => i.nome === 'Cadeira de banho').id;
  await page.selectOption('#emp-linhas .line:nth-child(1) .linha-item', idRodas);
  await page.click('text=Adicionar outro equipamento');
  await page.selectOption('#emp-linhas .line:nth-child(2) .linha-item', idBanho);
  await page.fill('#emp-linhas .line:nth-child(2) .linha-qtd', '3');
  await page.dispatchEvent('#emp-linhas .line:nth-child(2) .linha-qtd', 'input');
  log.push('linha 2 info: ' + await page.innerText('#emp-linhas .line:nth-child(2) .line-info'));
  await shot(page, '05-novo-sem-saldo');
  await page.click('#form-emprestimo button[type=submit]');
  await page.waitForSelector('#modal.open');
  ok((await page.innerText('#modal')).includes('Equipamento indisponível'), 'bloqueia empréstimo maior que o disponível');
  await page.click('#modal-ok');
  await page.fill('#emp-linhas .line:nth-child(2) .linha-qtd', '1');
  await page.dispatchEvent('#emp-linhas .line:nth-child(2) .linha-qtd', 'input');
  await page.click('#form-emprestimo button[type=submit]');
  await page.waitForSelector('#modal-detalhe.open');
  await esperar(300);
  ok(await saldo(page, 'Cadeira de rodas') === 3 && await saldo(page, 'Cadeira de banho') === 1, 'empréstimo baixou o estoque (rodas 4→3, banho 2→1)');
  await shot(page, '06-detalhe-novo');

  // Contato
  await page.click('#modal-detalhe >> text=Registrar contato');
  await page.waitForSelector('#modal-acao.open');
  await page.selectOption('#cont-resultado', 'VAI_DEVOLVER');
  await page.fill('#cont-obs', 'Devolve na sexta');
  await page.click('#acao-ok');
  await page.waitForSelector('#modal-acao:not(.open)');
  await esperar(200);
  ok((await page.innerText('#detalhe-corpo')).includes('Atendeu: vai devolver'), 'contato aparece no detalhe');

  // Devolução parcial
  await page.click('#detalhe-devolver');
  await page.waitForSelector('#modal-acao.open');
  await shot(page, '07-devolucao');
  await page.selectOption('.dev-itens .dev-item:nth-child(2) select', 'EM_USO');
  await page.click('#acao-ok');
  await page.waitForSelector('#modal-acao:not(.open)');
  await esperar(300);
  ok(await saldo(page, 'Cadeira de rodas') === 4 && await saldo(page, 'Cadeira de banho') === 1, 'devolução parcial: rodas voltou (4), banho continua fora (1)');
  ok((await page.innerText('#detalhe-badge')).includes('Em aberto'), 'continua em aberto após devolução parcial');
  // Devolve o resto
  await page.click('#detalhe-devolver');
  await page.waitForSelector('#modal-acao.open');
  await page.click('#acao-ok');
  await page.waitForSelector('#modal-acao:not(.open)');
  await esperar(300);
  ok((await page.innerText('#detalhe-badge')).includes('Encerrado'), 'encerrado depois de devolver tudo');
  ok(await saldo(page, 'Cadeira de banho') === 2, 'banho voltou (2)');
  await shot(page, '08-detalhe-encerrado');
  await page.keyboard.press('Escape');

  // Devolução de empréstimo importado lança entrada
  const juv = (await store(page, 'emprestimos')).find(e => e.aberto && e.origem === 'planilha' && e.itens.some(i => i.nome === 'Andador'));
  await page.evaluate(id => abrirDetalhe(id), juv.id);
  const antesAnd = await saldo(page, 'Andador');
  await page.click('#detalhe-devolver');
  await page.waitForSelector('#modal-acao.open');
  await page.click('#acao-ok');
  await page.waitForSelector('#modal-acao:not(.open)');
  await esperar(300);
  ok(await saldo(page, 'Andador') === antesAnd + juv.itens.filter(i => i.nome === 'Andador').reduce((s, i) => s + i.qtd, 0), 'devolver empréstimo importado soma no estoque de andador');
  await page.keyboard.press('Escape');

  // Filtros
  const comTel = emps.find(e => e.aberto && e.telefone.replace(/\D/g, '').length >= 8);
  await page.fill('#emp-f-busca', comTel.telefone.replace(/\D/g, '').slice(-5));
  await esperar(100);
  ok(Number((await page.innerText('#emp-contagem')).split(' ')[0]) >= 1, 'busca por parte do telefone acha o empréstimo');
  await page.click('text=Limpar filtros >> nth=-1').catch(() => page.evaluate(() => limparFiltrosEmprestimo()));
  await page.check('#emp-f-contato');
  log.push('sem contato 90d: ' + await page.innerText('#emp-contagem'));
  await page.evaluate(() => limparFiltrosEmprestimo());
  await page.click('#emp-f-situacao button[data-situacao=""]');
  log.push('todos: ' + await page.innerText('#emp-contagem'));

  // Exportar
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#view-emprestimos >> text=Exportar Excel')]);
  const destino = path.join(SAIDA, 'export.xlsx');
  await dl.saveAs(destino);
  ok(fs.existsSync(destino), 'exportou planilha: ' + dl.suggestedFilename());

  // Movimentações mostram motivo Empréstimo
  await page.click('#tab-movimentacoes');
  await page.selectOption('#f-motivo', 'Empréstimo');
  await esperar(100);
  log.push('movimentações com motivo Empréstimo: ' + await page.$$eval('#table-movimentacoes tr', t => t.length));

  // Excluir o empréstimo criado no teste
  const novo = (await store(page, 'emprestimos')).find(e => e.origem === 'sistema');
  const movsAntes = (await store(page, 'estoque_movimentacoes')).length;
  await page.evaluate(id => abrirDetalhe(id), novo.id);
  await page.click('#modal-detalhe >> text=Excluir');
  await page.waitForSelector('#modal.open');
  await page.click('#modal-ok');
  await esperar(300);
  ok(!(await store(page, 'emprestimos')).some(e => e.id === novo.id), 'excluiu empréstimo');
  ok((await store(page, 'estoque_movimentacoes')).length === movsAntes - 4, 'excluiu as 4 movimentações dele (2 saídas + 2 entradas)');

  // Itens: checkbox emprestimo
  await page.click('#tab-itens');
  await page.evaluate(id => editarItem(id), idRodas);
  ok(await page.isChecked('#item-emprestimo'), 'item mostra "Pode ser emprestado" marcado');
  await shot(page, '09-itens');

  // Mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#tab-emprestimos');
  await esperar(150);
  await page.screenshot({ path: path.join(SAIDA, '10-mobile-lista.png'), fullPage: true });
  await page.evaluate(id => abrirDetalhe(id), juv.id);
  await esperar(250);
  await shot(page, '11-mobile-detalhe');
  const largura = await page.evaluate(() => document.documentElement.scrollWidth);
  ok(largura <= 390, 'sem rolagem horizontal no celular (' + largura + 'px)');
  log.push('erros gestor: ' + (erros.length ? erros.join('\n') : 'nenhum'));
  await page.context().close();

  // ---------------- ASSISTENTE ----------------
  const a = await abrir(browser, 'assistente');
  await a.page.evaluate(async () => {
    const b = __db.batch();
    b.set(__db.collection('estoque_itens').doc('cad'), { nome: 'Cadeira de rodas', unidade: 'un', categoria: 'Equipamentos', ativo: true, emprestimo: true, areas: ['Fundo Social'] });
    b.set(__db.collection('estoque_movimentacoes').doc('m1'), { tipo: 'AJUSTE', itemId: 'cad', itemNome: 'Cadeira de rodas', qtd: 2, data: '2026-11-01', area: 'Fundo Social' });
    await b.commit();
  });
  await a.page.click('#tab-emprestimos');
  await esperar(150);
  ok(!(await a.page.isVisible('text=Importar planilha')), 'assistente não vê Importar planilha');
  await a.page.click('#tab-novo-emprestimo');
  await a.page.fill('#emp-nome', 'Fulana de Tal');
  await a.page.selectOption('#emp-linhas .line .linha-item', 'cad');
  await a.page.click('#form-emprestimo button[type=submit]');
  await a.page.waitForSelector('#modal-detalhe.open');
  ok(!(await a.page.isVisible('#modal-detalhe >> text=Excluir')), 'assistente não vê Excluir');
  const e1 = (await store(a.page, 'emprestimos'))[0];
  ok(e1 && e1.usuarioId === 'uid-assist', 'empréstimo no nome da assistente');
  await shot(a.page, '12-assistente-detalhe');
  log.push('erros assistente: ' + (a.erros.length ? a.erros.join('\n') : 'nenhum'));
  await browser.close();
  console.log(log.join('\n'));
})().catch(e => { console.log(global.__log.join('\n')); console.log(global.__erros); console.error('ERRO NO TESTE', e.message); process.exit(1); });
