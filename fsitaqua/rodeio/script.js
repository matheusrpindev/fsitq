// script.js - Rodeio Arrecadação com Firebase Compat
const firebaseConfig = {
    apiKey: "AIzaSyBs8IyZMrpavUXEaHTPcQIqXgyfU7nA30s",
    authDomain: "fundosocialitq.firebaseapp.com",
    projectId: "fundosocialitq",
    storageBucket: "fundosocialitq.firebasestorage.app",
    messagingSenderId: "672696448922",
    appId: "1:672696448922:web:d32f8cd5739cddc73dac23"
};

// Inicializa o Firebase em modo Compat (não requer módulo)
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const COLLECTION_NAME = "rodeio_arrecadacoes";

let arrecadacoesGlobais = [];
let unsubscribeArrecadacoes = null;

// -----------------------------------------------------------------
// Guard de autenticação desta página.
//
// Esta página é aberta como navegação direta (não é um #hash dentro do
// mesmo app), então precisa restaurar a sessão do Firebase Auth por
// conta própria antes de fazer qualquer chamada ao Firestore. Sem isso,
// o Firestore tenta ler/escrever sem token de autenticação e as regras
// de segurança recusam com "Missing or insufficient permissions".
// -----------------------------------------------------------------
auth.onAuthStateChanged(async (firebaseUser) => {
    if (!firebaseUser) {
        // Sem sessão válida — manda de volta para o login do portal.
        window.location.href = '../index.html#login';
        return;
    }

    // Se o usuário ainda precisa criar sua senha no primeiro acesso, manda pro login
    try {
        const userDoc = await db.collection('usuarios').doc(firebaseUser.uid).get();
        if (userDoc.exists && userDoc.data().mustChangePassword) {
            window.location.href = '../index.html#login';
            return;
        }
    } catch (err) {
        console.error("Erro ao verificar status do primeiro acesso:", err);
    }

    // Módulo desativado no portal (config/portal): só o dono do portal entra.
    // Mesmo UID de OWNER_UID em ../auth.js.
    try {
        const config = await db.collection('config').doc('portal').get();
        const ativos = config.exists ? config.data().modulosAtivos : null;
        if (Array.isArray(ativos) && !ativos.includes('Rodeio') && firebaseUser.uid !== 'QC7sDiAG5tZQitj2rFcr7OHGOy73') {
            alert('O módulo Rodeio está desativado no momento.');
            window.location.href = '../index.html';
            return;
        }
    } catch (err) {
        console.warn("Módulos ativos indisponíveis:", err.code || err);
    }

    // Sessão confirmada: só agora é seguro começar a ouvir/escrever no Firestore.
    if (unsubscribeArrecadacoes) unsubscribeArrecadacoes();
    unsubscribeArrecadacoes = db.collection(COLLECTION_NAME).orderBy("timestamp", "desc")
        .onSnapshot((snapshot) => {
            arrecadacoesGlobais = [];
            snapshot.forEach((doc) => {
                arrecadacoesGlobais.push({ id: doc.id, ...doc.data() });
            });
            renderTable();
        }, (error) => {
            console.error("Erro ao carregar arrecadações:", error);
        });
});

// Configura locale Português com Domingo (0) como primeiro dia da semana
if (typeof flatpickr !== 'undefined' && flatpickr.l10ns && flatpickr.l10ns.pt) {
    flatpickr.l10ns.pt.firstDayOfWeek = 0;
}

// Flatpickr para o campo de Data
flatpickr("#input-data", {
    defaultDate: "today",
    locale: "pt",
    dateFormat: "Y-m-d", // Formato real (para o código funcionar)
    altInput: true,
    altFormat: "d \\de F", // Ex: "12 de Agosto"
    onChange: function(selectedDates, dateStr, instance) {
        window.toggleVanBairro();
        window.recalculateAllItems();
    }
});

window.fazerLogout = function() {
    auth.signOut();
    window.location.href = '../index.html#login';
};

window.switchTab = function(tabId) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
    
    document.getElementById(`view-${tabId}`).classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');
};

const agendaVan = {
    '2026-08-11': 'Jardim Gonçalves',
    '2026-08-12': 'Parque Marengo',
    '2026-08-13': 'Estância Fraternidade',
    '2026-08-14': "Jd. N. S. D'Ajuda",
    '2026-08-15': 'Vila São Carlos',
    '2026-08-16': 'Parque Piratininga',
    '2026-08-17': 'Jardim Paineira'
};

// ====== CUSTOM DROPDOWN ======
window.toggleDropdown = function(csId) {
    const cs = document.getElementById(csId);
    // Fecha todos os outros
    document.querySelectorAll('.custom-select.open').forEach(el => {
        if (el.id !== csId) el.classList.remove('open');
    });
    cs.classList.toggle('open');
};

window.selectOption = function(csId, optionEl) {
    const cs = document.getElementById(csId);
    const trigger = cs.querySelector('.custom-select-trigger span');
    const hiddenInput = cs.previousElementSibling; // input hidden

    // Marca como selecionado
    cs.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
    optionEl.classList.add('selected');

    // Atualiza trigger e hidden input
    trigger.textContent = optionEl.textContent;
    hiddenInput.value = optionEl.dataset.value;

    // Fecha dropdown
    cs.classList.remove('open');

    // Dispara a lógica de UI e Recálculo se for o select de local
    if (csId === 'cs-local') {
        window.toggleVanBairro();
        window.updatePostoUI();
        window.recalculateAllItems();
    }
};

window.updatePostoUI = function() {
    const local = document.getElementById('input-local')?.value || '';
    const isPlenaSaude = (local === 'Plena Saúde');

    // Card de Fralda destaque vs fraco
    const fraldaCard = document.getElementById('card-item-fralda');
    if (fraldaCard) {
        if (isPlenaSaude) {
            fraldaCard.style.opacity = '1';
            fraldaCard.style.borderColor = '#06b6d4';
            fraldaCard.style.boxShadow = '0 0 16px rgba(6, 182, 212, 0.4)';
        } else {
            fraldaCard.style.opacity = '0.5';
            fraldaCard.style.borderColor = 'var(--border)';
            fraldaCard.style.boxShadow = 'none';
        }
    }

    // Esconde/mostra subcontrols de Ração/PET nos ingressos se for Plena Saúde
    const subcontrols = document.querySelectorAll('.card-subcontrols-block');
    subcontrols.forEach(sub => {
        sub.style.display = isPlenaSaude ? 'none' : 'block';
    });
};

