// app.js

const appDiv = document.getElementById('app');

// Router
function router() {
    const hash = window.location.hash || '#login';
    const currentUser = getCurrentUser();

    // Auth guard
    if (hash !== '#login' && !isAuthenticated()) {
        window.location.hash = '#login';
        return;
    }

    if (hash === '#login' && isAuthenticated()) {
        // Não redireciona se o usuário ainda precisa definir a senha de primeiro acesso
        if (currentUser && currentUser.mustChangePassword === true) {
            // Fica no login — o modal será aberto pelo handler do formulário de login
        } else {
            goHome(currentUser);
            return;
        }
    }

    if (hash === '#dashboard' && isAuthenticated()) {
        if (getHomeLink(currentUser) !== '#dashboard') {
            goHome(currentUser);
            return;
        }
    }

    appDiv.innerHTML = '';

    if (hash === '#login') {
        renderLogin();
    } else if (hash === '#dashboard') {
        renderDashboard();
    } else if (hash === '#access') {
        renderAccessManagement();
    } else if (hash.startsWith('#module/')) {
        renderModulePlaceholder(decodeURIComponent(hash.split('/')[1]));
    } else {
        appDiv.innerHTML = `<h1>Página não encontrada</h1>`;
    }
}

// -----------------------------------------------------
// PAGE: LOGIN
// -----------------------------------------------------
function renderLogin() {
    appDiv.innerHTML = `
        <div class="auth-container">
            <section class="auth-hero">
                <div class="auth-hero-logos">
                    <img src="logo.png?v=10" alt="Fundo Social de Solidariedade">
                    <img src="logo-itaqua.png" alt="Prefeitura de Itaquaquecetuba">
                </div>
                <h2>Solidariedade organizada, do galpão até quem precisa.</h2>
                <p>Portal de gestão do Fundo Social de Solidariedade de Itaquaquecetuba.</p>
                <div class="auth-hero-tags">
                    <span><i class="ph ph-package"></i> Estoque</span>
                    <span><i class="ph ph-hand-heart"></i> Doações</span>
                    <span><i class="ph ph-confetti"></i> Rodeio</span>
                </div>
            </section>
            <section class="auth-side">
                <div class="auth-card">
                    <div class="auth-logo">
                        <img src="logo-login.png?v=1" alt="Logo Fundo Social">
                    </div>
                    <h1>Bem-vindo(a)</h1>
                    <p>Entre com seu e-mail e senha para acessar o portal.</p>

                    <form class="auth-form" id="loginForm">
                        <div class="input-group">
                            <label for="email">E-mail</label>
                            <div class="input-icon">
                                <i class="ph ph-envelope-simple"></i>
                                <input type="email" id="email" class="input-field" placeholder="seu@email.com" autocomplete="username" required>
                            </div>
                        </div>
                        <div class="input-group">
                            <label for="password">Senha</label>
                            <div class="input-icon">
                                <i class="ph ph-lock-simple"></i>
                                <input type="password" id="password" class="input-field" placeholder="••••••••" autocomplete="current-password" required>
                            </div>
                        </div>
                        <p id="loginError" class="text-error">E-mail ou senha incorretos.</p>
                        <button type="submit" class="btn btn-primary">
                            <i class="ph ph-sign-in"></i> Entrar
                        </button>
                    </form>
                    <p class="auth-foot"><i class="ph ph-lock-key"></i> Acesso restrito a servidores autorizados.</p>
                </div>
            </section>
        </div>
    `;

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const pass = document.getElementById('password').value;
        const errorEl = document.getElementById('loginError');
        const btn = e.target.querySelector('button[type="submit"]');
        
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i class="ph ph-circle-notch"></i> Entrando...`;
        }

        const result = await login(email, pass);

        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="ph ph-sign-in"></i> Entrar`;
        }

        if (result.success) {
            errorEl.style.display = 'none';
            const currentUser = getCurrentUser();
            
            if (currentUser.mustChangePassword) {
                renderFirstAccessModal(currentUser);
            } else {
                proceedAfterLogin(currentUser);
            }
        } else {
            errorEl.innerText = result.error || "E-mail ou senha incorretos.";
            errorEl.style.display = 'block';
        }
    });
}

