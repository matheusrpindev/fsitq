# Portal Fundo Social de Itaquaquecetuba (fsitaqua)

Site público: https://fsitaqua.netlify.app/ — publicado no Netlify arrastando a pasta `fsitaqua/` inteira (substitui o deploy todo).

## Estrutura

- `fsitaqua/` — o site (HTML + JS puro, sem build). É exatamente o que vai para o Netlify.
  - `index.html`, `app.js`, `components.js`, `auth.js`, `styles.css` — portal (login, dashboard, Gestão de Acesso, liga/desliga de módulos).
  - `fundo-social/` — Estoque do Fundo Social (galpão).
  - `ecobazar/` — EcoBazar itinerante (van): paradas por bairro, munícipes, câmbio de recicláveis → EcoCash, loja, estoque da van, planilhas.
  - `rodeio/` — arrecadações do Rodeio.
  - `casa-da-mulher/` — protótipo antigo (salva só no navegador, localStorage), desligado por padrão.
- `firestore.rules` — regras do Firestore. NÃO vão pelo Netlify: são coladas à mão no console do Firebase (Firestore Database → Regras → Publicar).

As versões nos `?v=` dos `<script>`/`<link>` servem para furar cache: aumente o número ao mudar um arquivo.

## Tecnologia

- Firebase compat v10.12.2 (Auth + Firestore), projeto `fundosocialitq`.
- Phosphor Icons 2.1.1, fonte Inter, ExcelJS 4.3.0 (cdnjs, carregado só ao exportar).
- Papéis: Administrador, Gestor, Assistente Técnico, Assistente Administrativo. "Gestor ou mais" = Administrador/Gestor.
- Dono do portal: `OWNER_UID = 'QC7sDiAG5tZQitj2rFcr7OHGOy73'` (Matheus), fixo em `auth.js`, `rodeio/script.js` e `firestore.rules`. Só ele liga/desliga módulos (`config/portal.modulosAtivos`).

## Coleções do Firestore

- `usuarios`, `rodeio_arrecadacoes`, `config/portal` {modulosAtivos[]}
- `estoque_itens` {nome, categoria, unidade, estoqueMinimo, ativo, areas[], valorEco, criadoEm}: catálogo único, `areas` diz em qual tela o item aparece; saldo compartilhado entre telas.
- `estoque_movimentacoes` {tipo, area, itemId, itemNome, unidade, qtd, data, origemDestino, motivo, obs, contado, lote, usuarioId, usuarioNome, criadoEm}
- `ecobazar_paradas` {bairro, local, inicio, fimPrevisto, ativa, encerradaEm, encerradaPor, ...}: a van fica 7 dias por bairro (`DIAS_PARADA`).
- `ecobazar_municipes` {nome, telefone, bairro, paradaId, ...}: cadastro só vale na parada; depois some da interface, mas continua no banco.
- `ecobazar_materiais` {nome, unidade, qtdBase, valor}: EcoCash = floor(qtd/qtdBase)*valor.
- `ecobazar_operacoes` {tipo CAMBIO|LOJA|ESTOQUE, paradaId, municipeId, itens[], total, ...}: o EcoCash expira quando a van muda de bairro.

## Regras de negócio combinadas com o usuário

- Só Gestor ou mais cadastra/edita itens, escolhe em qual tela cada item aparece e apaga lançamentos. Abaixo disso, só controla quantidades.
- Planilhas do EcoBazar: uma aba por bairro no formato `(mm-aaaa) Bairro` (o Excel não aceita "/"), com nome, telefone, bairro, itens doados, EcoCash atual e EcoCash já trocado.
- **Publicação em lote:** fazer todas as alterações primeiro e só depois mexer em regras e publicação, tudo de uma vez e com revisão. Quem publica é o usuário: regras primeiro, site depois.

## Histórico

- Out–nov/2026: redesenho do portal e do estoque, catálogo único, filtros de movimentações, controle de módulos pelo dono, EcoBazar itinerante. O site com tudo isso está no ar (conferido em 09/11). O `firestore.rules` daqui é a versão entregue ao usuário para publicar; não dá para confirmar daqui se é exatamente a que está no console.
- 03/11/2026: orçamento em PDF de R$ 9.000 (8 módulos: Estoque, EcoBazar, Casa da Mulher, Jantar Beneficente, Natal do Fundo Social, Banco de dados e segurança, Redesenho (incluso), Testes/publicação). Casa da Mulher, Jantar Beneficente e Natal ainda não foram feitos.
- Este repositório foi montado em 09/11/2026 a partir do site publicado. Ficaram só no PC do usuário (não estão aqui): `dev-server.js`, `teste/` (simuladores com banco falso), backups `_backup-prototipo-*` e o `orcamento/`.

## Rodar localmente

```bash
cd fsitaqua && python3 -m http.server 5500
```

Abra http://localhost:5500. O site usa o Firebase real, então tudo o que for feito logado grava no banco de verdade.
