// auth.js falso: usuário vem de ?papel=gestor|assistente
const db = window.__db;
const auth = { signOut: async () => {} };
const ALL_ORGANS = ['Rodeio', 'Fundo Social', 'Bazar', 'Casa da Mulher'];
let ORGANS = ['Rodeio', 'Fundo Social', 'Bazar'];
const papel = new URLSearchParams(location.search).get('papel') || 'gestor';
const USER = papel === 'gestor'
  ? { id: 'uid-gestor', name: 'Gestora Teste', email: 'g@t', role: 'Gestor', organs: [] }
  : { id: 'uid-assist', name: 'Assistente Teste', email: 'a@t', role: 'Assistente Técnico', organs: ['Fundo Social'] };
function getCurrentUser() { return USER; }
function canManageAccess(u) { return u && (u.role === 'Administrador' || u.role === 'Gestor'); }
function isModuleActive() { return true; }
function isOwner() { return false; }
function initAuth(cb) { setTimeout(cb, 10); }
