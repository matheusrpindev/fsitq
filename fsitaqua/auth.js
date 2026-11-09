// auth.js — Autenticação real via Firebase Authentication + perfis no Firestore
//
// MUDANÇA IMPORTANTE em relação à versão anterior:
//   - O login agora é feito por E-MAIL + SENHA usando o Firebase Auth
//     (firebase.auth().signInWithEmailAndPassword). O Firebase nunca expõe
//     senhas — nem em texto puro, nem por leitura de banco — então não há
//     mais "senha de usuário" nenhuma guardada no Firestore.
//   - O documento em /usuarios/{uid} guarda só o PERFIL (nome, role, organs),
//     nunca senha. O UID do documento é o mesmo UID da conta no Auth.
//   - Isso exige que o formulário de login (app.js) colete e-mail em vez de
//     "usuário". Ver nota no final deste arquivo.
//
// LIMITAÇÕES DO CLIENT SDK (por design de segurança do Firebase):
//   - Um usuário logado NÃO pode criar contas de Auth para outras pessoas
//     sem deslogar a si mesmo — por isso usamos um "app secundário" do
//     Firebase só para esse propósito (ver createUserAccount abaixo).
//   - Ninguém pode definir a senha de outra pessoa para um valor escolhido
//     via client SDK. O que existe é sendPasswordResetEmail(), que manda
//     um link por e-mail para a PRÓPRIA pessoa trocar a senha.
//   - Deletar a conta de Auth de outra pessoa (não só o perfil no Firestore)
//     exige Admin SDK, ou seja, uma Cloud Function. deleteUserAccess() aqui
//     remove o PERFIL (revoga acesso ao sistema), mas a conta de login em
//     si continua existindo até essa Cloud Function ser criada.

const firebaseConfig = {
    apiKey: "AIzaSyBs8IyZMrpavUXEaHTPcQIqXgyfU7nA30s",
    authDomain: "fundosocialitq.firebaseapp.com",
    projectId: "fundosocialitq",
    storageBucket: "fundosocialitq.firebasestorage.app",
    messagingSenderId: "672696448922",
    appId: "1:672696448922:web:d32f8cd5739cddc73dac23"
};

// App principal (sessão do usuário logado no navegador)
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const auth = firebase.auth();
const db = firebase.firestore();
const USERS_COLLECTION = "usuarios";

// App secundário, usado SÓ para criar contas de outras pessoas sem
// derrubar a sessão do admin atual (truque padrão do Firebase Auth).
const secondaryApp = firebase.initializeApp(firebaseConfig, "Secondary");
const secondaryAuth = secondaryApp.auth();

// Módulos (órgãos) que o portal conhece. Quais estão ATIVOS fica salvo em
// config/portal { modulosAtivos } e só o dono do portal (OWNER_UID) liga/desliga.
// ORGANS = módulos ativos; é recarregado do Firestore no initAuth.
const ALL_ORGANS = ['Rodeio', 'Fundo Social', 'Casa da Mulher', 'Bazar'];
const DEFAULT_ACTIVE_ORGANS = ['Rodeio', 'Fundo Social'];
const PORTAL_CONFIG = db.collection('config').doc('portal');
const OWNER_UID = 'QC7sDiAG5tZQitj2rFcr7OHGOy73'; // login de Matheus Rodrigues Pinheiro
let ORGANS = [...DEFAULT_ACTIVE_ORGANS];
const ROLES = ['Administrador', 'Gestor', 'Assistente Técnico', 'Assistente Administrativo'];

// Cache síncrono do usuário atual (perfil do Firestore, não a sessão do Auth).
// app.js/components.js chamam getCurrentUser() de forma síncrona, então
// mantemos esse cache atualizado via onAuthStateChanged + listener do doc.
let currentUserCache = null;
let unsubscribeUserDoc = null;
let authReadyCallbacks = [];
let authIsReady = false;

