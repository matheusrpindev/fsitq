// components.js

function createLogoImage(size = 48) {
    return `
        <img src="logo.png?v=10" alt="Logo Fundo Social" style="width: ${size}px; height: auto; object-fit: contain;">
    `;
}

function getInitials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
}

function renderHeader() {
    const user = getCurrentUser();
    if (!user) return '';

    const showManageAccess = canManageAccess(user);
    const hash = window.location.hash || '#dashboard';

    return `
        <header class="app-header">
            <a class="header-brand" href="#dashboard">
                ${createLogoImage(44)}
                <div>
                    Portal Fundo Social
                    <small>Itaquaquecetuba</small>
                </div>
            </a>
            <nav class="header-nav">
                <button class="nav-link ${hash === '#dashboard' ? 'active' : ''}" onclick="window.location.hash='#dashboard'" title="Início">
                    <i class="ph ph-squares-four"></i> <span>Início</span>
                </button>
                ${showManageAccess ? `
                    <button class="nav-link ${hash === '#access' ? 'active' : ''}" onclick="window.location.hash='#access'" title="Gestão de Acesso">
                        <i class="ph ph-shield-check"></i> <span>Gestão de Acesso</span>
                    </button>
                ` : ''}
                <span class="header-divider"></span>
                <div class="user-info">
                    <div class="avatar">${getInitials(user.name)}</div>
                    <div class="user-text">
                        <strong>${user.name}</strong>
                        <span class="role-tag">${user.role || ''}</span>
                    </div>
                </div>
                <button class="icon-btn danger" onclick="logout()" title="Sair">
                    <i class="ph ph-sign-out"></i>
                </button>
            </nav>
        </header>
    `;
}

// Logos mapping for organs
const organLogos = {
    'Casa da Mulher': 'logo-mulher.png',
    'Fundo Social': 'logo.png',
    'Bazar': 'logo-bazar.png',
    'Rodeio': 'logo-rodeio.png'
};

const organDescriptions = {
    'Casa da Mulher': 'Atendimentos e cursos da Casa da Mulher.',
    'Fundo Social': 'Estoque do galpão: entradas, saídas e inventário.',
    'Bazar': 'Câmbio de recicláveis e loja EcoCash.',
    'Rodeio': 'Arrecadações do Itaquá Rodeio Fest.'
};

function getOrganLink(organName) {
    if (organName === 'Casa da Mulher') return './casa-da-mulher/index.html';
    if (organName === 'Rodeio') return './rodeio/index.html';
    if (organName === 'Bazar') return './ecobazar/index.html';
    if (organName === 'Fundo Social') return './fundo-social/index.html';
    return `#module/${encodeURIComponent(organName)}`;
}

// Módulos que ainda são protótipos (salvam só no navegador, sem login)
const PROTOTYPE_ORGANS = ['Casa da Mulher'];

// Versão do card para o dono do portal: chave de ativar/desativar por cima do card
function renderOrganCardOwner(organName) {
    const active = isModuleActive(organName);
    return `
        <div class="org-card-wrap ${active ? '' : 'is-off'}">
            <div class="org-card-controls">
                ${PROTOTYPE_ORGANS.includes(organName) ? '<span class="org-badge proto" title="Salva só no navegador e não exige login">Protótipo</span>' : ''}
                ${active ? '' : '<span class="org-badge off">Desativado</span>'}
                <label class="switch-toggle" title="${active ? 'Desativar' : 'Ativar'} módulo">
                    <input type="checkbox" ${active ? 'checked' : ''} onchange="handleToggleModule('${organName}', this)">
                    <span class="switch-track"><span class="switch-thumb"></span></span>
                </label>
            </div>
            ${renderOrganCard(organName)}
        </div>
    `;
}

function renderOrganCard(organName) {
    const logoFile = organLogos[organName];
    const link = getOrganLink(organName);

    return `
        <a href="${link}" class="org-card">
            <div class="org-logo-wrapper">
                ${logoFile
                    ? `<img src="${logoFile}" alt="Logo ${organName}">`
                    : `<i class="ph ph-buildings"></i>`
                }
            </div>
            <h3>${organName}</h3>
            <p>${organDescriptions[organName] || 'Acessar sistema.'}</p>
            <span class="org-go">Acessar <i class="ph ph-arrow-right"></i></span>
        </a>
    `;
}

function renderFooter() {
    return `
        <footer class="app-footer">
            <div class="footer-logos">
                <img src="logo.png?v=10" alt="Fundo Social de Solidariedade" class="footer-logo">
                <img src="logo-itaqua.png" alt="Prefeitura de Itaquá" class="footer-logo">
            </div>
            <p class="footer-copy">Fundo Social de Solidariedade de Itaquaquecetuba — ${new Date().getFullYear()}</p>
        </footer>
    `;
}