// Função auxiliar para setar bairro via JS (usado pelo auto-preenchimento da Van)
function setBairroByValue(value) {
    const cs = document.getElementById('cs-bairro');
    const trigger = cs.querySelector('.custom-select-trigger span');
    const hiddenInput = document.getElementById('input-bairro');
    
    const option = cs.querySelector(`.custom-select-option[data-value="${value}"]`);
    if (option) {
        cs.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
        trigger.textContent = option.textContent;
        hiddenInput.value = value;
    }
}

// Fecha dropdown ao clicar fora
document.addEventListener('click', function(e) {
    if (!e.target.closest('.custom-select')) {
        document.querySelectorAll('.custom-select.open').forEach(el => el.classList.remove('open'));
    }
});

window.toggleVanBairro = function() {
    const local = document.getElementById('input-local').value;
    const divBairro = document.getElementById('div-van-bairro');
    const dataSelecionada = document.getElementById('input-data').value;

    if (local === 'Van Itinerante') {
        divBairro.style.display = 'block';
        // Tenta achar na agenda oficial e auto-seleciona
        if (agendaVan[dataSelecionada]) {
            setBairroByValue(agendaVan[dataSelecionada]);
        }
    } else {
        divBairro.style.display = 'none';
        document.getElementById('input-bairro').value = "";
    }
};

window.changeQty = function(inputId, delta) {
    const input = document.getElementById(inputId);
    let currentVal = parseInt(input.value) || 0;
    let newVal = currentVal + delta;
    if (newVal < 0) newVal = 0;
    input.value = newVal;
};

function updateTicketHintsUI() {
    const inputData = document.getElementById('input-data')?.value || '';
    const isNewModel = (inputData >= '2026-08-26');

    const h05 = document.getElementById('hint-tk-05');
    const h06 = document.getElementById('hint-tk-06');
    const h11 = document.getElementById('hint-tk-11');
    const h12 = document.getElementById('hint-tk-12');

    if (isNewModel) {
        if (h05) h05.textContent = '☕ Café';
        if (h06) h06.textContent = '🥛 Leite / Açúcar / Sal';
        if (h11) h11.textContent = '🍚 Arroz / Feijão';
        if (h12) h12.textContent = '🫒 Óleo / Macarrão / Molho';
    } else {
        if (h05) h05.textContent = '🍚 Arroz / Feijão';
        if (h06) h06.textContent = '🫒 Óleo / Macarrão / Molho';
        if (h11) h11.textContent = '☕ Café';
        if (h12) h12.textContent = '🥛 Leite / Açúcar / Sal';
    }
}

window.recalculateAllItems = function() {
    const local = document.getElementById('input-local')?.value || '';
    const inputData = document.getElementById('input-data')?.value || '';
    const isPlenaSaude = (local === 'Plena Saúde');
    const isNewFoodModel = (inputData >= '2026-08-26');

    updateTicketHintsUI();

    // 05/Set
    const t05 = parseInt(document.getElementById('ticket-05')?.value) || 0;
    let r05 = parseInt(document.getElementById('racao-tk05')?.value) || 0;
    let p05 = parseInt(document.getElementById('pet-tk05')?.value) || 0;
    if (r05 + p05 > t05) {
        p05 = Math.max(0, t05 - r05);
        if(document.getElementById('pet-tk05')) document.getElementById('pet-tk05').value = p05;
        if (r05 > t05) { r05 = t05; if(document.getElementById('racao-tk05')) document.getElementById('racao-tk05').value = r05; }
    }
    const f05 = Math.max(0, t05 - r05 - p05);

    // 06/Set
    const t06 = parseInt(document.getElementById('ticket-06')?.value) || 0;
    let r06 = parseInt(document.getElementById('racao-tk06')?.value) || 0;
    let p06 = parseInt(document.getElementById('pet-tk06')?.value) || 0;
    if (r06 + p06 > t06) {
        p06 = Math.max(0, t06 - r06);
        if(document.getElementById('pet-tk06')) document.getElementById('pet-tk06').value = p06;
        if (r06 > t06) { r06 = t06; if(document.getElementById('racao-tk06')) document.getElementById('racao-tk06').value = r06; }
    }
    const f06 = Math.max(0, t06 - r06 - p06);

    // 11/Set
    const t11 = parseInt(document.getElementById('ticket-11')?.value) || 0;
    let r11 = parseInt(document.getElementById('racao-tk11')?.value) || 0;
    let p11 = parseInt(document.getElementById('pet-tk11')?.value) || 0;
    if (r11 + p11 > t11) {
        p11 = Math.max(0, t11 - r11);
        if(document.getElementById('pet-tk11')) document.getElementById('pet-tk11').value = p11;
        if (r11 > t11) { r11 = t11; if(document.getElementById('racao-tk11')) document.getElementById('racao-tk11').value = r11; }
    }
    const f11 = Math.max(0, t11 - r11 - p11);

    // 12/Set
    const t12 = parseInt(document.getElementById('ticket-12')?.value) || 0;
    let r12 = parseInt(document.getElementById('racao-tk12')?.value) || 0;
    let p12 = parseInt(document.getElementById('pet-tk12')?.value) || 0;
    if (r12 + p12 > t12) {
        p12 = Math.max(0, t12 - r12);
        if(document.getElementById('pet-tk12')) document.getElementById('pet-tk12').value = p12;
        if (r12 > t12) { r12 = t12; if(document.getElementById('racao-tk12')) document.getElementById('racao-tk12').value = r12; }
    }
    const f12 = Math.max(0, t12 - r12 - p12);

    const totalTicketsSum = t05 + t06 + t11 + t12;

    if (isPlenaSaude) {
        // No posto Plena Saúde, o item é exclusivamente Fralda (1 ingresso = 1 pct fralda)
        if (document.getElementById('item-fralda')) document.getElementById('item-fralda').value = totalTicketsSum;

        // Comida e adicionais zerados
        const foodIds = ['item-arroz', 'item-feijao', 'item-oleo', 'item-macarrao', 'item-molho', 'item-cafe', 'item-leite', 'item-sal', 'item-acucar', 'item-racao', 'item-pet-kg', 'item-plastico'];
        foodIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = 0;
        });

        // Zerar subcontrols de ração/pet se houver
        ['racao-tk05', 'pet-tk05', 'racao-tk06', 'pet-tk06', 'racao-tk11', 'pet-tk11', 'racao-tk12', 'pet-tk12'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = 0;
        });
    } else {
        // Nos outros postos, Fralda é zerada e Alimentos calculados de acordo com a data de lançamento
        if (document.getElementById('item-fralda')) document.getElementById('item-fralda').value = 0;

        if (isNewFoodModel) {
            // Regra a partir de 26/08/2026:
            // 05/Set: 1 Café + 1 Emb. Plástica (f05)
            // 06/Set: 1 Leite + 1 Açúcar + 1 Sal + 1 Emb. Plástica (f06)
            // 11/Set: 1 Arroz + 1 Feijão + 1 Emb. Plástica (f11)
            // 12/Set: 1 Óleo + 1 Macarrão + 1 Molho + 1 Emb. Plástica (f12)

            if(document.getElementById('item-cafe')) document.getElementById('item-cafe').value = f05;

            if(document.getElementById('item-leite')) document.getElementById('item-leite').value = f06;
            if(document.getElementById('item-acucar')) document.getElementById('item-acucar').value = f06;
            if(document.getElementById('item-sal')) document.getElementById('item-sal').value = f06;

            if(document.getElementById('item-arroz')) document.getElementById('item-arroz').value = f11;
            if(document.getElementById('item-feijao')) document.getElementById('item-feijao').value = f11;

            if(document.getElementById('item-oleo')) document.getElementById('item-oleo').value = f12;
            if(document.getElementById('item-macarrao')) document.getElementById('item-macarrao').value = f12;
            if(document.getElementById('item-molho')) document.getElementById('item-molho').value = f12;
        } else {
            // Regra anterior a 26/08/2026:
            // 05/Set: 1 Arroz + 1 Feijão (f05)
            // 06/Set: 1 Óleo + 1 Macarrão + 1 Molho (f06)
            // 11/Set: 1 Café (f11)
            // 12/Set: 1 Leite + 1 Sal + 1 Açúcar (f12)

            if(document.getElementById('item-arroz')) document.getElementById('item-arroz').value = f05;
            if(document.getElementById('item-feijao')) document.getElementById('item-feijao').value = f05;

            if(document.getElementById('item-oleo')) document.getElementById('item-oleo').value = f06;
            if(document.getElementById('item-macarrao')) document.getElementById('item-macarrao').value = f06;
            if(document.getElementById('item-molho')) document.getElementById('item-molho').value = f06;

            if(document.getElementById('item-cafe')) document.getElementById('item-cafe').value = f11;

            if(document.getElementById('item-leite')) document.getElementById('item-leite').value = f12;
            if(document.getElementById('item-sal')) document.getElementById('item-sal').value = f12;
            if(document.getElementById('item-acucar')) document.getElementById('item-acucar').value = f12;
        }

        // Ração, PET e Embalagens Plásticas (somente para alimentos)
        if(document.getElementById('item-racao')) document.getElementById('item-racao').value = r05 + r06 + r11 + r12;
        if(document.getElementById('item-pet-kg')) document.getElementById('item-pet-kg').value = p05 + p06 + p11 + p12;
        if(document.getElementById('item-plastico')) document.getElementById('item-plastico').value = f05 + f06 + f11 + f12;
    }
};