// -----------------------------------------------------------------
// Inicialização — chame initAuth(callback) UMA VEZ no início do app.js,
// e só chame router() de dentro do callback (ou depois que ele disparar
// pela primeira vez). Isso evita renderizar a tela antes de saber se
// existe uma sessão válida.
// -----------------------------------------------------------------
function initAuth(onReadyOrChange) {
    authReadyCallbacks.push(onReadyOrChange);

    auth.onAuthStateChanged((firebaseUser) => {
        if (unsubscribeUserDoc) {
            unsubscribeUserDoc();
            unsubscribeUserDoc = null;
        }

        if (!firebaseUser) {
            currentUserCache = null;
            authIsReady = true;
            authReadyCallbacks.forEach(cb => cb());
            return;
        }

        // Flag para garantir que router() só é chamado UMA VEZ por sessão
        // de autenticação. Snapshots subsequentes apenas atualizam o cache
        // silenciosamente (evita re-render/modal fantasma).
        let firstSnapshotDone = false;

        // Módulos ativos carregam em paralelo com o perfil
        const portalConfigLoaded = loadPortalConfig();

        // Escuta o perfil em tempo real (reflete mudanças de role/organs
        // feitas por um Admin enquanto o usuário está com a sessão aberta).
        unsubscribeUserDoc = db.collection(USERS_COLLECTION).doc(firebaseUser.uid)
            .onSnapshot((doc) => {
                if (doc.exists) {
                    currentUserCache = {
                        id: firebaseUser.uid,
                        email: firebaseUser.email,
                        ...doc.data()
                    };
                } else {
                    // Conta existe no Auth mas não tem perfil no Firestore
                    // (ex: foi criada fora do fluxo normal). Trata como sem
                    // permissão nenhuma até um Admin criar o perfil.
                    currentUserCache = {
                        id: firebaseUser.uid,
                        email: firebaseUser.email,
                        name: firebaseUser.email,
                        role: null,
                        organs: []
                    };
                }

                // Só dispara router() no PRIMEIRO snapshot desta sessão.
                // Atualizações seguintes (ex: admin editou perfil, troca de
                // senha atualizou mustChangePassword) apenas atualizam o
                // cache — a navegação é controlada pelo app, não pelo listener.
                // Antes, carrega quais módulos estão ativos.
                if (!firstSnapshotDone) {
                    firstSnapshotDone = true;
                    portalConfigLoaded.then(() => {
                        authIsReady = true;
                        authReadyCallbacks.forEach(cb => cb());
                    });
                }
            }, (error) => {
                console.error("Erro ao carregar perfil do usuário:", error);
                currentUserCache = null;
                if (!firstSnapshotDone) {
                    firstSnapshotDone = true;
                    authIsReady = true;
                    authReadyCallbacks.forEach(cb => cb());
                }
            });
    });
}

function isAuthReady() {
    return authIsReady;
}

// -----------------------------------------------------------------
// Módulos ativos (config/portal)
// -----------------------------------------------------------------
async function loadPortalConfig() {
    try {
        const doc = await PORTAL_CONFIG.get();
        const ativos = doc.exists && Array.isArray(doc.data().modulosAtivos)
            ? doc.data().modulosAtivos
            : DEFAULT_ACTIVE_ORGANS;
        ORGANS = ALL_ORGANS.filter(o => ativos.includes(o));
    } catch (e) {
        console.warn("Módulos ativos indisponíveis, usando o padrão:", e.code || e);
        ORGANS = [...DEFAULT_ACTIVE_ORGANS];
    }
}

function isOwner(user) {
    return !!user && user.id === OWNER_UID;
}

function isModuleActive(organName) {
    return ORGANS.includes(organName);
}

// Só o dono do portal; as regras do Firestore também só aceitam o OWNER_UID
async function setModuleActive(organName, active) {
    if (!isOwner(getCurrentUser())) return { success: false, error: 'Só o dono do portal pode ativar ou desativar módulos.' };
    const ativos = ALL_ORGANS.filter(o => o === organName ? active : ORGANS.includes(o));
    try {
        await PORTAL_CONFIG.set({
            modulosAtivos: ativos,
            atualizadoPor: auth.currentUser.uid,
            atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        ORGANS = ativos;
        return { success: true };
    } catch (e) {
        console.error("Erro ao salvar módulos ativos:", e);
        return {
            success: false,
            error: e.code === 'permission-denied'
                ? 'O Firebase recusou a alteração. As regras do Firestore ainda não liberam a configuração de módulos.'
                : 'Não foi possível salvar. Tente novamente.'
        };
    }
}

// -----------------------------------------------------------------
// Login / Logout
// -----------------------------------------------------------------

// login agora recebe EMAIL, não "username". Retorna { success, error }.
async function login(email, password) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanPass = (password || '').trim();

    if (!cleanEmail || !cleanPass) {
        return { success: false, error: 'Informe e-mail e senha.' };
    }

    try {
        await auth.signInWithEmailAndPassword(cleanEmail, cleanPass);
        // currentUserCache é populado pelo listener de onAuthStateChanged
        // acima; aguardamos o próximo "tick" do Firestore via Promise.
        await waitForUserDocLoaded();
        return { success: true };
    } catch (e) {
        console.error("Erro no login:", e.code, e.message);
        let msg = 'Não foi possível entrar. Tente novamente.';
        if (e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found') {
            msg = 'E-mail ou senha incorretos.';
        } else if (e.code === 'auth/too-many-requests') {
            msg = 'Muitas tentativas. Aguarde um pouco antes de tentar novamente.';
        }
        return { success: false, error: msg };
    }
}

// Pequeno helper para esperar o primeiro snapshot do perfil chegar
// depois de um login bem-sucedido, já que onSnapshot é assíncrono.
function waitForUserDocLoaded(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            if (currentUserCache) return resolve(currentUserCache);
            if (Date.now() - start > timeoutMs) return reject(new Error('Tempo esgotado ao carregar perfil.'));
            setTimeout(check, 50);
        };
        check();
    });
}