// Para onde o usuário vai depois do login: gestores vão ao dashboard; os
// demais vão direto ao órgão quando só têm um e ao dashboard quando têm mais
// de um. Quem não tem área nenhuma cadastrada vai ao Rodeio, como antes (se
// estiver ativo); quem tem áreas mas todas desativadas fica no dashboard.
function getHomeLink(user) {
    if (canManageAccess(user)) return '#dashboard';
    const organs = getAccessibleOrgans(user);
    if (organs.length === 0) {
        const semVinculo = !(user.organs || []).length;
        return semVinculo && isModuleActive('Rodeio') ? getOrganLink('Rodeio') : '#dashboard';
    }
    if (organs.length === 1) return getOrganLink(organs[0]);
    return '#dashboard';
}

function goHome(user) {
    const link = getHomeLink(user);
    if (!link.startsWith('#')) {
        window.location.href = link;
    } else if (window.location.hash === link) {
        router();
    } else {
        window.location.hash = link;
    }
}

function proceedAfterLogin(currentUser) {
    goHome(currentUser);
}

function renderFirstAccessModal(currentUser) {
    if (document.getElementById('firstAccessModal')) return;

    const modalHtml = `
        <div class="modal-overlay active" id="firstAccessModal">
            <div class="modal-content glass-panel" style="max-width: 420px;">
                <div class="modal-header">
                    <h3>🔐 Primeiro Acesso — Crie sua Senha</h3>
                </div>
                <form id="firstAccessForm" style="margin-top: 15px;">
                    <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">
                        Olá, <b>${currentUser.name}</b>! Por motivos de segurança, você precisa cadastrar uma nova senha pessoal para prosseguir.
                    </p>
                    <div class="input-group">
                        <label>Nova Senha</label>
                        <input type="password" id="newPass1" class="input-field" placeholder="Digite sua nova senha" required minlength="4">
                    </div>
                    <div class="input-group">
                        <label>Confirme a Nova Senha</label>
                        <input type="password" id="newPass2" class="input-field" placeholder="Repita a nova senha" required minlength="4">
                    </div>
                    <p id="firstAccessError" style="display:none; color: #ef4444; font-size: 0.85rem; margin-bottom: 10px;">As senhas não coincidem. Digite novamente.</p>
                    <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 10px;">
                        <i class="ph ph-check-circle"></i> Salvar Senha e Entrar
                    </button>
                </form>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    document.getElementById('firstAccessForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const p1 = document.getElementById('newPass1').value;
        const p2 = document.getElementById('newPass2').value;
        const err = document.getElementById('firstAccessError');
        const btn = e.target.querySelector('button[type="submit"]');
        
        if (p1 !== p2) {
            err.innerText = 'As senhas não coincidem. Digite novamente.';
            err.style.display = 'block';
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i class="ph ph-circle-notch"></i> Salvando...`;
        }

        const result = await changeOwnPassword(p1);

        if (!result.success) {
            err.innerText = result.error || 'Não foi possível salvar a nova senha.';
            err.style.display = 'block';
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<i class="ph ph-check-circle"></i> Salvar Senha e Entrar`;
            }
            return;
        }

        err.style.display = 'none';
        currentUser.mustChangePassword = false;
        const modal = document.getElementById('firstAccessModal');
        if (modal) modal.remove();

        proceedAfterLogin(currentUser);
    });
}

// -----------------------------------------------------
// PAGE: DASHBOARD
// -----------------------------------------------------
function renderDashboard() {
    const user = getCurrentUser();
    const organs = getAccessibleOrgans(user);
    const today = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    const owner = isOwner(user);

    appDiv.innerHTML = `
        <div style="min-height: 100vh; display: flex; flex-direction: column;">
            ${renderHeader()}
            <main class="container" style="flex: 1; padding-bottom: 2rem;">
                <div class="page-header">
                    <span class="page-eyebrow"><i class="ph ph-calendar-blank"></i> ${today.charAt(0).toUpperCase() + today.slice(1)}</span>
                    <h2>Olá, ${user.name.split(' ')[0]} 👋</h2>
                    <p>Escolha a área que deseja acessar.</p>
                </div>

                ${owner ? `
                    <div class="owner-note">
                        <i class="ph ph-toggle-right"></i>
                        <span>Use a chave de cada card para ativar ou desativar o módulo. Módulos desativados somem para todos os outros usuários; só você continua vendo.</span>
                    </div>
                ` : ''}

                <div class="dashboard-grid">
                    ${owner
                        ? ALL_ORGANS.map(org => renderOrganCardOwner(org)).join('')
                        : organs.length > 0
                            ? organs.map(org => renderOrganCard(org)).join('')
                            : (user.organs || []).length
                                ? `<div class="empty-state"><i class="ph ph-moon"></i>As áreas que você acessa estão desativadas no momento.</div>`
                                : `<div class="empty-state"><i class="ph ph-lock-key"></i>Você ainda não tem acesso a nenhuma área. Fale com um administrador.</div>`
                    }
                </div>
            </main>
            ${renderFooter()}
        </div>
    `;
}

window.handleToggleModule = async function(organName, checkbox) {
    const active = checkbox.checked;
    if (active && PROTOTYPE_ORGANS.includes(organName)) {
        const ok = confirm(`"${organName}" ainda é um protótipo: salva os dados só no navegador de cada pessoa e a página não exige login.\n\nAtivar mesmo assim? O card vai aparecer para quem tiver acesso a essa área.`);
        if (!ok) {
            checkbox.checked = false;
            return;
        }
    }
    checkbox.disabled = true;
    const result = await setModuleActive(organName, active);
    if (!result.success) {
        alert(result.error);
    }
    renderDashboard();
};

// -----------------------------------------------------
// PAGE: ACCESS MANAGEMENT
// -----------------------------------------------------
async function renderAccessManagement() {
    const user = getCurrentUser();
    if (!canManageAccess(user)) {
        window.location.hash = '#dashboard';
        return;
    }

    const users = await getUsers();

    appDiv.innerHTML = `
        ${renderHeader()}
        <main class="container">
            <div class="page-header" style="display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap;">
                <div>
                    <h2>Gestão de Acesso</h2>
                    <p>Gerencie os usuários e as áreas que cada um acessa. ${users.length} usuário${users.length === 1 ? '' : 's'} cadastrado${users.length === 1 ? '' : 's'}.</p>
                </div>
                <button class="btn btn-primary" onclick="openUserModal()">
                    <i class="ph ph-plus"></i> Novo Usuário
                </button>
            </div>
            
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Nome</th>
                            <th>E-mail</th>
                            <th>Nível de Acesso</th>
                            <th>Áreas</th>
                            <th style="text-align: right;">Ações</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${users.map(u => `
                            <tr>
                                <td><div class="user-cell"><div class="avatar">${getInitials(u.name)}</div>${u.name}</div></td>
                                <td>${u.email || ''}</td>
                                <td>
                                    <span class="badge ${getRoleBadgeClass(u.role)}">${u.role}</span>
                                </td>
                                <td>
                                    ${u.role === 'Administrador' || u.role === 'Gestor' 
                                        ? '<span class="org-tag">Acesso Total</span>'
                                        : (u.organs && u.organs.length > 0) 
                                            ? u.organs.map(o => `<span class="org-tag">${o}</span>`).join('') 
                                            : '<span style="color: #94a3b8; font-size: 0.8rem">Nenhum</span>'
                                    }
                                </td>
                                <td class="cell-actions">
                                    <button class="icon-btn" onclick='openUserModal(${JSON.stringify(u)})' title="Editar">
                                        <i class="ph ph-pencil-simple"></i>
                                    </button>
                                    ${u.id !== user.id ? `
                                        <button class="icon-btn warn" onclick="handleResetPassword('${u.id}', '${u.name}', '${u.email || ''}')" title="Enviar link de redefinição de senha">
                                            <i class="ph ph-key"></i>
                                        </button>
                                        <button class="icon-btn danger" onclick="handleDeleteUser('${u.id}', '${u.name}')" title="Remover acesso">
                                            <i class="ph ph-trash"></i>
                                        </button>
                                    ` : ''}
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </main>

        <!-- User Modal -->
        <div class="modal-overlay" id="userModal">
            <div class="modal-content glass-panel">
                <div class="modal-header">
                    <h3 id="modalTitle">Novo Usuário</h3>
                    <button class="modal-close" onclick="closeUserModal()"><i class="ph ph-x"></i></button>
                </div>
                <form id="userForm">
                    <input type="hidden" id="userId">
                    <div class="input-group">
                        <label>Nome Completo</label>
                        <input type="text" id="editName" class="input-field" required>
                    </div>
                    <div class="input-group">
                        <label>E-mail de Acesso</label>
                        <input type="email" id="editEmail" class="input-field" required>
                    </div>
                    <div class="input-group" id="tempPasswordGroup">
                        <label>Senha Provisória</label>
                        <input type="text" id="editTempPassword" class="input-field" placeholder="Mínimo 6 caracteres" minlength="6">
                        <p style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 4px;">O usuário vai trocar essa senha no primeiro acesso.</p>
                    </div>
                    <div class="input-group">
                        <label>Nível de Hierarquia</label>
                        <select id="editRole" class="input-field" onchange="toggleOrgansSelection()">
                            ${ROLES.map(r => `<option value="${r}">${r}</option>`).join('')}
                        </select>
                    </div>
                    <div class="input-group" id="organsSelectionDiv">
                        <label>Áreas Vinculadas</label>
                        <div class="checkbox-grid">
                            ${ALL_ORGANS.map(o => `
                                <label class="checkbox-item">
                                    <input type="checkbox" name="editOrgans" value="${o}">
                                    ${o}${isModuleActive(o) ? '' : ' <small style="color: var(--text-3)">(desativado)</small>'}
                                </label>
                            `).join('')}
                        </div>
                    </div>
                    <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 20px;">
                        Salvar Usuário
                    </button>
                </form>
            </div>
        </div>
    `;

    document.getElementById('userForm').addEventListener('submit', handleUserSubmit);
    toggleOrgansSelection();
}

window.handleDeleteUser = async function(id, name) {
    if (confirm(`Tem certeza que deseja remover o acesso de "${name}"?\n\nIsso revoga o acesso ao sistema imediatamente. A conta de login em si só é totalmente removida por um processo administrativo separado.`)) {
        const result = await deleteUserAccess(id);
        if (!result.success) {
            alert(result.error || 'Não foi possível remover o acesso.');
        }
        renderAccessManagement();
    }
};

window.handleResetPassword = async function(id, name, email) {
    if (!email) {
        alert('Este usuário não possui e-mail cadastrado.');
        return;
    }
    if (confirm(`Enviar um link de redefinição de senha para "${name}" (${email})?`)) {
        const result = await sendPasswordReset(email);
        if (result.success) {
            alert(`Link de redefinição enviado para ${email}.`);
        } else {
            alert(result.error || 'Não foi possível enviar o link.');
        }
    }
};

function getRoleBadgeClass(role) {
    if (role === 'Administrador') return 'badge-admin';
    if (role === 'Gestor') return 'badge-gestor';
    if (role === 'Assistente Técnico') return 'badge-tecnico';
    return 'badge-adminstrativo';
}

// Modal functions
window.openUserModal = function(user = null) {
    const modal = document.getElementById('userModal');
    const form = document.getElementById('userForm');
    form.reset();
    
    document.getElementById('modalTitle').innerText = user ? 'Editar Usuário' : 'Novo Usuário';
    const tempPasswordGroup = document.getElementById('tempPasswordGroup');
    const emailField = document.getElementById('editEmail');
    
    if (user) {
        document.getElementById('userId').value = user.id;
        document.getElementById('editName').value = user.name;
        emailField.value = user.email || '';
        emailField.disabled = true; // e-mail não é editável por aqui (é a identidade de login)
        document.getElementById('editRole').value = user.role;
        // Senha provisória só se aplica na criação da conta; edição não altera senha.
        tempPasswordGroup.style.display = 'none';
        document.getElementById('editTempPassword').required = false;

        // Check organs
        const checkboxes = document.getElementsByName('editOrgans');
        checkboxes.forEach(cb => {
            cb.checked = user.organs ? user.organs.includes(cb.value) : false;
        });
    } else {
        document.getElementById('userId').value = '';
        emailField.value = '';
        emailField.disabled = false;
        tempPasswordGroup.style.display = '';
        document.getElementById('editTempPassword').required = true;
        document.getElementById('editTempPassword').value = '';
    }
    
    toggleOrgansSelection();
    modal.classList.add('active');
}

window.closeUserModal = function() {
    document.getElementById('userModal').classList.remove('active');
}

window.toggleOrgansSelection = function() {
    const role = document.getElementById('editRole').value;
    const organsDiv = document.getElementById('organsSelectionDiv');
    if (role === 'Administrador' || role === 'Gestor') {
        organsDiv.style.opacity = '0.5';
        organsDiv.style.pointerEvents = 'none';
    } else {
        organsDiv.style.opacity = '1';
        organsDiv.style.pointerEvents = 'all';
    }
}

async function handleUserSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('userId').value;
    const name = document.getElementById('editName').value;
    const email = document.getElementById('editEmail').value;
    const tempPassword = document.getElementById('editTempPassword').value;
    const role = document.getElementById('editRole').value;

    const checkedOrgans = Array.from(document.getElementsByName('editOrgans'))
                            .filter(cb => cb.checked)
                            .map(cb => cb.value);

    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    let result;
    if (id) {
        result = await updateUserProfile(id, { name, role, organs: checkedOrgans });
    } else {
        result = await createUserAccount({ name, email, tempPassword, role, organs: checkedOrgans });
    }

    if (submitBtn) submitBtn.disabled = false;

    if (!result.success) {
        alert(result.error || 'Não foi possível salvar o usuário.');
        return;
    }

    closeUserModal();
    renderAccessManagement();
}

// -----------------------------------------------------
// MODULE PLACEHOLDER
// -----------------------------------------------------
function renderModulePlaceholder(moduleName) {
    appDiv.innerHTML = `
        ${renderHeader()}
        <main class="container" style="text-align: center; padding-top: 100px;">
            <i class="ph ph-wrench" style="font-size: 4rem; color: var(--primary-color); margin-bottom: 20px;"></i>
            <h2>Módulo: ${moduleName}</h2>
            <p style="color: var(--text-secondary); margin-top: 16px;">
                Esta interface do órgão ainda está em desenvolvimento.
            </p>
            <br/>
            <button class="btn btn-secondary" onclick="window.location.hash='#dashboard'">Voltar ao Dashboard</button>
        </main>
    `;
}

// Listen for hash changes
window.addEventListener('hashchange', router);

// Aguarda o Firebase Auth restaurar (ou não) uma sessão salva antes de
// desenhar qualquer tela. Sem isso, a página piscaria para #login mesmo
// quando o usuário já está autenticado.
initAuth(() => router());