window.changeTicketQty = function(ticketId, delta) {
    const input = document.getElementById(ticketId);
    if (!input) return;
    let currentVal = parseInt(input.value) || 0;
    let newVal = currentVal + delta;
    if (newVal < 0) newVal = 0;
    input.value = newVal;

    const dateSuffix = ticketId.replace('ticket-', '');
    const racaoInput = document.getElementById(`racao-tk${dateSuffix}`);
    const petInput = document.getElementById(`pet-tk${dateSuffix}`);
    let rVal = parseInt(racaoInput?.value) || 0;
    let pVal = parseInt(petInput?.value) || 0;

    if (rVal + pVal > newVal) {
        if (pVal > 0) {
            pVal = Math.max(0, newVal - rVal);
            if (petInput) petInput.value = pVal;
        }
        if (rVal + pVal > newVal) {
            rVal = Math.max(0, newVal);
            if (racaoInput) racaoInput.value = rVal;
        }
    }

    window.recalculateAllItems();
};

window.changeRacaoQty = function(racaoId, delta) {
    const input = document.getElementById(racaoId);
    if (!input) return;
    let currentVal = parseInt(input.value) || 0;
    let newVal = currentVal + delta;
    if (newVal < 0) newVal = 0;

    const dateSuffix = racaoId.replace('racao-tk', '');
    const ticketInput = document.getElementById(`ticket-${dateSuffix}`);
    if (ticketInput) {
        let tVal = parseInt(ticketInput.value) || 0;
        let petVal = parseInt(document.getElementById(`pet-tk${dateSuffix}`)?.value) || 0;
        if (newVal + petVal > tVal) {
            ticketInput.value = newVal + petVal;
        }
    }

    input.value = newVal;
    window.recalculateAllItems();
};

window.changePetQty = function(petId, delta) {
    const input = document.getElementById(petId);
    if (!input) return;
    let currentVal = parseInt(input.value) || 0;
    let newVal = currentVal + delta;
    if (newVal < 0) newVal = 0;

    const dateSuffix = petId.replace('pet-tk', '');
    const ticketInput = document.getElementById(`ticket-${dateSuffix}`);
    if (ticketInput) {
        let tVal = parseInt(ticketInput.value) || 0;
        let racaoVal = parseInt(document.getElementById(`racao-tk${dateSuffix}`)?.value) || 0;
        if (newVal + racaoVal > tVal) {
            ticketInput.value = newVal + racaoVal;
        }
    }

    input.value = newVal;
    window.recalculateAllItems();
};

// Listeners para suportar digitação no teclado
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('input[id^="ticket-"], input[id^="racao-tk"], input[id^="pet-tk"]').forEach(input => {
        input.addEventListener('input', () => {
            window.recalculateAllItems();
        });
        input.addEventListener('change', () => {
            window.recalculateAllItems();
        });
    });
});