async function logout() {
    try {
        await auth.signOut();
    } catch (e) {
        console.error("Erro ao deslogar:", e);
    }
    currentUserCache = null;
    const modal = document.getElementById('firstAccessModal');
    if (modal) modal.remove();
    window.location.hash = '#login';
}

function getCurrentUser() {
    return currentUserCache;
}

function isAuthenticated() {
    return !!currentUserCache;
}

function canManageAccess(user) {
    if (!user) return false;
    return user.role === 'Administrador' || user.role === 'Gestor';
}

function getAccessibleOrgans(user) {
    if (!user) return [];
    if (canManageAccess(user)) {
        return ORGANS;
    }
    // Só módulos ativos (vínculos a módulos desativados não aparecem)
    return (user.organs || []).filter(o => ORGANS.includes(o));
}

// -----------------------------------------------------------------
// Gestão de usuários
// -----------------------------------------------------------------

function getUsers() {
    return new Promise((resolve, reject) => {
        db.collection(USERS_COLLECTION).get()
            .then(snapshot => {
                const users = [];
                snapshot.forEach(doc => users.push({ id: doc.id, ...doc.data() }));
                resolve(users);
            })
            .catch(reject);
    });
}

function listenUsers(callback) {
    return db.collection(USERS_COLLECTION).onSnapshot((snapshot) => {
        const users = [];
        snapshot.forEach(doc => users.push({ id: doc.id, ...doc.data() }));
        callback(users);
    }, (error) => console.error("Erro ao escutar usuários:", error));
}

// Cria uma conta de Auth + perfil no Firestore para um novo usuário,
// SEM derrubar a sessão do Admin que está criando (usa o app secundário).
async function createUserAccount({ name, email, tempPassword, role, organs }) {
    const cleanEmail = (email || '').trim().toLowerCase();
    try {
        const cred = await secondaryAuth.createUserWithEmailAndPassword(cleanEmail, tempPassword);
        const uid = cred.user.uid;

        await db.collection(USERS_COLLECTION).doc(uid).set({
            name,
            email: cleanEmail,
            role,
            organs: organs || [],
            mustChangePassword: true,
            createdAt: Date.now()
        });

        await secondaryAuth.signOut();
        return { success: true, id: uid };
    } catch (e) {
        console.error("Erro ao criar usuário:", e.code, e.message);
        let msg = 'Não foi possível criar o usuário.';
        if (e.code === 'auth/email-already-in-use') msg = 'Já existe uma conta com esse e-mail.';
        if (e.code === 'auth/weak-password') msg = 'Senha provisória muito curta (mínimo 6 caracteres).';
        return { success: false, error: msg };
    }
}

// Atualiza só o PERFIL (nome, role, organs)
async function updateUserProfile(id, { name, role, organs }) {
    try {
        await db.collection(USERS_COLLECTION).doc(id).update({ name, role, organs: organs || [] });
        return { success: true };
    } catch (e) {
        console.error("Erro ao atualizar usuário:", e);
        return { success: false, error: 'Não foi possível salvar as alterações.' };
    }
}

// O usuário troca a PRÓPRIA senha
async function changeOwnPassword(newPassword) {
    try {
        // 1. Atualiza o Firestore PRIMEIRO para evitar race condition.
        //    Quando updatePassword() dispara onAuthStateChanged → novo onSnapshot,
        //    o doc já terá mustChangePassword: false.
        await db.collection(USERS_COLLECTION).doc(auth.currentUser.uid).update({
            mustChangePassword: false
        });
        if (currentUserCache) {
            currentUserCache.mustChangePassword = false;
        }

        // 2. Agora troca a senha no Firebase Auth.
        await auth.currentUser.updatePassword(newPassword);

        return { success: true };
    } catch (e) {
        console.error("Erro ao trocar senha:", e.code, e.message);

        // Se a troca de senha falhou, restaura a flag no Firestore
        try {
            await db.collection(USERS_COLLECTION).doc(auth.currentUser.uid).update({
                mustChangePassword: true
            });
            if (currentUserCache) {
                currentUserCache.mustChangePassword = true;
            }
        } catch (_) { /* ignora erro de rollback */ }

        if (e.code === 'auth/requires-recent-login') {
            return { success: false, error: 'Por segurança, faça login novamente antes de trocar a senha.' };
        }
        return { success: false, error: 'Não foi possível trocar a senha.' };
    }
}

// Envia um link de redefinição de senha para o e-mail
async function sendPasswordReset(email) {
    try {
        await auth.sendPasswordResetEmail(email);
        return { success: true };
    } catch (e) {
        console.error("Erro ao enviar redefinição de senha:", e);
        return { success: false, error: 'Não foi possível enviar o e-mail de redefinição.' };
    }
}

// Remove o PERFIL do usuário no Firestore
async function deleteUserAccess(id) {
    try {
        await db.collection(USERS_COLLECTION).doc(id).delete();
        return { success: true };
    } catch (e) {
        console.error("Erro ao remover acesso do usuário:", e);
        return { success: false, error: 'Não foi possível remover o acesso.' };
    }
}