window.limparLancamento = function() {
    const formFields = [
        'item-arroz', 'item-feijao', 'item-oleo', 'item-macarrao', 'item-molho', 'item-cafe', 'item-leite', 'item-sal', 'item-acucar', 'item-racao', 'item-pet-kg', 'item-plastico', 'item-fralda',
        'ticket-05', 'ticket-06', 'ticket-11', 'ticket-12',
        'racao-tk05', 'racao-tk06', 'racao-tk11', 'racao-tk12',
        'pet-tk05', 'pet-tk06', 'pet-tk11', 'pet-tk12'
    ];
    formFields.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.value = 0;
    });
    window.recalculateAllItems();
};

window.salvarLancamento = async function() {
    const inputData = document.getElementById('input-data').value;
    const inputLocal = document.getElementById('input-local').value;
    const inputBairro = document.getElementById('input-bairro').value;

    if(!inputData) {
        alert("Por favor, preencha a data.");
        return;
    }
    if (inputLocal === 'Van Itinerante' && !inputBairro) {
        alert("Por favor, informe o bairro que a Van visitou.");
        return;
    }

    const data = {
        data: inputData,
        local: inputLocal,
        bairro: inputBairro || "N/A",
        
        tk05: parseInt(document.getElementById('ticket-05').value) || 0,
        tk06: parseInt(document.getElementById('ticket-06').value) || 0,
        tk11: parseInt(document.getElementById('ticket-11').value) || 0,
        tk12: parseInt(document.getElementById('ticket-12').value) || 0,

        arroz: parseInt(document.getElementById('item-arroz').value) || 0,
        feijao: parseInt(document.getElementById('item-feijao').value) || 0,
        oleo: parseInt(document.getElementById('item-oleo').value) || 0,
        macarrao: parseInt(document.getElementById('item-macarrao').value) || 0,
        molho: parseInt(document.getElementById('item-molho').value) || 0,
        cafe: parseInt(document.getElementById('item-cafe').value) || 0,
        leite: parseInt(document.getElementById('item-leite').value) || 0,
        sal: parseInt(document.getElementById('item-sal').value) || 0,
        acucar: parseInt(document.getElementById('item-acucar').value) || 0,
        racao: parseInt(document.getElementById('item-racao').value) || 0,
        petKg: parseInt(document.getElementById('item-pet-kg')?.value) || 0,
        plastico: parseInt(document.getElementById('item-plastico').value) || 0,
        fralda: parseInt(document.getElementById('item-fralda')?.value) || 0,
        timestamp: Date.now()
    };
    
    data.totalTickets = data.tk05 + data.tk06 + data.tk11 + data.tk12;
    data.totalAlimentos = data.arroz + data.feijao + data.oleo + data.macarrao + data.molho + data.cafe + data.leite + data.sal + data.acucar + data.racao + data.petKg + data.plastico + data.fralda;
    
    if (data.totalAlimentos === 0 && data.totalTickets === 0) {
        alert("Nenhum item ou ingresso informado.");
        return;
    }

    try {
        await db.collection(COLLECTION_NAME).add(data);
        
        const toast = document.getElementById('toast');
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
        
        window.limparLancamento();
    } catch (e) {
        console.error("Erro ao adicionar documento: ", e);
        alert("Erro ao salvar no banco de dados.");
    }
};

window.deleteArrecadacao = async function(id) {
    if (!id) return;
    if (confirm('Tem certeza que deseja apagar este lançamento?')) {
        try {
            // Remove imediatamente da visualização da tabela (update otimista)
            arrecadacoesGlobais = arrecadacoesGlobais.filter(item => item.id !== id);
            renderTable();

            // Deleta no Firestore
            await db.collection(COLLECTION_NAME).doc(id).delete();
            
            const toast = document.getElementById('toast');
            if (toast) {
                toast.innerText = 'Lançamento excluído com sucesso!';
                toast.classList.add('show');
                setTimeout(() => toast.classList.remove('show'), 3000);
            }
        } catch (e) {
            console.error("Erro ao deletar lançamento:", e);
            alert("Erro ao excluir do banco de dados: " + (e.message || e));
        }
    }
};

function getFilteredArrecadacoes() {
    const filterDate = document.getElementById('filter-history-date')?.value || '';
    const filterLocal = document.getElementById('filter-history-local')?.value || '';
    const filterOrder = document.getElementById('filter-history-order')?.value || 'date';

    let list = arrecadacoesGlobais.filter(item => {
        const matchDate = !filterDate || item.data === filterDate;
        const matchLocal = !filterLocal || item.local === filterLocal;
        return matchDate && matchLocal;
    });

    if (filterOrder === 'date') {
        // Ordena por Data da arrecadação (da mais recente para a mais antiga). Se igual, desempata pelo timestamp
        list.sort((a, b) => {
            const dateA = a.data || '';
            const dateB = b.data || '';
            if (dateA !== dateB) {
                return dateB.localeCompare(dateA);
            }
            return (b.timestamp || 0) - (a.timestamp || 0);
        });
    } else if (filterOrder === 'timestamp') {
        // Ordena estritamente por Ordem de Lançamento (timestamp do sistema da mais recente para a mais antiga)
        list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    return list;
}

function updateDateFilterOptions() {
    const select = document.getElementById('filter-history-date');
    if (!select) return;

    const currentVal = select.value;
    const uniqueDates = [...new Set(arrecadacoesGlobais.map(item => item.data).filter(Boolean))].sort();

    select.innerHTML = '<option value="">📅 Todas as Datas</option>';
    uniqueDates.forEach(dateStr => {
        const parts = dateStr.split('-');
        const formatted = parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : dateStr;
        const opt = document.createElement('option');
        opt.value = dateStr;
        opt.textContent = `📅 ${formatted}`;
        if (dateStr === currentVal) opt.selected = true;
        select.appendChild(opt);
    });
}

window.limparFiltrosHistorico = function() {
    const filterDate = document.getElementById('filter-history-date');
    const filterLocal = document.getElementById('filter-history-local');
    const filterOrder = document.getElementById('filter-history-order');
    if (filterDate) filterDate.value = '';
    if (filterLocal) filterLocal.value = '';
    if (filterOrder) filterOrder.value = 'date';
    renderTable();
};

function renderTable() {
    const container = document.getElementById('history-cards');
    if(!container) return;
    container.innerHTML = '';

    // Atualiza opções do select de datas de acordo com os dados no Firestore
    updateDateFilterOptions();

    const filterDate = document.getElementById('filter-history-date')?.value || '';
    const filterLocal = document.getElementById('filter-history-local')?.value || '';
    const filterOrder = document.getElementById('filter-history-order')?.value || 'date';
    const isFiltered = !!(filterDate || filterLocal || filterOrder !== 'date');

    const clearBtn = document.getElementById('btn-clear-filters');
    if (clearBtn) clearBtn.style.display = isFiltered ? 'inline-flex' : 'none';

    const listToRender = getFilteredArrecadacoes();
    
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    
    let sums = {
        tk05: 0, tk06: 0, tk11: 0, tk12: 0,
        totalAlimentos: 0, arroz: 0, feijao: 0, oleo: 0, macarrao: 0, 
        molho: 0, cafe: 0, leite: 0, sal: 0, acucar: 0, racao: 0, petKg: 0, plastico: 0, fralda: 0
    };
    
    listToRender.forEach(item => {
        sums.tk05 += item.tk05 || 0;
        sums.tk06 += item.tk06 || 0;
        sums.tk11 += item.tk11 || 0;
        sums.tk12 += item.tk12 || 0;

        sums.totalAlimentos += item.totalAlimentos || 0;
        sums.arroz += item.arroz || 0;
        sums.feijao += item.feijao || 0;
        sums.oleo += item.oleo || 0;
        sums.macarrao += item.macarrao || 0;
        sums.molho += item.molho || 0;
        sums.cafe += item.cafe || 0;
        sums.leite += item.leite || 0;
        sums.sal += item.sal || 0;
        sums.acucar += item.acucar || 0;
        sums.racao += item.racao || 0;
        sums.petKg += item.petKg || 0;
        sums.plastico += item.plastico || 0;
        sums.fralda += item.fralda || 0;
        
        const dateObj = new Date(item.data + 'T00:00:00');
        const dia = dateObj.getDate().toString().padStart(2, '0');
        const mes = meses[dateObj.getMonth()];
        
        const postIcons = {
            'Fundo Social': '🏛️',
            'Shopping': '🛍️',
            'Paróquia': '⛪',
            'Davo': '🛒',
            'Mega Xereta': '🏬',
            'Base GCM': '🚔',
            'Parceiros': '🤝',
            'Plena Saúde': '🏥',
            'Van Itinerante': '🚐'
        };
        const icon = postIcons[item.local] || '🏛️';

        const isVan = item.local === 'Van Itinerante';
        const localDisplay = isVan 
            ? `🚐 Van Itinerante <span class="badge-van">${item.bairro !== 'N/A' ? item.bairro : ''}</span>` 
            : `${icon} ${item.local}`;
        
        // Monta resumo dos itens
        const itensArr = [];
        if(item.arroz) itensArr.push(`${item.arroz} Arroz`);
        if(item.feijao) itensArr.push(`${item.feijao} Feijão`);
        if(item.oleo) itensArr.push(`${item.oleo} Óleo`);
        if(item.macarrao) itensArr.push(`${item.macarrao} Macarrão`);
        if(item.molho) itensArr.push(`${item.molho} Molho`);
        if(item.cafe) itensArr.push(`${item.cafe} Café`);
        if(item.leite) itensArr.push(`${item.leite} Leite`);
        if(item.sal) itensArr.push(`${item.sal} Sal`);
        if(item.acucar) itensArr.push(`${item.acucar} Açúcar`);
        if(item.fralda) itensArr.push(`${item.fralda} pct. Fralda`);
        if(item.racao) itensArr.push(`${item.racao} kg Ração`);
        if(item.petKg) itensArr.push(`${item.petKg} kg PET`);
        if(item.plastico) itensArr.push(`${item.plastico} un. Emb. Plást.`);
        const resumo = itensArr.length > 0 ? itensArr.join(' · ') : 'Sem itens detalhados';
        
        container.innerHTML += `
            <div class="history-card">
                <div class="history-date">
                    <div class="day">${dia}</div>
                    <div class="month">${mes}</div>
                </div>
                <div class="history-divider"></div>
                <div class="history-info">
                    <div class="history-local">${localDisplay}</div>
                    <div class="history-items">${resumo}</div>
                </div>
                <div class="history-stats">
                    <div class="history-stat">
                        <div class="stat-val" style="color: var(--brand-orange)">${item.totalTickets || 0}</div>
                        <div class="stat-label">Ingressos</div>
                    </div>
                    <div class="history-stat">
                        <div class="stat-val">${item.totalAlimentos || 0}</div>
                        <div class="stat-label">Itens</div>
                    </div>
                </div>
                <button class="history-delete" onclick="deleteArrecadacao('${item.id}')"><i class="ph ph-trash"></i></button>
            </div>
        `;
    });
    
    if (arrecadacoesGlobais.length === 0) {
        container.innerHTML = `<div class="history-empty"><i class="ph ph-cloud-slash" style="font-size:2rem; display:block; margin-bottom:0.5rem;"></i>Nenhum lançamento registrado ainda.</div>`;
    } else if (listToRender.length === 0) {
        container.innerHTML = `<div class="history-empty"><i class="ph ph-funnel-x" style="font-size:2rem; display:block; margin-bottom:0.5rem;"></i>Nenhum lançamento encontrado para os filtros selecionados.</div>`;
    }
    
    // Hero Stats
    document.getElementById('tot-tk-05').innerText = sums.tk05.toLocaleString('pt-BR');
    document.getElementById('tot-tk-06').innerText = sums.tk06.toLocaleString('pt-BR');
    document.getElementById('tot-tk-11').innerText = sums.tk11.toLocaleString('pt-BR');
    document.getElementById('tot-tk-12').innerText = sums.tk12.toLocaleString('pt-BR');

    // Total geral = tudo
    document.getElementById('tot-geral').innerText = sums.totalAlimentos.toLocaleString('pt-BR');
    // Alimentos puros = total - ração - pet - plástico - fralda
    const alimentosPuros = sums.totalAlimentos - sums.racao - sums.petKg - sums.plastico - sums.fralda;
    document.getElementById('tot-alimentos-puros').innerText = alimentosPuros.toLocaleString('pt-BR');
    document.getElementById('tot-racao').innerText = sums.racao.toLocaleString('pt-BR');
    
    const elTotPet = document.getElementById('tot-pet-kg');
    if (elTotPet) elTotPet.innerText = sums.petKg.toLocaleString('pt-BR');
    
    document.getElementById('tot-plastico').innerText = sums.plastico.toLocaleString('pt-BR');

    const elTotFraldasHero = document.getElementById('tot-fraldas-hero');
    if (elTotFraldasHero) elTotFraldasHero.innerText = sums.fralda.toLocaleString('pt-BR');

    // Cards individuais
    document.getElementById('tot-arroz').innerText = sums.arroz.toLocaleString('pt-BR');
    document.getElementById('tot-feijao').innerText = sums.feijao.toLocaleString('pt-BR');
    document.getElementById('tot-oleo').innerText = sums.oleo.toLocaleString('pt-BR');
    document.getElementById('tot-macarrao').innerText = sums.macarrao.toLocaleString('pt-BR');
    document.getElementById('tot-molho').innerText = sums.molho.toLocaleString('pt-BR');
    document.getElementById('tot-cafe').innerText = sums.cafe.toLocaleString('pt-BR');
    document.getElementById('tot-leite').innerText = sums.leite.toLocaleString('pt-BR');
    document.getElementById('tot-sal').innerText = sums.sal.toLocaleString('pt-BR');
    document.getElementById('tot-acucar').innerText = sums.acucar.toLocaleString('pt-BR');

    const elFraldaItem = document.getElementById('tot-fralda-item');
    if (elFraldaItem) elFraldaItem.innerText = sums.fralda.toLocaleString('pt-BR');

    const elRacaoItem = document.getElementById('tot-racao-item');
    if (elRacaoItem) elRacaoItem.innerText = sums.racao.toLocaleString('pt-BR');
    
    const elPetItem = document.getElementById('tot-pet-item');
    if (elPetItem) elPetItem.innerText = sums.petKg.toLocaleString('pt-BR');
    
    const elPlasticoItem = document.getElementById('tot-plastico-item');
    if (elPlasticoItem) elPlasticoItem.innerText = sums.plastico.toLocaleString('pt-BR');
}

window.exportarParaCSV = async function() {
    const dataToExport = getFilteredArrecadacoes();
    if (dataToExport.length === 0) {
        alert("Não há dados para exportar com os filtros selecionados.");
        return;
    }

    if (typeof ExcelJS === 'undefined') {
        alert("Biblioteca de exportação para Excel carregando... por favor tente novamente em 2 segundos.");
        return;
    }

    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('2026');

        // 1. Banner Superior Título (Mesclado A1:N1, Rosa Escuro #ED335B, Texto Branco Negrito)
        sheet.mergeCells('A1:N1');
        const r1 = sheet.getCell('A1');
        r1.value = 'ITAQUÁ RODEIO FEST - 2026';
        r1.font = { name: 'Century Gothic', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
        r1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFED335B' } };
        r1.alignment = { horizontal: 'center', vertical: 'middle' };
        sheet.getRow(1).height = 28;

        // 2. Banner Subtítulo (Mesclado A2:N2, Rosa Médio #F96F8D, Texto Branco Negrito)
        sheet.mergeCells('A2:N2');
        const r2 = sheet.getCell('A2');
        r2.value = 'CONTAGEM DIÁRIA DAS TROCAS DE ALIMENTOS, RAÇÃO, PLÁSTICOS E FRALDAS';
        r2.font = { name: 'Century Gothic', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        r2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF96F8D' } };
        r2.alignment = { horizontal: 'center', vertical: 'middle' };
        sheet.getRow(2).height = 24;

        // Agrupa arrecadações por Data
        const porData = {};
        dataToExport.forEach(item => {
            const d = item.data || 'Sem Data';
            if (!porData[d]) porData[d] = [];
            porData[d].push(item);
        });

        // Ordena as datas em ordem cronológica
        const datasOrdenadas = Object.keys(porData).sort();

        let currRow = 3;
        const totalRowNums = []; // Guarda os números das linhas de "TOTAL DO DIA:"

        datasOrdenadas.forEach(dataStr => {
            const registros = porData[dataStr];

            // Linha de Data (Ex: 10/08/2026)
            sheet.mergeCells(`A${currRow}:N${currRow}`);
            const dateCell = sheet.getCell(`A${currRow}`);
            const dateParts = dataStr.split('-');
            const dateFormatted = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}` : dataStr;
            dateCell.value = dateFormatted;
            dateCell.font = { name: 'Century Gothic', size: 11, bold: true, color: { argb: 'FF881337' } };
            dateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE7F3' } }; // Rosa bem claro
            dateCell.alignment = { horizontal: 'left', vertical: 'middle' };
            sheet.getRow(currRow).height = 22;
            currRow++;

            // Cabeçalho de Colunas
            const colHeaderRow = currRow;
            const colNames = ['LOCAL', 'ARROZ', 'FEIJÃO', 'ÓLEO', 'MACARRÃO', 'MOLHO', 'CAFÉ', 'LEITE', 'SAL', 'AÇÚCAR', 'RAÇÃO', 'EMBALAGENS PLÁSTICAS', 'FRALDAS', 'TOTAL'];
            colNames.forEach((name, i) => {
                const colLetter = String.fromCharCode(65 + i);
                const cell = sheet.getCell(`${colLetter}${colHeaderRow}`);
                cell.value = name;
                cell.font = { name: 'Century Gothic', size: 10, bold: true, color: { argb: 'FF000000' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
                cell.alignment = { horizontal: i === 0 ? 'left' : 'center', vertical: 'middle' };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                    bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                    left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                    right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
                };
            });
            sheet.getRow(colHeaderRow).height = 22;
            currRow++;

            const startDataRow = currRow;

            // Linhas de dados por Local
            registros.forEach(r => {
                const localNome = (r.local === "Van Itinerante" && r.bairro) ? `${r.local} (${r.bairro})` : (r.local || 'Ponto Fixo');
                const vals = [
                    localNome,
                    r.arroz || 0,
                    r.feijao || 0,
                    r.oleo || 0,
                    r.macarrao || 0,
                    r.molho || 0,
                    r.cafe || 0,
                    r.leite || 0,
                    r.sal || 0,
                    r.acucar || 0,
                    r.racao || 0,
                    r.plastico || 0,
                    r.fralda || 0
                ];

                vals.forEach((v, idx) => {
                    const colLetter = String.fromCharCode(65 + idx);
                    const cell = sheet.getCell(`${colLetter}${currRow}`);
                    cell.value = v;
                    cell.font = { name: 'Century Gothic', size: 10, bold: idx === 0 };
                    cell.alignment = { horizontal: idx === 0 ? 'left' : 'center', vertical: 'middle' };
                    cell.border = {
                        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                        right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
                    };
                });

                // Coluna TOTAL (N) com Fórmula =SUM(B:M)
                const totCell = sheet.getCell(`N${currRow}`);
                totCell.value = { formula: `SUM(B${currRow}:M${currRow})` };
                totCell.font = { name: 'Century Gothic', size: 10, bold: true };
                totCell.alignment = { horizontal: 'center', vertical: 'middle' };
                totCell.border = {
                    top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
                };

                sheet.getRow(currRow).height = 20;
                currRow++;
            });

            const endDataRow = currRow - 1;

            // Linha TOTAL DO DIA:
            const totalRowIndex = currRow;
            totalRowNums.push(totalRowIndex);

            const lblCell = sheet.getCell(`A${totalRowIndex}`);
            lblCell.value = 'TOTAL DO DIA:';
            lblCell.font = { name: 'Century Gothic', size: 10, bold: true, color: { argb: 'FF000000' } };
            lblCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } }; // Amarelo suave
            lblCell.alignment = { horizontal: 'left', vertical: 'middle' };
            lblCell.border = {
                top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
            };

            // Fórmulas para as colunas B até M (com result pré-calculado)
            const fields = ['arroz','feijao','oleo','macarrao','molho','cafe','leite','sal','acucar','racao','plastico','fralda'];
            let dayTotalSum = 0;

            for (let colIdx = 1; colIdx <= 12; colIdx++) {
                const colLetter = String.fromCharCode(65 + colIdx);
                const field = fields[colIdx - 1];
                const sumVal = registros.reduce((acc, r) => acc + (r[field] || 0), 0);
                dayTotalSum += sumVal;

                const cell = sheet.getCell(`${colLetter}${totalRowIndex}`);
                cell.value = { formula: `SUM(${colLetter}${startDataRow}:${colLetter}${endDataRow})`, result: sumVal };
                cell.font = { name: 'Century Gothic', size: 10, bold: true };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } };
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                    bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                    left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                    right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
                };
            }

            // Fórmula Total N da linha TOTAL DO DIA:
            const totDayCell = sheet.getCell(`N${totalRowIndex}`);
            totDayCell.value = { formula: `SUM(N${startDataRow}:N${endDataRow})`, result: dayTotalSum };
            totDayCell.font = { name: 'Century Gothic', size: 10, bold: true };
            totDayCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } };
            totDayCell.alignment = { horizontal: 'center', vertical: 'middle' };
            totDayCell.border = {
                top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
            };

            sheet.getRow(totalRowIndex).height = 22;
            currRow++;
        });

        // =====================================================
        // 5. RESUMO TOTAL DIA A DIA
        // =====================================================
        currRow += 1; // Espaço em branco

        sheet.mergeCells(`A${currRow}:N${currRow}`);
        const resumoBanner = sheet.getCell(`A${currRow}`);
        resumoBanner.value = 'RESUMO TOTAL DIA A DIA';
        resumoBanner.font = { name: 'Century Gothic', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        resumoBanner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1c3d70' } };
        resumoBanner.alignment = { horizontal: 'center', vertical: 'middle' };
        sheet.getRow(currRow).height = 24;
        currRow++;

        // Cabeçalho do resumo
        const resumoHeaders = ['DATA', 'ARROZ', 'FEIJÃO', 'ÓLEO', 'MACARRÃO', 'MOLHO', 'CAFÉ', 'LEITE', 'SAL', 'AÇÚCAR', 'RAÇÃO', 'EMBALAGENS PLÁSTICAS', 'FRALDAS', 'TOTAL'];
        resumoHeaders.forEach((name, i) => {
            const colLetter = String.fromCharCode(65 + i);
            const cell = sheet.getCell(`${colLetter}${currRow}`);
            cell.value = name;
            cell.font = { name: 'Century Gothic', size: 10, bold: true, color: { argb: 'FF000000' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
            cell.alignment = { horizontal: i === 0 ? 'left' : 'center', vertical: 'middle' };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
            };
        });
        sheet.getRow(currRow).height = 22;
        currRow++;

        // Uma linha por dia, calculando os totais diretamente dos dados
        const resumoDataRowNums = [];
        const fieldsList = ['arroz','feijao','oleo','macarrao','molho','cafe','leite','sal','acucar','racao','plastico','fralda'];
        datasOrdenadas.forEach((dataStr, idx) => {
            const registros = porData[dataStr];
            const dateParts = dataStr.split('-');
            const dateFormatted = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}` : dataStr;

            // Coluna A = data formatada
            const cellA = sheet.getCell(`A${currRow}`);
            cellA.value = dateFormatted;
            cellA.font = { name: 'Century Gothic', size: 10, bold: true };
            cellA.alignment = { horizontal: 'left', vertical: 'middle' };
            cellA.border = {
                top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
            };

            // Colunas B–M: calcula os totais reais a partir dos dados
            let dayTotal = 0;
            fieldsList.forEach((field, fIdx) => {
                const colLetter = String.fromCharCode(66 + fIdx); // B is 66
                const cell = sheet.getCell(`${colLetter}${currRow}`);
                
                const sum = registros.reduce((acc, r) => acc + (r[field] || 0), 0);
                dayTotal += sum;
                
                cell.value = sum; // Valor real (não fórmula)
                cell.font = { name: 'Century Gothic', size: 10 };
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
                };
            });

            // Coluna N = total da linha
            const cellN = sheet.getCell(`N${currRow}`);
            cellN.value = dayTotal;
            cellN.font = { name: 'Century Gothic', size: 10, bold: true };
            cellN.alignment = { horizontal: 'center', vertical: 'middle' };
            cellN.border = {
                top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
            };

            sheet.getRow(currRow).height = 20;
            resumoDataRowNums.push(currRow);
            currRow++;
        });

        // Linha TOTAL GERAL do resumo dia a dia
        const resumoTotalRow = currRow;
        const resumoTotalLbl = sheet.getCell(`A${resumoTotalRow}`);
        resumoTotalLbl.value = 'TOTAL GERAL:';
        resumoTotalLbl.font = { name: 'Century Gothic', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        resumoTotalLbl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1c3d70' } };
        resumoTotalLbl.alignment = { horizontal: 'left', vertical: 'middle' };
        resumoTotalLbl.border = {
            top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
        };

        let grandTotalAll = 0;
        for (let colIdx = 1; colIdx <= 12; colIdx++) {
            const colLetter = String.fromCharCode(65 + colIdx);
            const field = fieldsList[colIdx - 1];
            const sumFieldGlobal = dataToExport.reduce((acc, r) => acc + (r[field] || 0), 0);
            grandTotalAll += sumFieldGlobal;

            const cell = sheet.getCell(`${colLetter}${resumoTotalRow}`);
            cell.value = { 
                formula: `SUM(${colLetter}${resumoDataRowNums[0]}:${colLetter}${resumoDataRowNums[resumoDataRowNums.length - 1]})`,
                result: sumFieldGlobal 
            };
            cell.font = { name: 'Century Gothic', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1c3d70' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
            };
        }

        const resumoTotN = sheet.getCell(`N${resumoTotalRow}`);
        resumoTotN.value = { 
            formula: `SUM(B${resumoTotalRow}:M${resumoTotalRow})`,
            result: grandTotalAll 
        };
        resumoTotN.font = { name: 'Century Gothic', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        resumoTotN.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1c3d70' } };
        resumoTotN.alignment = { horizontal: 'center', vertical: 'middle' };
        resumoTotN.border = {
            top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
        };
        sheet.getRow(resumoTotalRow).height = 24;
        currRow++;

        // Largura automática das colunas para legibilidade perfeita
        sheet.columns = [
            { width: 34 }, // LOCAL
            { width: 12 }, // ARROZ
            { width: 12 }, // FEIJÃO
            { width: 12 }, // ÓLEO
            { width: 14 }, // MACARRÃO
            { width: 12 }, // MOLHO
            { width: 12 }, // CAFÉ
            { width: 12 }, // LEITE
            { width: 10 }, // SAL
            { width: 12 }, // AÇÚCAR
            { width: 14 }, // RAÇÃO
            { width: 24 }, // EMBALAGENS PLÁSTICAS
            { width: 14 }, // FRALDAS
            { width: 14 }  // TOTAL
        ];

        // Exportação do buffer e download automático em .xlsx real
        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'Contagem_Trocas_Arrecadacao_Itaqua_Rodeio_Fest_2026.xlsx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    } catch (err) {
        console.error("Erro ao gerar planilha Excel:", err);
        alert("Ocorreu um erro ao gerar a planilha Excel. Verifique o console.");
    }
};

window.exportarParaPDF = function() {
    const dataToExport = getFilteredArrecadacoes();
    if (dataToExport.length === 0) {
        alert("Não há dados para exportar com os filtros selecionados.");
        return;
    }

    if (typeof window.jspdf === 'undefined') {
        alert("Biblioteca PDF carregando... por favor tente novamente em alguns segundos.");
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape' });

    // Cores
    const colorPink = [237, 51, 91]; // #ED335B
    const colorPinkLight = [249, 111, 141]; // #F96F8D

    // Cabeçalho
    doc.setFillColor(...colorPink);
    doc.rect(0, 0, 300, 20, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("ITAQUÁ RODEIO FEST - 2026", 148.5, 10, { align: "center" });
    doc.setFontSize(12);
    doc.text("RELATÓRIO DE ARRECADAÇÕES", 148.5, 16, { align: "center" });

    // Preparar dados por dia
    const porData = {};
    dataToExport.forEach(item => {
        const d = item.data || 'Sem Data';
        if (!porData[d]) porData[d] = [];
        porData[d].push(item);
    });
    const datasOrdenadas = Object.keys(porData).sort();

    const tableBody = [];
    const totals = {
        arroz: 0, feijao: 0, oleo: 0, macarrao: 0, molho: 0, cafe: 0, 
        leite: 0, sal: 0, acucar: 0, racao: 0, plastico: 0, fralda: 0, geral: 0
    };

    const fields = ['arroz','feijao','oleo','macarrao','molho','cafe','leite','sal','acucar','racao','plastico','fralda'];

    datasOrdenadas.forEach(dataStr => {
        const registros = porData[dataStr];
        const dateParts = dataStr.split('-');
        const dateFormatted = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}` : dataStr;
        
        let dayTotals = {};
        fields.forEach(f => dayTotals[f] = 0);
        
        let dayTotalGeral = 0;
        registros.forEach(r => {
            fields.forEach(f => {
                const val = r[f] || 0;
                dayTotals[f] += val;
                totals[f] += val;
                dayTotalGeral += val;
                totals.geral += val;
            });
        });

        tableBody.push([
            dateFormatted,
            dayTotals.arroz,
            dayTotals.feijao,
            dayTotals.oleo,
            dayTotals.macarrao,
            dayTotals.molho,
            dayTotals.cafe,
            dayTotals.leite,
            dayTotals.sal,
            dayTotals.acucar,
            dayTotals.racao,
            dayTotals.plastico,
            dayTotals.fralda,
            dayTotalGeral
        ]);
    });

    tableBody.push([
        { content: 'TOTAL GERAL', styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.arroz, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.feijao, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.oleo, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.macarrao, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.molho, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.cafe, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.leite, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.sal, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.acucar, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.racao, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.plastico, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.fralda, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } },
        { content: totals.geral, styles: { fontStyle: 'bold', fillColor: colorPink, textColor: 255 } }
    ]);

    doc.autoTable({
        startY: 30,
        head: [['DATA', 'ARROZ', 'FEIJÃO', 'ÓLEO', 'MACARRÃO', 'MOLHO', 'CAFÉ', 'LEITE', 'SAL', 'AÇÚCAR', 'RAÇÃO', 'EMB. PLÁST.', 'FRALDAS', 'TOTAL']],
        body: tableBody,
        headStyles: { fillColor: colorPinkLight, halign: 'center' },
        columnStyles: {
            0: { halign: 'left', fontStyle: 'bold' },
            1: { halign: 'center' },
            2: { halign: 'center' },
            3: { halign: 'center' },
            4: { halign: 'center' },
            5: { halign: 'center' },
            6: { halign: 'center' },
            7: { halign: 'center' },
            8: { halign: 'center' },
            9: { halign: 'center' },
            10: { halign: 'center' },
            11: { halign: 'center' },
            12: { halign: 'center' },
            13: { halign: 'center', fontStyle: 'bold' }
        },
        theme: 'grid'
    });

    doc.save('Relatorio_Arrecadacoes_Rodeio_2026.pdf');
};

document.querySelectorAll('.input-qty').forEach(input => {
    input.addEventListener('focus', function() {
        this.select();
    });
});
