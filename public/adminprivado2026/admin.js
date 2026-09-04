
/**
 * ADMIN PANEL - Sala de Juegos
 * Ultra-fast real-time chat with Socket.IO
 * Professional, clean, no lag
 */

// ============================================
// CONFIGURATION
// ============================================
const API_URL = '';
const SOCKET_OPTIONS = {
    // Allow both WebSocket and HTTP long-polling so the connection works even when
    // WebSocket is blocked (e.g. Cloudflare without WebSocket enabled) when
    // accessing via the custom domain vipcargas.com.  WebSocket is tried first
    // (faster), polling is used as fallback.
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
};

// ============================================
// STATE
// ============================================
let socket = null;
let currentToken = null;
let currentAdmin = null;
let selectedUserId = null;
let selectedUsername = null;
let selectedUserRole = null; // Role of the user currently selected for an action (password change, block…)
let selectedUserForBlock = null; // { id, username } for the block modal
let conversations = [];
let currentTab = 'open';
let comunidadAlertCount = 0; // chats derivados a Comunidad sin mirar (badge + alerta)
let typingTimeout = null;
let messageCache = new Map();
let lastSentMessageContent = null; // Para evitar duplicados de mensajes propios
let lastSentMessageTime = 0;
let availableCommands = []; // Comandos disponibles para sugerencias
let commandSuggestions = [];
let selectedCommandIndex = -1;
let processedMessageIds = new Set(); // CORREGIDO: Para evitar mensajes duplicados
let isLoadingMessages = false; // Para evitar cargas múltiples simultáneas
let activeConversationId = null; // Identificador estable del chat activo (race condition fix)
let activeFetchController = null; // AbortController para cancelar fetches de mensajes anteriores

// PWA - Instalación de App
let deferredInstallPrompt = null;
let isAppInstalled = false;

// Notificaciones Push
let pushSubscription = null;

// ============================================
// DOM ELEMENTS
// ============================================
const elements = {
    loginScreen: document.getElementById('loginScreen'),
    app: document.getElementById('app'),
    loginForm: document.getElementById('loginForm'),
    loginError: document.getElementById('loginError'),
    username: document.getElementById('username'),
    password: document.getElementById('password'),
    adminName: document.getElementById('adminName'),
    logoutBtn: document.getElementById('logoutBtn'),
    
    // Stats
    statUsers: document.getElementById('statUsers'),
    statOnline: document.getElementById('statOnline'),
    statMessages: document.getElementById('statMessages'),
    statUnread: document.getElementById('statUnread'),
    unreadBadge: document.getElementById('unreadBadge'),
    
    // Navigation
    navItems: document.querySelectorAll('.nav-item'),
    sections: document.querySelectorAll('.section'),
    
    // Chats
    conversationsList: document.getElementById('conversationsList'),
    searchUser: document.getElementById('searchUser'),
    refreshChats: document.getElementById('refreshChats'),
    tabBtns: document.querySelectorAll('.tab-btn'),
    
    // Chat panel
    chatHeader: document.getElementById('chatHeader'),
    chatMessages: document.getElementById('chatMessages'),
    chatInputArea: document.getElementById('chatInputArea'),
    chatUsername: document.getElementById('chatUsername'),
    chatStatus: document.getElementById('chatStatus'),
    chatAppStatus: document.getElementById('chatAppStatus'),
    chatBalance: document.getElementById('chatBalance'),
    chatBlockedBanner: document.getElementById('chatBlockedBanner'),
    chatBlockedReason: document.getElementById('chatBlockedReason'),
    messageInput: document.getElementById('messageInput'),
    sendMessage: document.getElementById('sendMessage'),
    typingIndicator: document.getElementById('typingIndicator'),

    // Action buttons
    btnCBU: document.getElementById('btnCBU'),
    btnDeposit: document.getElementById('btnDeposit'),
    btnBonus: document.getElementById('btnBonus'),
    btnWithdraw: document.getElementById('btnWithdraw'),
    btnPassword: document.getElementById('btnPassword'),
    btnPayments: document.getElementById('btnPayments'),
    btnCommunity: document.getElementById('btnCommunity'),
    btnBlock: document.getElementById('btnBlock'),
    btnUnblock: document.getElementById('btnUnblock'),
    btnClose: document.getElementById('btnClose'),
    
    // Modals
    depositModal: document.getElementById('depositModal'),
    withdrawModal: document.getElementById('withdrawModal'),
    passwordModal: document.getElementById('passwordModal'),
    
    // Toast
    toastContainer: document.getElementById('toastContainer')
};

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    checkAdminSession();
    setupEventListeners();
});

function setupEventListeners() {
    // Login
    elements.loginForm.addEventListener('submit', handleLogin);
    
    // Logout
    elements.logoutBtn.addEventListener('click', handleLogout);
    
    // Navigation
    elements.navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const section = item.dataset.section;
            switchSection(section);
        });
    });
    
    // Tabs - INSTANTÁNEO: mostrar inmediatamente sin delay
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            elements.tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTab = btn.dataset.tab;
            if (currentTab === 'comunidad') clearComunidadAlert();
            // Limpiar selección de chat al cambiar de pestaña
            if (selectedUserId) {
                if (socket) socket.emit('leave_chat_room', { userId: selectedUserId });
                selectedUserId = null;
                elements.chatHeader.classList.add('hidden');
                elements.chatInputArea.classList.add('hidden');
                elements.chatMessages.innerHTML = `
                    <div class="empty-state">
                        <span class="icon icon-comment-dots"></span>
                        <p>Selecciona una conversación para ver los mensajes</p>
                    </div>
                `;
            }
            // Mostrar datos cacheados de la pestaña al instante (sin pantalla en blanco)
            const tabCache = conversationsCacheByTab.get(currentTab);
            if (tabCache && tabCache.data.length > 0) {
                conversations = tabCache.data;
                renderConversations();
            } else {
                elements.conversationsList.innerHTML = `
                    <div class="empty-state">
                        <span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span>
                        <p>Cargando...</p>
                    </div>
                `;
            }
            // Refrescar datos en background (actualiza lista suavemente)
            loadConversations(false);
            // Actualizar botón según la pestaña
            updateActionButtonsByTab();
        });
    });
    
    // Search
    elements.searchUser.addEventListener('input', debounce((e) => {
        searchConversations(e.target.value);
    }, 300));
    
    // Refresh
    elements.refreshChats.addEventListener('click', loadConversations);
    
    // Chat input
    elements.messageInput.addEventListener('keydown', (e) => {
        // CORREGIDO: Manejar navegación y selección de comandos ANTES de enviar mensaje
        if (commandSuggestions.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedCommandIndex = (selectedCommandIndex + 1) % commandSuggestions.length;
                updateCommandSelection();
                return;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedCommandIndex = (selectedCommandIndex - 1 + commandSuggestions.length) % commandSuggestions.length;
                updateCommandSelection();
                return;
            } else if (e.key === 'Enter' && selectedCommandIndex >= 0) {
                e.preventDefault();
                insertCommand(commandSuggestions[selectedCommandIndex].name);
                return;
            } else if (e.key === 'Tab') {
                e.preventDefault();
                const idx = selectedCommandIndex >= 0 ? selectedCommandIndex : 0;
                insertCommand(commandSuggestions[idx].name);
                return;
            } else if (e.key === 'Escape') {
                hideCommandSuggestions();
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
        handleTyping();
    });
    
    // COMANDOS: Detectar cuando se escribe "/" para mostrar sugerencias
    elements.messageInput.addEventListener('input', (e) => {
        const value = e.target.value;
        if (value.startsWith('/')) {
            showCommandSuggestions(value);
        } else {
            hideCommandSuggestions();
        }
        handleTyping();
    });
    
    elements.sendMessage.addEventListener('click', sendMessage);
    
    // CORREGIDO: Botón adjuntar imagen
    const attachImageBtn = document.getElementById('attachImageBtn');
    const imageInput = document.getElementById('imageInput');
    if (attachImageBtn && imageInput) {
        attachImageBtn.addEventListener('click', () => {
            imageInput.click();
        });
        imageInput.addEventListener('change', handleImageSelect);
    }

    // Pegar imagen con Ctrl+V desde portapapeles (escritorio)
    if (elements.messageInput) {
        elements.messageInput.addEventListener('paste', handleAdminPaste);
    }
    
    // Action buttons
    elements.btnCBU.addEventListener('click', sendCBU);
    elements.btnDeposit.addEventListener('click', () => {
        // Limpiar formulario antes de abrir
        document.getElementById('depositAmount').value = '';
        document.querySelectorAll('.quick-amounts button').forEach(b => b.classList.remove('active'));
        const bonusInfoEl = document.getElementById('bonusInfo');
        if (bonusInfoEl) bonusInfoEl.textContent = '';
        showModal('depositModal');
        // Aviso INTERNO de bono automático (async, no bloquea el modal)
        loadDepositAppBonusHint();
    });
    if (elements.btnBonus) {
        elements.btnBonus.addEventListener('click', () => {
            // Limpiar formulario de bonus antes de abrir
            const bonusAmountEl = document.getElementById('bonusAmount');
            const bonusDescEl = document.getElementById('bonusDesc');
            if (bonusAmountEl) bonusAmountEl.value = '';
            if (bonusDescEl) bonusDescEl.value = '';
            document.querySelectorAll('.bonus-options button').forEach(b => b.classList.remove('active'));
            showModal('bonusModal');
        });
    }
    elements.btnWithdraw.addEventListener('click', () => {
        // Limpiar formulario de retiro antes de abrir
        const withdrawAmountEl = document.getElementById('withdrawAmount');
        if (withdrawAmountEl) withdrawAmountEl.value = '';
        showModal('withdrawModal');
    });
    elements.btnPassword.addEventListener('click', () => {
        // Opening from the chat panel: clear any user-table-specific role override.
        selectedUserRole = null;
        showModal('passwordModal');
    });
    elements.btnPayments.addEventListener('click', sendToPayments);
    if (elements.btnBlock) elements.btnBlock.addEventListener('click', openBlockModalFromChat);
    if (elements.btnUnblock) elements.btnUnblock.addEventListener('click', handleUnblockFromChat);
    elements.btnClose.addEventListener('click', closeChat);
    
    // Modal close buttons
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal');
            hideModal(modal.id);
        });
    });
    
    // Quick amounts - ACUMULATIVO
    document.querySelectorAll('.quick-amounts button').forEach(btn => {
        btn.addEventListener('click', () => {
            const amount = parseInt(btn.dataset.amount);
            const modal = btn.closest('.modal');
            if (modal.id === 'depositModal') {
                const currentAmount = parseInt(document.getElementById('depositAmount').value) || 0;
                document.getElementById('depositAmount').value = currentAmount + amount;
                calculateBonus();
            } else if (modal.id === 'withdrawModal') {
                const currentAmount = parseInt(document.getElementById('withdrawAmount').value) || 0;
                const newAmount = currentAmount + amount;
                document.getElementById('withdrawAmount').value = newAmount;
                updateWithdrawTotal();
            }
        });
    });
    
    // Bonus options
    document.querySelectorAll('.bonus-options button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.bonus-options button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            calculateBonus();
        });
    });
    
    // Deposit amount change
    document.getElementById('depositAmount').addEventListener('input', calculateBonus);
    
    // Withdraw amount change - update total
    document.getElementById('withdrawAmount').addEventListener('input', updateWithdrawTotal);
    
    // Confirm buttons
    document.getElementById('confirmDeposit').addEventListener('click', handleDeposit);
    document.getElementById('confirmWithdraw').addEventListener('click', handleWithdraw);
    document.getElementById('confirmPasswordChange').addEventListener('click', handlePasswordChange);
    const confirmBonusBtn = document.getElementById('confirmBonus');
    if (confirmBonusBtn) {
        confirmBonusBtn.addEventListener('click', handleDirectBonus);
    }
    
    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                hideModal(modal.id);
            }
        });
    });
    
    // CORREGIDO: Tecla Escape para cerrar chat seleccionado (deseleccionar)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && selectedUserId) {
            // Si hay un modal abierto, cerrarlo primero
            const openModal = document.querySelector('.modal.active');
            if (openModal) {
                hideModal(openModal.id);
                return;
            }
            // Si no hay modal, deseleccionar el chat
            deselectChat();
        }
    });
}

// ============================================
// AUTHENTICATION
// ============================================
async function handleLogin(e) {
    e.preventDefault();
    
    const username = elements.username.value.trim();
    const password = elements.password.value;
    
    if (!username || !password) {
        showLoginError('Completa todos los campos');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (data.token) {
            currentToken = data.token;
            currentAdmin = data.user;
            
            // Configurar UI según el rol
            setupRoleBasedUI();
            
            // Verificar si necesita cambiar contraseña
            if (data.user.needsPasswordChange) {
                showPasswordChangeModal();
                return;
            }
            
            // Primero mostrar el panel
            showApp();

            // publisher_admin: vista limitada. Skip socket / chats / FCM /
            // stats globales (no tiene permisos y generaría 403 ruidosos).
            if (currentAdmin?.role === 'publisher_admin') {
                showToast('Login exitoso', 'success');
                return;
            }

            // CORREGIDO: Solicitar permiso para notificaciones del navegador
            requestNotificationPermission();

            // Send FCM token to backend now that we have an auth token
            const pendingFcmToken = localStorage.getItem('adminFcmToken');
            if (pendingFcmToken) {
                fetch(`${API_URL}/api/notifications/register-token`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${currentToken}`
                    },
                    body: JSON.stringify({ fcmToken: pendingFcmToken })
                }).then(r => r.json()).then(d => {
                    if (d.success) console.log('[FCM Admin] ✅ Token registrado post-login');
                }).catch(() => {});
            }

            // Luego intentar cargar datos (con manejo de errores)
            try {
                initSocket();
            } catch (e) {
            }

            try {
                loadConversations();
            } catch (e) {
            }

            try {
                loadStats();
            } catch (e) {
            }

            startConversationReconciliation();

            showToast('Login exitoso', 'success');
        } else {
            showLoginError(data.message || data.error || 'Credenciales inválidas');
        }
    } catch (error) {
        console.error('Login error:', error);
        showLoginError('Error de conexión');
    }
}

async function checkAdminSession() {
    try {
        const response = await fetch(`${API_URL}/api/admin/me`, {
            credentials: 'include',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            currentToken = data.token || null;
            currentAdmin = data.user;
            setupRoleBasedUI();
            showApp();
            // publisher_admin: vista limitada — no carga socket / chats /
            // stats globales / comandos. setupRoleBasedUI ya disparó sus
            // stats propios via loadPublisherAdminStats().
            if (currentAdmin?.role === 'publisher_admin') {
                return;
            }
            initSocket();
            // Solicitar permiso para notificaciones al iniciar
            requestNotificationPermission();
            loadConversations();
            loadStats();
            // Cargar comandos al iniciar para las sugerencias
            loadCommands();
            // Iniciar reconciliación periódica de conversaciones
            startConversationReconciliation();
        } else {
            showLogin();
        }
    } catch (error) {
        console.error('Session check error:', error);
        showLogin();
    }
}

function handleLogout() {
    if (socket) {
        socket.disconnect();
    }
    // Clear the server-side admin_session cookie (best-effort, ignore errors).
    fetch(`${API_URL}/api/auth/admin-logout`, { method: 'POST', credentials: 'include', headers: { 'Authorization': `Bearer ${currentToken}` } })
        .catch(() => {});
    currentToken = null;
    currentAdmin = null;
    selectedUserId = null;
    showLogin();
}

function showLogin() {
    elements.loginScreen.classList.remove('hidden');
    elements.app.classList.add('hidden');
    elements.username.value = '';
    elements.password.value = '';
    elements.loginError.textContent = '';
}

function showLoginError(message) {
    elements.loginError.textContent = message;
}

function showApp() {
    elements.loginScreen.classList.add('hidden');
    elements.app.classList.remove('hidden');
    elements.adminName.textContent = currentAdmin?.username || 'Admin';
}

function showPasswordChangeModal() {
    showModal('passwordModal');
    // Deshabilitar el botón de cerrar modal
    const closeBtn = document.querySelector('#passwordModal .close-modal');
    if (closeBtn) {
        closeBtn.style.display = 'none';
    }
    // Cambiar el botón de cancelar para que no funcione
    const cancelBtn = document.querySelector('#passwordModal .btn-secondary');
    if (cancelBtn) {
        cancelBtn.style.display = 'none';
    }
    // Agregar mensaje obligatorio
    const modalHeader = document.querySelector('#passwordModal .modal-header h3');
    if (modalHeader) {
        modalHeader.innerHTML = '<span class="icon icon-key"></span> Cambio de Contraseña Obligatorio';
    }
}

function setupRoleBasedUI() {
    const role = currentAdmin?.role;

    // ============================================================
    // PUBLISHER_ADMIN — vista limitada
    // Esta cuenta no ve nada del panel general: ocultamos sidebar
    // entero, stats-bar, y todas las secciones excepto su panel
    // dedicado. Sale temprano para no aplicar la lógica de tabs/chats
    // que no aplica a este rol.
    // ============================================================
    if (role === 'publisher_admin') {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) sidebar.style.display = 'none';
        const statsBar = document.querySelector('.stats-bar');
        if (statsBar) statsBar.style.display = 'none';
        // Ocultar TODAS las secciones primero...
        document.querySelectorAll('section.section').forEach(s => {
            s.classList.remove('active');
            s.style.display = 'none';
        });
        // ...y mostrar SÓLO la de publisher_admin.
        const paSection = document.getElementById('publisherAdminSection');
        if (paSection) {
            paSection.style.display = 'block';
            paSection.classList.add('active');
        }
        // Ajustar layout del main para que ocupe todo (sidebar oculto).
        const main = document.querySelector('.main-content');
        if (main) main.style.marginLeft = '0';
        // Cargar stats iniciales + lista de usuarios paginada + influencers.
        loadPublisherAdminStats();
        loadPaUsers(1, '');
        loadPaInfluencers();
        // Búsqueda al apretar Enter en el input.
        const searchInput = document.getElementById('paUsersSearch');
        if (searchInput && !searchInput.dataset.bound) {
            searchInput.dataset.bound = '1';
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); paUsersSearchSubmit(); }
            });
        }
        return;
    }

    // Configurar pestañas visibles según el rol
    const tabOpen = document.querySelector('[data-tab="open"]');
    const tabClosed = document.querySelector('[data-tab="closed"]');
    const tabPayments = document.querySelector('[data-tab="payments"]');
    const tabComunidad = document.querySelector('[data-tab="comunidad"]');

    if (role === 'withdrawer') {
        // Withdrawer solo ve PAGOS
        if (tabOpen) tabOpen.style.display = 'none';
        if (tabClosed) tabClosed.style.display = 'none';
        if (tabPayments) tabPayments.style.display = 'flex';
        if (tabComunidad) tabComunidad.style.display = 'none';
        currentTab = 'payments';
    } else if (role === 'depositor') {
        // Depositor: abiertos/cerrados; NO ve PAGOS ni COMUNIDAD
        if (tabPayments) tabPayments.style.display = 'none';
        if (tabComunidad) tabComunidad.style.display = 'none';
        if (tabOpen) tabOpen.style.display = 'flex';
        if (tabClosed) tabClosed.style.display = 'flex';
        currentTab = 'open';
    } else if (role === 'comunidad') {
        // Comunidad: abiertos/cerrados/comunidad; NO ve PAGOS. Enfocado en Abiertos.
        if (tabPayments) tabPayments.style.display = 'none';
        if (tabOpen) tabOpen.style.display = 'flex';
        if (tabClosed) tabClosed.style.display = 'flex';
        if (tabComunidad) tabComunidad.style.display = 'flex';
        currentTab = 'open';
    } else {
        // Admin general ve todo (incluida Comunidad)
        if (tabOpen) tabOpen.style.display = 'flex';
        if (tabClosed) tabClosed.style.display = 'flex';
        if (tabPayments) tabPayments.style.display = 'flex';
        if (tabComunidad) tabComunidad.style.display = 'flex';
    }
    
    // Depositor y withdrawer pueden ver "Usuarios" pero NO pueden exportar CSV
    const usersNavItem = document.querySelector('.nav-item[data-section="users"]');
    if (usersNavItem) {
        usersNavItem.style.display = ['admin', 'depositor', 'withdrawer'].includes(role) ? '' : 'none';
    }
    // Solo el admin general puede exportar usuarios
    const exportCsvBtn = document.getElementById('exportUsersCSVBtn');
    if (exportCsvBtn) {
        exportCsvBtn.style.display = role === 'admin' ? '' : 'none';
    }

    // Bonus directo: visible para admin, depositor y comunidad
    const btnBonus = elements.btnBonus;
    if (btnBonus) {
        btnBonus.style.display = ['admin', 'depositor', 'comunidad'].includes(role) ? '' : 'none';
    }

    // SMS Masivo: solo visible para admin general
    const smsNavItem = document.querySelector('.nav-item-sms-masivo');
    if (smsNavItem) {
        smsNavItem.style.display = role === 'admin' ? '' : 'none';
    }

    // Config privada (#128): solo admin general (adentro pide su propia clave)
    const pcNavItem = document.querySelector('.nav-item-private-config');
    if (pcNavItem) {
        pcNavItem.style.display = role === 'admin' ? '' : 'none';
    }
    // Auditoría (#132): solo admin general
    const auNavItem = document.querySelector('.nav-item-audit');
    if (auNavItem) {
        auNavItem.style.display = role === 'admin' ? '' : 'none';
        if (role === 'admin') { refreshAuditBadge(); setInterval(refreshAuditBadge, 5 * 60 * 1000); }
    }
    // Deep-link desde Telegram: /adminprivado2026/?chat=<userId>&u=<username>
    try {
        const qp = new URLSearchParams(location.search);
        const dlUser = qp.get('chat');
        if (dlUser && !window._deepLinkDone) {
            window._deepLinkDone = true;
            history.replaceState(null, '', location.pathname);
            setTimeout(() => { try { selectConversation(dlUser, qp.get('u') || ''); } catch (_) {} }, 1500);
        }
    } catch (_) {}

    // Cuentas Publicistas y Dashboard Publicistas: sólo admin general
    const paNavItem = document.querySelector('.nav-item-publisher-admins');
    if (paNavItem) {
        paNavItem.style.display = role === 'admin' ? '' : 'none';
    }
    const dashNavItem = document.querySelector('.nav-item-publishers-dashboard');
    if (dashNavItem) {
        dashNavItem.style.display = role === 'admin' ? '' : 'none';
    }

    // Demoras de respuesta (SLA): sólo admin general
    const cdNavItem = document.querySelector('.nav-item-chat-delays');
    if (cdNavItem) {
        cdNavItem.style.display = role === 'admin' ? '' : 'none';
    }

    // Actualizar botones según la pestaña actual
    updateActionButtonsByTab();
}

// ============================================
// PUBLISHER_ADMIN — vista limitada
// ============================================
// Sólo se invocan desde la vista publisher_admin (role==='publisher_admin').
// Cualquier 403 acá indica desincronización entre frontend y backend; se
// loguea pero no se propaga al usuario porque no hay nada que pueda hacer.

async function loadPublisherAdminStats() {
    try {
        const r = await fetch(`${API_URL}/api/admin/publisher-admin/my-stats`, {
            credentials: 'include',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!r.ok) {
            console.warn('[publisher_admin] my-stats falló:', r.status);
            return;
        }
        const data = await r.json();

        // Título: "Juan Pérez — Meta Ads enero 2026"
        const title = document.getElementById('paPublisherName');
        const subtitle = document.getElementById('paPublisherSubtitle');
        if (data.publisher) {
            if (title) title.textContent = data.publisher.publisher;
            if (subtitle) subtitle.textContent = data.publisher.name + ' (' + data.publisher.code + ')';
        } else {
            if (title) title.textContent = 'Mi panel';
            if (subtitle) subtitle.textContent = 'Sin publicista asignado — contactá al administrador';
        }

        // Stats
        const fmt = n => '$' + (Number(n) || 0).toLocaleString('es-AR');
        const elUsers = document.getElementById('paStatUsers');
        const elDep = document.getElementById('paStatDeposits');
        const elWit = document.getElementById('paStatWithdrawals');
        const elNet = document.getElementById('paStatNet');
        if (elUsers) elUsers.textContent = data.totals.users;
        if (elDep) elDep.textContent = fmt(data.totals.deposits);
        if (elWit) elWit.textContent = fmt(data.totals.withdrawals);
        if (elNet) elNet.textContent = fmt(data.totals.netRevenue);

        // La lista de usuarios ahora la maneja loadPaUsers (paginada + búsqueda).
    } catch (e) {
        console.error('[publisher_admin] loadPublisherAdminStats:', e);
    }
}

// ============================================
// PUBLISHER_ADMIN — Mis usuarios (lista paginada + búsqueda + cambio contraseña)
// ============================================
let _paUsersPage = 1;
let _paUsersSearch = '';

function _paSafe(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadPaUsers(page = 1, search = '') {
    _paUsersPage = page;
    _paUsersSearch = search;
    const listEl = document.getElementById('paUsersList');
    const pagEl = document.getElementById('paUsersPagination');
    if (!listEl) return;
    listEl.innerHTML = '<span style="color:#888;font-size:13px;">Cargando…</span>';
    if (pagEl) pagEl.innerHTML = '';
    try {
        const qs = new URLSearchParams({ page: String(page) });
        if (search) qs.set('search', search);
        const r = await fetch(`${API_URL}/api/admin/publisher-admin/users?${qs.toString()}`, {
            credentials: 'include',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!r.ok) {
            listEl.innerHTML = '<span style="color:#ff6666;font-size:13px;">Error cargando usuarios</span>';
            return;
        }
        const data = await r.json();
        const users = data.users || [];
        if (users.length === 0) {
            listEl.innerHTML = search
                ? `<span style="color:#888;font-size:13px;">No hay usuarios que coincidan con "${_paSafe(search)}".</span>`
                : '<span style="color:#888;font-size:13px;">Todavía no creaste usuarios.</span>';
            return;
        }
        listEl.innerHTML = users.map(u => {
            const dateStr = fmtFechaHoraAR(u.createdAt);
            const infBadge = u.acquisitionInfluencer
                ? `<span style="color:#6cf;font-size:10px;background:rgba(108,170,255,0.12);padding:1px 6px;border-radius:4px;margin-left:6px;white-space:nowrap;">🎬 ${_paSafe(u.acquisitionInfluencer)}</span>`
                : '';
            return `<div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:10px 12px;background:#1a1a2e;border-radius:6px;font-size:13px;">
                <span style="color:#fff;font-weight:600;">${_paSafe(u.username)}${infBadge}</span>
                <span style="color:#888;font-size:11px;white-space:nowrap;">${_paSafe(dateStr)}</span>
                <button onclick="openPaChangePwdModal('${_paSafe(u.id)}','${_paSafe(u.username)}')" style="padding:6px 12px;background:rgba(212,175,55,0.15);border:1px solid #d4af37;color:#d4af37;border-radius:5px;cursor:pointer;font-size:11px;white-space:nowrap;">🔑 Contraseña</button>
            </div>`;
        }).join('');

        // Paginación
        const totalPages = data.totalPages || 0;
        if (pagEl && totalPages > 1) {
            const mk = (label, targetPage, disabled) => `<button onclick="loadPaUsers(${targetPage}, _paUsersSearch)" ${disabled ? 'disabled' : ''} style="padding:6px 12px;background:${disabled ? '#1a1a2e' : '#2a2a3a'};color:${disabled ? '#444' : '#fff'};border:none;border-radius:6px;cursor:${disabled ? 'not-allowed' : 'pointer'};font-size:12px;">${label}</button>`;
            pagEl.innerHTML = `
                ${mk('← Anterior', page - 1, page <= 1)}
                <span style="color:#aaa;font-size:12px;">Página ${page} de ${totalPages} <span style="color:#666;">(${data.total} usuarios)</span></span>
                ${mk('Siguiente →', page + 1, page >= totalPages)}
            `;
        } else if (pagEl && data.total > 0) {
            pagEl.innerHTML = `<span style="color:#666;font-size:11px;">${data.total} usuario(s)</span>`;
        }
    } catch (e) {
        listEl.innerHTML = '<span style="color:#ff6666;font-size:13px;">Error de conexión</span>';
    }
}

function paUsersSearchSubmit() {
    const input = document.getElementById('paUsersSearch');
    const search = input ? input.value.trim() : '';
    loadPaUsers(1, search);
}

function paUsersClearSearch() {
    const input = document.getElementById('paUsersSearch');
    if (input) input.value = '';
    loadPaUsers(1, '');
}

function openPaChangePwdModal(userId, username) {
    document.getElementById('paChangePwdUserId').value = userId;
    document.getElementById('paChangePwdSubtitle').textContent = 'Vas a cambiar la contraseña de: ' + username;
    document.getElementById('paChangePwdNew').value = '';
    document.getElementById('paChangePwdError').style.display = 'none';
    document.getElementById('paChangePwdOk').style.display = 'none';
    showModal('paChangePwdModal');
}

function closePaChangePwdModal() {
    hideModal('paChangePwdModal');
}

async function submitPaChangePwd() {
    const userId = document.getElementById('paChangePwdUserId').value;
    const newPassword = document.getElementById('paChangePwdNew').value;
    const errEl = document.getElementById('paChangePwdError');
    const okEl = document.getElementById('paChangePwdOk');
    const btn = document.getElementById('paChangePwdBtn');
    errEl.style.display = 'none';
    okEl.style.display = 'none';
    if (!newPassword || newPassword.length < 6) {
        errEl.textContent = 'La contraseña debe tener al menos 6 caracteres';
        errEl.style.display = 'block';
        return;
    }
    btn.disabled = true; btn.textContent = 'Cambiando...';
    try {
        const r = await fetch(`${API_URL}/api/admin/publisher-admin/users/${encodeURIComponent(userId)}/change-password`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ newPassword })
        });
        const data = await r.json();
        if (!r.ok) {
            errEl.textContent = data.error || 'Error cambiando contraseña';
            errEl.style.display = 'block';
            return;
        }
        okEl.textContent = '✓ Contraseña cambiada. Pasale la nueva al cliente por WhatsApp.';
        okEl.style.display = 'block';
        document.getElementById('paChangePwdNew').value = '';
        setTimeout(() => closePaChangePwdModal(), 2200);
    } catch (e) {
        errEl.textContent = 'Error de conexión';
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false; btn.textContent = 'Cambiar';
    }
}

// Carga los influencers activos de la campaña del publisher_admin y puebla el
// desplegable del form de crear usuario. Si la campaña no tiene influencers
// cargados, oculta el selector (flujo igual al de antes).
let _paInfluencers = [];
async function loadPaInfluencers() {
    const wrap = document.getElementById('paNewInfluencerWrap');
    const sel = document.getElementById('paNewInfluencer');
    if (!wrap || !sel) return;
    try {
        const r = await fetch(`${API_URL}/api/admin/publisher-admin/influencers`, {
            credentials: 'include',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = r.ok ? await r.json() : { influencers: [] };
        _paInfluencers = data.influencers || [];
    } catch (e) {
        _paInfluencers = [];
    }
    if (_paInfluencers.length === 0) {
        wrap.style.display = 'none';
        sel.innerHTML = '';
        return;
    }
    sel.innerHTML = '<option value="">— Elegí un influencer —</option>' +
        _paInfluencers.map(n => `<option value="${_paSafe(n)}">${_paSafe(n)}</option>`).join('');
    wrap.style.display = 'block';
}
window.loadPaInfluencers = loadPaInfluencers;

async function paCreateUser() {
    const usernameEl = document.getElementById('paNewUsername');
    const passwordEl = document.getElementById('paNewPassword');
    const phoneEl = document.getElementById('paNewPhone');
    const influencerEl = document.getElementById('paNewInfluencer');
    const errBox = document.getElementById('paCreateError');
    const okBox = document.getElementById('paCreateSuccess');
    const btn = document.getElementById('paCreateBtn');

    if (errBox) errBox.style.display = 'none';
    if (okBox) okBox.style.display = 'none';

    const username = usernameEl?.value.trim();
    const password = passwordEl?.value;
    const phone = phoneEl?.value.trim();
    // El selector sólo está visible si la campaña tiene influencers cargados.
    const influencerRequired = _paInfluencers.length > 0;
    const influencer = influencerRequired ? (influencerEl?.value || '') : '';

    if (!username || !password) {
        if (errBox) {
            errBox.textContent = 'Usuario y contraseña son obligatorios';
            errBox.style.display = 'block';
        }
        return;
    }
    if (influencerRequired && !influencer) {
        if (errBox) {
            errBox.textContent = 'Elegí el influencer de este usuario';
            errBox.style.display = 'block';
        }
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Creando...'; }

    try {
        const r = await fetch(`${API_URL}/api/admin/publisher-admin/create-user`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ username, password, phone: phone || null, influencer: influencer || undefined })
        });
        const data = await r.json();
        if (!r.ok) {
            if (errBox) {
                errBox.textContent = data.error || 'Error creando usuario';
                errBox.style.display = 'block';
            }
            return;
        }
        if (okBox) {
            okBox.textContent = `✓ Usuario "${data.user.username}" creado correctamente. Pasale los datos por WhatsApp.`;
            okBox.style.display = 'block';
        }
        usernameEl.value = '';
        passwordEl.value = '';
        phoneEl.value = '';
        if (influencerEl) influencerEl.value = '';
        // Recargar stats + la lista (volver a página 1 sin búsqueda activa).
        loadPublisherAdminStats();
        loadPaUsers(1, '');
        const searchInput = document.getElementById('paUsersSearch');
        if (searchInput) searchInput.value = '';
    } catch (e) {
        if (errBox) {
            errBox.textContent = 'Error de conexión';
            errBox.style.display = 'block';
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Crear usuario'; }
    }
}
// Exponer al global scope para los onclick="" del HTML
window.paCreateUser = paCreateUser;
window.loadPaUsers = loadPaUsers;
window.paUsersSearchSubmit = paUsersSearchSubmit;
window.paUsersClearSearch = paUsersClearSearch;
window.openPaChangePwdModal = openPaChangePwdModal;
window.closePaChangePwdModal = closePaChangePwdModal;
window.submitPaChangePwd = submitPaChangePwd;

// ====== Alerta / badge de la sección Comunidad ======
// Pinta el contador rojo en la pestaña Comunidad.
function renderComunidadBadge() {
    const tab = document.querySelector('[data-tab="comunidad"]');
    if (!tab) return;
    let b = document.getElementById('comunidadTabBadge');
    if (comunidadAlertCount > 0) {
        if (!b) {
            b = document.createElement('span');
            b.id = 'comunidadTabBadge';
            b.style.cssText = 'background:#dc3545;color:#fff;border-radius:10px;padding:0 6px;font-size:10px;margin-left:5px;font-weight:800;';
            tab.appendChild(b);
        }
        b.textContent = comunidadAlertCount;
        b.style.display = '';
    } else if (b) {
        b.style.display = 'none';
    }
}

// userIds ya contados en el badge (mientras el admin no entró a la pestaña).
// Evita que un cliente que escribe muchos mensajes infle el contador: el badge
// cuenta CHATS distintos esperando, no mensajes.
const _comunidadSeenUsers = new Set();
let _lastComunidadAlertAt = 0; // throttle del aviso sonoro/toast

// Avisa de actividad en Comunidad (derivación o cliente que vuelve a escribir):
// suma al badge si es un chat nuevo + sonido/toast/notificación (con throttle).
//   userId: el cliente; kind: 'derive' (derivación) | 'activity' (re-escribió).
function bumpComunidadAlert(userId, kind) {
    const isNew = !userId || !_comunidadSeenUsers.has(userId);
    if (userId) _comunidadSeenUsers.add(userId);
    if (isNew) {
        comunidadAlertCount++;
        renderComunidadBadge();
    }
    // El aviso ruidoso se limita a 1 cada 3s para no spamear si llegan varios
    // mensajes seguidos, pero el badge siempre se actualiza al instante.
    const now = Date.now();
    if (now - _lastComunidadAlertAt < 3000) return;
    _lastComunidadAlertAt = now;
    try { playNotificationSound(); } catch (_) {}
    const isActivity = kind === 'activity';
    showToast(isActivity
        ? '🔔 Un cliente de COMUNIDAD respondió — revisá la pestaña Comunidad'
        : '🔔 Nuevo chat en COMUNIDAD — entrá a la pestaña Comunidad', 'info');
    try {
        showBrowserNotification('🔔 Comunidad',
            isActivity ? 'Un cliente de Comunidad respondió' : 'Derivaron un chat a la sección Comunidad', '');
    } catch (_) {}
}

// Al entrar a la pestaña Comunidad: limpiar el aviso.
function clearComunidadAlert() {
    comunidadAlertCount = 0;
    _comunidadSeenUsers.clear();
    renderComunidadBadge();
}

// Actualizar botones de acción según la pestaña actual
function updateActionButtonsByTab() {
    const btnPayments = elements.btnPayments;
    const btnCommunity = elements.btnCommunity;
    if (!btnPayments) return;

    const role = currentAdmin?.role;
    // Quién puede derivar a Comunidad desde Abiertos (no el withdrawer).
    const canDeriveCommunity = ['admin', 'depositor', 'comunidad'].includes(role);

    if (currentTab === 'payments') {
        // En Pagos: "Enviar a Abiertos" (no para withdrawer). Sin botón de comunidad.
        if (role === 'withdrawer') {
            btnPayments.style.display = 'none';
        } else {
            btnPayments.style.display = '';
            btnPayments.innerHTML = '<span class="icon icon-exchange"></span> Enviar a Abiertos';
            btnPayments.onclick = sendToOpen;
        }
        if (btnCommunity) btnCommunity.style.display = 'none';
    } else if (currentTab === 'comunidad') {
        // En Comunidad: ocultar "Pagos"; el botón verde devuelve el chat a Abiertos.
        btnPayments.style.display = 'none';
        if (btnCommunity) {
            btnCommunity.style.display = '';
            btnCommunity.innerHTML = '<span class="icon icon-exchange"></span> Enviar a Abiertos';
            btnCommunity.onclick = sendToOpen;
        }
    } else {
        // Abiertos / Cerrados: "Enviar a Pagos" + (en Abiertos) "Derivar a Comunidad".
        btnPayments.style.display = '';
        btnPayments.innerHTML = '<span class="icon icon-exchange"></span> Enviar a Pagos';
        btnPayments.onclick = sendToPayments;
        if (btnCommunity) {
            if (currentTab === 'open' && canDeriveCommunity) {
                btnCommunity.style.display = '';
                btnCommunity.innerHTML = '<span class="icon icon-users"></span> Derivar a Comunidad';
                btnCommunity.onclick = sendToCommunity;
            } else {
                btnCommunity.style.display = 'none';
            }
        }
    }
}

// ============================================
// SOCKET.IO - ULTRA FAST
// ============================================
function initSocket() {
    if (socket) {
        socket.disconnect();
    }
    
    socket = io(SOCKET_OPTIONS);
    
    socket.on('connect', () => {
        socket.emit('authenticate', currentToken);
    });
    
    socket.on('authenticated', (data) => {
        if (data.success) {
            joinAdminRoom();
        } else {
            console.error('❌ Socket authentication failed');
        }
    });
    
    // NEW MESSAGE - INSTANT
    socket.on('new_message', (data) => {
        handleNewMessage(data);
    });
    
    // MESSAGE SENT CONFIRMATION
    socket.on('message_sent', (data) => {
        // Update temp message with real one instead of adding duplicate
        const tempEl = document.querySelector('[data-messageid^="temp-"]');
        if (tempEl) {
            tempEl.dataset.messageid = data.id;
        }
    });
    
    // CHAT CLOSED - Mantener chat abierto para seguir respondiendo
    socket.on('chat_closed', (data) => {
        if (data.userId === selectedUserId) {
            showToast('Chat movido a Cerrados. Puedes seguir respondiendo.', 'info');
            // Fix #3: Recargar mensajes para mostrar el mensaje de cierre desde DB
            messageCache.delete(selectedUserId);
            loadMessages(selectedUserId);
        }
        // Invalidar cache de las pestañas afectadas y recargar
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        loadConversations(true);
    });
    
    // CONVERSATION_UPDATED (para compatibilidad con versiones anteriores del backend)
    socket.on('conversation_updated', (data) => {
        if (data.userId !== selectedUserId) {
            incrementUnreadCount();
            playNotificationSound();
        }
        scheduleConversationsRefresh();
    });
    
    // CHAT MOVED TO PAYMENTS
    socket.on('chat_moved', (data) => {
        const dest = data && data.to;

        // Si el chat activo es el que se movió, limpiar el panel.
        if (data.userId === selectedUserId) {
            selectedUserId = null;
            activeConversationId = null; // RACE CONDITION FIX
            elements.chatHeader.classList.add('hidden');
            elements.chatInputArea.classList.add('hidden');
            const txt = dest === 'comunidad' ? 'Chat derivado a Comunidad. Selecciona otra conversación.'
                      : dest === 'open' ? 'Chat enviado a Abiertos. Selecciona otra conversación.'
                      : 'Chat enviado a pagos. Selecciona otra conversación.';
            elements.chatMessages.innerHTML = `
                <div class="empty-state">
                    <span class="icon icon-comment-dots"></span>
                    <p>${txt}</p>
                </div>
            `;
        }

        if (dest === 'comunidad') {
            // Invalidar caches afectadas y refrescar si estoy en una de ellas.
            conversationsCacheByTab.delete('open');
            conversationsCacheByTab.delete('comunidad');
            if (currentTab === 'open' || currentTab === 'comunidad') loadConversations(true);
            // ALERTA para el agente de Comunidad (solo a quien ve esa sección).
            if (['admin', 'comunidad'].includes(currentAdmin?.role) && currentTab !== 'comunidad') {
                bumpComunidadAlert(data.userId, 'derive');
            }
            return;
        }

        // Movimientos a pagos / abiertos (comportamiento existente).
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('payments');
        conversationsCacheByTab.delete('comunidad');
        loadConversations(true);
        showToast(dest === 'open' ? 'Chat enviado a Abiertos' : 'Chat enviado a pagos', 'info');
    });

    // ACTIVIDAD EN COMUNIDAD: un cliente ya derivado volvió a escribir. Re-avisar
    // al agente de Comunidad (badge + sonido) si no está mirando esa pestaña, así
    // no se le pierde el chat al estar respondiendo en "Abiertos".
    socket.on('comunidad_activity', (data) => {
        if (!data || !data.userId) return;
        // Refrescar la lista de Comunidad para que el chat suba con el nuevo mensaje.
        conversationsCacheByTab.delete('comunidad');
        if (currentTab === 'comunidad') {
            loadConversations(true);
            return; // ya la está viendo, no hace falta alertar
        }
        if (['admin', 'comunidad'].includes(currentAdmin?.role)) {
            bumpComunidadAlert(data.userId, 'activity');
        }
    });
    
    // hgcash: movimiento nuevo / cambio de estado → refrescar el panel en vivo (si está abierto).
    socket.on('hgcash_movement', () => {
        if (typeof hgcashLiveRefresh === 'function') hgcashLiveRefresh(false);
    });

    // USER TYPING
    socket.on('user_typing', (data) => {
        if (data.userId === selectedUserId) {
            showTypingIndicator();
        }
    });
    
    socket.on('user_stop_typing', (data) => {
        if (data.userId === selectedUserId) {
            hideTypingIndicator();
        }
    });
    
    // STATS UPDATE
    socket.on('stats', (data) => {
        updateStats(data);
    });
    
    // USER ONLINE/OFFLINE
    socket.on('user_connected', (data) => {
        updateUserStatus(data.userId, true);
        // Si el usuario conectado es el chat activo, actualizar info (incl. estado de app)
        if (data.userId === selectedUserId) {
            loadUserInfo(data.userId);
        }
    });
    
    socket.on('user_disconnected', (data) => {
        updateUserStatus(data.userId, false);
    });
    
    // Actualizar estado de app de notificaciones en tiempo real
    socket.on('user_app_status', (data) => {
        if (data.userId === selectedUserId && elements.chatAppStatus) {
            if (data.appInstalled && data.fcmTokenContext === 'standalone') {
                elements.chatAppStatus.textContent = '📱 APP INSTALADA';
                elements.chatAppStatus.style.color = '#00ff88';
            } else if (data.appInstalled && data.fcmTokenContext !== 'standalone') {
                elements.chatAppStatus.textContent = '🌐 NOTIS EN NAVEGADOR';
                elements.chatAppStatus.style.color = '#4fc3f7';
            } else {
                elements.chatAppStatus.textContent = '📵 NOTIS INACTIVAS';
                elements.chatAppStatus.style.color = '#aaa';
            }
        }
    });
    
    // CHAT UPDATED - Actualizar lista lateral en tiempo real cuando llega un mensaje
    socket.on('chat_updated', (data) => {
        const convIndex = conversations.findIndex(c => c.userId === data.userId);
        if (convIndex === -1) {
            // Conversación nueva o no visible: refrescar coalescido (evita un
            // reload por cada mensaje de chats fuera del tab actual).
            scheduleConversationsRefresh();
            return;
        }
        const conv = conversations[convIndex];
        conv.lastMessageAt = data.lastMessageAt || new Date();
        if (data.unreadIncrement > 0 && data.userId !== selectedUserId) {
            conv.unread = (conv.unread || 0) + data.unreadIncrement;
        }
        // Mover al tope de la lista
        conversations.splice(convIndex, 1);
        conversations.unshift(conv);
        // Actualizar cache
        conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
        renderConversations();
    });

    // MESSAGES READ - Sincronizar estado leído/no leído entre admins
    socket.on('messages_read', (data) => {
        const convIndex = conversations.findIndex(c => c.userId === data.userId);
        if (convIndex !== -1) {
            conversations[convIndex].unread = 0;
            conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
            renderConversations();
        }
        loadStatsThrottled();
    });

    // ADMIN MESSAGE SENT - Actualizar lista cuando otro admin envía un mensaje
    socket.on('admin_message_sent', (data) => {
        const message = data.message;
        if (!message) return;
        const chatUserId = data.receiverId;
        const currentAdminId = currentAdmin && (currentAdmin.userId || currentAdmin.id);
        // Si otro admin envió al chat activo, mostrar el mensaje
        if (chatUserId === selectedUserId && data.senderId !== currentAdminId) {
            if (!processedMessageIds.has(message.id)) {
                processedMessageIds.add(message.id);
                addMessageToChat(message, true);
                scrollToBottom();
            }
        }
        // Actualizar conversación en la lista
        updateConversationInList(message);
    });

    // DISCONNECT
    socket.on('disconnect', () => {
    });

    // RECONNECT - Re-fetch conversations to recover any missed events
    socket.on('reconnect', () => {
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true);
    });
    
    // ERROR
    socket.on('error', (data) => {
        console.error('❌ Socket error:', data);
        showToast(data.message || 'Error de conexión', 'error');
    });
}

// Reconciliación periódica: invalidar cache y recargar conversaciones para
// recuperar cualquier evento perdido por reconexión u otro motivo. Es SOLO red
// de seguridad (el socket cubre el tiempo real) → cada 180s alcanza; el fetch
// es grande y dispara un re-render completo. Se saltea con la pestaña oculta
// (al volver, el socket 'reconnect' y el switch de sección ya recargan).
let reconciliationInterval = null;
function startConversationReconciliation() {
    if (reconciliationInterval) clearInterval(reconciliationInterval);
    reconciliationInterval = setInterval(() => {
        if (document.hidden) return;
        conversationsCacheByTab.delete(currentTab);
        loadConversations(false);
    }, 180000);
}

function joinAdminRoom() {
    socket.emit('join_admin_room');
}

function handleNewMessage(data) {
    const message = data.message || data;
    const senderId = message.senderId;
    const receiverId = message.receiverId;
    
    
    // CORREGIDO: Verificar si el mensaje ya fue procesado (evitar duplicados del socket)
    if (message.id) {
        if (processedMessageIds.has(message.id)) {
            return;
        }
        processedMessageIds.add(message.id);
    }
    
    // Verificar si el mensaje ya existe en el DOM
    if (message.id && elements.chatMessages.querySelector(`[data-messageid="${message.id}"]`)) {
        return;
    }
    
    // CORREGIDO: Verificar mensajes temporales con mismo contenido (evitar duplicados del optimistic UI)
    if (message.content) {
        const tempElements = elements.chatMessages.querySelectorAll('[data-messageid^="temp-"]');
        for (const tempEl of tempElements) {
            const tempContent = tempEl.querySelector('.message-content')?.textContent?.trim();
            if (tempContent === message.content.trim()) {
                // Actualizar el ID temporal al real en lugar de crear duplicado
                tempEl.dataset.messageid = message.id;
                return;
            }
        }
    }
    
    const adminRoles = ['admin', 'depositor', 'withdrawer', 'comunidad'];
    const isFromAdmin = adminRoles.includes(message.senderRole);
    const isSystemMessage = message.type === 'system' || senderId === 'admin' || senderId === 'system';
    
    // Determinar el userId del chat al que pertenece este mensaje
    const chatUserId = isFromAdmin || isSystemMessage ? receiverId : senderId;
    
    // Si hay un chat seleccionado y este mensaje pertenece a ese chat, mostrarlo
    if (selectedUserId && chatUserId === selectedUserId) {
        addMessageToChat(message, isFromAdmin || isSystemMessage);
        markMessagesAsRead(selectedUserId);
        playNotificationSound();
        scrollToBottom();
        setTimeout(scrollToBottom, 100);
        // También actualizar conversación en la lista (mover al tope y actualizar preview)
        updateConversationInList(message);
    } else {
        // Mensaje de otro chat - actualizar lista y mostrar notificación
        incrementUnreadCount();
        playNotificationSound();
        // Mostrar notificación del navegador
        const senderName = message.senderUsername || 'Usuario';
        const messagePreview = message.type === 'image' ? '📸 Imagen' : message.type === 'video' ? '🎥 Video' : (message.content?.substring(0, 50) + '...');
        showBrowserNotification(
            `💬 Nuevo mensaje de ${senderName}`,
            messagePreview,
            '/favicon.ico'
        );
        // Actualizar conversación en la lista en tiempo real (sin HTTP call)
        updateConversationInList(message);
    }
}

// ============================================
// CONVERSATIONS
// ============================================
// Cache por pestaña: clave = tab ('open'|'closed'|'payments'), valor = { data: [], timestamp: 0 }
let conversationsCacheByTab = new Map();
const CONVERSATIONS_CACHE_TIME = 30000; // 30 segundos (actualizamos en tiempo real vía WebSocket)

// ---- Anti-tormenta de requests (fix 429 "Demasiadas solicitudes") ----
// El admin está en la sala `admins` y el backend hace notifyAdmins('new_message')
// por CADA mensaje del sistema (todos los usuarios, incl. automáticos de
// Fueguito/reembolso/depósito). Sin throttle, cada evento disparaba un
// loadConversations(true) (4 requests: reload forzado + 3 prefetch) o un
// loadStats(), agotando el límite global de 300 req/min por IP y devolviendo
// 429 en todo el panel cuando hay muchos chats activos. Coalescemos esas
// recargas de fondo: como mucho UNA cada few segundos.
// Throttle con leading edge: si hace >=4s que no hubo recarga, refresca YA
// (cero lag en uso normal). Solo bajo ráfaga de mensajes se limita a 1 cada 4s
// con una recarga final (trailing), garantizando que nunca se "starve".
let _lastConvRefreshAt = 0;
let _convRefreshTimer = null;
function scheduleConversationsRefresh() {
    // Si no estás viendo la sección Chats, no tiene sentido recargar la lista de
    // conversaciones por cada mensaje de otros agentes (gasta requests y puede
    // 429-ear). Al volver a Chats, switchSection('chats') la recarga una vez.
    const chatsActive = document.getElementById('chatsSection')?.classList.contains('active');
    if (!chatsActive) return;
    const MIN_GAP = 4000;
    const doRefresh = () => {
        _lastConvRefreshAt = Date.now();
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true, { prefetch: false });
    };
    const elapsed = Date.now() - _lastConvRefreshAt;
    if (elapsed >= MIN_GAP) {
        doRefresh(); // leading edge: refrescar al instante
    } else if (!_convRefreshTimer) {
        _convRefreshTimer = setTimeout(() => {
            _convRefreshTimer = null;
            doRefresh();
        }, MIN_GAP - elapsed);
    }
}

// loadStats throttleado: la insignia de no leídos también se actualiza de forma
// optimista y por el evento `stats` del socket, así que la llamada HTTP puede
// limitarse (máx 1 cada 5s) sin perder exactitud visible.
let _lastStatsAt = 0;
let _statsTimer = null;
function loadStatsThrottled() {
    const MIN_GAP = 5000;
    const now = Date.now();
    const elapsed = now - _lastStatsAt;
    if (elapsed >= MIN_GAP) {
        _lastStatsAt = now;
        loadStats();
    } else if (!_statsTimer) {
        _statsTimer = setTimeout(() => {
            _statsTimer = null;
            _lastStatsAt = Date.now();
            loadStats();
        }, MIN_GAP - elapsed);
    }
}

/**
 * Actualización inteligente de una conversación en la lista (sin HTTP call).
 * Se llama cuando llega un mensaje nuevo de otro chat.
 */
function updateConversationInList(message) {
    const adminRoles = ['admin', 'depositor', 'withdrawer', 'comunidad'];
    const isFromAdmin = adminRoles.includes(message.senderRole);
    const chatUserId = isFromAdmin ? message.receiverId : message.senderId;
    
    // Actualizar en el array conversations actual
    const convIndex = conversations.findIndex(c => c.userId === chatUserId);
    if (convIndex === -1) {
        // Conversación nueva o no visible: refrescar de forma coalescida
        // (un solo reload aunque lleguen muchos mensajes de chats no listados).
        scheduleConversationsRefresh();
        return;
    }
    
    const conv = conversations[convIndex];
    if (message.type === 'video') {
        conv.lastMessage = '🎥 Video';
    } else if (message.type !== 'image') {
        conv.lastMessage = message.content;
    } else {
        conv.lastMessage = '📸 Imagen';
    }
    conv.lastMessageAt = message.timestamp || new Date();
    if (!isFromAdmin) {
        conv.unread = (conv.unread || 0) + 1;
    }
    
    // Mover la conversación al top de la lista
    conversations.splice(convIndex, 1);
    conversations.unshift(conv);
    
    // Actualizar cache de la pestaña actual
    conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
    
    // Re-renderizar la lista de forma instantánea
    renderConversations();
}

// Cargar conversaciones con cache por pestaña.
// opts.prefetch=false evita el prefetch de mensajes (se usa en recargas de
// fondo disparadas por sockets, para no amplificar las requests).
async function loadConversations(forceRefresh = false, opts = {}) {
    const { prefetch = true } = opts;
    const now = Date.now();
    const tabCache = conversationsCacheByTab.get(currentTab);
    
    // Usar cache si está disponible, no es forzado y no expiró
    if (!forceRefresh && tabCache && (now - tabCache.timestamp) < CONVERSATIONS_CACHE_TIME) {
        conversations = tabCache.data;
        renderConversations();
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/conversations?status=${currentTab}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            console.error('[loadConversations] HTTP', response.status, errBody);
            showToast(`Error cargando ${currentTab}: ${errBody.error || response.status}`, 'error');
            // NO guardar respuesta vacía en cache cuando hay error
            return;
        }
        
        const data = await response.json();
        conversations = data.conversations || [];
        
        // Guardar en cache por pestaña
        conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
        
        renderConversations();

        // PREFETCH: Cargar mensajes de los primeros 3 chats en background
        // (solo en cargas manuales; se omite en refrescos de fondo por socket).
        if (prefetch) prefetchMessages(conversations.slice(0, 3));
    } catch (error) {
        console.error('Error loading conversations:', error);
    }
}

// PREFETCH: Cargar mensajes silenciosamente
async function prefetchMessages(convs) {
    for (const conv of convs) {
        if (!messageCache.has(conv.userId)) {
            fetch(`${API_URL}/api/messages/${conv.userId}?limit=50`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            })
            .then(r => r.json())
            .then(data => {
                if (data.messages) {
                    messageCache.set(conv.userId, data.messages);
                }
            })
            .catch(() => {});
        }
    }
}

// Render coalescido: en un panel ocupado cada evento de socket (chat_updated,
// new_message, messages_read…) disparaba un rebuild COMPLETO de la lista por
// evento. Ahora múltiples llamadas en el mismo frame producen UN solo render
// (requestAnimationFrame); el estado `conversations` ya queda actualizado al
// instante, solo se difiere el pintado. Con la pestaña oculta el navegador
// pausa rAF → se pinta al volver, con el estado más reciente.
let _renderConvsPending = false;
function renderConversations() {
    if (_renderConvsPending) return;
    _renderConvsPending = true;
    requestAnimationFrame(() => {
        _renderConvsPending = false;
        _renderConversationsNow();
    });
}

function _renderConversationsNow() {
    // Delegación de clicks: UN solo listener en el contenedor (antes se
    // re-adjuntaba un listener POR ITEM en cada render → miles de listeners
    // huérfanos por minuto en horas pico).
    if (!elements.conversationsList._convClickDelegated) {
        elements.conversationsList._convClickDelegated = true;
        elements.conversationsList.addEventListener('click', (ev) => {
            const item = ev.target.closest('.conversation-item');
            if (!item || !elements.conversationsList.contains(item)) return;
            selectConversation(item.dataset.userid, item.dataset.username);
        });
    }
    if (conversations.length === 0) {
        elements.conversationsList.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comments"></span>
                <p>No hay conversaciones</p>
            </div>
        `;
        return;
    }
    
    elements.conversationsList.innerHTML = conversations.map(conv => {
        // Chips de etiquetas del cliente (visibles sin entrar al chat). Mismo estilo
        // que la tabla de Usuarios. 'comunidad' se resalta en verde.
        const tagsHtml = (Array.isArray(conv.tags) && conv.tags.length)
            ? `<span class="conv-tags" style="display:flex;gap:3px;flex-wrap:wrap;margin-top:2px;">` + conv.tags.map(t => {
                const low = String(t).toLowerCase();
                const st = low === 'comunidad'
                    ? 'background:rgba(22,163,74,0.20);border:1px solid rgba(22,163,74,0.55);color:#34d36b;'
                    : low === 'no comunidad'
                    ? 'background:rgba(120,120,130,0.20);border:1px solid rgba(160,160,170,0.5);color:#b8bcc6;'
                    : 'background:rgba(212,175,55,0.18);border:1px solid rgba(212,175,55,0.45);color:#d4af37;';
                return `<span style="${st}border-radius:9px;padding:0 6px;font-size:9.5px;">${escapeHtml(t)}</span>`;
              }).join('') + `</span>`
            : '';
        return `
        <div class="conversation-item ${conv.unread > 0 ? 'unread' : ''} ${conv.userId === selectedUserId ? 'active' : ''}"
             data-userid="${escapeHtml(conv.userId)}"
             data-username="${escapeHtml(conv.username)}">
            <div class="conv-avatar">
                <span class="icon icon-user"></span>
            </div>
            <div class="conv-info">
                <span class="conv-name">${escapeHtml(conv.username)}${conv.publisher ? ` <span class="conv-publisher" title="Captado por la pauta de ${escapeHtml(conv.publisher)}">📣 ${escapeHtml(conv.publisher)}</span>` : ''}</span>
                <span class="conv-preview">${escapeHtml(conv.lastMessage || 'Sin mensajes')}</span>
                ${tagsHtml}
            </div>
            <div class="conv-meta">
                <span class="conv-time">${formatTime(conv.lastMessageAt)}</span>
                ${conv.unread > 0 ? `<span class="conv-badge">${conv.unread}</span>` : ''}
            </div>
        </div>
    `;
    }).join('');
    // Los clicks los maneja el listener delegado del contenedor (ver arriba).
}

function searchConversations(query) {
    const items = document.querySelectorAll('.conversation-item');
    const lowerQuery = query.toLowerCase();
    
    items.forEach(item => {
        const name = item.querySelector('.conv-name').textContent.toLowerCase();
        item.style.display = name.includes(lowerQuery) ? 'flex' : 'none';
    });
}

// CORREGIDO: Optimizado para eliminar lag al seleccionar conversación
async function selectConversation(userId, username) {
    // CORREGIDO: Salir de la sala anterior si existe
    if (selectedUserId && socket) {
        socket.emit('leave_chat_room', { userId: selectedUserId });
    }
    
    selectedUserId = userId;
    selectedUsername = username;
    activeConversationId = userId; // Identificador estable para verificar respuestas tardías
    
    // Update UI inmediatamente
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.toggle('active', item.dataset.userid === userId);
    });
    
    // Fix #2: Marcar como leído de forma instantánea en la UI (antes de la llamada API)
    const convItem = document.querySelector(`.conversation-item[data-userid="${userId}"]`);
    if (convItem) {
        convItem.classList.remove('unread');
        const badge = convItem.querySelector('.conv-badge');
        if (badge) badge.remove();
    }
    const conv = conversations.find(c => c.userId === userId);
    if (conv && conv.unread > 0) {
        const currentBadgeCount = parseInt(elements.unreadBadge.textContent) || 0;
        const newCount = Math.max(0, currentBadgeCount - conv.unread);
        if (newCount <= 0) {
            elements.unreadBadge.classList.add('hidden');
            elements.unreadBadge.textContent = '0';
        } else {
            elements.unreadBadge.textContent = String(newCount);
        }
        conv.unread = 0;
    }
    
    // Show chat panel inmediatamente
    elements.chatHeader.classList.remove('hidden');
    elements.chatInputArea.classList.remove('hidden');
    elements.chatUsername.textContent = username;

    // Bono de carga vigente del cliente (lo activó una notificación).
    loadChatPromoBonus(username);

    // Reset banner de bloqueo y botones hasta que loadUserInfo confirme el estado
    if (elements.chatBlockedBanner) elements.chatBlockedBanner.style.display = 'none';
    { const _fb = document.getElementById('chatFraudBanner'); if (_fb) { _fb.style.display = 'none'; _fb.innerHTML = ''; } }
    if (elements.chatBlockedReason) elements.chatBlockedReason.textContent = '';
    if (elements.btnBlock) elements.btnBlock.style.display = 'none';
    if (elements.btnUnblock) elements.btnUnblock.style.display = 'none';
    // Reset del banner de premio Fueguito hasta que loadUserInfo confirme el estado
    const fireBanner = document.getElementById('chatFireBonusBanner');
    if (fireBanner) fireBanner.style.display = 'none';
    // Reset del banner del cupón 100% por instalar la app
    const installBanner = document.getElementById('chatInstallBonusBanner');
    if (installBanner) installBanner.style.display = 'none';
    // Reset de la barra de etiquetas/notas hasta que loadUserInfo la rellene
    const tagsBar = document.getElementById('chatTagsBar');
    if (tagsBar) tagsBar.style.display = 'none';
    // Reset del banner de pago/retiro pendiente
    const payoutBanner = document.getElementById('chatPayoutBanner');
    if (payoutBanner) payoutBanner.style.display = 'none';

    // CORREGIDO: Mostrar mensajes cacheados inmediatamente (sin esperar)
    const cachedMessages = messageCache.get(userId);
    if (cachedMessages && cachedMessages.length > 0) {
        renderMessages(cachedMessages);
    } else {
        // Mostrar loading mientras se cargan los mensajes
        elements.chatMessages.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span>
                <p>Cargando mensajes...</p>
            </div>
        `;
    }
    
    // CORREGIDO: Unirse a la sala de chat del usuario
    if (socket) {
        socket.emit('join_chat_room', { userId });
    }
    
    // CORREGIDO: Cargar mensajes en paralelo (no await) para eliminar lag
    loadMessages(userId).then(() => {
        // Mark as read después de cargar (confirma en DB)
        // RACE CONDITION FIX: Solo marcar leído si este chat sigue activo
        if (userId === activeConversationId) {
            markMessagesAsRead(userId);
        }
    });
    
    // Load user info en paralelo
    loadUserInfo(userId);
}

// Solicitar permiso para notificaciones del navegador
function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
        });
    }
}

// CORREGIDO: Mostrar notificación del navegador
function showBrowserNotification(title, body, icon = '/favicon.ico') {
    if ('Notification' in window && Notification.permission === 'granted') {
        try {
            const notification = new Notification(title, {
                body: body,
                icon: icon,
                badge: icon,
                tag: 'new-message',
                requireInteraction: false,
                silent: false
            });
            
            notification.onclick = () => {
                window.focus();
                notification.close();
            };
            
            // Cerrar automáticamente después de 5 segundos
            setTimeout(() => notification.close(), 5000);
        } catch (e) {
        }
    }
}

async function loadMessages(userId) {
    // RACE CONDITION FIX: Crear un nuevo AbortController para este fetch
    if (activeFetchController) {
        activeFetchController.abort();
    }
    const controller = new AbortController();
    activeFetchController = controller;

    isLoadingMessages = true;
    
    try {
        // Mostrar mensajes cacheados inmediatamente si existen
        const cachedMessages = messageCache.get(userId);
        if (cachedMessages && cachedMessages.length > 0) {
            // Verificar que siga siendo el chat activo antes de renderizar cache
            if (userId === activeConversationId) {
                renderMessages(cachedMessages);
            }
        } else {
            // Solo mostrar loading si no hay cache y sigue activo
            if (userId === activeConversationId) {
                elements.chatMessages.innerHTML = '<div class="empty-state"><span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span><p>Cargando mensajes...</p></div>';
            }
        }
        
        // Cargar últimos 50 mensajes previos (límite del panel de admin)
        const response = await fetch(`${API_URL}/api/messages/${userId}?limit=50`, {
            signal: controller.signal,
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load messages');
        
        const data = await response.json();
        const messages = data.messages || [];
        
        // RACE CONDITION FIX: Ignorar respuesta si ya no es el chat activo
        if (userId !== activeConversationId) {
            return;
        }
        
        // Cache messages
        messageCache.set(userId, messages);
        
        // Solo re-renderizar si hay cambios
        renderMessages(messages);
    } catch (error) {
        if (error.name === 'AbortError') {
            return;
        }
        console.error('Error loading messages:', error);
        // Solo mostrar error si sigue siendo el chat activo y no hay cache
        if (userId === activeConversationId && !messageCache.get(userId)) {
            elements.chatMessages.innerHTML = '<div class="empty-state"><span class="icon icon-times-circle"></span><p>Error cargando mensajes</p></div>';
        }
    } finally {
        // Limpiar controller solo si sigue siendo el activo
        if (activeFetchController === controller) {
            activeFetchController = null;
        }
        isLoadingMessages = false;
    }
}

function renderMessages(messages) {
    // Si no hay mensajes en absoluto, mostrar empty state
    if (messages.length === 0) {
        elements.chatMessages.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comment-dots"></span>
                <p>No hay mensajes aún</p>
            </div>
        `;
        return;
    }
    
    // Usar DocumentFragment para mínimo reflow DOM
    const fragment = document.createDocumentFragment();
    processedMessageIds.clear();

    function getAdminDateLabel(dateStr) {
        const d = new Date(dateStr);
        const today = new Date();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const opts = { timeZone: 'America/Argentina/Buenos_Aires' };
        const dStr = d.toLocaleDateString('es-AR', opts);
        const todayStr = today.toLocaleDateString('es-AR', opts);
        const yesterdayStr = yesterday.toLocaleDateString('es-AR', opts);
        if (dStr === todayStr) return 'Hoy';
        if (dStr === yesterdayStr) return 'Ayer';
        return d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Argentina/Buenos_Aires' });
    }

    let lastDateLabel = '';
    messages.forEach(msg => {
        if (msg.id) {
            processedMessageIds.add(msg.id);
        }
        const dateLabel = getAdminDateLabel(msg.timestamp || new Date());
        if (dateLabel !== lastDateLabel) {
            const sep = document.createElement('div');
            sep.className = 'chat-date-separator';
            sep.innerHTML = `<span>${dateLabel}</span>`;
            fragment.appendChild(sep);
            lastDateLabel = dateLabel;
        }
        const msgDiv = createMessageElement(msg);
        fragment.appendChild(msgDiv);
    });
    
    elements.chatMessages.innerHTML = '';
    elements.chatMessages.appendChild(fragment);
    
    // Scroll instantáneo al final
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function formatMessageContent(msg) {
    if (msg.type === 'image') {
        const safeUrl = encodeURI(msg.content);
        return `<img src="${safeUrl}" class="message-image" data-lightbox-src="${safeUrl}" alt="Imagen" loading="lazy" style="cursor:pointer;">`;
    }
    
    if (msg.type === 'video') {
        const safeUrl = encodeURI(msg.content);
        return `<video src="${safeUrl}" class="message-video" controls preload="metadata" style="max-width:100%;max-height:300px;border-radius:8px;"></video>`;
    }
    
    // CORREGIDO: Convertir URLs en links clickeables
    let content = escapeHtml(msg.content);
    
    // Detectar y convertir URLs en links
    const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,;:!?])/g;
    content = content.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>');
    
    // Preservar saltos de línea
    content = content.replace(/\n/g, '<br>');
    
    return content;
}

function openLightbox(imageSrc) {
    const lightbox = document.getElementById('imageLightbox');
    const img = document.getElementById('lightboxImage');
    img.src = imageSrc;
    lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeLightbox(event) {
    // Close if clicked on background or close button
    if (event.target.id === 'imageLightbox' || event.target.classList.contains('lightbox-close')) {
        const lightbox = document.getElementById('imageLightbox');
        lightbox.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

function addMessageToChat(message, isOutgoing = false) {
    // CORREGIDO: Verificar si el mensaje ya existe en el DOM (evitar duplicados)
    if (message.id) {
        const existingById = elements.chatMessages.querySelector(`[data-messageid="${message.id}"]`);
        if (existingById) {
            return;
        }
        // Verificar si existe un mensaje temporal con el mismo contenido
        const tempElements = elements.chatMessages.querySelectorAll('[data-messageid^="temp-"]');
        for (const tempEl of tempElements) {
            const tempContent = tempEl.querySelector('.message-content')?.textContent?.trim();
            const tempTime = tempEl.querySelector('.message-time')?.textContent;
            if (tempContent === message.content && tempTime) {
                // Actualizar el ID temporal al real
                tempEl.dataset.messageid = message.id;
                // CORREGIDO: Scroll después de actualizar
                scrollToBottom();
                setTimeout(scrollToBottom, 100);
                return;
            }
        }
    }
    
    // CORREGIDO: Agregar a mensajes procesados
    if (message.id) {
        processedMessageIds.add(message.id);
        // Limpiar Set si crece demasiado
        if (processedMessageIds.size > 100) {
            const iterator = processedMessageIds.values();
            processedMessageIds.delete(iterator.next().value);
        }
    }
    
    // Mensajes de sistema (automáticos, naranja): mismo render que al cargar el
    // historial, ya con la hora de envío visible (createMessageElement).
    let msgDiv;
    if (message.type === 'system') {
        msgDiv = createMessageElement(message);
    } else {
        msgDiv = document.createElement('div');
        msgDiv.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
        msgDiv.dataset.messageid = message.id;
        msgDiv.innerHTML = `
            <div class="message-header">
                <span class="icon icon-user"></span>
                <span>${escapeHtml(message.senderUsername)}</span>
            </div>
            <div class="message-content">${formatMessageContent(message)}</div>
            <div class="message-time">${formatChatTime(message.timestamp || new Date())}</div>
        `;
    }

    // Remove empty state if exists
    const emptyState = elements.chatMessages.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    
    elements.chatMessages.appendChild(msgDiv);
    
    // CORREGIDO: Scroll automático con múltiples intentos
    requestAnimationFrame(() => {
        scrollToBottom();
        setTimeout(scrollToBottom, 50);
        setTimeout(scrollToBottom, 150);
        setTimeout(scrollToBottom, 300);
    });
}

function getMessageType(msg) {
    if (msg.type === 'system') return 'system';
    // CORREGIDO: Incluir depositor y withdrawer como roles de admin
    const adminRoles = ['admin', 'depositor', 'withdrawer', 'comunidad'];
    if (adminRoles.includes(msg.senderRole)) return 'outgoing';
    return 'incoming';
}

// ============================================
// MESSAGING
// ============================================
async function sendMessage() {
    const content = elements.messageInput.value.trim();
    if (!content || !selectedUserId) return;

    // Issue #3: Si el admin escribe un comando (/...), enviar solo la respuesta del comando
    let messageToSend = content;
    if (content.startsWith('/')) {
        const cmdName = content.split(' ')[0];
        const cmd = availableCommands.find(c => c.name === cmdName);
        if (cmd && cmd.response) {
            messageToSend = cmd.response;
        } else if (cmd) {
            showToast('Este comando no tiene respuesta configurada', 'error');
            elements.messageInput.value = '';
            elements.messageInput.style.height = 'auto';
            hideCommandSuggestions();
            return;
        } else {
            showToast('Comando no encontrado', 'error');
            elements.messageInput.value = '';
            elements.messageInput.style.height = 'auto';
            hideCommandSuggestions();
            return;
        }
        hideCommandSuggestions();
    }
    
    // CORREGIDO: Verificar si ya existe un mensaje con el mismo contenido en los últimos 3 segundos
    const recentMessages = elements.chatMessages.querySelectorAll('.message');
    const now = Date.now();
    for (const msg of recentMessages) {
        const msgContent = msg.querySelector('.message-content')?.textContent?.trim();
        const msgTime = msg.querySelector('.message-time')?.textContent;
        if (msgContent === messageToSend && msgTime) {
            // Verificar si el mensaje fue enviado hace menos de 3 segundos
            const msgTimestamp = new Date(msgTime).getTime();
            if (now - msgTimestamp < 3000) {
                elements.messageInput.value = '';
                elements.messageInput.style.height = 'auto';
                return;
            }
        }
    }
    
    // CORREGIDO: Verificar si ya se envió este contenido recientemente
    if (lastSentMessageContent === messageToSend && (now - lastSentMessageTime) < 5000) {
        elements.messageInput.value = '';
        elements.messageInput.style.height = 'auto';
        return;
    }
    
    // Clear input immediately for better UX
    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';
    
    // CORREGIDO: Guardar el contenido del mensaje enviado para evitar duplicados
    lastSentMessageContent = messageToSend;
    lastSentMessageTime = Date.now();
    
    // Optimistic UI - show message immediately
    const tempMessage = {
        id: 'temp-' + now,
        senderId: currentAdmin.userId,
        senderUsername: currentAdmin.username,
        senderRole: 'admin',
        content: messageToSend,
        timestamp: new Date(),
        type: 'text'
    };
    
    addMessageToChat(tempMessage, true);
    
    // CORREGIDO: Actualizar lista de conversaciones en tiempo real (optimistic)
    updateConversationInList({ ...tempMessage, receiverId: selectedUserId, senderId: currentAdmin.userId || currentAdmin.id, senderRole: 'admin' });
    scrollToBottom();
    setTimeout(scrollToBottom, 100);
    setTimeout(scrollToBottom, 300);
    
    // Send via socket (fastest)
    if (socket && socket.connected) {
        socket.emit('send_message', {
            content: messageToSend,
            receiverId: selectedUserId,
            type: 'text'
        });
        
        // CORREGIDO: Enviar notificación push al usuario
        sendPushNotification(selectedUserId, {
            type: 'text',
            content: messageToSend
        });
    } else {
        // Fallback to REST API
        try {
            const response = await fetch(`${API_URL}/api/messages/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify({
                    content: messageToSend,
                    receiverId: selectedUserId,
                    type: 'text'
                })
            });
            
            if (!response.ok) throw new Error('Failed to send message');
            
            const data = await response.json();
            
            // Update temp message with real one
            const tempEl = document.querySelector(`[data-messageid="${tempMessage.id}"]`);
            if (tempEl) {
                tempEl.dataset.messageid = data.id;
            }
            
            // CORREGIDO: Scroll después de confirmar
            scrollToBottom();
            
            // CORREGIDO: Enviar notificación push al usuario
            sendPushNotification(selectedUserId, {
                type: 'text',
                content: messageToSend
            });
            
        } catch (error) {
            console.error('Error sending message:', error);
            showToast('Error al enviar mensaje', 'error');
        }
    }
    
    // Stop typing
    socket.emit('stop_typing', { receiverId: selectedUserId });
}

// CORREGIDO: Convertir archivo a base64
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
        reader.readAsDataURL(file);
    });
}

// Comprime una imagen via Canvas: max 1600px lado mayor, JPEG q0.85.
// Necesario porque el endpoint rechaza base64 > 5MB.
function compressImageFile(file, { maxDim = 1600, quality = 0.85 } = {}) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            let { width, height } = img;
            if (width > maxDim || height > maxDim) {
                if (width >= height) {
                    height = Math.round(height * (maxDim / width));
                    width = maxDim;
                } else {
                    width = Math.round(width * (maxDim / height));
                    height = maxDim;
                }
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            try {
                resolve(canvas.toDataURL('image/jpeg', quality));
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('No se pudo decodificar la imagen'));
        };
        img.src = url;
    });
}

function removeTempMessageEl(tempId) {
    // admin's addMessageToChat stores the message id in data-messageid (one word)
    const el = document.querySelector(`[data-messageid="${tempId}"]`);
    if (el) el.remove();
}

async function parseFetchError(response, fallback) {
    try {
        const body = await response.json();
        if (body && body.error) return body.error;
    } catch (_) {}
    return fallback || `Error ${response.status}`;
}

// Manejar selección de imagen o video
async function handleImageSelect(e) {
    const file = e.target.files[0];
    if (!file || !selectedUserId) return;

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) {
        showToast('❌ Solo se permiten imágenes o videos', 'error');
        e.target.value = '';
        return;
    }
    if (isImage && file.size > 30 * 1024 * 1024) {
        showToast('❌ La imagen es muy grande (máx 30 MB)', 'error');
        e.target.value = '';
        return;
    }
    // Videos no se comprimen en el navegador: el server rechaza base64 > 5MB
    if (isVideo && file.size > 3.5 * 1024 * 1024) {
        showToast('❌ El video es muy grande (máx 3.5 MB)', 'error');
        e.target.value = '';
        return;
    }

    const sendingIndicator = document.getElementById('sendingIndicator');
    if (sendingIndicator) sendingIndicator.classList.remove('hidden');

    const fileType = isVideo ? 'video' : 'image';
    const fileLabel = isVideo ? '🎥 Video' : '📸 Imagen';
    const tempId = 'temp-' + fileType + '-' + Date.now();

    try {
        const dataUrl = isImage
            ? await compressImageFile(file)
            : await fileToBase64(file);

        const tempMessage = {
            id: tempId,
            senderId: currentAdmin.userId,
            senderUsername: currentAdmin.username,
            senderRole: 'admin',
            content: dataUrl,
            timestamp: new Date(),
            type: fileType
        };
        addMessageToChat(tempMessage, true);
        scrollToBottom();

        if (socket && socket.connected) {
            socket.emit('send_message', {
                content: dataUrl,
                receiverId: selectedUserId,
                type: fileType
            });

            sendPushNotification(selectedUserId, {
                type: fileType,
                content: fileLabel
            });

            showToast(`✅ ${fileLabel} enviada`, 'success');
        } else {
            const response = await fetch(`${API_URL}/api/messages/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify({
                    content: dataUrl,
                    receiverId: selectedUserId,
                    type: fileType
                })
            });

            if (!response.ok) {
                removeTempMessageEl(tempId);
                const errMsg = await parseFetchError(response, `No se pudo enviar ${fileLabel.toLowerCase()}`);
                showToast(`❌ ${fileLabel}: ${errMsg}`, 'error');
                return;
            }

            showToast(`✅ ${fileLabel} enviada`, 'success');
            loadMessages(selectedUserId, true);
        }
    } catch (error) {
        console.error('Error sending file:', error);
        removeTempMessageEl(tempId);
        showToast(`❌ Error al enviar ${fileLabel.toLowerCase()}`, 'error');
    } finally {
        if (sendingIndicator) sendingIndicator.classList.add('hidden');
        e.target.value = '';
    }
}

// Pegar imagen con Ctrl+V desde portapapeles (escritorio)
async function handleAdminPaste(e) {
    if (!selectedUserId) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    for (const item of items) {
        if (!item.type.startsWith('image/')) continue;
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        if (file.size > 30 * 1024 * 1024) {
            showToast('❌ La imagen es muy grande (máx 30 MB)', 'error');
            return;
        }

        const tempId = 'temp-image-' + Date.now();
        const sendingIndicator = document.getElementById('sendingIndicator');
        if (sendingIndicator) sendingIndicator.classList.remove('hidden');

        try {
            const dataUrl = await compressImageFile(file);

            const tempMessage = {
                id: tempId,
                senderId: currentAdmin.userId,
                senderUsername: currentAdmin.username,
                senderRole: 'admin',
                content: dataUrl,
                timestamp: new Date(),
                type: 'image'
            };
            addMessageToChat(tempMessage, true);
            scrollToBottom();

            if (socket && socket.connected) {
                socket.emit('send_message', {
                    content: dataUrl,
                    receiverId: selectedUserId,
                    type: 'image'
                });

                sendPushNotification(selectedUserId, { type: 'image', content: '📸 Imagen' });
                showToast('✅ Imagen enviada', 'success');
            } else {
                const response = await fetch(`${API_URL}/api/messages/send`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${currentToken}`
                    },
                    body: JSON.stringify({ content: dataUrl, receiverId: selectedUserId, type: 'image' })
                });
                if (!response.ok) {
                    removeTempMessageEl(tempId);
                    const errMsg = await parseFetchError(response, 'No se pudo enviar imagen');
                    showToast(`❌ 📸 Imagen: ${errMsg}`, 'error');
                    return;
                }
                showToast('✅ Imagen enviada', 'success');
                loadMessages(selectedUserId, true);
            }
        } catch (error) {
            console.error('Error sending pasted image:', error);
            removeTempMessageEl(tempId);
            showToast('❌ Error al enviar imagen', 'error');
        } finally {
            if (sendingIndicator) sendingIndicator.classList.add('hidden');
        }
        break;
    }
}


function handleTyping() {
    if (!selectedUserId) return;
    
    socket.emit('typing', { receiverId: selectedUserId });
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('stop_typing', { receiverId: selectedUserId });
    }, 2000);
}

function showTypingIndicator() {
    elements.typingIndicator.classList.remove('hidden');
}

function hideTypingIndicator() {
    elements.typingIndicator.classList.add('hidden');
}

// COMANDOS: Mostrar sugerencias de comandos
function showCommandSuggestions(inputValue) {
    const searchTerm = inputValue.slice(1).toLowerCase();
    
    // Filtrar comandos que coincidan
    commandSuggestions = availableCommands.filter(cmd => 
        cmd.name.toLowerCase().includes(searchTerm) || 
        (cmd.description && cmd.description.toLowerCase().includes(searchTerm))
    );
    
    if (commandSuggestions.length === 0) {
        hideCommandSuggestions();
        return;
    }
    
    // Crear o actualizar el contenedor de sugerencias
    let suggestionsContainer = document.getElementById('commandSuggestions');
    if (!suggestionsContainer) {
        suggestionsContainer = document.createElement('div');
        suggestionsContainer.id = 'commandSuggestions';
        suggestionsContainer.className = 'command-suggestions';
        suggestionsContainer.style.cssText = `
            position: absolute;
            bottom: 100%;
            left: 0;
            right: 0;
            background: white;
            border: 1px solid #ddd;
            border-radius: 8px 8px 0 0;
            max-height: 200px;
            overflow-y: auto;
            box-shadow: 0 -4px 12px rgba(0,0,0,0.15);
            z-index: 1000;
        `;
        elements.messageInput.parentElement.style.position = 'relative';
        elements.messageInput.parentElement.appendChild(suggestionsContainer);
    }
    
    // Renderizar sugerencias
    suggestionsContainer.innerHTML = commandSuggestions.map((cmd, index) => `
        <div class="command-suggestion-item ${index === selectedCommandIndex ? 'selected' : ''}" 
             data-index="${index}"
             style="padding: 10px 15px; cursor: pointer; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 10px;">
            <span style="font-weight: bold; color: #25d366;">${escapeHtml(cmd.name)}</span>
            <span style="color: #666; font-size: 0.85em;">${escapeHtml(cmd.description || '')}</span>
        </div>
    `).join('');
    
    // Agregar event listeners a cada sugerencia
    suggestionsContainer.querySelectorAll('.command-suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
            const index = parseInt(item.dataset.index);
            insertCommand(commandSuggestions[index].name);
        });
        item.addEventListener('mouseenter', () => {
            selectedCommandIndex = parseInt(item.dataset.index);
            updateCommandSelection();
        });
    });
    
    suggestionsContainer.style.display = 'block';
}

// COMANDOS: Ocultar sugerencias
function hideCommandSuggestions() {
    const suggestionsContainer = document.getElementById('commandSuggestions');
    if (suggestionsContainer) {
        suggestionsContainer.style.display = 'none';
    }
    commandSuggestions = [];
    selectedCommandIndex = -1;
}

// COMANDOS: Actualizar selección visual
function updateCommandSelection() {
    const suggestionsContainer = document.getElementById('commandSuggestions');
    if (!suggestionsContainer) return;
    
    suggestionsContainer.querySelectorAll('.command-suggestion-item').forEach((item, index) => {
        if (index === selectedCommandIndex) {
            item.style.background = '#f0f0f0';
            item.classList.add('selected');
        } else {
            item.style.background = 'white';
            item.classList.remove('selected');
        }
    });
}

// COMANDOS: Insertar comando seleccionado
function insertCommand(commandName) {
    elements.messageInput.value = commandName + ' ';
    elements.messageInput.focus();
    hideCommandSuggestions();
}


async function markMessagesAsRead(userId) {
    try {
        await fetch(`${API_URL}/api/messages/read/${userId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        // Actualizar conteo local de no leídos inmediatamente (optimistic update)
        const convIndex = conversations.findIndex(c => c.userId === userId);
        if (convIndex !== -1) {
            conversations[convIndex].unread = 0;
            conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
            renderConversations();
        }

        // Update unread count (throttleado: se llama por cada mensaje entrante
        // del chat activo, no debe golpear /api/admin/stats sin límite).
        loadStatsThrottled();
    } catch (error) {
        console.error('Error marking messages as read:', error);
    }
}

// ============================================
// USER ACTIONS
// ============================================
async function loadUserInfo(userId) {
    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load user info');
        
        const data = await response.json();
        const user = data.user;
        
        // RACE CONDITION FIX: Ignorar respuesta si ya no es el chat activo
        if (userId !== activeConversationId) {
            return;
        }
        
        elements.chatBalance.textContent = formatMoney(user.balance);
        elements.chatStatus.textContent = user.online ? 'En línea' : 'Desconectado';
        elements.chatStatus.className = user.online ? 'status online' : 'status';

        // Reflejar estado de bloqueo en el header del chat
        applyBlockStateToChatHeader(user);

        // Alerta de posible multicuenta (fire-and-forget; nunca frena el chat).
        renderFraudBanner(userId);

        // Publicista de adquisición: si el cliente llegó por un link de pauta,
        // mostrar el nombre del publicista al lado del nombre en la cabecera.
        if (user.acquisitionPublisher) {
            elements.chatUsername.innerHTML = escapeHtml(user.username) +
                ' <span class="chat-publisher">(📣 ' + escapeHtml(user.acquisitionPublisher) + ')</span>';
        } else {
            elements.chatUsername.textContent = user.username;
        }

        // Mostrar estado de la app de notificaciones
        if (elements.chatAppStatus) {
            // Determinar el mejor estado a partir del array multi-token.
            // Si tiene cualquier token standalone → APP INSTALADA (prioridad máxima).
            // Si solo tiene tokens browser → NOTIS EN NAVEGADOR.
            // Si no tiene tokens → NOTIS INACTIVAS.
            const tokens = user.fcmTokens && user.fcmTokens.length > 0 ? user.fcmTokens : [];
            const hasStandalone = tokens.some(t => t.context === 'standalone' && t.token);
            const hasBrowser = tokens.some(t => t.context !== 'standalone' && t.token);
            // También considerar el campo individual por compatibilidad con cuentas antiguas
            const singleCtx = user.fcmTokenContext;
            const singleToken = user.fcmToken;
            const effectiveStandalone = hasStandalone || (singleToken && singleCtx === 'standalone');
            const effectiveBrowser = hasBrowser || (singleToken && singleCtx !== 'standalone');
            const hasAnyToken = tokens.length > 0 || !!singleToken;

            if (hasAnyToken) {
                // Determinar permiso: si tiene standalone, usar el permiso de ese token
                let perm = null;
                if (effectiveStandalone) {
                    const standaloneTk = tokens.find(t => t.context === 'standalone' && t.token);
                    perm = standaloneTk ? standaloneTk.notifPermission : (user.notifPermission || null);
                } else {
                    const browserTk = tokens.find(t => t.context !== 'standalone' && t.token);
                    perm = browserTk ? browserTk.notifPermission : (user.notifPermission || null);
                }
                // Fallback para cuentas antiguas sin notifPermission en token
                if (!perm) perm = user.notifPermission || null;

                if (effectiveStandalone) {
                    if (perm === 'denied') {
                        elements.chatAppStatus.textContent = '📱 APP - NOTIS BLOQUEADAS';
                        elements.chatAppStatus.style.color = '#ff6b6b';
                    } else {
                        elements.chatAppStatus.textContent = '📱 APP INSTALADA';
                        elements.chatAppStatus.style.color = '#00ff88';
                    }
                } else if (effectiveBrowser) {
                    if (perm === 'denied') {
                        elements.chatAppStatus.textContent = '🌐 NAVEGADOR - NOTIS BLOQUEADAS';
                        elements.chatAppStatus.style.color = '#ff6b6b';
                    } else {
                        elements.chatAppStatus.textContent = '🌐 NOTIS EN NAVEGADOR';
                        elements.chatAppStatus.style.color = '#4fc3f7';
                    }
                } else {
                    elements.chatAppStatus.textContent = '📵 NOTIS INACTIVAS';
                    elements.chatAppStatus.style.color = '#aaa';
                }
            } else {
                elements.chatAppStatus.textContent = '📵 NOTIS INACTIVAS';
                elements.chatAppStatus.style.color = '#aaa';
            }
        }

        // Fueguito: si el cliente tiene pendiente el premio "100% en próxima carga"
        // (hito día 15), mostrar un cartel al operador con botón para marcarlo como
        // aplicado. Así el operador sabe que se lo tiene que dar y queda registrado.
        renderFireBonusBanner(user);

        // Cupón "100% próxima carga" por INSTALAR LA APP: cartel al operador con
        // botón "Marcar usado". El operador aplica el +100% en el modal de carga
        // y después lo marca acá para que no se use dos veces.
        renderInstallBonus100Banner(user);

        // Etiquetas y nota interna del cliente.
        renderUserTagsAndNotes(user);

        // Pago/retiro pendiente (verificar y pagar automático).
        loadPayoutBanner(user.id);
    } catch (error) {
        console.error('Error loading user info:', error);
    }
}

async function loadPayoutBanner(userId) {
    const el = document.getElementById('chatPayoutBanner');
    if (!el) return;
    try {
        // SOLO el retiro actual a verificar (pending_review). Los pagos en proceso/fallidos
        // NO se muestran acá (se confirman solos por el poller del back) para no resucitar
        // pagos viejos ni arriesgar un re-pago.
        const r = await authFetch('/api/admin/payouts?userId=' + encodeURIComponent(userId) + '&status=pending_review');
        if (!r.ok) { el.style.display = 'none'; return; }
        const j = await r.json();
        const p = (j.payouts || [])[0];
        if (!p) { el.style.display = 'none'; el.innerHTML = ''; return; }
        el.style.display = '';
        el.style.padding = '9px 14px';
        el.style.borderBottom = '1px solid rgba(0,0,0,0.30)';
        el.style.background = 'linear-gradient(90deg,#7a1fa2,#5a1580)';
        const dest = escapeHtml(p.alias || p.cbu || '-');
        const titular = escapeHtml(p.titular || '-');
        const monto = '$' + Number(p.amount).toLocaleString('es-AR');
        // Anti retiro fantasma: si el descuento en JUGAYGANA no se confirmó al solicitar,
        // avisamos al agente y resaltamos el banner. Si rechaza, NO se devuelven fichas solas.
        const debitUnconfirmed = (p.debitConfirmed === false);
        if (debitUnconfirmed) el.style.background = 'linear-gradient(90deg,#a02020,#7a1010)';
        const debitWarn = debitUnconfirmed
            ? '<div style="margin-top:5px;font-size:11px;font-weight:800;color:#ffe08a;background:rgba(0,0,0,0.32);padding:5px 8px;border-radius:6px;">⚠️ Descuento NO confirmado en JUGAYGANA — verificá el saldo real antes de pagar. Si rechazás, NO se devuelven fichas automáticamente.</div>'
            : '';
        const payBtn = j.payEnabled
            ? '<button onclick="payPayout(\'' + escapeHtml(p.id) + '\')" style="background:#0f8a2f;color:#fff;border:none;border-radius:7px;padding:7px 13px;font-weight:800;font-size:12px;cursor:pointer;">💸 Pagar ' + monto + '</button>'
            : '<span style="color:#ffd;font-size:11px;">Pago automático no configurado (falta token). Pagá manual.</span>';
        // "Descartar": SOLO admin general. Limpia un pago viejo ya resuelto SIN devolver fichas ni avisar al cliente.
        const dismissBtn = (currentAdmin?.role === 'admin')
            ? '<button onclick="dismissPayout(\'' + escapeHtml(p.id) + '\')" title="Limpiar pago viejo ya resuelto: no devuelve fichas ni avisa al cliente" style="background:rgba(0,0,0,0.35);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:7px;padding:7px 11px;font-size:11.5px;cursor:pointer;">🗑️ Descartar</button>'
            : '';
        el.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:#fff;font-size:12.5px;">' +
            '<span style="font-size:18px;">💸</span>' +
            '<div style="flex:1;min-width:160px;"><strong>RETIRO PENDIENTE: ' + monto + '</strong>' +
            '<div style="font-size:11px;opacity:0.92;">Titular: ' + titular + ' · CBU/alias: ' + dest + '</div>' +
            '<div style="font-size:10.5px;opacity:0.8;">Verificá los datos antes de pagar.</div>' + debitWarn + '</div>' +
            payBtn +
            '<button onclick="payOtherBank(\'' + escapeHtml(p.id) + '\')" style="background:#1f6feb;color:#fff;border:none;border-radius:7px;padding:7px 11px;font-size:11.5px;font-weight:700;cursor:pointer;">🏦 Pagar con otro banco</button>' +
            '<button onclick="cancelPayout(\'' + escapeHtml(p.id) + '\')" style="background:rgba(255,255,255,0.18);color:#fff;border:none;border-radius:7px;padding:7px 11px;font-size:11.5px;cursor:pointer;">↩️ Rechazar pago</button>' +
            dismissBtn +
            '</div>';
    } catch (e) {
        el.style.display = 'none';
    }
}

async function payPayout(id) {
    if (!confirm('¿Confirmás el PAGO automático de este retiro? Se va a transferir al CBU del cliente. Verificá que los datos sean correctos.')) return;
    const el = document.getElementById('chatPayoutBanner');
    try {
        const r = await authFetch('/api/admin/payouts/' + encodeURIComponent(id) + '/pay', { method: 'POST' });
        const j = await r.json();
        if (r.ok && j.success) {
            showToast(j.status === 'paid' ? 'Pago realizado ✅' : 'Pago iniciado ⏳', 'success');
            if (el) { el.style.display = 'none'; el.innerHTML = ''; }
        } else if (r.ok && j.insufficient) {
            // El cliente se jugó las fichas: no se descontó ni se pagó. Se avisó y se cerró el chat.
            showToast(j.message || 'Saldo insuficiente: no se pagó. Se avisó al cliente.', 'error');
            if (el) { el.style.display = 'none'; el.innerHTML = ''; }
        } else {
            showToast(j.error || 'Error al pagar', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

async function cancelPayout(id) {
    if (!confirm('¿Rechazar este pago? NO se paga. Como las fichas se descuentan recién al pagar, acá no hay nada que devolver: solo se cancela la solicitud.')) return;
    const el = document.getElementById('chatPayoutBanner');
    try {
        const r = await authFetch('/api/admin/payouts/' + encodeURIComponent(id) + '/cancel', { method: 'POST' });
        const j = await r.json();
        if (r.ok && j.success) {
            // Flujo nuevo: noDeduction = no se había descontado nada (caso normal).
            // chipsReturned = se había descontado y se devolvió (caso raro: cash-out falló antes).
            // skippedRefund = pago viejo con descuento no confirmado (compatibilidad).
            let msg = 'Pago rechazado', tipo = 'success';
            if (j.skippedRefund) { msg = 'Pago rechazado SIN devolver (descuento NO confirmado) — verificá en JUGAYGANA y devolvé a mano si corresponde'; tipo = 'error'; }
            else if (j.chipsReturned) { msg = 'Pago rechazado · fichas devueltas ✅'; }
            else if (j.noDeduction) { msg = 'Pago rechazado (no se habían descontado fichas)'; }
            showToast(msg, tipo);
            if (el) { el.style.display = 'none'; el.innerHTML = ''; }
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// Pagar el retiro DESDE OTRO BANCO (manual, fuera de hgcash): marca pagado sin
// devolver fichas y sin llamar a hgcash. Avisa "pago enviado" al cliente.
async function payOtherBank(id) {
    if (!confirm('¿Marcar este retiro como PAGADO desde otro banco? Confirmá sólo si YA hiciste la transferencia por fuera. No se devuelven fichas.')) return;
    const el = document.getElementById('chatPayoutBanner');
    try {
        const r = await authFetch('/api/admin/payouts/' + encodeURIComponent(id) + '/pay-other-bank', { method: 'POST' });
        const j = await r.json();
        if (r.ok && j.success) {
            showToast('Pagado por otro banco ✅', 'success');
            if (el) { el.style.display = 'none'; el.innerHTML = ''; }
        } else if (r.ok && j.insufficient) {
            showToast(j.message || 'Saldo insuficiente: no se pagó. Se avisó al cliente.', 'error');
            if (el) { el.style.display = 'none'; el.innerHTML = ''; }
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// Descartar un pago pendiente VIEJO que ya se resolvió en su momento: NO devuelve
// fichas y NO le avisa nada al cliente. Solo admin general (limpieza de cartel viejo).
async function dismissPayout(id) {
    if (!confirm('¿DESCARTAR este pago pendiente?\n\n• NO le devuelve fichas al cliente\n• NO le envía ningún aviso\n\nUsar SOLO para limpiar pagos viejos que ya se pagaron en su momento.')) return;
    const el = document.getElementById('chatPayoutBanner');
    try {
        const r = await authFetch('/api/admin/payouts/' + encodeURIComponent(id) + '/dismiss', { method: 'POST' });
        const j = await r.json();
        if (r.ok && j.success) {
            showToast('Pago descartado (sin avisar ni devolver)', 'success');
            if (el) { el.style.display = 'none'; el.innerHTML = ''; }
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// Destrabar un pago colgado: consulta el estado real en hgcash y actualiza el payout.
async function syncPayout(id) {
    try {
        const r = await authFetch('/api/admin/payouts/' + encodeURIComponent(id) + '/sync', { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { showToast(j.error || 'No se pudo sincronizar', 'error'); return; }
        showToast('Estado actualizado: ' + (j.status || j.hgStatus || 'ok'), 'success');
        if (selectedUserId) loadPayoutBanner(selectedUserId);
    } catch (e) { showToast('Error al sincronizar', 'error'); }
}

function renderFireBonusBanner(user) {
    const el = document.getElementById('chatFireBonusBanner');
    if (!el) return;
    if (!user || !user.fireNextLoadBonus) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    el.style.display = '';
    el.style.padding = '8px 14px';
    el.style.fontSize = '12px';
    el.style.borderBottom = '1px solid rgba(0,0,0,0.30)';
    el.style.background = 'linear-gradient(90deg,#d4820a,#b36904)';
    el.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:#fff;">' +
        '<span style="font-size:18px;">🔥</span>' +
        '<div style="flex:1;min-width:120px;"><strong style="font-size:13px;">FUEGUITO: 30% en la próxima carga</strong>' +
        '<div style="font-size:11px;opacity:0.9;">Premio del día 15 — aplicáselo en la próxima carga y marcalo como aplicado.</div></div>' +
        '<button onclick="applyFireNextLoadBonus(\'' + escapeHtml(String(user.id)) + '\')" style="background:#fff;color:#b36904;border:none;border-radius:7px;padding:6px 11px;font-weight:800;font-size:11.5px;cursor:pointer;">✓ Marcar aplicado</button>' +
        '</div>';
}

async function applyFireNextLoadBonus(userId) {
    if (!confirm('¿Marcar el 30% de próxima carga (Fueguito) como aplicado? El cliente no lo va a tener más después de esto.')) return;
    try {
        const r = await authFetch('/api/admin/users/' + encodeURIComponent(userId) + '/fire-next-load-bonus/apply', { method: 'POST' });
        const j = await r.json();
        if (r.ok && j.success) {
            showToast('Premio Fueguito marcado como aplicado', 'success');
            const el = document.getElementById('chatFireBonusBanner');
            if (el) { el.style.display = 'none'; el.innerHTML = ''; }
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// Cupón "100% EXTRA en próxima carga" por instalar la app (2026-07-28).
// Mismo patrón que el banner del Fueguito: cartel + botón "Marcar usado".
function renderInstallBonus100Banner(user) {
    const el = document.getElementById('chatInstallBonusBanner');
    if (!el) return;
    if (!user || user.installBonus100Pending !== true) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    el.style.display = '';
    el.style.padding = '8px 14px';
    el.style.fontSize = '12px';
    el.style.borderBottom = '1px solid rgba(0,0,0,0.30)';
    el.style.background = 'linear-gradient(90deg,#1a8200,#0f4c00)';
    el.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:#fff;">' +
        '<span style="font-size:18px;">🎁</span>' +
        '<div style="flex:1;min-width:120px;"><strong style="font-size:13px;">BONO APP: 100% en la próxima carga</strong>' +
        '<div style="font-size:11px;opacity:0.9;">Por instalar la app — aplicá el +100% en la carga y marcalo como usado.</div></div>' +
        '<button onclick="applyInstallBonus100(\'' + escapeHtml(String(user.id)) + '\')" style="background:#fff;color:#0f4c00;border:none;border-radius:7px;padding:6px 11px;font-weight:800;font-size:11.5px;cursor:pointer;">✓ Marcar usado</button>' +
        '</div>';
}

async function applyInstallBonus100(userId) {
    if (!confirm('¿Marcar el 100% de próxima carga (bono por instalar la app) como USADO? El cliente no lo va a tener más después de esto.')) return;
    try {
        const r = await authFetch('/api/admin/users/' + encodeURIComponent(userId) + '/install-bonus-100/apply', { method: 'POST' });
        const j = await r.json();
        if (r.ok && j.success) {
            showToast('Bono 100% de instalación marcado como usado', 'success');
            const el = document.getElementById('chatInstallBonusBanner');
            if (el) { el.style.display = 'none'; el.innerHTML = ''; }
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// ============================================================
// ETIQUETAS Y NOTAS DE USUARIOS (panel admin)
// ============================================================
let allTagsCache = [];

// Trae la lista de etiquetas en uso (para filtro, sugerencias y difusión).
async function loadAllTags() {
    try {
        const r = await authFetch('/api/admin/tags');
        const j = await r.json();
        allTagsCache = Array.isArray(j.tags) ? j.tags : [];
    } catch (e) { /* no romper la UI por esto */ }
    return allTagsCache;
}

// Mantiene una etiqueta nueva en el cache local (para que aparezca al instante
// en filtros/sugerencias sin re-consultar).
function rememberTag(tag) {
    if (tag && !allTagsCache.includes(tag)) {
        allTagsCache.push(tag);
        allTagsCache.sort((a, b) => a.localeCompare(b, 'es'));
    }
}

// Desplegable de filtro por etiqueta en la sección Usuarios.
function populateUsersTagFilter() {
    const sel = document.getElementById('usersTagFilter');
    if (!sel) return;
    const fill = () => {
        const current = sel.value;
        sel.innerHTML = '<option value="">🏷️ Todas las etiquetas</option>' +
            allTagsCache.map(t => '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>').join('');
        sel.value = current;
    };
    if (allTagsCache.length === 0) { loadAllTags().then(fill); } else { fill(); }
}

// Sugerencias (datalist) del input de etiqueta en el chat.
function populateTagSuggestions() {
    const dl = document.getElementById('chatTagSuggestions');
    if (!dl) return;
    const fill = () => { dl.innerHTML = allTagsCache.map(t => '<option value="' + escapeHtml(t) + '"></option>').join(''); };
    if (allTagsCache.length === 0) { loadAllTags().then(fill); } else { fill(); }
}

// Render completo de la barra de etiquetas + nota del cliente (al cargar el chat).
function renderUserTagsAndNotes(user) {
    const bar = document.getElementById('chatTagsBar');
    if (!bar) return;
    bar.style.display = '';
    renderChatTagsList(Array.isArray(user.tags) ? user.tags : []);
    const notesText = document.getElementById('chatNotesText');
    if (notesText) notesText.value = user.adminNotes || '';
    const toggle = document.getElementById('chatNotesToggle');
    if (toggle) toggle.textContent = (user.adminNotes && user.adminNotes.trim()) ? '📝 Nota ✓' : '📝 Nota';
    const box = document.getElementById('chatNotesBox');
    if (box) box.style.display = 'none';
    populateTagSuggestions();
}

// Render solo de los chips de etiquetas (se reusa al agregar/quitar).
function renderChatTagsList(tags) {
    const list = document.getElementById('chatTagsList');
    if (!list) return;
    list.innerHTML = '';
    if (!tags || tags.length === 0) {
        const empty = document.createElement('span');
        empty.style.color = '#888';
        empty.textContent = 'sin etiquetas';
        list.appendChild(empty);
        return;
    }
    tags.forEach(t => list.appendChild(buildTagChip(t)));
}

// Construye un chip de etiqueta con botón de quitar. Usa DOM (no innerHTML) para
// no tener que escapar la etiqueta dentro de un onclick.
function buildTagChip(tag) {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:rgba(212,175,55,0.22);border:1px solid rgba(212,175,55,0.5);color:#f0d98c;border-radius:12px;padding:2px 8px;font-size:11px;';
    const label = document.createElement('span');
    label.textContent = tag;
    chip.appendChild(label);
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.title = 'Quitar etiqueta';
    x.style.cssText = 'background:none;border:none;color:#f0d98c;cursor:pointer;font-size:11px;padding:0;line-height:1;';
    x.onclick = () => removeChatTag(tag);
    chip.appendChild(x);
    return chip;
}

async function addChatTag() {
    if (!selectedUserId) return;
    const input = document.getElementById('chatTagInput');
    const tag = input ? input.value.trim() : '';
    if (!tag) return;
    try {
        const r = await authFetch('/api/admin/users/' + encodeURIComponent(selectedUserId) + '/tags', {
            method: 'POST',
            body: JSON.stringify({ action: 'add', tag })
        });
        const j = await r.json();
        if (r.ok && j.success) {
            if (input) input.value = '';
            rememberTag(tag.toLowerCase().replace(/\s+/g, ' ').slice(0, 40));
            renderChatTagsList(j.tags);
            populateTagSuggestions();
            showToast('Etiqueta agregada', 'success');
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// Agrega una etiqueta predefinida con un solo clic (ej: "Comunidad").
function quickAddChatTag(tag) {
    const input = document.getElementById('chatTagInput');
    if (input) input.value = tag;
    addChatTag();
}

async function removeChatTag(tag) {
    if (!selectedUserId) return;
    try {
        const r = await authFetch('/api/admin/users/' + encodeURIComponent(selectedUserId) + '/tags', {
            method: 'POST',
            body: JSON.stringify({ action: 'remove', tag })
        });
        const j = await r.json();
        if (r.ok && j.success) {
            renderChatTagsList(j.tags);
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

function toggleChatNotes() {
    const box = document.getElementById('chatNotesBox');
    if (box) box.style.display = (box.style.display === 'none' || !box.style.display) ? 'block' : 'none';
}

async function saveChatNotes() {
    if (!selectedUserId) return;
    const ta = document.getElementById('chatNotesText');
    const notes = ta ? ta.value : '';
    try {
        const r = await authFetch('/api/admin/users/' + encodeURIComponent(selectedUserId) + '/notes', {
            method: 'POST',
            body: JSON.stringify({ notes })
        });
        const j = await r.json();
        if (r.ok && j.success) {
            showToast('Nota guardada', 'success');
            const toggle = document.getElementById('chatNotesToggle');
            if (toggle) toggle.textContent = (notes && notes.trim()) ? '📝 Nota ✓' : '📝 Nota';
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// ---- Difusión push por etiqueta (sección Notificaciones) ----
async function loadTagBroadcastOptions() {
    const sel = document.getElementById('tagBroadcastSelect');
    if (!sel) return;
    await loadAllTags();
    const current = sel.value;
    sel.innerHTML = '<option value="">— Elegí una etiqueta —</option>' +
        allTagsCache.map(t => '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>').join('');
    sel.value = current;
}

async function sendTagBroadcast() {
    const sel = document.getElementById('tagBroadcastSelect');
    const titleEl = document.getElementById('tagBroadcastTitle');
    const bodyEl = document.getElementById('tagBroadcastBody');
    const statusEl = document.getElementById('tagBroadcastStatus');
    const btn = document.getElementById('tagBroadcastSendBtn');
    const tag = sel ? sel.value : '';
    const title = titleEl ? titleEl.value.trim() : '';
    const body = bodyEl ? bodyEl.value.trim() : '';
    if (!tag) { showToast('Elegí una etiqueta', 'error'); return; }
    if (!title || !body) { showToast('Completá título y mensaje', 'error'); return; }
    if (!confirm('¿Enviar la difusión a todos los clientes con la etiqueta "' + tag + '"?')) return;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando...'; }
    if (statusEl) statusEl.textContent = '';
    try {
        const r = await authFetch('/api/notifications/send-to-tag', {
            method: 'POST',
            body: JSON.stringify({ tag, title, body })
        });
        const j = await r.json();
        if (r.ok && j.success) {
            if (statusEl) statusEl.textContent = '✅ Enviado a ' + j.targetUsers + ' usuario(s) · OK ' + j.successCount + ' · fallos ' + j.failureCount;
            showToast('Difusión enviada', 'success');
        } else {
            showToast(j.error || 'Error al enviar', 'error');
        }
    } catch (e) {
        showToast('Error de conexión', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🚀 Enviar a la etiqueta'; }
    }
}

async function sendCBU() {
    if (!selectedUserId) return;
    
    const btnCBU = elements.btnCBU;
    setButtonLoading(btnCBU, true, 'Enviando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/send-cbu`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ userId: selectedUserId })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al enviar CBU');
        }
        
        showToast('CBU enviado correctamente', 'success');
        
        // Reload messages to show the CBU message
        loadMessages(selectedUserId);
        
    } catch (error) {
        console.error('Error sending CBU:', error);
        showToast(error.message || 'Error al enviar CBU', 'error');
    } finally {
        setButtonLoading(btnCBU, false, '<span class="icon icon-credit-card"></span> Enviar CBU');
    }
}

// Aviso INTERNO en el modal de depósito: qué bono automático (app + notifs) le
// correspondería a este cliente si su carga hubiera entrado sola por hgcash.
// SOLO lo ve el agente — al cliente no se le envía ningún mensaje por esto.
async function loadDepositAppBonusHint() {
    const el = document.getElementById('depositAppBonusHint');
    if (!el) return;
    el.style.display = 'none';
    el.innerHTML = '';
    if (!selectedUserId) return;
    try {
        const r = await authFetch(`/api/admin/users/${selectedUserId}/app-bonus-hint`);
        if (!r.ok) return; // sin permiso o error: no se muestra nada
        const h = await r.json();
        const base = 'border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px;line-height:1.5;';
        const tag = '<div style="font-weight:800;letter-spacing:.4px;margin-bottom:4px;">🔒 AVISO INTERNO — el cliente NO ve este mensaje</div>';
        if (h.firstAvailable) {
            el.style.cssText = base + 'background:rgba(212,175,55,.12);border:1px solid rgba(212,175,55,.55);color:#f0e6c8;';
            el.innerHTML = tag +
                `💥 Este cliente tiene la <b>APP con notificaciones</b> y <b>NUNCA usó su bono de primera carga</b> → le corresponde <b>+${h.firstPct}%</b>.<br>` +
                'Aplicáselo en "Bonificación extra": al acreditarse queda <b>marcado como usado automáticamente</b> (no se puede repetir).';
        } else if (h.allActive) {
            el.style.cssText = base + 'background:rgba(40,167,69,.12);border:1px solid rgba(40,167,69,.55);color:#cdeed7;';
            el.innerHTML = tag +
                `🔥 Cliente con <b>APP + notificaciones</b> → le corresponde <b>+${h.allPct}%</b> en esta carga (promo vigente hasta el 31/08).` +
                (h.firstUsedBy ? `<br><span style="opacity:.75;">Su 100% de primera carga ya fue usado (${h.firstUsedBy}).</span>` : '');
        } else if (h.hasApp) {
            el.style.cssText = base + 'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.18);color:#bbb;';
            el.innerHTML = tag + '📲 Tiene la app, pero no le corresponde bono automático (100% ya usado y promo del 20% inactiva).';
        } else {
            el.style.cssText = base + 'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.18);color:#bbb;';
            el.innerHTML = tag + '🚫 <b>SIN app instalada o sin notificaciones</b> → NO le corresponde bono automático.';
        }
        el.style.display = 'block';
    } catch (e) {
        // Best-effort: si falla, el modal funciona igual sin el aviso.
        console.error('Error cargando aviso de bono:', e);
    }
}

async function handleDeposit() {
    const amount = parseFloat(document.getElementById('depositAmount').value);
    const bonus = parseFloat(document.getElementById('depositBonus').value) || 0;
    const description = document.getElementById('depositDesc').value;
    const confirmBtn = document.getElementById('confirmDeposit');
    
    if (!amount || amount <= 0) {
        showToast('Ingresa un monto válido', 'error');
        return;
    }
    
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    // Loading state
    setButtonLoading(confirmBtn, true, 'Procesando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/deposit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                amount,
                bonus,
                description
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Error al realizar depósito');
        }

        // Si el backend reporta que el bonus se solicitó pero no se aplicó
        // en JUGAYGANA, mostramos un toast destacado al agente para que sepa
        // que tiene que reintentar el bonus manualmente. La carga sí entró.
        if (data.bonusRequested === true && data.bonusApplied === false) {
            showToast(
                `⚠️ Carga $${amount} OK, pero BONUS $${bonus} NO se aplicó (${data.bonusError || 'JUGAYGANA intermitente'}). Reintentá el bonus desde el botón "Bonus".`,
                'error'
            );
        } else {
            showToast(`Depósito de ${formatMoney(amount + bonus)} realizado`, 'success');
        }
        hideModal('depositModal');
        
        // Reset deposit form
        document.getElementById('depositAmount').value = '';
        document.getElementById('depositBonus').value = '';
        document.getElementById('depositDesc').value = '';
        document.querySelectorAll('.bonus-options button').forEach(b => b.classList.remove('active'));
        const noBonusBtn = document.querySelector('.bonus-options button[data-bonus="0"]');
        if (noBonusBtn) noBonusBtn.classList.add('active');
        
        // Update balance display
        loadUserInfo(selectedUserId);
        
        // Reload messages to show deposit notification
        loadMessages(selectedUserId);
        
    } catch (error) {
        console.error('Error depositing:', error);
        showToast(error.message || 'Error al realizar depósito', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Confirmar Depósito');
    }
}

async function handleWithdraw() {
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    const description = document.getElementById('withdrawDesc').value;
    const confirmBtn = document.getElementById('confirmWithdraw');
    
    if (!amount || amount <= 0) {
        showToast('Ingresa un monto válido', 'error');
        return;
    }
    
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    // Loading state
    setButtonLoading(confirmBtn, true, 'Procesando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/withdrawal`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                amount,
                description
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || data.message || 'Error al realizar retiro');
        }
        
        showToast(`Retiro de ${formatMoney(amount)} realizado`, 'success');
        hideModal('withdrawModal');
        
        // Reset withdrawal form
        document.getElementById('withdrawAmount').value = '';
        document.getElementById('withdrawDesc').value = '';
        
        // Update balance display
        loadUserInfo(selectedUserId);
        
        // Reload messages to show withdrawal notification
        loadMessages(selectedUserId);
        
    } catch (error) {
        console.error('Error withdrawing:', error);
        showToast(error.message || 'Error al realizar retiro', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Confirmar Retiro');
    }
}

async function handleDirectBonus() {
    const amount = parseFloat(document.getElementById('bonusAmount').value);
    const description = document.getElementById('bonusDesc').value;
    const confirmBtn = document.getElementById('confirmBonus');

    if (!amount || amount <= 0) {
        showToast('Ingresa un monto válido', 'error');
        return;
    }

    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }

    setButtonLoading(confirmBtn, true, 'Procesando...');

    try {
        const response = await fetch(`${API_URL}/api/admin/bonus`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                amount,
                description
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Error al aplicar bonus');
        }

        showToast(`Bonus de ${formatMoney(amount)} aplicado`, 'success');
        hideModal('bonusModal');
        document.getElementById('bonusAmount').value = '';
        document.getElementById('bonusDesc').value = '';

        loadUserInfo(selectedUserId);
        loadMessages(selectedUserId);

    } catch (error) {
        console.error('Error applying bonus:', error);
        showToast(error.message || 'Error al aplicar bonus', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Confirmar Bonus');
    }
}

async function handlePasswordChange() {
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const confirmBtn = document.getElementById('confirmPasswordChange');
    
    if (!newPassword || newPassword.length < 6) {
        showToast('La contraseña debe tener al menos 6 caracteres', 'error');
        return;
    }
    
    if (newPassword !== confirmPassword) {
        showToast('Las contraseñas no coinciden', 'error');
        return;
    }
    
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    // Verificar permisos según rol
    const adminRole = currentAdmin?.role;
    // Prefer the role stored when the modal was opened (users-table flow), then
    // fall back to the conversations list (chat-panel flow).
    const targetUser = conversations.find(c => c.userId === selectedUserId);
    const targetUserRole = selectedUserRole || targetUser?.role || 'user';
    
    // Admin general puede cambiar contraseña de TODOS incluyendo admins
    // Admin depositer puede cambiar contraseña de usuarios pero NO de admins
    // Admin withdrawer NO puede cambiar contraseñas
    if (adminRole === 'withdrawer') {
        showToast('No tienes permiso para cambiar contraseñas', 'error');
        return;
    }
    
    if (adminRole === 'depositor' && targetUserRole !== 'user') {
        showToast('Solo puedes cambiar contraseñas de usuarios, no de administradores', 'error');
        return;
    }
    
    // Loading state
    setButtonLoading(confirmBtn, true, 'Cambiando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/change-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                newPassword
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Error al cambiar contraseña');
        }
        
        showToast(`Contraseña actualizada correctamente`, 'success');
        hideModal('passwordModal');
        selectedUserRole = null;
        
        // Clear inputs
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmPassword').value = '';
        
    } catch (error) {
        console.error('Error changing password:', error);
        showToast(error.message || 'Error al cambiar contraseña', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Cambiar Contraseña');
    }
}

async function sendToPayments() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    const btnPayments = elements.btnPayments;
    setButtonLoading(btnPayments, true, 'Enviando...');
    
    // Optimistic UI - clear chat panel immediately
    const userIdToRemove = selectedUserId;
    selectedUserId = null;
    activeConversationId = null; // RACE CONDITION FIX
    elements.chatHeader.classList.add('hidden');
    elements.chatInputArea.classList.add('hidden');
    elements.chatMessages.innerHTML = `
        <div class="empty-state">
            <span class="icon icon-comment-dots"></span>
            <p>Chat enviado a pagos...</p>
        </div>
    `;
    
    // Remove from conversations list immediately
    const convItem = document.querySelector(`.conversation-item[data-userid="${userIdToRemove}"]`);
    if (convItem) {
        convItem.style.opacity = '0.5';
        convItem.style.pointerEvents = 'none';
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/send-to-payments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ userId: userIdToRemove })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al enviar a pagos');
        }
        
        showToast('Chat enviado a pagos correctamente', 'success');
        
        // Remove from list immediately
        if (convItem) {
            convItem.remove();
        }
        
        // Invalidar cache y recargar en background
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        conversationsCacheByTab.delete('payments');
        loadConversations();
        
    } catch (error) {
        console.error('Error sending to payments:', error);
        showToast(error.message || 'Error al enviar a cargas', 'error');
        // Restore UI on error
        if (convItem) {
            convItem.style.opacity = '1';
            convItem.style.pointerEvents = 'auto';
        }
    } finally {
        setButtonLoading(btnPayments, false, '<span class="icon icon-exchange"></span> Enviar a Pagos');
    }
}

// Derivar un chat a la sección COMUNIDAD (desde Abiertos).
async function sendToCommunity() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    const btnCommunity = elements.btnCommunity;
    setButtonLoading(btnCommunity, true, 'Derivando...');

    const userIdToRemove = selectedUserId;
    try {
        const response = await fetch(`${API_URL}/api/admin/send-to-community`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ userId: userIdToRemove })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            // 400 típico: el cliente ya tiene la etiqueta 'comunidad'.
            throw new Error(data.error || 'Error al derivar a Comunidad');
        }

        // Optimistic UI solo en éxito.
        selectedUserId = null;
        activeConversationId = null;
        elements.chatHeader.classList.add('hidden');
        elements.chatInputArea.classList.add('hidden');
        elements.chatMessages.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comment-dots"></span>
                <p>Chat derivado a Comunidad. Selecciona otra conversación.</p>
            </div>
        `;
        const convItem = document.querySelector(`.conversation-item[data-userid="${userIdToRemove}"]`);
        if (convItem) convItem.remove();

        showToast('Chat derivado a Comunidad', 'success');
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('comunidad');
        loadConversations();
    } catch (error) {
        console.error('Error derivando a comunidad:', error);
        showToast(error.message || 'Error al derivar a Comunidad', 'error');
    } finally {
        setButtonLoading(btnCommunity, false, '<span class="icon icon-users"></span> Derivar a Comunidad');
    }
}

// Enviar a Abiertos (nueva función para cuando está en Pagos)
async function sendToOpen() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    const btnPayments = elements.btnPayments;
    setButtonLoading(btnPayments, true, 'Enviando...');
    
    // Optimistic UI - clear chat panel immediately
    const userIdToRemove = selectedUserId;
    selectedUserId = null;
    activeConversationId = null; // RACE CONDITION FIX
    elements.chatHeader.classList.add('hidden');
    elements.chatInputArea.classList.add('hidden');
    elements.chatMessages.innerHTML = `
        <div class="empty-state">
            <span class="icon icon-comment-dots"></span>
            <p>Chat enviado a abiertos...</p>
        </div>
    `;
    
    // Remove from conversations list immediately
    const convItem = document.querySelector(`.conversation-item[data-userid="${userIdToRemove}"]`);
    if (convItem) {
        convItem.style.opacity = '0.5';
        convItem.style.pointerEvents = 'none';
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/send-to-open`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ userId: userIdToRemove })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al enviar a abiertos');
        }
        
        showToast('Chat enviado a abiertos correctamente', 'success');
        
        // Remove from list immediately
        if (convItem) {
            convItem.remove();
        }
        
        // Invalidar cache y recargar en background
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        conversationsCacheByTab.delete('payments');
        conversationsCacheByTab.delete('comunidad');
        loadConversations();

    } catch (error) {
        console.error('Error sending to open:', error);
        showToast(error.message || 'Error al enviar a abiertos', 'error');
        // Restore UI on error
        if (convItem) {
            convItem.style.opacity = '1';
            convItem.style.pointerEvents = 'auto';
        }
    } finally {
        setButtonLoading(btnPayments, false, '<span class="icon icon-exchange"></span> Enviar a Abiertos');
    }
}

// Función para deseleccionar el chat (sin cerrarlo)
function deselectChat() {
    if (!selectedUserId) return;
    
    // RACE CONDITION FIX: Cancelar fetch en curso y limpiar id activo
    if (activeFetchController) {
        activeFetchController.abort();
        activeFetchController = null;
    }
    activeConversationId = null;

    // Salir de la sala de chat
    if (socket) {
        socket.emit('leave_chat_room', { userId: selectedUserId });
    }
    
    // Limpiar selección visual
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Ocultar panel de chat
    selectedUserId = null;
    selectedUsername = null;
    elements.chatHeader.classList.add('hidden');
    elements.chatInputArea.classList.add('hidden');
    if (elements.chatAppStatus) {
        elements.chatAppStatus.textContent = '';
    }
    elements.chatMessages.innerHTML = `
        <div class="empty-state">
            <span class="icon icon-comment-dots"></span>
            <p>Selecciona una conversación para ver los mensajes</p>
        </div>
    `;
    
}

async function closeChat() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    const btnClose = elements.btnClose;
    setButtonLoading(btnClose, true, 'Cerrando...');
    
    // Optimistic UI - update immediately
    const userIdToClose = selectedUserId;
    
    // Move conversation to closed tab visually
    const convItem = document.querySelector(`.conversation-item[data-userid="${userIdToClose}"]`);
    if (convItem) {
        convItem.style.opacity = '0.5';
    }
    
    // COMPORTAMIENTO DIFERENTE SEGÚN LA PESTAÑA:
    // - En "Abiertos": Mantener chat abierto para seguir respondiendo
    // - En "Pagos": Cerrar el chat completamente
    const isPaymentsTab = currentTab === 'payments';
    
    if (isPaymentsTab) {
        // En pagos: cerrar completamente
        selectedUserId = null;
        elements.chatHeader.classList.add('hidden');
        elements.chatInputArea.classList.add('hidden');
        elements.chatMessages.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comment-dots"></span>
                <p>Chat cerrado. Selecciona otra conversación.</p>
            </div>
        `;
    }
    // Fix #3: No insertar mensaje de cierre en el DOM manualmente; el backend lo guarda
    // en la DB como adminOnly y se muestra al recargar mensajes.
    
    try {
        const response = await fetch(`${API_URL}/api/admin/close-chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ 
                userId: userIdToClose,
                notifyClient: false, // No notificar al cliente, solo interno
                isPaymentsTab: isPaymentsTab
            })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al cerrar chat');
        }
        
        showToast('Chat cerrado correctamente', 'success');
        
        // If on open tab, remove from list
        if (currentTab === 'open' && convItem) {
            convItem.remove();
        }
        
        // Fix #3: Recargar mensajes para mostrar el mensaje de cierre guardado en DB
        if (!isPaymentsTab && selectedUserId === userIdToClose) {
            messageCache.delete(userIdToClose);
            loadMessages(userIdToClose);
        }
        
        // Invalidar cache y recargar en background
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        loadConversations();
        
    } catch (error) {
        console.error('Error closing chat:', error);
        showToast(error.message || 'Error al cerrar chat', 'error');
        // Restore UI on error
        if (convItem) {
            convItem.style.opacity = '1';
        }
    } finally {
        setButtonLoading(btnClose, false, '<span class="icon icon-lock"></span> Cerrar Chat');
    }
}

// ============================================
// DATOS (métricas de adquisición, actividad y recurrencia)
// ============================================
let datosPeriod = 'today';

function setDatosPeriod(period) {
    datosPeriod = period;
    // Limpiar fecha exacta y rango
    const fechaInput = document.getElementById('datosFecha');
    if (fechaInput) fechaInput.value = '';
    const desdeInput = document.getElementById('datosDesde');
    if (desdeInput) desdeInput.value = '';
    const hastaInput = document.getElementById('datosHasta');
    if (hastaInput) hastaInput.value = '';
    // Resaltar botón activo
    document.querySelectorAll('.datos-period-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === period);
    });
    loadDatos();
}

function setDatosDate(date) {
    if (!date) return;
    datosPeriod = null;
    const desdeInput = document.getElementById('datosDesde');
    if (desdeInput) desdeInput.value = '';
    const hastaInput = document.getElementById('datosHasta');
    if (hastaInput) hastaInput.value = '';
    document.querySelectorAll('.datos-period-btn').forEach(btn => btn.classList.remove('active'));
    loadDatos();
}

function applyDatosRange() {
    const desde = document.getElementById('datosDesde')?.value;
    const hasta = document.getElementById('datosHasta')?.value;
    if (!desde || !hasta) {
        showToast('Seleccioná fecha desde y hasta', 'error');
        return;
    }
    datosPeriod = null;
    const fechaInput = document.getElementById('datosFecha');
    if (fechaInput) fechaInput.value = '';
    document.querySelectorAll('.datos-period-btn').forEach(btn => btn.classList.remove('active'));
    loadDatos();
}

async function loadDatos() {
    try {
        const fechaInput = document.getElementById('datosFecha');
        const fecha = fechaInput ? fechaInput.value : '';
        const desde = document.getElementById('datosDesde')?.value || '';
        const hasta = document.getElementById('datosHasta')?.value || '';

        let url;
        if (desde && hasta) {
            url = `${API_URL}/api/admin/datos?dateFrom=${encodeURIComponent(desde)}&dateTo=${encodeURIComponent(hasta)}`;
        } else if (fecha) {
            url = `${API_URL}/api/admin/datos?date=${encodeURIComponent(fecha)}`;
        } else {
            url = `${API_URL}/api/admin/datos?period=${datosPeriod || 'today'}`;
        }

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!response.ok) throw new Error('Failed to load datos');
        const json = await response.json();
        const d = json.data || {};

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val !== undefined && val !== null) ? val : '—';
        };
        const setAmt = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val !== undefined && val !== null)
                ? '$\u202F' + Number(val).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
                : '—';
        };
        const setPct = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val !== undefined && val !== null) ? val + '%' : '—';
        };

        // Período activo
        const periodLabel = document.getElementById('datosPeriodLabel');
        if (periodLabel && d.period) periodLabel.textContent = '— ' + d.period.label;

        const a = d.acquisition      || {};
        const b = d.depositActivity  || {};
        const c = d.economicQuality  || {};
        const r = d.recurrence       || {};

        // Bloque A — Adquisición
        set('datosRegisteredUsers',  a.registeredUsers);
        set('datosFirstDepositUsers', a.firstDepositUsers);
        setPct('datosConversionRate', a.conversionRate);
        set('datosNeverDeposited',   a.registeredNeverDeposited);

        // Bloque B — Actividad de depósitos
        set('datosTotalDeposits',          b.totalDeposits);
        set('datosUniqueDepositors',       b.uniqueDepositors);
        set('datosFirstTimeDeposits',      b.firstTimeDeposits);
        set('datosFirstTimeDepositUsers',  b.firstTimeDepositUsers);
        set('datosReturningDeposits',      b.returningDeposits);
        set('datosReturningUsers',         b.returningDepositUsers);
        set('datosFrequency',              b.depositFrequency);

        // Bloque C — Calidad económica
        setAmt('datosTotalAmount',       c.totalAmount);
        setAmt('datosAvgTicket',         c.avgTicket);
        setAmt('datosAvgPerDepositor',   c.avgPerDepositor);
        setAmt('datosFirstTimeAmount',   c.firstTimeAmount);
        setAmt('datosReturningAmount',   c.returningAmount);

        // Bloque D — Recurrencia
        set('datosActiveReturning',  r.activeReturningUsers);
        setPct('datosReturningPct',  r.returningPct);
        set('datosMultipleUsers',    r.multipleDepositUsers);
        setPct('datosRepeatRate',    r.repeatRate);

        // Bloque E — Retención (tiempo real)
        const e = d.retention || {};
        set('datosRetention3d',  e.users3d);
        set('datosRetention7d',  e.users7d);
        set('datosRetention15d', e.users15d);
        set('datosRetention30d', e.users30d);

    } catch (error) {
        console.error('Error loading datos:', error);
    }
}

// ============================================
// STATS
// ============================================
async function loadStats() {
    try {
        const response = await fetch(`${API_URL}/api/admin/stats`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load stats');
        
        const json = await response.json();
        // CORREGIDO: extraer data.data si existe (respuesta envuelta)
        const data = json.data || json;
        updateStats(data);
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

function updateStats(data) {
    elements.statUsers.textContent = data.totalUsers || 0;
    // CORREGIDO: usar connectedUsers (socket) o onlineUsers (HTTP)
    elements.statOnline.textContent = data.connectedUsers !== undefined ? data.connectedUsers : (data.onlineUsers || 0);
    elements.statMessages.textContent = data.totalMessages || 0;
    elements.statUnread.textContent = data.unreadMessages || 0;
    
    // Update badge
    if (data.unreadMessages > 0) {
        elements.unreadBadge.textContent = data.unreadMessages;
        elements.unreadBadge.classList.remove('hidden');
    } else {
        elements.unreadBadge.classList.add('hidden');
    }
}

function incrementUnreadCount() {
    const current = parseInt(elements.statUnread.textContent) || 0;
    elements.statUnread.textContent = current + 1;
    elements.unreadBadge.textContent = current + 1;
    elements.unreadBadge.classList.remove('hidden');
}

// ============================================
// USERS SECTION
// ============================================
let allUsersCache = [];   // sólo la página actual (no toda la base)
let usersPage = 1;

// Carga una página de usuarios desde el backend (10/20 por página + búsqueda
// server-side). Antes traía TODOS los usuarios y filtraba/renderizaba todo junto,
// lo que trababa el panel con muchas cuentas.
async function loadUsers(page = 1) {
    usersPage = page;
    const searchInput = document.getElementById('searchUsers');
    const search = searchInput ? searchInput.value.trim() : '';
    const tagSel = document.getElementById('usersTagFilter');
    const tag = tagSel ? tagSel.value : '';
    try {
        const qs = new URLSearchParams({ page: String(page) });
        if (search) qs.set('search', search);
        if (tag) qs.set('tag', tag);
        const response = await fetch(`${API_URL}/api/admin/users?${qs.toString()}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });

        if (!response.ok) throw new Error('Failed to load users');

        const data = await response.json();
        allUsersCache = data.users || [];
        renderUsers(allUsersCache);
        renderUsersPagination(data);
        // Mantener poblado el desplegable de etiquetas para el filtro.
        populateUsersTagFilter();
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

// La búsqueda ahora recarga desde el backend (página 1). El backend filtra por
// username / email / phone / id / accountNumber (mismo criterio que antes, pero
// sin traer toda la base al navegador).
function filterAndRenderUsers() {
    loadUsers(1);
}

function renderUsersPagination(data) {
    const el = document.getElementById('usersPagination');
    if (!el) return;
    const page = data.page || 1;
    const totalPages = data.totalPages || 0;
    const total = data.total || 0;
    if (totalPages <= 1) {
        el.innerHTML = total > 0 ? `<span style="color:#888;font-size:12px;">${total} usuario(s)</span>` : '';
        return;
    }
    const mk = (label, target, disabled) => `<button onclick="loadUsers(${target})" ${disabled ? 'disabled' : ''} style="padding:7px 14px;background:${disabled ? '#1a1a2e' : '#2a2a3a'};color:${disabled ? '#444' : '#fff'};border:none;border-radius:6px;cursor:${disabled ? 'not-allowed' : 'pointer'};font-size:13px;">${label}</button>`;
    el.innerHTML = `${mk('← Anterior', page - 1, page <= 1)}
        <span style="color:#aaa;font-size:13px;">Página ${page} de ${totalPages} <span style="color:#666;">(${total} usuarios)</span></span>
        ${mk('Siguiente →', page + 1, page >= totalPages)}`;
}

// Exportar todos los usuarios a CSV (solo admin general)
async function exportUsersCSV() {
    if (currentAdmin?.role !== 'admin') {
        showToast('No tienes permiso para exportar usuarios', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/users/export/csv`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to export users');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `usuarios_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast('Usuarios exportados correctamente', 'success');
    } catch (error) {
        console.error('Error exporting users:', error);
        showToast('Error al exportar usuarios', 'error');
    }
}

// Badge del plan de notificaciones elegido por el usuario en la encuesta.
function notifPlanBadge(plan) {
    const map = {
        suave:           { label: 'Suave',       color: '#28a745' },
        normal:          { label: 'Normal',      color: '#d4af37' },
        activo:          { label: 'Activo',      color: '#dc3545' },
        solo_reembolsos: { label: 'Solo reemb.', color: '#00a8ff' }
    };
    const p = map[plan];
    if (!p) return '<span style="color:#888;">—</span>';
    return `<span style="background:${p.color}22;border:1px solid ${p.color};color:${p.color};font-size:10px;font-weight:700;border-radius:6px;padding:2px 7px;white-space:nowrap;">${p.label}</span>`;
}

// Topes mensuales por plan (espejo de NOTIF_PLAN_LIMITS del backend).
const NOTIF_PLAN_LIMITS_ADMIN = {
    suave:           { bonos: 2, invitaciones: 5,  regalos: 2 },
    normal:          { bonos: 4, invitaciones: 5,  regalos: 2 },
    activo:          { bonos: 6, invitaciones: 10, regalos: 3 },
    solo_reembolsos: { bonos: 0, invitaciones: 0,  regalos: 0 }
};

// Celda con el consumo de notificaciones del mes vs el tope del plan.
function notifUsageCell(user) {
    const plan = user.notificationPlan;
    const lim = NOTIF_PLAN_LIMITS_ADMIN[plan];
    if (!lim) return '<span style="color:#888;">—</span>';
    if (plan === 'solo_reembolsos') {
        return '<span style="color:#00a8ff;font-size:.76rem;white-space:nowrap;">Solo reembolsos</span>';
    }
    const now = new Date();
    const period = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const c = user.notifMonthlyCounts || {};
    const cur = (c.period === period) ? c : { bonos: 0, invitaciones: 0, regalos: 0 };
    const fmt = (used, cap) => {
        const u = used || 0;
        const color = (u >= cap) ? '#dc3545' : '#aaa';
        return `<span style="color:${color}">${u}/${cap}</span>`;
    };
    return `<span style="font-size:.76rem;white-space:nowrap;" title="Bonos / Invitaciones / Regalos recibidos este mes">🎁${fmt(cur.bonos, lim.bonos)} 🎰${fmt(cur.invitaciones, lim.invitaciones)} 🎉${fmt(cur.regalos, lim.regalos)}</span>`;
}

function renderUsers(users) {
    const tbody = document.getElementById('usersTableBody');
    const adminRole = currentAdmin?.role;

    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="12" class="empty-state">No hay usuarios</td></tr>';
        return;
    }
    
    tbody.innerHTML = users.map(user => {
        const isAdminUser = ['admin', 'depositor', 'withdrawer', 'comunidad'].includes(user.role);
        const canChangePassword = adminRole === 'admin' || (adminRole === 'depositor' && !isAdminUser);
        const canBlock = adminRole === 'admin' && !isAdminUser;

        // Status cell: show BLOQUEADO badge if blocked
        let statusCell;
        if (user.isBlocked) {
            const reason = user.blockReason ? escapeHtml(user.blockReason).replace(/"/g, '&quot;') : 'Sin motivo registrado';
            statusCell = `<span class="status-badge blocked" title="${reason}" style="background:#dc3545;color:#fff;cursor:default;">BLOQUEADO</span>`;
        } else {
            statusCell = `<span class="status-badge ${user.status}">${escapeHtml(user.status)}</span>`;
        }

        // ROOT CAUSE FIX: los onclick deben usar comillas SIMPLES como
        // delimitador de atributo porque JSON.stringify produce strings con
        // comillas dobles ("abc"). Si el atributo se delimita con dobles, el
        // browser parsea onclick="fn(" y descarta el resto → ningún botón
        // ejecutaba su handler. Con comillas simples afuera, las dobles del
        // JSON conviven sin colisión: onclick='fn("abc", "pepe")'.
        // Link de autologin: para clientes que ya existen en JUGAYGANA pero
        // nunca entraron acá. Solo admin general y nunca sobre cuentas de staff
        // (el backend lo vuelve a validar).
        const autologinBtn = (adminRole === 'admin' && !isAdminUser)
            ? `<button class="action-btn-small" title="Generar link de acceso (WhatsApp)" onclick='generateAutologinLink(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)})'>🔗</button>`
            : '';

        const pwdBtn = canChangePassword
            ? `<button class="action-btn-small" title="Cambiar contraseña" onclick='openUserPasswordModal(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)}, ${JSON.stringify(user.role)})'><span class="icon icon-key"></span></button>`
            : '';

        let blockBtn = '';
        if (canBlock) {
            if (user.isBlocked) {
                blockBtn = `<button class="action-btn-small" title="Desbloquear usuario" onclick='handleUnblockUser(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)})'><span class="icon icon-lock-open"></span></button>`;
            } else {
                blockBtn = `<button class="action-btn-small" style="color:#dc3545" title="Bloquear usuario" onclick='openBlockModal(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)})'><span class="icon icon-ban"></span></button>`;
            }
        }

        // Columna SMS — 2 botones por cliente:
        //  · Retiro: verificar/desverificar teléfono (retiro sin SMS).
        //  · Inicio: permitir entrar solo con el usuario (sin clave ni SMS).
        let verifyBtn = '';
        let loginNoPwdBtn = '';
        if (adminRole === 'admin' && !isAdminUser) {
            if (user.phoneVerified) {
                verifyBtn = `<button class="action-btn-small" style="color:#28a745" title="RETIRO sin SMS activado — clic para desactivar" onclick='handleToggleVerifyPhone(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)}, false)'><span class="icon icon-check"></span></button>`;
            } else {
                verifyBtn = `<button class="action-btn-small" title="Activar RETIRO sin SMS (marca el teléfono como verificado)" onclick='handleToggleVerifyPhone(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)}, true)'><span class="icon icon-check"></span></button>`;
            }
            if (user.loginWithoutPassword) {
                loginNoPwdBtn = `<button class="action-btn-small" style="color:#28a745" title="INICIO sin SMS/clave activado — clic para desactivar" onclick='handleToggleLoginNoPwd(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)}, false)'><span class="icon icon-sign-in"></span></button>`;
            } else {
                loginNoPwdBtn = `<button class="action-btn-small" title="Activar INICIO sin SMS (entra solo con el usuario, sin clave)" onclick='handleToggleLoginNoPwd(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)}, true)'><span class="icon icon-sign-in"></span></button>`;
            }
        }
        const smsCell = (verifyBtn || loginNoPwdBtn)
            ? `${verifyBtn}${loginNoPwdBtn}`
            : '<span style="color:#888;">—</span>';

        const tagsHtml = (Array.isArray(user.tags) && user.tags.length)
            ? '<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:3px;">' +
              user.tags.map(t => '<span style="background:rgba(212,175,55,0.18);border:1px solid rgba(212,175,55,0.45);color:#d4af37;border-radius:9px;padding:1px 6px;font-size:9.5px;">' + escapeHtml(t) + '</span>').join('') +
              '</div>'
            : '';

        return `
        <tr class="${isAdminUser ? 'admin-row' : ''}">
            <td>${escapeHtml(user.username)}${tagsHtml}</td>
            <td>${escapeHtml(user.accountNumber || user.accountId || '-')}</td>
            <td>${escapeHtml(user.email || '-')}</td>
            <td>${escapeHtml(user.phone || '-')}</td>
            <td><span class="role-badge ${user.role}">${getRoleLabel(user.role)}</span></td>
            <td>${formatMoney(user.balance)}</td>
            <td>${statusCell}</td>
            <td>${formatDate(user.lastLogin)}</td>
            <td>${notifPlanBadge(user.notificationPlan)}</td>
            <td>${notifUsageCell(user)}</td>
            <td>${smsCell}</td>
            <td>
                <button class="action-btn-small" title="Ver detalle" onclick='viewUser(${JSON.stringify(user.id)})'>
                    <span class="icon icon-eye"></span>
                </button>
                <button class="action-btn-small" title="Ir al chat" onclick='chatUser(${JSON.stringify(user.id)})'>
                    <span class="icon icon-comment"></span>
                </button>
                ${autologinBtn}
                ${pwdBtn}
                ${blockBtn}
            </td>
        </tr>
        `;
    }).join('');
}

// ============================================
// USER ACTIONS — Password change & Block/Unblock
// ============================================

// Opens the existing passwordModal pre-filled for a specific user from the table.
function openUserPasswordModal(userId, username, userRole) {
    selectedUserId = userId;
    selectedUserRole = userRole;
    // Update modal title to show which user's password is being changed
    const modalHeader = document.querySelector('#passwordModal .modal-header h3');
    if (modalHeader) {
        modalHeader.innerHTML = `<span class="icon icon-key"></span> Cambiar contraseña: ${escapeHtml(username)}`;
    }
    // Ensure close/cancel buttons are visible (they may have been hidden by the forced-change flow)
    const closeBtn = document.querySelector('#passwordModal .close-modal');
    if (closeBtn) closeBtn.style.display = '';
    const cancelBtn = document.querySelector('#passwordModal .btn-secondary');
    if (cancelBtn) cancelBtn.style.display = '';
    // Clear previous values
    const np = document.getElementById('newPassword');
    const cp = document.getElementById('confirmPassword');
    if (np) np.value = '';
    if (cp) cp.value = '';
    showModal('passwordModal');
}

// Opens the block modal for a specific user.
function openBlockModal(userId, username) {
    selectedUserForBlock = { id: userId, username };
    const titleEl = document.getElementById('blockModalUsername');
    if (titleEl) titleEl.textContent = username;
    const reasonEl = document.getElementById('blockReasonInput');
    if (reasonEl) reasonEl.value = '';
    const confirmBtn = document.getElementById('confirmBlockBtn');
    if (confirmBtn) confirmBtn.disabled = true;
    showModal('blockModal');
}

// Handles submitting the block form.
async function handleBlockUser() {
    if (!selectedUserForBlock) return;
    const reasonEl = document.getElementById('blockReasonInput');
    const reason = reasonEl ? reasonEl.value.trim() : '';
    if (reason.length < 5) {
        showToast('El motivo debe tener al menos 5 caracteres', 'error');
        return;
    }
    const confirmBtn = document.getElementById('confirmBlockBtn');
    setButtonLoading(confirmBtn, true, 'Bloqueando...');
    try {
        const response = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(selectedUserForBlock.id)}/block`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ reason })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al bloquear usuario');
        showToast(`Usuario ${selectedUserForBlock.username} bloqueado`, 'success');
        hideModal('blockModal');
        // Si el usuario bloqueado es el del chat activo, refrescar header
        if (selectedUserForBlock.id === selectedUserId) {
            loadUserInfo(selectedUserForBlock.id);
        }
        // Refrescar tabla de usuarios solo si la sección está visible
        if (typeof loadUsers === 'function' && document.getElementById('usersSection')?.classList.contains('active')) {
            loadUsers();
        }
    } catch (error) {
        showToast(error.message || 'Error al bloquear usuario', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Bloquear usuario');
    }
}

// Handles unblocking a user directly (with a simple confirm dialog).
async function handleUnblockUser(userId, username) {
    if (!confirm(`¿Desbloquear a ${username}?`)) return;
    try {
        const response = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(userId)}/unblock`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al desbloquear usuario');
        showToast(`Usuario ${username} desbloqueado`, 'success');
        loadUsers();
    } catch (error) {
        showToast(error.message || 'Error al desbloquear usuario', 'error');
    }
}

// Verifica o desverifica el teléfono de un usuario (habilita retiro sin SMS).
// Genera un link de acceso de UN SOLO USO para un cliente que ya existe en
// JUGAYGANA pero nunca entró acá. Se le manda por WhatsApp: al abrirlo entra
// directo y le salta el cambio de contraseña obligatorio.
// `skipConfirm` lo usa el alta de usuario: ahí el link es la continuación
// natural de crear la cuenta, así que no tiene sentido volver a preguntar.
async function generateAutologinLink(userId, username, { skipConfirm = false } = {}) {
    if (!skipConfirm && !confirm(`¿Generar un link de acceso para ${username}?\n\nEl link entra a la cuenta SIN contraseña, sirve UNA sola vez y vence.\nMandáselo solo a esa persona.\n\nSi ya le habías generado uno, el anterior deja de funcionar.`)) return;
    try {
        const response = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(userId)}/autologin-link`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al generar el link');

        showAutologinLinkModal(data.username || username, data.link, data.expiresInHours);
    } catch (error) {
        showToast(error.message || 'Error al generar el link', 'error');
    }
}

// Muestra el link en un recuadro seleccionable y lo deja YA copiado.
function showAutologinLinkModal(username, link, hours) {
    const userEl = document.getElementById('autologinLinkUser');
    const input = document.getElementById('autologinLinkInput');
    const hoursEl = document.getElementById('autologinLinkHours');
    const state = document.getElementById('autologinCopyState');
    if (!input) { // por si el modal no está en el DOM: no perder el link
        window.prompt(`Link de acceso para ${username}:`, link);
        return;
    }
    if (userEl) userEl.textContent = username;
    if (hoursEl) hoursEl.textContent = hours || 72;
    input.value = link;
    if (state) state.textContent = '';
    showModal('autologinLinkModal');
    copyAutologinLink();
}

// Copia al portapapeles con fallback a execCommand (navegadores que niegan el
// permiso o contextos sin HTTPS). Si nada funciona, deja el texto seleccionado
// para que el agente lo copie a mano.
async function copyAutologinLink() {
    const input = document.getElementById('autologinLinkInput');
    const state = document.getElementById('autologinCopyState');
    if (!input || !input.value) return;

    let ok = false;
    try {
        await navigator.clipboard.writeText(input.value);
        ok = true;
    } catch (e) {
        try {
            input.select();
            ok = document.execCommand('copy');
        } catch (e2) { ok = false; }
    }

    if (!state) return;
    if (ok) {
        state.style.color = '#28a745';
        state.textContent = '✅ Link copiado — ya lo podés pegar en WhatsApp';
    } else {
        state.style.color = '#ffb84d';
        state.textContent = '⚠️ No se pudo copiar solo: tocá el recuadro y copialo a mano';
        input.select();
    }
}

async function handleToggleVerifyPhone(userId, username, verified) {
    const msg = verified
        ? `¿Verificar el teléfono de ${username}? Va a poder retirar sin pasar por el SMS.`
        : `¿Marcar el teléfono de ${username} como NO verificado? Le va a volver a pedir SMS al retirar.`;
    if (!confirm(msg)) return;
    try {
        const response = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(userId)}/verify-phone`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ verified })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al actualizar la verificación');
        showToast(data.message || 'Verificación actualizada', 'success');
        loadUsers();
    } catch (error) {
        showToast(error.message || 'Error al actualizar la verificación', 'error');
    }
}

// Activa/desactiva el inicio de sesión sin clave ni SMS (entra solo con el usuario).
async function handleToggleLoginNoPwd(userId, username, enabled) {
    const msg = enabled
        ? `¿Permitir que ${username} entre SOLO con su usuario, sin contraseña ni SMS?\n\n⚠️ Cualquiera que sepa el usuario va a poder entrar a esa cuenta.`
        : `¿Desactivar el inicio sin clave para ${username}? Va a volver a necesitar su contraseña.`;
    if (!confirm(msg)) return;
    try {
        const response = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(userId)}/login-without-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ enabled })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al actualizar el inicio sin clave');
        showToast(data.message || 'Inicio sin clave actualizado', 'success');
        loadUsers();
    } catch (error) {
        showToast(error.message || 'Error al actualizar el inicio sin clave', 'error');
    }
}

window.openUserPasswordModal = openUserPasswordModal;
window.openBlockModal = openBlockModal;

// === Alerta de POSIBLE MULTICUENTA en el header del chat ===
// Consulta el fraud-check del usuario y, si es sospechoso, muestra un banner rojo
// con el detalle (qué comparte y con qué cuentas) + botón para bloquear en el momento.
async function renderFraudBanner(userId) {
    const banner = document.getElementById('chatFraudBanner');
    if (!banner) return;
    banner.style.display = 'none';
    banner.innerHTML = '';
    try {
        const resp = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(userId)}/fraud-check`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!resp.ok) return;
        const data = await resp.json();
        // Race condition: si ya se cambió de chat, no pintar
        if (userId !== activeConversationId) return;
        if (!data || !data.suspicious || !Array.isArray(data.reasons) || !data.reasons.length) return;

        const iconFor = (t) => t === 'device' ? '📱' : (t === 'phone' ? '☎️' : '🌐');
        const rows = data.reasons.map(r => {
            const accs = Array.isArray(r.accounts) ? r.accounts : [];
            const names = accs.map(a => escapeHtml(a.username) + (a.isBlocked ? ' 🚫' : '')).join(', ');
            const extra = (r.count > accs.length) ? ` <span style="opacity:.8">(+${r.count - accs.length} más)</span>` : '';
            return `<div style="margin-top:5px;">${iconFor(r.type)} Comparte <strong>${escapeHtml(r.label)}</strong> con <strong>${r.count}</strong> cuenta${r.count === 1 ? '' : 's'}: ${names}${extra}</div>`;
        }).join('');

        banner.innerHTML =
            `<div style="padding:10px 14px;background:linear-gradient(90deg,#c1860b 0%,#8a5a00 100%);color:#fff;font-size:13px;border-bottom:1px solid #6e4700;cursor:pointer;user-select:none;" onclick="toggleFraudDetail()">`
            + `<strong>⚠️ POSIBLE MULTICUENTA</strong> — tocá para ver por qué <span id="fraudCaret" style="float:right">▸</span>`
            + `</div>`
            + `<div id="chatFraudDetail" style="display:none;padding:9px 14px;background:rgba(0,0,0,0.28);color:#fff;font-size:12.5px;border-bottom:1px solid rgba(0,0,0,0.3);">`
            + rows
            + `<button onclick="blockFromFraud('${encodeURIComponent(userId)}')" style="margin-top:9px;background:#dc3545;color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-weight:700;">🚫 Bloquear este usuario</button>`
            + `</div>`;
        banner.style.display = 'block';
    } catch (e) { /* best-effort: nunca romper el chat por esto */ }
}
function toggleFraudDetail() {
    const d = document.getElementById('chatFraudDetail');
    const c = document.getElementById('fraudCaret');
    if (!d) return;
    const willOpen = d.style.display === 'none';
    d.style.display = willOpen ? 'block' : 'none';
    if (c) c.textContent = willOpen ? '▾' : '▸';
}
function blockFromFraud(userId) {
    const id = decodeURIComponent(userId);
    let uname = (elements.chatUsername && elements.chatUsername.textContent) || '';
    uname = uname.replace(/\s*\(.*$/, '').trim(); // sacar el sufijo de publicista si lo hubiera
    openBlockModal(id, uname);
}
window.toggleFraudDetail = toggleFraudDetail;
window.blockFromFraud = blockFromFraud;
window.handleBlockUser = handleBlockUser;
window.handleUnblockUser = handleUnblockUser;
window.handleToggleVerifyPhone = handleToggleVerifyPhone;
window.handleToggleLoginNoPwd = handleToggleLoginNoPwd;
window.generateAutologinLink = generateAutologinLink;
window.showAutologinLinkModal = showAutologinLinkModal;
window.copyAutologinLink = copyAutologinLink;

// Pinta el banner BLOQUEADO + alterna botones Bloquear/Desbloquear según el estado del user.
// El banner muestra motivo y QUIÉN lo bloqueó — esta info es solo para admins
// (el usuario nunca la ve: el cliente solo recibe el motivo en el login bloqueado,
// nunca el blockedBy).
function applyBlockStateToChatHeader(user) {
    if (!user) return;
    const isBlocked = user.isBlocked === true;
    const reason = user.blockReason || 'Sin motivo registrado';
    const blockedBy = user.blockedBy || null;
    const blockedAt = user.blockedAt ? new Date(user.blockedAt) : null;
    const isAdminUser = ['admin', 'depositor', 'withdrawer', 'comunidad'].includes(user.role);
    // Tanto admin general como depositor pueden bloquear (son los que operan en el chat).
    const canBlock = ['admin', 'depositor'].includes(currentAdmin?.role) && !isAdminUser;

    if (elements.chatBlockedBanner) {
        elements.chatBlockedBanner.style.display = isBlocked ? 'block' : 'none';
    }
    if (elements.chatBlockedReason) {
        if (isBlocked) {
            const lines = [`Motivo: ${reason}`];
            if (blockedBy) {
                let byLine = `Bloqueado por: ${blockedBy}`;
                if (blockedAt && !isNaN(blockedAt.getTime())) {
                    byLine += ` — ${fmtFechaHoraAR(blockedAt)}`;
                }
                lines.push(byLine);
            }
            elements.chatBlockedReason.innerHTML = lines.map(escapeHtml).join('<br>');
        } else {
            elements.chatBlockedReason.textContent = '';
        }
    }

    if (elements.btnBlock) {
        elements.btnBlock.style.display = (canBlock && !isBlocked) ? '' : 'none';
    }
    if (elements.btnUnblock) {
        elements.btnUnblock.style.display = (canBlock && isBlocked) ? '' : 'none';
    }
}

// Abre el modal de bloqueo desde el header del chat (usa el chat seleccionado)
function openBlockModalFromChat() {
    if (!selectedUserId || !selectedUsername) {
        showToast('Seleccioná un chat primero', 'error');
        return;
    }
    openBlockModal(selectedUserId, selectedUsername);
}

// Desbloquea desde el header del chat y refresca el header
async function handleUnblockFromChat() {
    if (!selectedUserId || !selectedUsername) {
        showToast('Seleccioná un chat primero', 'error');
        return;
    }
    if (!confirm(`¿Desbloquear a ${selectedUsername}?`)) return;
    const userId = selectedUserId;
    const username = selectedUsername;
    try {
        const response = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(userId)}/unblock`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al desbloquear usuario');
        showToast(`Usuario ${username} desbloqueado`, 'success');
        // Refrescar header con el estado nuevo
        if (userId === selectedUserId) loadUserInfo(userId);
    } catch (error) {
        showToast(error.message || 'Error al desbloquear usuario', 'error');
    }
}

window.applyBlockStateToChatHeader = applyBlockStateToChatHeader;
window.openBlockModalFromChat = openBlockModalFromChat;
window.handleUnblockFromChat = handleUnblockFromChat;

// ============================================
// UI HELPERS
// ============================================
function switchSection(section) {
    // CORREGIDO: Solo admin general puede acceder a "Usuarios"
    if (section === 'users' && currentAdmin?.role !== 'admin') {
        showToast('No tienes permiso para acceder a esta sección', 'error');
        return;
    }
    // Solo admin general puede ver el reporte de demoras
    if (section === 'chatDelays' && currentAdmin?.role !== 'admin') {
        showToast('No tienes permiso para acceder a esta sección', 'error');
        return;
    }
    
    // Update nav
    elements.navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.section === section);
    });
    
    // Update sections
    elements.sections.forEach(sec => {
        sec.classList.toggle('active', sec.id === `${section}Section`);
    });
    
    // Load section data
    // Al volver a Chats, recargar la lista una vez (mientras estuviste en otra
    // sección no se refrescaba en background, así que puede haber chats nuevos).
    if (section === 'chats') loadConversations(false);
    if (section === 'users') loadUsers(1);
    if (section === 'transactions') {
        // La primera vez que se entra, el rango arranca en HOY (antes traía TODO
        // desde el inicio de los tiempos → se trababa). Después respeta el filtro
        // que el admin haya dejado puesto.
        if (!window._txDefaultsSet) {
            window._txDefaultsSet = true;
            setTodayFilter();
        } else {
            loadTransactions(1);
        }
    }
    if (section === 'commands') loadCommands();
    if (section === 'datos') loadDatos();
    if (section === 'notifications') loadNotificationsPanel();
    if (section === 'referrals') loadAdminReferralSummary();
    if (section === 'roulette') loadRouletteAdmin();
    if (section === 'automations') loadAutomations();
    if (section === 'bonusStrategy') loadBonusStrategy();
    if (section === 'encuesta') loadEncuesta();
    if (section === 'inactivos') loadInactivos();
    if (section === 'centralIngresos') loadCentralIngresos();
    if (section === 'centralAppUsers') loadCentralAppUsers();
    if (section === 'centralWelcomeBonus') loadCentralWelcomeBonus();
    if (section === 'suspiciousAccounts') loadSuspiciousAccounts();
    if (section === 'reembolsos') loadReembolsos();
    if (section === 'chatDelays') loadChatDelays();
    if (section === 'reviews') loadReviews();
    if (section === 'campaigns') loadCampaigns();
    if (section === 'publisherAdmins') {
        if (currentAdmin?.role !== 'admin') {
            showToast('No tienes permiso para acceder a esta sección', 'error');
            return;
        }
        loadPublisherAdmins();
    }
    if (section === 'publishersDashboard') {
        if (currentAdmin?.role !== 'admin') {
            showToast('No tienes permiso para acceder a esta sección', 'error');
            return;
        }
        loadPublishersRanking();
        loadPublishersDashboard();
    }
    if (section === 'audit') {
        if (currentAdmin?.role !== 'admin') {
            showToast('No tienes permiso para acceder a esta sección', 'error');
            return;
        }
        loadAudit();
    }
    if (section === 'privateConfig') {
        if (currentAdmin?.role !== 'admin') {
            showToast('No tienes permiso para acceder a esta sección', 'error');
            return;
        }
        loadPrivateConfig();
    }
    if (section === 'sms') {
        if (currentAdmin?.role !== 'admin') {
            showToast('No tienes permiso para acceder a esta sección', 'error');
            return;
        }
        loadSoporteVip();
        if (!smsAccessGranted) {
            showSmsPasswordModal();
        } else {
            document.getElementById('smsSectionContent').classList.remove('hidden');
        }
    }
    // Sección 'database' ELIMINADA (2026-07-09): era código muerto — no existía
    // nav-item ni <section id="databaseSection"> en el HTML (inalcanzable).
}

function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }
}

function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

function calculateBonus() {
    const amount = parseFloat(document.getElementById('depositAmount').value) || 0;
    const activeBonus = document.querySelector('.bonus-options button.active');
    const bonusPercent = activeBonus ? parseFloat(activeBonus.dataset.bonus) : 0;
    
    const bonusAmount = Math.floor(amount * (bonusPercent / 100));
    document.getElementById('depositBonus').value = bonusAmount;
}

function scrollToBottom() {
    // CORREGIDO: Scroll suave al final del contenedor
    if (elements.chatMessages) {
        elements.chatMessages.scrollTo({
            top: elements.chatMessages.scrollHeight,
            behavior: 'smooth'
        });
        // Asegurar que llegue al final
        elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    }
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconClass = type === 'success' ? 'icon-check' : type === 'error' ? 'icon-times-circle' : type === 'warning' ? 'icon-exclamation' : 'icon-info';
    toast.innerHTML = `
        <span class="icon ${iconClass}"></span>
        <span>${message}</span>
    `;
    
    elements.toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function playNotificationSound() {
    // Sonido de notificación para nuevos mensajes
    try {
        // Crear un beep simple usando Web Audio API
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.5);
    } catch (e) {
    }
}

function updateUserStatus(userId, online) {
    if (userId === selectedUserId) {
        elements.chatStatus.textContent = online ? 'En línea' : 'Desconectado';
        elements.chatStatus.className = online ? 'status online' : 'status';
    }
}

// ============================================
// UTILITIES
// ============================================

function formatMoney(amount) {
    if (amount === undefined || amount === null) return '$0';
    return '$' + parseFloat(amount).toLocaleString('es-AR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
}

// ============================================
// FORMATO DE FECHA CANÓNICO DEL PANEL → DD/MM/YYYY (hora Argentina)
// Usar SIEMPRE estos helpers para mostrar fechas, así todo el panel queda
// consistente (día y mes con 2 dígitos, año con 4).
// ============================================
function fmtFechaAR(date) {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('es-AR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        timeZone: 'America/Argentina/Buenos_Aires'
    });
}
// DD/MM/YYYY HH:mm
function fmtFechaHoraAR(date) {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const t = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
    return fmtFechaAR(d) + ' ' + t;
}
window.fmtFechaAR = fmtFechaAR;
window.fmtFechaHoraAR = fmtFechaHoraAR;

function formatDate(date) {
    if (!date) return 'Nunca';
    return fmtFechaAR(date);
}

function formatTime(date) {
    if (!date) return '';
    const d = new Date(date);
    const now = new Date();
    const diff = now - d;

    if (diff < 60000) return 'Ahora';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
    return fmtFechaAR(d);
}

function formatDateTime(date) {
    if (!date) return '';
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const dateOpts = { timeZone: 'America/Argentina/Buenos_Aires' };
    const dStr = d.toLocaleDateString('es-AR', dateOpts);
    const todayStr = today.toLocaleDateString('es-AR', dateOpts);
    const yesterdayStr = yesterday.toLocaleDateString('es-AR', dateOpts);

    const time = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });

    if (dStr === todayStr) return `Hoy ${time}`;
    if (dStr === yesterdayStr) return `Ayer ${time}`;

    return d.toLocaleDateString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'America/Argentina/Buenos_Aires'
    }) + ' ' + time;
}

// Igual que formatDateTime pero CON segundos. Se usa solo en los mensajes del
// chat (enviados/recibidos) para poder ver el horario exacto y controlar demoras.
function formatChatTime(date) {
    if (!date) return '';
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const dateOpts = { timeZone: 'America/Argentina/Buenos_Aires' };
    const dStr = d.toLocaleDateString('es-AR', dateOpts);
    const todayStr = today.toLocaleDateString('es-AR', dateOpts);
    const yesterdayStr = yesterday.toLocaleDateString('es-AR', dateOpts);

    const time = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });

    if (dStr === todayStr) return `Hoy ${time}`;
    if (dStr === yesterdayStr) return `Ayer ${time}`;

    return d.toLocaleDateString('es-AR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        timeZone: 'America/Argentina/Buenos_Aires'
    }) + ' ' + time;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ============================================
// WITHDRAW TOTAL UPDATE
// ============================================
function updateWithdrawTotal() {
    const amount = parseInt(document.getElementById('withdrawAmount').value) || 0;
    const totalDisplay = document.getElementById('withdrawTotal');
    if (totalDisplay) {
        totalDisplay.textContent = formatMoney(amount);
    }
}

// Seleccionar todo el saldo del usuario
async function selectAllBalance() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/balance/${selectedUsername}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            const balance = data.balance || 0;
            document.getElementById('withdrawAmount').value = balance;
            updateWithdrawTotal();
            showToast(`Saldo seleccionado: ${formatMoney(balance)}`, 'success');
        } else {
            showToast('No se pudo obtener el saldo del usuario', 'error');
        }
    } catch (error) {
        console.error('Error obteniendo saldo:', error);
        showToast('Error al obtener el saldo', 'error');
    }
}

// ============================================
// BUTTON LOADING STATE
// ============================================
function setButtonLoading(button, isLoading, loadingText = 'Cargando...') {
    if (!button) return;
    
    if (isLoading) {
        button.dataset.originalText = button.innerHTML;
        button.innerHTML = `<span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span> ${loadingText}`;
        button.disabled = true;
        button.style.opacity = '0.7';
        button.style.cursor = 'not-allowed';
    } else {
        button.innerHTML = button.dataset.originalText || loadingText;
        button.disabled = false;
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
    }
}

// ============================================
// TRANSACTIONS DASHBOARD
// ============================================
let transactionsData = [];
let transactionsFilter = 'all';
let transactionDateFrom = '';
let transactionDateTo = '';
let transactionUsernameFilter = '';
let transactionsPage = 1;

// Carga una página de transacciones. El tipo, la fecha y el usuario se filtran en
// el BACKEND (antes traía todo el rango y filtraba/renderizaba todo en el
// navegador → se trababa). El resumen de tarjetas viene calculado por agregación
// sobre todo el rango (todos los tipos), independiente del filtro de tipo.
async function loadTransactions(page = 1) {
    transactionsPage = page;
    try {
        let url = `${API_URL}/api/admin/transactions`;
        const params = [`page=${page}`];

        if (transactionDateFrom) {
            params.push(`from=${transactionDateFrom}`);
        }
        if (transactionDateTo) {
            params.push(`to=${transactionDateTo}`);
        }
        if (transactionUsernameFilter) {
            params.push(`username=${encodeURIComponent(transactionUsernameFilter)}`);
        }
        if (transactionsFilter && transactionsFilter !== 'all') {
            params.push(`type=${encodeURIComponent(transactionsFilter)}`);
        }

        url += '?' + params.join('&');

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });

        if (!response.ok) throw new Error('Failed to load transactions');

        const data = await response.json();
        transactionsData = data.transactions || [];
        renderTransactions(transactionsData);
        renderTransactionStats(data.summary || {});
        renderTransactionsPagination(data);
    } catch (error) {
        console.error('Error loading transactions:', error);
    }
}

function renderTransactionsPagination(data) {
    const el = document.getElementById('transactionsPagination');
    if (!el) return;
    const page = data.page || 1;
    const totalPages = data.totalPages || 0;
    const total = data.listTotal || 0;
    if (totalPages <= 1) {
        el.innerHTML = total > 0 ? `<span style="color:#888;font-size:12px;">${total} transacción(es)</span>` : '';
        return;
    }
    const mk = (label, target, disabled) => `<button onclick="loadTransactions(${target})" ${disabled ? 'disabled' : ''} style="padding:7px 14px;background:${disabled ? '#1a1a2e' : '#2a2a3a'};color:${disabled ? '#444' : '#fff'};border:none;border-radius:6px;cursor:${disabled ? 'not-allowed' : 'pointer'};font-size:13px;">${label}</button>`;
    el.innerHTML = `${mk('← Anterior', page - 1, page <= 1)}
        <span style="color:#aaa;font-size:13px;">Página ${page} de ${totalPages} <span style="color:#666;">(${total} transacciones)</span></span>
        ${mk('Siguiente →', page + 1, page >= totalPages)}`;
}

function renderTransactionStats(summary) {
    const statsContainer = document.getElementById('transactionStats');
    if (statsContainer) {
        const netBalance = (summary.deposits || 0) - (summary.withdrawals || 0);
        const netBalanceClass = netBalance >= 0 ? '' : 'negative';
        
        statsContainer.innerHTML = `
            <div class="stat-card deposit">
                <span class="icon icon-plus-circle"></span>
                <span class="stat-number">${formatMoney(summary.deposits || 0)}</span>
                <span class="stat-label">Depósitos</span>
            </div>
            <div class="stat-card withdrawal">
                <span class="icon icon-minus-circle"></span>
                <span class="stat-number">${formatMoney(summary.withdrawals || 0)}</span>
                <span class="stat-label">Retiros</span>
            </div>
            <div class="stat-card bonus">
                <span class="icon icon-gift"></span>
                <span class="stat-number">${formatMoney(summary.bonuses || 0)}</span>
                <span class="stat-label">Bonificaciones</span>
            </div>
            <div class="stat-card refund">
                <span class="icon icon-undo"></span>
                <span class="stat-number">${formatMoney(summary.refunds || 0)}</span>
                <span class="stat-label">Reembolsos</span>
            </div>
            <div class="stat-card referral">
                <span class="icon icon-users"></span>
                <span class="stat-number">${formatMoney(summary.referrals || 0)}</span>
                <span class="stat-label">Referidos</span>
            </div>
            ${summary.fireRewards > 0 ? `
            <div class="stat-card bonus" style="border-color:#f97316">
                <span style="font-size:1.2rem">🔥</span>
                <span class="stat-number" style="color:#f97316">${formatMoney(summary.fireRewards || 0)}</span>
                <span class="stat-label">Fueguito</span>
            </div>` : ''}
            <div class="stat-card net-balance ${netBalanceClass}">
                <span class="icon icon-balance"></span>
                <span class="stat-number">${formatMoney(netBalance)}</span>
                <span class="stat-label">Saldo Neto</span>
            </div>
            <div class="stat-card total">
                <span class="icon icon-list"></span>
                <span class="stat-number">${summary.totalTransactions || 0}</span>
                <span class="stat-label">Total Transacciones</span>
            </div>
        `;
    }
    
    // CORREGIDO: Actualizar comisión con el total de depósitos y retiros
    window.currentDepositsTotal = summary.deposits || 0;
    window.currentWithdrawalsTotal = summary.withdrawals || 0;
    updateCommissionDisplay();
}

// CORREGIDO: Función para actualizar la visualización de comisión
// Issue #5: La comisión total se resta al saldo neto para reflejar el valor real
function updateCommissionDisplay() {
    const commissionRateInput = document.getElementById('commissionRate');
    const commissionAmountEl = document.getElementById('commissionAmount');
    const commissionBaseEl = document.getElementById('commissionBaseAmount');
    const netAfterCommissionEl = document.getElementById('netAfterCommission');
    
    if (!commissionRateInput || !commissionAmountEl) return;
    
    const rate = parseFloat(commissionRateInput.value) || 0;
    const baseAmount = window.currentDepositsTotal || 0;
    const withdrawals = window.currentWithdrawalsTotal || 0;
    const commissionAmount = baseAmount * (rate / 100);
    // Saldo neto = (depósitos - retiros) - comisión
    const netBeforeCommission = baseAmount - withdrawals;
    const netAfterCommission = netBeforeCommission - commissionAmount;
    
    commissionAmountEl.textContent = formatMoney(commissionAmount);
    if (commissionBaseEl) commissionBaseEl.textContent = formatMoney(baseAmount);
    if (netAfterCommissionEl) netAfterCommissionEl.textContent = formatMoney(netAfterCommission);

    // Issue #5: Actualizar también la tarjeta "Saldo Neto" en el dashboard
    const netBalanceEl = document.querySelector('.stat-card.net-balance .stat-number');
    if (netBalanceEl) {
        netBalanceEl.textContent = formatMoney(netAfterCommission);
        const netBalanceCard = netBalanceEl.closest('.stat-card');
        if (netBalanceCard) {
            netBalanceCard.classList.toggle('negative', netAfterCommission < 0);
        }
    }
}

function applyTransactionDateFilter() {
    transactionDateFrom = document.getElementById('dateFrom').value;
    transactionDateTo = document.getElementById('dateTo').value;
    loadTransactions();
}

function clearTransactionDateFilter() {
    transactionDateFrom = '';
    transactionDateTo = '';
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';
    loadTransactions();
}

function applyTxUserFilter() {
    const input = document.getElementById('txUserFilter');
    transactionUsernameFilter = input ? input.value.trim() : '';
    loadTransactions();
}

function clearTxUserFilter() {
    transactionUsernameFilter = '';
    const input = document.getElementById('txUserFilter');
    if (input) input.value = '';
    loadTransactions();
}

// Devuelve la fecha actual en Argentina (UTC-3, sin DST) como "YYYY-MM-DD"
function getArgentinaDateStr(date) {
    // Argentina es UTC-3 todo el año (no usa horario de verano desde 2009)
    const offset = -3 * 60; // -180 minutos
    const local = new Date(date.getTime() + offset * 60 * 1000);
    return local.toISOString().split('T')[0];
}

function setTodayFilter() {
    const today = getArgentinaDateStr(new Date());
    document.getElementById('dateFrom').value = today;
    document.getElementById('dateTo').value = today;
    applyTransactionDateFilter();
}

function setYesterdayFilter() {
    const yesterday = getArgentinaDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
    document.getElementById('dateFrom').value = yesterday;
    document.getElementById('dateTo').value = yesterday;
    applyTransactionDateFilter();
}

function setWeekFilter() {
    const today = getArgentinaDateStr(new Date());
    const weekAgo = getArgentinaDateStr(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    document.getElementById('dateFrom').value = weekAgo;
    document.getElementById('dateTo').value = today;
    applyTransactionDateFilter();
}

function setMonthFilter() {
    const now = new Date();
    const today = getArgentinaDateStr(now);
    const monthAgo = getArgentinaDateStr(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()));
    document.getElementById('dateFrom').value = monthAgo;
    document.getElementById('dateTo').value = today;
    applyTransactionDateFilter();
}

function renderTransactions(transactions) {
    const tbody = document.getElementById('transactionsTableBody');

    // El filtro por tipo ya viene aplicado por el backend (junto con la fecha y el
    // usuario). Acá sólo renderizamos la página recibida.
    if (!transactions.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No hay transacciones</td></tr>';
        return;
    }

    tbody.innerHTML = transactions.map(t => `
        <tr>
            <td>${formatDateTime(t.timestamp || t.createdAt)}</td>
            <td>${escapeHtml(t.username)}</td>
            <td><span class="type-badge ${t.type}">${getTransactionTypeLabel(t.type)}</span></td>
            <td>${formatMoney(t.amount)}</td>
            <td>${escapeHtml(t.description || '-')}</td>
            <td>${escapeHtml(t.adminUsername || '-')}</td>
        </tr>
    `).join('');
}

function getTransactionTypeLabel(type) {
    const labels = {
        deposit: 'Depósito',
        withdrawal: 'Retiro',
        bonus: 'Bonificación',
        fire_reward: '🔥 Fueguito',
        refund: 'Reembolso',
        referral_commission: '🤝 Referido'
    };
    return labels[type] || type;
}

function filterTransactions(type) {
    transactionsFilter = type;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === type);
    });
    // Recarga server-side desde la página 1 (el backend filtra por tipo).
    loadTransactions(1);
}

// ============================================
// SMS MASIVO SECTION - Password Gate
// ============================================
// ============================================
// CONFIG PRIVADA (#128) — clave propia + config de la IA de comprobantes
// ============================================
// La clave se guarda en memoria SOLO mientras el sector está desbloqueado (el
// server la exige en cada escritura; no hay sesión desbloqueada del lado server).
let _pcPassword = null;

function _pcShow(id, on) { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', !on); }
// #144: estado persistente al lado del botón (el toast dura 3 s y se pierde fácil).
function _pcStatus(id, text, ok) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? '#25d366' : '#ff5050';
}
// Lee la respuesta aunque no sea JSON (429 del limiter, 502, etc.).
async function _pcReadJson(r) {
    try { return await r.json(); } catch (_) { return { error: `HTTP ${r.status} ${r.statusText || ''}`.trim() }; }
}

async function loadPrivateConfig() {
    _pcPassword = null;
    _pcShow('pcAiCard', false); _pcShow('pcAuditCard', false); _pcShow('pcRefundsCard', false); _pcShow('pcUnlockedBar', false); _pcShow('pcChangePassForm', false);
    _pcShow('pcSetupForm', false); _pcShow('pcUnlockForm', false);
    const hint = document.getElementById('pcLockHint');
    try {
        const r = await authFetch('/api/admin/private-config/status');
        const j = await r.json();
        if (!r.ok) { if (hint) hint.textContent = j.error || 'Sin acceso'; return; }
        if (j.hasPassword) {
            if (hint) hint.textContent = 'Este sector tiene su propia clave (distinta del login). Ingresala para ver y modificar la configuración.';
            _pcShow('pcUnlockForm', true);
            const inp = document.getElementById('pcUnlockPass'); if (inp) { inp.value = ''; inp.focus(); }
        } else {
            if (hint) hint.textContent = 'Todavía no hay clave definida para este sector. Definila ahora (queda guardada hasheada en la base, no en código ni en SSM).';
            _pcShow('pcSetupForm', true);
        }
    } catch (e) {
        if (hint) hint.textContent = 'Error de conexión';
    }
}

async function setupPrivateConfigPassword() {
    const p1 = (document.getElementById('pcSetupPass1') || {}).value || '';
    const p2 = (document.getElementById('pcSetupPass2') || {}).value || '';
    if (p1.length < 8) { showToast('La clave debe tener al menos 8 caracteres', 'error'); return; }
    if (p1 !== p2) { showToast('Las claves no coinciden', 'error'); return; }
    try {
        const r = await authFetch('/api/admin/private-config/setup', { method: 'POST', body: JSON.stringify({ password: p1 }) });
        const j = await r.json();
        if (!r.ok) { showToast(j.error || 'Error', 'error'); return; }
        showToast('Clave definida', 'success');
        document.getElementById('pcSetupPass1').value = ''; document.getElementById('pcSetupPass2').value = '';
        await loadPrivateConfig();
        const inp = document.getElementById('pcUnlockPass'); if (inp) inp.value = p1;
        unlockPrivateConfig();
    } catch (e) { showToast('Error de conexión', 'error'); }
}

async function unlockPrivateConfig() {
    const pw = (document.getElementById('pcUnlockPass') || {}).value || '';
    if (!pw) { showToast('Ingresá la clave', 'error'); return; }
    try {
        const r = await authFetch('/api/admin/private-config/unlock', { method: 'POST', body: JSON.stringify({ password: pw }) });
        const j = await _pcReadJson(r);
        if (!r.ok) { showToast(j.error || 'Clave incorrecta', 'error'); return; }
        _pcPassword = pw;
        document.getElementById('pcUnlockPass').value = '';
        _pcShow('pcUnlockForm', false); _pcShow('pcUnlockedBar', true); _pcShow('pcAiCard', true);
        const hint = document.getElementById('pcLockHint'); if (hint) hint.textContent = 'Los cambios que guardes acá aplican en producción sin deploy.';
        renderPrivateAiConfig(j.ai || {});
        _pcShow('pcAuditCard', true);
        renderPrivateAuditConfig(j.audit || {});
        _pcShow('pcRefundsCard', true);
        renderPrivateRefundsConfig(j.refunds || {});
    } catch (e) { showToast('Error de conexión', 'error'); }
}

function lockPrivateConfig() { loadPrivateConfig(); }

function togglePrivateConfigPassForm() {
    const el = document.getElementById('pcChangePassForm');
    if (el) el.classList.toggle('hidden');
}

async function changePrivateConfigPassword() {
    if (!_pcPassword) { showToast('Primero desbloqueá el sector', 'error'); return; }
    const p1 = (document.getElementById('pcNewPass1') || {}).value || '';
    const p2 = (document.getElementById('pcNewPass2') || {}).value || '';
    if (p1.length < 8) { showToast('La clave nueva debe tener al menos 8 caracteres', 'error'); return; }
    if (p1 !== p2) { showToast('Las claves no coinciden', 'error'); return; }
    try {
        const r = await authFetch('/api/admin/private-config/password', { method: 'POST', body: JSON.stringify({ password: _pcPassword, newPassword: p1 }) });
        const j = await r.json();
        if (!r.ok) { showToast(j.error || 'Error', 'error'); return; }
        _pcPassword = p1;
        document.getElementById('pcNewPass1').value = ''; document.getElementById('pcNewPass2').value = '';
        _pcShow('pcChangePassForm', false);
        showToast('Clave cambiada', 'success');
    } catch (e) { showToast('Error de conexión', 'error'); }
}

function renderPrivateAiConfig(ai) {
    const en = document.getElementById('pcAiEnabled'); if (en) en.checked = ai.enabled !== false;
    const sel = document.getElementById('pcAiModel');
    const custom = document.getElementById('pcAiModelCustom');
    if (sel) {
        const known = Array.from(sel.options).some(o => o.value === (ai.model || ''));
        if (known) { sel.value = ai.model || ''; if (custom) { custom.style.display = 'none'; custom.value = ''; } }
        else { sel.value = '__custom__'; if (custom) { custom.style.display = ''; custom.value = ai.model || ''; } }
    }
    const ef = document.getElementById('pcAiEffort'); if (ef) ef.value = ai.effort || '';
    const key = document.getElementById('pcAiApiKey'); if (key) key.value = '';
    const clr = document.getElementById('pcAiApiKeyClear'); if (clr) clr.checked = false;
    const hint = document.getElementById('pcAiKeyHint');
    if (hint) hint.textContent = ai.apiKeySet ? `(guardada en el panel: ${ai.apiKeyHint})` : '(no hay key en el panel: se usa la de SSM si existe)';
    const rules = document.getElementById('pcAiExtraRules'); if (rules) rules.value = ai.extraRules || '';
    const st = document.getElementById('pcAiStatus');
    const e = ai.effective || {};
    if (st) {
        st.innerHTML =
            `<b>En uso ahora:</b> ${e.enabled ? '🟢 IA activa' : '⚪ IA apagada o sin key'} · modelo <code>${escapeHtml(e.model || '?')}</code> (${escapeHtml(e.modelSource || '')})` +
            ` · esfuerzo <code>${escapeHtml(e.effort || '')}</code> · key: ${escapeHtml(e.apiKeySource || '')}${e.apiKeyHint ? ' ' + escapeHtml(e.apiKeyHint) : ''}` +
            (ai.updatedBy ? `<br><span style="color:#777;">Último cambio: ${escapeHtml(ai.updatedBy)} · ${ai.updatedAt ? new Date(ai.updatedAt).toLocaleString('es-AR') : ''}</span>` : '');
    }
}

async function savePrivateAiConfig() {
    if (!_pcPassword) { showToast('Primero desbloqueá el sector', 'error'); return; }
    const sel = document.getElementById('pcAiModel');
    let model = sel ? sel.value : '';
    if (model === '__custom__') model = ((document.getElementById('pcAiModelCustom') || {}).value || '').trim();
    const ai = {
        enabled: !!(document.getElementById('pcAiEnabled') || {}).checked,
        model,
        effort: (document.getElementById('pcAiEffort') || {}).value || '',
        extraRules: (document.getElementById('pcAiExtraRules') || {}).value || ''
    };
    const keyVal = ((document.getElementById('pcAiApiKey') || {}).value || '').trim();
    if ((document.getElementById('pcAiApiKeyClear') || {}).checked) ai.apiKey = 'CLEAR';
    else if (keyVal) ai.apiKey = keyVal;
    if (!ai.enabled && !confirm('Vas a APAGAR la IA de comprobantes: no se detectarán duplicados ni habrá auto-carga hgcash por comprobante. ¿Confirmás?')) return;
    _pcStatus('pcAiSaveStatus', 'Guardando…', true);
    try {
        const r = await authFetch('/api/admin/private-config/ai', { method: 'POST', body: JSON.stringify({ password: _pcPassword, ai }) });
        const j = await _pcReadJson(r);
        if (!r.ok) { showToast(j.error || 'Error al guardar', 'error'); _pcStatus('pcAiSaveStatus', '❌ ' + (j.error || 'Error al guardar'), false); return; }
        showToast('Config de IA guardada', 'success');
        _pcStatus('pcAiSaveStatus', '✅ Guardado ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }), true);
        renderPrivateAiConfig(j.ai || {});
    } catch (e) { showToast('Error: ' + (e.message || 'conexión'), 'error'); _pcStatus('pcAiSaveStatus', '❌ ' + (e.message || 'Error de conexión'), false); }
}

// ---- Config privada → Auditoría + Telegram (#132) ----
function renderPrivateAuditConfig(a) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v === undefined || v === null) ? '' : v; };
    const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    chk('pcAuditEnabled', a.enabled !== false); chk('pcAuditRules', a.rulesEnabled !== false); chk('pcAuditRating', a.ratingEnabled !== false);
    set('pcAuditModel', a.model || ''); set('pcAuditEffort', a.effort || '');
    set('pcAuditIdle', a.idleMinutes); set('pcAuditMinScore', a.minScoreAlert); set('pcAuditRatingCooldown', a.ratingCooldownHours); set('pcAuditMaxPerTick', a.maxPerTick);
    set('pcAuditSessionGap', a.sessionGapMinutes);
    set('pcTgToken', ''); chk('pcTgTokenClear', false); set('pcTgChatId', a.telegramChatId || '');
    set('pcAuditExtraRules', a.extraRules || '');
    chk('pcLearnEnabled', a.learnEnabled !== false); set('pcLearnHour', a.learnHourART); set('pcLearnMinScore', a.learnMinScore); set('pcLearnMaxChats', a.learnMaxChats);
    loadLearnedContext();
    const th = document.getElementById('pcTgTokenHint'); if (th) th.textContent = a.telegramTokenSet ? `(guardado: ${a.telegramTokenHint})` : '(sin token en el panel)';
    const flags = document.getElementById('pcAuditFlags');
    if (flags) {
        const labels = { queja:'queja', mal_trato:'mal trato', sin_solucion:'sin solución', cliente_enojado:'cliente enojado', promesa_incumplida:'promesa incumplida', error_plata:'error de plata', respuesta_pobre:'respuesta pobre', demora:'demora', posible_fraude:'posible fraude', insulto_cliente:'insulto del cliente', mensaje_repetido:'mensaje repetido', sin_respuesta:'sin respuesta', cerrado_sin_responder:'cerrado sin responder' };
        flags.innerHTML = (a.allFlags || []).map(f => `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" class="pcAuditFlag" value="${f}" ${(a.alertFlags || []).includes(f) ? 'checked' : ''}> ${escapeHtml(labels[f] || f)}</label>`).join('');
    }
    const st = document.getElementById('pcAuditStatus');
    const e = a.effective || {};
    if (st) st.innerHTML = `<b>En uso ahora:</b> IA ${e.audit && e.audit.enabled ? '🟢' : '⚪'} <code>${escapeHtml((e.audit || {}).model || '')}</code> · Telegram ${e.telegram && e.telegram.enabled ? '🟢 conectado (chat ' + escapeHtml(e.telegram.chatId || '') + ')' : '⚪ sin configurar'} · proyecto <code>${escapeHtml(a.projectLabel || '')}</code>` +
        (a.updatedBy ? `<br><span style="color:#777;">Último cambio: ${escapeHtml(a.updatedBy)} · ${a.updatedAt ? new Date(a.updatedAt).toLocaleString('es-AR') : ''}</span>` : '');
}
async function savePrivateAuditConfig() {
    if (!_pcPassword) { showToast('Primero desbloqueá el sector', 'error'); return; }
    const v = (id) => (document.getElementById(id) || {}).value;
    const c = (id) => !!(document.getElementById(id) || {}).checked;
    const audit = {
        enabled: c('pcAuditEnabled'), rulesEnabled: c('pcAuditRules'), ratingEnabled: c('pcAuditRating'),
        model: v('pcAuditModel') || '', effort: v('pcAuditEffort') || '',
        idleMinutes: v('pcAuditIdle'), minScoreAlert: v('pcAuditMinScore'), ratingCooldownHours: v('pcAuditRatingCooldown'), maxPerTick: v('pcAuditMaxPerTick'),
        sessionGapMinutes: v('pcAuditSessionGap'),
        alertFlags: Array.from(document.querySelectorAll('.pcAuditFlag:checked')).map(x => x.value),
        extraRules: v('pcAuditExtraRules') || '',
        learnEnabled: c('pcLearnEnabled'), learnHourART: v('pcLearnHour'), learnMinScore: v('pcLearnMinScore'), learnMaxChats: v('pcLearnMaxChats'),
        telegramChatId: (v('pcTgChatId') || '').trim()
    };
    const tok = (v('pcTgToken') || '').trim();
    if (c('pcTgTokenClear')) audit.telegramBotToken = 'CLEAR'; else if (tok) audit.telegramBotToken = tok;
    _pcStatus('pcAuditSaveStatus', 'Guardando…', true);
    try {
        const r = await authFetch('/api/admin/private-config/audit', { method: 'POST', body: JSON.stringify({ password: _pcPassword, audit }) });
        const j = await _pcReadJson(r);
        if (!r.ok) { showToast(j.error || 'Error al guardar', 'error'); _pcStatus('pcAuditSaveStatus', '❌ ' + (j.error || 'Error al guardar'), false); return; }
        showToast('Auditoría guardada', 'success');
        _pcStatus('pcAuditSaveStatus', '✅ Guardado ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }), true);
        renderPrivateAuditConfig(j.audit || {});
    } catch (e) { showToast('Error: ' + (e.message || 'conexión'), 'error'); _pcStatus('pcAuditSaveStatus', '❌ ' + (e.message || 'Error de conexión'), false); }
}
// #148 Reembolsos: formato de fecha a JUGAYGANA + diagnóstico.
function renderPrivateRefundsConfig(r) {
    const sel = document.getElementById('pcRefundsFormat'); if (sel) sel.value = r.revenueDateFormat || '';
    const st = document.getElementById('pcRefundsStatus');
    if (st) st.innerHTML = `<b>En uso ahora:</b> <code>${escapeHtml(r.active || 'iso')}</code> (panel: ${escapeHtml(r.revenueDateFormat || '—')} · SSM: ${escapeHtml(r.env || '—')})` + (r.updatedBy ? `<br><span style="color:#777;">Último cambio: ${escapeHtml(r.updatedBy)} · ${r.updatedAt ? new Date(r.updatedAt).toLocaleString('es-AR') : ''}</span>` : '');
    const d = document.getElementById('pcRefDiagDate');
    if (d && !d.value) { const y = new Date(Date.now() - 86400000); d.value = y.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); }
}
async function savePrivateRefundsConfig() {
    if (!_pcPassword) { showToast('Primero desbloqueá el sector', 'error'); return; }
    const fmt = (document.getElementById('pcRefundsFormat') || {}).value || '';
    if (!confirm(`Vas a cambiar el formato de fecha con el que se calculan TODOS los reembolsos (diario/semanal/mensual y rango) a "${fmt || 'default'}". ¿Probaste con el diagnóstico que coincide con el panel de JUGAYGANA?`)) return;
    _pcStatus('pcRefundsSaveStatus', 'Guardando…', true);
    try {
        const j = await _pcPost('/api/admin/private-config/refunds', { revenueDateFormat: fmt });
        _pcStatus('pcRefundsSaveStatus', '✅ Guardado — activo: ' + (j.active || ''), true);
        showToast('Formato guardado', 'success');
    } catch (e) { _pcStatus('pcRefundsSaveStatus', '❌ ' + e.message, false); }
}
async function runRefundsDiagnostic() {
    if (!_pcPassword) { showToast('Primero desbloqueá el sector', 'error'); return; }
    const username = ((document.getElementById('pcRefDiagUser') || {}).value || '').trim();
    const date = (document.getElementById('pcRefDiagDate') || {}).value || '';
    const out = document.getElementById('pcRefDiagOut');
    if (!username || !date) { showToast('Usuario y día requeridos', 'error'); return; }
    out.innerHTML = '<div style="color:#aaa;font-size:12px;">Consultando JUGAYGANA con cada formato… (6 llamadas, puede tardar)</div>';
    try {
        const j = await _pcPost('/api/admin/private-config/refunds/diagnose', { username, date });
        const fmtMoney = (v) => v == null ? '—' : '$' + Number(v).toLocaleString('es-AR', { maximumFractionDigits: 2 });
        out.innerHTML = `<div style="font-size:12px;color:#aaa;margin-bottom:6px;">${escapeHtml(j.username)} (id JUGAYGANA ${escapeHtml(String(j.jugayganaUserId))}) · día ${escapeHtml(j.dayART)} hora Argentina (00:00–23:59). Compará la columna NETWIN con "Reportes globales → ese día" en el panel de JUGAYGANA.</div>
        <table class="data-table" style="width:100%;font-size:12px;"><thead><tr><th>Formato</th><th>Lo que se manda</th><th>HTTP</th><th>NETWIN</th><th>Apuestas</th><th>Ganancias</th></tr></thead><tbody>` +
        (j.results || []).map(r => `<tr style="${r.active ? 'background:rgba(212,175,55,.08);' : ''}"><td><code>${escapeHtml(r.format)}</code>${r.active ? ' <span style="color:#d4af37;">(activo)</span>' : ''}</td><td style="font-size:11px;color:#aaa;">${escapeHtml(JSON.stringify(r.sent))}</td><td>${escapeHtml(String(r.status || '—'))}</td><td style="font-weight:700;color:${r.ok ? '#25d366' : '#ff5050'};">${r.ok ? fmtMoney(r.netwin) : escapeHtml(r.error || 'error')}</td><td>${r.ok ? fmtMoney(r.bets) : '—'}</td><td>${r.ok ? fmtMoney(r.wins) : '—'}</td></tr>`).join('') + '</tbody></table>';
    } catch (e) { out.innerHTML = `<div style="color:#ff5050;font-size:12px;">❌ ${escapeHtml(e.message)}</div>`; }
}

// #146 Contexto aprendido: propuestas/dudas pendientes + doc + hechos.
async function _pcPost(path, body) {
    const r = await authFetch(path, { method: 'POST', body: JSON.stringify(Object.assign({ password: _pcPassword }, body || {})) });
    const j = await _pcReadJson(r);
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
}
async function loadLearnedContext() {
    if (!_pcPassword) return;
    const box = document.getElementById('pcLearnPending');
    try {
        const j = await _pcPost('/api/admin/private-config/audit/learned');
        const doc = document.getElementById('pcLearnedDoc'); if (doc) doc.value = j.doc || '';
        const facts = document.getElementById('pcLearnFacts'); if (facts) facts.textContent = j.facts || '(sin datos)';
        const last = (j.lastRuns || [])[0];
        _pcStatus('pcLearnStatus', last ? `Último análisis (${last.dayKey || ''}): ${new Date(last.at).toLocaleString('es-AR')} · ${last.sampled} chats · ${last.proposals} propuestas · ${last.questions} dudas — ${last.summary || ''}` : 'Todavía no corrió ningún análisis.', true);
        const pending = j.pending || [];
        if (!box) return;
        if (!pending.length) { box.innerHTML = '<div style="font-size:12.5px;color:#888;">Nada pendiente de confirmar. 🎉</div>'; return; }
        box.innerHTML = pending.map(p => p.kind === 'question'
            ? `<div style="border:1px solid rgba(212,175,55,.4);border-radius:8px;padding:8px;background:rgba(212,175,55,.06);">
                <div style="font-size:12.5px;"><b>❓ La IA pregunta:</b> ${escapeHtml(p.text)}</div>
                ${p.why ? `<div style="font-size:11px;color:#888;margin-top:2px;">Lo vio en: ${escapeHtml(p.why)}</div>` : ''}
                <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
                    <input type="text" id="pcAns-${p.id}" placeholder="Tu respuesta (ej: sí, es normal / no, eso no se hace porque…)" style="flex:1;min-width:220px;font-size:12px;">
                    <button class="btn-primary" style="font-size:11px;padding:3px 8px;" onclick="resolveLearned('${p.id}','answer')">Responder</button>
                    <button class="btn-secondary" style="font-size:11px;padding:3px 8px;" onclick="resolveLearned('${p.id}','reject')">Ignorar</button>
                </div></div>`
            : `<div style="border:1px solid rgba(0,255,136,.3);border-radius:8px;padding:8px;background:rgba(0,255,136,.04);">
                <div style="font-size:11px;color:#888;">💡 Propuesta de contexto${p.why ? ' · ' + escapeHtml(p.why) : ''}</div>
                <textarea id="pcProp-${p.id}" rows="2" style="width:100%;font-size:12.5px;font-family:inherit;margin-top:4px;">${escapeHtml(p.text)}</textarea>
                <div style="display:flex;gap:6px;margin-top:4px;">
                    <button class="btn-primary" style="font-size:11px;padding:3px 8px;" onclick="resolveLearned('${p.id}','accept')">✅ Confirmar</button>
                    <button class="btn-secondary" style="font-size:11px;padding:3px 8px;" onclick="resolveLearned('${p.id}','reject')">❌ No</button>
                </div></div>`).join('');
    } catch (e) { _pcStatus('pcLearnStatus', '❌ ' + e.message, false); }
}
async function resolveLearned(id, action) {
    if (!_pcPassword) return;
    const body = { action };
    if (action === 'accept') body.text = ((document.getElementById('pcProp-' + id) || {}).value || '').trim();
    if (action === 'answer') { body.answer = ((document.getElementById('pcAns-' + id) || {}).value || '').trim(); if (body.answer.length < 2) { showToast('Escribí la respuesta', 'error'); return; } }
    try {
        const j = await _pcPost('/api/admin/private-config/audit/learned/' + encodeURIComponent(id), body);
        if (action === 'answer') showToast(j.savedAs === 'regla' ? 'Guardado como REGLA: ' + (j.text || '') : 'Guardado como contexto', 'success');
        else showToast(action === 'accept' ? 'Agregado al contexto' : 'Descartado', 'success');
        loadLearnedContext();
        if (j.savedAs === 'regla') { try { const r = await _pcPost('/api/admin/private-config/unlock', { password: _pcPassword }); renderPrivateAuditConfig(r.audit || {}); } catch (_) {} }
    } catch (e) { showToast(e.message, 'error'); }
}
async function runLearnNow() {
    if (!_pcPassword) return;
    _pcStatus('pcLearnStatus', 'Analizando los chats bien evaluados de hoy… (puede tardar unos minutos si hubo muchos)', true);
    try {
        const j = await _pcPost('/api/admin/private-config/audit/learned/run');
        showToast(j.hasNews ? `${(j.proposals || []).length} propuesta(s) y ${(j.questions || []).length} duda(s)` : 'No hay nada nuevo para agregar', 'success');
        loadLearnedContext();
    } catch (e) { _pcStatus('pcLearnStatus', '❌ ' + e.message, false); }
}
async function saveLearnedDoc() {
    if (!_pcPassword) return;
    try {
        await _pcPost('/api/admin/private-config/audit/learned/doc', { doc: (document.getElementById('pcLearnedDoc') || {}).value || '' });
        _pcStatus('pcLearnDocStatus', '✅ Guardado', true);
    } catch (e) { _pcStatus('pcLearnDocStatus', '❌ ' + e.message, false); }
}

// #145 Enseñarle a la IA: reporte + corrección → regla general (vista previa) → base.
let _pcTeach = null;
async function teachAuditRule() {
    if (!_pcPassword) { showToast('Primero desbloqueá el sector', 'error'); return; }
    const report = ((document.getElementById('pcTeachReport') || {}).value || '').trim();
    const correction = ((document.getElementById('pcTeachCorrection') || {}).value || '').trim();
    if (correction.length < 5) { showToast('Escribí tu corrección', 'error'); return; }
    _pcStatus('pcTeachStatus', 'Pensando la regla…', true);
    document.getElementById('pcTeachPreview').classList.add('hidden');
    try {
        const r = await authFetch('/api/admin/private-config/audit/teach', { method: 'POST', body: JSON.stringify({ password: _pcPassword, report, correction }) });
        const j = await _pcReadJson(r);
        if (!r.ok) { _pcStatus('pcTeachStatus', '❌ ' + (j.error || 'Error'), false); return; }
        _pcTeach = Object.assign({ report, correction }, j);
        document.getElementById('pcTeachExplain').textContent = '💬 ' + (j.explicacion || '');
        document.getElementById('pcTeachRule').value = j.regla || '';
        const act = document.getElementById('pcTeachAction');
        if (j.accion === 'sin_cambio') act.textContent = 'ℹ️ La base ya cubre este caso; no hace falta agregar nada (podés guardar igual si querés forzar la regla).';
        else if (j.accion === 'reemplazar' && j.indice) act.textContent = `🔁 Reemplaza a la regla #${j.indice}: “${(j.reglasActuales || [])[j.indice - 1] || ''}”`;
        else act.textContent = `➕ Se agrega como regla #${(j.nuevasReglas || []).length} (la base queda con ${(j.nuevasReglas || []).length} reglas).`;
        document.getElementById('pcTeachPreview').classList.remove('hidden');
        _pcStatus('pcTeachStatus', '', true);
    } catch (e) { _pcStatus('pcTeachStatus', '❌ ' + (e.message || 'Error de conexión'), false); }
}
async function applyTeachRule() {
    if (!_pcPassword || !_pcTeach) return;
    const regla = ((document.getElementById('pcTeachRule') || {}).value || '').trim().replace(/\s+/g, ' ');
    if (!regla) { showToast('La regla quedó vacía', 'error'); return; }
    // Reconstruir la base con la regla (posiblemente retocada) en el lugar que propuso la IA.
    const base = (_pcTeach.reglasActuales || []).slice();
    if (_pcTeach.accion === 'reemplazar' && _pcTeach.indice && _pcTeach.indice <= base.length) base[_pcTeach.indice - 1] = regla;
    else base.push(regla);
    const nuevoTexto = base.map(x => '- ' + x).join('\n');
    _pcStatus('pcTeachStatus', 'Guardando…', true);
    try {
        const r = await authFetch('/api/admin/private-config/audit/teach/apply', { method: 'POST', body: JSON.stringify({ password: _pcPassword, nuevoTexto, accion: _pcTeach.accion, regla, report: _pcTeach.report, correction: _pcTeach.correction }) });
        const j = await _pcReadJson(r);
        if (!r.ok) { _pcStatus('pcTeachStatus', '❌ ' + (j.error || 'Error'), false); return; }
        showToast('Regla agregada a la base', 'success');
        _pcStatus('pcTeachStatus', '✅ Base actualizada (' + base.length + ' reglas)', true);
        document.getElementById('pcTeachPreview').classList.add('hidden');
        document.getElementById('pcTeachReport').value = ''; document.getElementById('pcTeachCorrection').value = '';
        _pcTeach = null;
        renderPrivateAuditConfig(j.audit || {});
    } catch (e) { _pcStatus('pcTeachStatus', '❌ ' + (e.message || 'Error de conexión'), false); }
}

async function testPrivateTelegram() {
    if (!_pcPassword) { showToast('Primero desbloqueá el sector', 'error'); return; }
    try {
        const r = await authFetch('/api/admin/private-config/telegram-test', { method: 'POST', body: JSON.stringify({ password: _pcPassword }) });
        const j = await _pcReadJson(r);
        if (!r.ok) { showToast(j.error || 'Falló', 'error'); _pcStatus('pcAuditSaveStatus', '❌ Telegram: ' + (j.error || 'falló'), false); return; }
        showToast('Mensaje de prueba enviado a Telegram', 'success');
        _pcStatus('pcAuditSaveStatus', '✅ Prueba enviada a Telegram', true);
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// ============================================
// AUDITORÍA DE ATENCIÓN (#132) — sección del panel
// ============================================
const AUDIT_FLAG_LABELS = { queja:'queja', mal_trato:'MAL TRATO', sin_solucion:'sin solución', cliente_enojado:'cliente enojado', promesa_incumplida:'promesa incumplida', error_plata:'ERROR DE PLATA', respuesta_pobre:'respuesta pobre', demora:'demora', posible_fraude:'posible fraude', insulto_cliente:'insulto del cliente', mensaje_repetido:'mensaje repetido', sin_respuesta:'SIN RESPUESTA', cerrado_sin_responder:'cerrado sin responder' };
function _auditDays() { return (document.getElementById('auditDays') || {}).value || '7'; }
function _scoreBadge(score) {
    if (score === null || score === undefined) return '<span style="background:#555;color:#fff;border-radius:8px;padding:1px 7px;font-size:11px;">regla</span>';
    const color = score <= 2 ? '#c0392b' : score <= 4 ? '#e67e22' : score <= 6 ? '#b7950b' : '#1e8449';
    return `<span style="background:${color};color:#fff;border-radius:8px;padding:1px 8px;font-weight:900;font-size:12px;">${score}/10</span>`;
}
function _flagChips(flags) {
    return (flags || []).map(f => `<span style="background:rgba(255,80,80,.18);border:1px solid rgba(255,80,80,.4);border-radius:8px;padding:1px 6px;font-size:10.5px;margin-right:4px;">${escapeHtml(AUDIT_FLAG_LABELS[f] || f)}</span>`).join('');
}
async function refreshAuditBadge() {
    try {
        const r = await authFetch('/api/admin/audit/agents?days=7');
        if (!r.ok) return;
        const j = await r.json();
        const un = (j.totals || []).reduce((n, t) => n + (t.unreviewed || 0), 0);
        const b = document.getElementById('auditBadge');
        if (b) { b.textContent = String(un); b.style.display = un > 0 ? '' : 'none'; }
    } catch (_) {}
}
async function loadAudit() {
    loadAuditAgents();
    loadAuditRatings();
    loadAuditList(1);
}
async function loadAuditAgents() {
    const body = document.getElementById('auditAgentsBody');
    const sum = document.getElementById('auditSummary');
    const st = document.getElementById('auditStatusLine');
    try {
        const r = await authFetch('/api/admin/audit/agents?days=' + _auditDays());
        const j = await r.json();
        if (!r.ok) { if (body) body.innerHTML = `<tr><td colspan="9" style="color:#888;text-align:center;">${escapeHtml(j.error || 'Sin acceso')}</td></tr>`; return; }
        if (st) st.textContent = (j.aiEnabled ? 'IA 🟢' : 'IA ⚪ apagada/sin key') + ' · ' + (j.telegram ? 'Telegram 🟢' : 'Telegram ⚪ (configurar en 🔐 Config privada)');
        const ai = (j.totals || []).find(t => t._id === 'ai') || {};
        const rules = (j.totals || []).find(t => t._id === 'rules') || {};
        const un = (j.totals || []).reduce((n, t) => n + (t.unreviewed || 0), 0);
        const tile = (label, val, color) => `<div style="background:var(--bg-secondary,#1a1a2e);border-radius:10px;padding:10px 14px;min-width:120px;"><div style="font-size:11px;color:#888;">${label}</div><div style="font-size:20px;font-weight:900;color:${color || '#fff'};">${val}</div></div>`;
        if (sum) sum.innerHTML = tile('Chats auditados (IA)', ai.n || 0) + tile('Puntaje promedio', ai.avgScore ? (Math.round(ai.avgScore * 10) / 10) : '-', ai.avgScore && ai.avgScore < 6 ? '#e67e22' : '#25d366') + tile('Alertas de reglas', rules.n || 0, '#e67e22') + tile('Pendientes de revisar', un, un ? '#ff5050' : '#25d366') + tile('👍 / 👎', `${(j.ratings || {}).up || 0} / ${(j.ratings || {}).down || 0}`, (j.ratings || {}).down ? '#ff5050' : '#25d366');
        if (!body) return;
        if (!(j.agents || []).length) { body.innerHTML = '<tr><td colspan="9" style="color:#888;text-align:center;">Todavía no hay auditorías con agente en este período.</td></tr>'; return; }
        body.innerHTML = j.agents.map(a => `<tr>
            <td><a href="#" onclick="document.getElementById('auditAgent').value='${escapeHtml(a.agent)}';loadAuditList(1);return false;">${escapeHtml(a.agent)}</a></td>
            <td>${a.chats}</td><td>${_scoreBadge(a.avgScore)}</td>
            <td style="color:${a.bad ? '#ff5050' : 'inherit'};">${a.bad}</td><td>${a.flagged}</td><td style="color:${a.malTrato ? '#ff5050' : 'inherit'};">${a.malTrato}</td><td>${a.sinSolucion}</td>
            <td style="color:#25d366;">${a.up}</td><td style="color:${a.down ? '#ff5050' : 'inherit'};">${a.down}</td></tr>`).join('');
    } catch (e) { if (body) body.innerHTML = '<tr><td colspan="9" style="color:#888;text-align:center;">Error de conexión</td></tr>'; }
}
async function loadAuditRatings() {
    const box = document.getElementById('auditRatingsBody');
    if (!box) return;
    try {
        const r = await authFetch('/api/admin/audit/ratings?days=' + _auditDays() + '&rating=down');
        const j = await r.json();
        const items = (j.items || []);
        if (!items.length) { box.innerHTML = '<div style="color:#888;font-size:12.5px;">Sin calificaciones negativas en el período. 🎉</div>'; return; }
        box.innerHTML = items.map(it => `<div style="border:1px solid rgba(255,80,80,.35);border-radius:10px;padding:10px;background:rgba(255,80,80,.06);${it.reviewed ? 'opacity:.6;' : ''}">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
                <div><b>👎 @${escapeHtml(it.username || it.userId)}</b> <span style="color:#888;font-size:11px;">${new Date(it.createdAt).toLocaleString('es-AR')}</span> ${it.agents && it.agents.length ? `<span style="font-size:11px;color:#aaa;">· atendió: ${escapeHtml(it.agents.join(', '))}</span>` : ''}</div>
                <div style="display:flex;gap:6px;">
                    <button class="btn-secondary" style="font-size:11px;padding:3px 8px;" onclick="selectConversation('${escapeHtml(it.userId)}','${escapeHtml(it.username || '')}');switchSection('chats')">Abrir chat</button>
                    ${it.reviewed ? `<span style="font-size:11px;color:#25d366;">✓ visto por ${escapeHtml(it.reviewedBy || '')}</span>` : `<button class="btn-primary" style="font-size:11px;padding:3px 8px;" onclick="reviewAuditRating('${escapeHtml(it.id)}')">Marcar visto</button>`}
                </div>
            </div>
            <div style="margin-top:6px;font-size:13px;">${it.comment ? '📝 “' + escapeHtml(it.comment) + '”' : (it.aiContext ? '<span style="color:#aaa;">🤖 Sin motivo del cliente — lo que vio la IA' + (it.aiScore != null ? ' (' + it.aiScore + '/10)' : '') + ':</span> ' + escapeHtml(it.aiContext) : '<span style="color:#888;">(sin motivo; la IA lo analiza a los 3 min)</span>')}</div>
        </div>`).join('');
    } catch (e) { box.innerHTML = '<div style="color:#888;">Error de conexión</div>'; }
}
async function loadAuditList(page) {
    const box = document.getElementById('auditListBody');
    const pag = document.getElementById('auditPagination');
    if (!box) return;
    window._auditPage = page || 1;
    const qs = new URLSearchParams({ days: _auditDays(), filter: (document.getElementById('auditFilter') || {}).value || 'unreviewed', page: String(window._auditPage) });
    const flag = (document.getElementById('auditFlag') || {}).value; if (flag) qs.set('flag', flag);
    const agent = ((document.getElementById('auditAgent') || {}).value || '').trim(); if (agent) qs.set('agent', agent);
    const user = ((document.getElementById('auditUser') || {}).value || '').trim(); if (user) qs.set('username', user);
    try {
        const r = await authFetch('/api/admin/audit/list?' + qs.toString());
        const j = await r.json();
        if (!r.ok) { box.innerHTML = `<div style="color:#888;">${escapeHtml(j.error || 'Sin acceso')}</div>`; return; }
        const fsel = document.getElementById('auditFlag');
        if (fsel && fsel.options.length <= 1 && j.flags) fsel.innerHTML = '<option value="">Cualquier bandera</option>' + j.flags.map(f => `<option value="${f}">${escapeHtml(AUDIT_FLAG_LABELS[f] || f)}</option>`).join('');
        const items = j.items || [];
        if (!items.length) { box.innerHTML = '<div style="color:#888;font-size:12.5px;">Nada para mostrar con este filtro.</div>'; if (pag) pag.innerHTML = ''; return; }
        box.innerHTML = items.map(it => `<div style="border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px;background:rgba(255,255,255,.02);${it.reviewed ? 'opacity:.6;' : ''}">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
                <div>${_scoreBadge(it.score)} <b>@${escapeHtml(it.username || it.userId)}</b> <span style="color:#888;font-size:11px;">${new Date(it.createdAt).toLocaleString('es-AR')} · ${it.source === 'ai' ? 'IA' : 'regla'}${it.alerted ? ' · 📨' : ''}</span>
                    ${it.agents && it.agents.length ? `<span style="font-size:11px;color:#aaa;">· ${escapeHtml(it.agents.join(', '))}${it.responsibleAgent ? ' (resp: ' + escapeHtml(it.responsibleAgent) + ')' : ''}</span>` : '<span style="font-size:11px;color:#ff5050;">· sin agente</span>'}</div>
                <div style="display:flex;gap:6px;">
                    <button class="btn-secondary" style="font-size:11px;padding:3px 8px;" onclick="selectConversation('${escapeHtml(it.userId)}','${escapeHtml(it.username || '')}');switchSection('chats')">Abrir chat</button>
                    ${it.reviewed ? `<span style="font-size:11px;color:${it.falsePositive ? '#aaa' : '#25d366'};">${it.falsePositive ? '❌ falso positivo' : '✓'} ${escapeHtml(it.reviewedBy || '')}${it.reviewNote ? ': ' + escapeHtml(it.reviewNote) : ''}</span>` : `<button class="btn-primary" style="font-size:11px;padding:3px 8px;" onclick="reviewAudit('${escapeHtml(it.id)}')">Marcar visto</button><button class="btn-secondary" style="font-size:11px;padding:3px 8px;" title="La IA se equivocó: la atención estaba bien. Sale del ranking." onclick="reviewAudit('${escapeHtml(it.id)}', true)">❌ Falso positivo</button>`}
                </div>
            </div>
            <div style="margin-top:6px;">${_flagChips(it.flags)}</div>
            <div style="margin-top:6px;font-size:13px;">${escapeHtml(it.summary || '')}</div>
            ${it.quote ? `<div style="margin-top:4px;font-size:12px;color:#aaa;">💬 “${escapeHtml(it.quote)}”</div>` : ''}
        </div>`).join('');
        if (pag) {
            let h = '';
            for (let p = 1; p <= Math.min(j.pages || 1, 20); p++) h += `<button class="btn-secondary" style="font-size:11px;padding:3px 8px;${p === j.page ? 'font-weight:900;border-color:#d4af37;' : ''}" onclick="loadAuditList(${p})">${p}</button>`;
            pag.innerHTML = (j.pages > 1 ? h : '') + `<span style="font-size:11px;color:#888;align-self:center;margin-left:6px;">${j.total} resultado(s)</span>`;
        }
    } catch (e) { box.innerHTML = '<div style="color:#888;">Error de conexión</div>'; }
}
async function reviewAudit(id, falsePositive) {
    const note = prompt(falsePositive ? '¿Por qué estaba bien? (ej: "retiro con bono, se explicó el rollover"). Sumá esa regla en Config privada → Reglas del negocio.' : 'Nota (opcional): qué se hizo / a quién se le habló', '');
    if (note === null) return;
    try {
        const r = await authFetch('/api/admin/audit/' + encodeURIComponent(id) + '/review', { method: 'POST', body: JSON.stringify({ note, falsePositive: !!falsePositive }) });
        if (!r.ok) { showToast('No se pudo marcar', 'error'); return; }
        loadAuditList(window._auditPage || 1); refreshAuditBadge();
    } catch (_) { showToast('Error de conexión', 'error'); }
}
async function reviewAuditRating(id) {
    try {
        const r = await authFetch('/api/admin/audit/ratings/' + encodeURIComponent(id) + '/review', { method: 'POST', body: '{}' });
        if (!r.ok) { showToast('No se pudo marcar', 'error'); return; }
        loadAuditRatings();
    } catch (_) { showToast('Error de conexión', 'error'); }
}

let smsAccessGranted = false;
// #130: la clave verificada se retiene en memoria y viaja en cada preview/envío
// (el server la exige). Si el server la rechaza, se vuelve a pedir.
let _smsPassword = null;
function _smsRelock(msg) {
    smsAccessGranted = false; _smsPassword = null;
    const c = document.getElementById('smsSectionContent'); if (c) c.classList.add('hidden');
    showToast(msg || 'Volvé a ingresar la clave del sector', 'error');
    showSmsPasswordModal();
}

function showSmsPasswordModal() {
    showModal('smsPasswordModal');
}

async function verifySmsAccessFromModal() {
    const password = document.getElementById('smsPasswordInput').value;

    if (!password) {
        showToast('Ingresa la contraseña', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/admin/verify-sms-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ password })
        });

        if (response.ok) {
            smsAccessGranted = true;
            _smsPassword = password;
            hideModal('smsPasswordModal');
            document.getElementById('smsPasswordInput').value = '';
            document.getElementById('smsSectionContent').classList.remove('hidden');
            showToast('Acceso concedido', 'success');
        } else {
            let msg = 'Clave incorrecta';
            try { const j = await response.json(); if (j && j.error) msg = j.error; } catch (_) {}
            showToast(msg, 'error');
        }
    } catch (error) {
        console.error('Error verifying SMS access:', error);
        showToast('Error al verificar acceso', 'error');
    }
}

// ============================================
// DATABASE SECTION — ELIMINADA (2026-07-09)
// Código muerto: la sección no tenía nav-item ni <section id="databaseSection">
// en el HTML (inalcanzable desde #79). Se borraron loadDatabaseUsers,
// renderDatabaseUsers, verifyDatabaseAccessFromModal, showDatabasePasswordModal,
// el modal databasePasswordModal y los endpoints del backend. Rollback: git revert.
// getRoleLabel se CONSERVA: la usan renderUsers y el detalle de usuario.
// ============================================

function getRoleLabel(role) {
    const labels = {
        user: 'Usuario',
        admin: 'Admin General',
        depositor: 'Admin Depositor',
        withdrawer: 'Admin Withdrawer',
        comunidad: 'Admin Comunidad'
    };
    return labels[role] || role;
}

// ============================================
// CREATE USER / ADMIN
// ============================================
function showCreateUserModal() {
    showModal('createUserModal');
}

async function handleCreateUser() {
    const username = document.getElementById('newUserUsername').value.trim();
    const password = document.getElementById('newUserPassword').value;
    const email = document.getElementById('newUserEmail').value.trim();
    const phone = document.getElementById('newUserPhone').value.trim();
    const role = document.getElementById('newUserRole').value;
    
    if (!username || !password) {
        showToast('Usuario y contraseña son requeridos', 'error');
        return;
    }
    
    if (password.length < 6) {
        showToast('La contraseña debe tener al menos 6 caracteres', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/users`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ username, password, email, phone, role })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast(data.message, 'success');
            hideModal('createUserModal');
            loadUsers();
            // Limpiar formulario
            document.getElementById('newUserUsername').value = '';
            document.getElementById('newUserPassword').value = '';
            document.getElementById('newUserEmail').value = '';
            document.getElementById('newUserPhone').value = '';
            document.getElementById('newUserRole').value = 'user';

            // Recién creado un CLIENTE: le generamos el link de acceso y lo
            // mostramos ya copiado, que es el paso siguiente del alta (el agente
            // se lo manda por WhatsApp). Solo admin general puede generarlo, y
            // nunca para cuentas de staff — el backend lo revalida igual.
            if (role === 'user' && currentAdmin?.role === 'admin' && data.user?.id) {
                await generateAutologinLink(data.user.id, data.user.username || username, { skipConfirm: true });
            }
        } else {
            showToast(data.error || 'Error al crear usuario', 'error');
        }
    } catch (error) {
        console.error('Error creating user:', error);
        showToast('Error al crear usuario', 'error');
    }
}

// ============================================
// COMMANDS MANAGEMENT
// ============================================
let commandsData = [];

async function loadCommands() {
    try {
        const response = await fetch(`${API_URL}/api/admin/commands`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load commands');
        
        const data = await response.json();
        commandsData = data.commands || [];
        // CORREGIDO: Actualizar availableCommands para las sugerencias
        availableCommands = commandsData.filter(cmd => cmd.isActive !== false);
        renderCommands(commandsData);
        
        // Cargar CBU
        loadCBUConfig();
    } catch (error) {
        console.error('Error loading commands:', error);
    }
}

function renderCommands(commands) {
    const container = document.getElementById('commandsList');
    
    if (!commands.length) {
        container.innerHTML = '<div class="empty-state">No hay comandos personalizados</div>';
        return;
    }
    
    container.innerHTML = commands.map(cmd => `
        <div class="command-card">
            <div class="command-info">
                <code class="command-name">${escapeHtml(cmd.name)}${cmd.isSystem ? ' 🔒' : ''}</code>
                <p class="command-desc">${escapeHtml(cmd.description || 'Sin descripción')}</p>
                <p class="command-response">${escapeHtml(cmd.response || 'Sin respuesta')}</p>
            </div>
            <div class="command-actions">
                <button class="btn-small" onclick="editCommand('${cmd.name}')">
                    <span class="icon icon-edit"></span>
                </button>
                ${cmd.isSystem ? '' : `<button class="btn-small btn-danger" onclick="deleteCommand('${cmd.name}')">
                    <span class="icon icon-trash"></span>
                </button>`}
            </div>
        </div>
    `).join('');
}

async function loadCBUConfig() {
    try {
        const response = await fetch(`${API_URL}/api/admin/cbu`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            document.getElementById('cbuBank').value = data.bank || '';
            document.getElementById('cbuTitular').value = data.titular || '';
            document.getElementById('cbuNumber').value = data.number || '';
            document.getElementById('cbuAlias').value = data.alias || '';
        }
    } catch (error) {
        console.error('Error loading CBU:', error);
    }
    
    // Cargar también la URL del Canal Informativo
    // Cargar la config de la Comunidad (Telegram)
    loadCommunityConfig();
    // Cargar la config del banco automático (hgcash)
    loadHgcashConfig();
    // Cargar los rangos de reembolso (solo admin general)
    loadRefundTiers();
    // Cargar los equipos por prefijo de usuario (solo admin general)
    loadTeams();
    // Cargar los bonos automáticos de las cargas hgcash (solo admin general)
    loadHgAppBonus();
    // Cargar los premios del fueguito (solo admin general)
    loadFireMilestones();
}

// ====== Bonos automáticos hgcash: app + notificaciones (solo admin general) ======
// Interruptores y % del bono de primera carga y del bono en todas las cargas
// automáticas. Config['hgcashAppBonus'] en el backend.
async function loadHgAppBonus() {
    const form = document.getElementById('hgAppBonusForm');
    const header = document.getElementById('hgAppBonusHeader');
    try {
        const r = await authFetch('/api/admin/hgcash/app-bonus');
        if (!r.ok) {
            // Sólo admin general: si no, se oculta la card entera.
            if (form) form.style.display = 'none';
            if (header) header.style.display = 'none';
            return;
        }
        if (form) form.style.display = '';
        if (header) header.style.display = '';
        const j = await r.json();
        const c = j.config || {};
        const fe = document.getElementById('hgAppBonusFirstEnabled');
        const fp = document.getElementById('hgAppBonusFirstPct');
        const ae = document.getElementById('hgAppBonusAllEnabled');
        const ap = document.getElementById('hgAppBonusAllPct');
        if (fe) fe.checked = c.firstEnabled !== false;
        if (fp) fp.value = c.firstPct || 100;
        if (ae) ae.checked = c.allEnabled !== false;
        if (ap) ap.value = c.allPct || 20;
        const until = document.getElementById('hgAppBonusUntil');
        if (until && j.promo20Until) {
            const d = new Date(j.promo20Until);
            until.textContent = d.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' (hora argentina)';
        }
    } catch (e) {
        console.error('Error cargando bonos hgcash:', e);
    }
}

async function saveHgAppBonus() {
    const msg = document.getElementById('hgAppBonusMsg');
    const pct = (id, fallback) => {
        const el = document.getElementById(id);
        const n = el ? Math.round(Number(el.value)) : NaN;
        return Number.isFinite(n) && n >= 1 && n <= 200 ? n : fallback;
    };
    const body = {
        firstEnabled: !!(document.getElementById('hgAppBonusFirstEnabled') || {}).checked,
        firstPct: pct('hgAppBonusFirstPct', 100),
        allEnabled: !!(document.getElementById('hgAppBonusAllEnabled') || {}).checked,
        allPct: pct('hgAppBonusAllPct', 20)
    };
    try {
        const r = await authFetch('/api/admin/hgcash/app-bonus', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Error al guardar');
        const c = j.config || body;
        if (msg) {
            msg.style.color = '#28a745';
            msg.textContent = `✅ Guardado — Primera carga: ${c.firstEnabled ? c.firstPct + '%' : 'APAGADO'} · Todas las cargas: ${c.allEnabled ? c.allPct + '%' : 'APAGADO'}`;
        }
        showToast('Bonos automáticos guardados', 'success');
        loadHgAppBonus();
    } catch (e) {
        if (msg) { msg.style.color = '#dc3545'; msg.textContent = '❌ ' + e.message; }
        showToast(e.message || 'Error al guardar bonos', 'error');
    }
}

// ====== Rangos de reembolso bronce/plata/oro (solo admin general) ======
// Reemplaza a los % fijos diario/semanal/mensual (2026-07-28).
// ============================================
// EQUIPOS (detección por el inicio del usuario)
// ============================================
// Cada equipo tiene prefijo + nombre + Telegram + WhatsApp. El SOPORTE no se
// divide por equipo (es uno solo para todos, se configura en Comunidad).

function _teamRowHtml(t) {
    t = t || {};
    const v = (x) => escapeHtml(String(x == null ? '' : x));
    return `
    <div class="team-row" style="border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:10px;margin-bottom:8px;background:rgba(0,0,0,.18);">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <div class="form-group" style="flex:0 0 130px;margin:0;">
                <label>Prefijo</label>
                <input type="text" class="team-prefix" value="${v(t.prefix)}" placeholder="mar" maxlength="20">
            </div>
            <div class="form-group" style="flex:1;min-width:150px;margin:0;">
                <label>Nombre del equipo</label>
                <input type="text" class="team-name" value="${v(t.name)}" placeholder="Marshall" maxlength="60">
            </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            <div class="form-group" style="flex:1;min-width:180px;margin:0;">
                <label>Telegram del equipo</label>
                <input type="text" class="team-telegram" value="${v(t.telegram)}" placeholder="https://t.me/...">
            </div>
            <div class="form-group" style="flex:1;min-width:150px;margin:0;">
                <label>WhatsApp del equipo</label>
                <input type="text" class="team-whatsapp" value="${v(t.whatsapp)}" placeholder="5491155551234">
            </div>
        </div>
        <button class="btn-danger" style="margin-top:8px;background:#dc3545;color:#fff;"
                onclick="this.closest('.team-row').remove()">🗑️ Quitar</button>
    </div>`;
}

function addTeamRow(t) {
    const cont = document.getElementById('teamsList');
    if (!cont) return;
    cont.insertAdjacentHTML('beforeend', _teamRowHtml(t));
}

async function loadTeams() {
    const form = document.getElementById('teamsForm');
    const header = document.getElementById('teamsHeader');
    try {
        const r = await authFetch('/api/admin/teams');
        if (!r.ok) {
            // Sólo admin general: si no, se oculta la card entera.
            if (form) form.style.display = 'none';
            if (header) header.style.display = 'none';
            return;
        }
        if (form) form.style.display = '';
        if (header) header.style.display = '';
        const j = await r.json();
        const g = j.general || {};
        const gt = document.getElementById('teamsGeneralTelegram');
        const gw = document.getElementById('teamsGeneralWhatsapp');
        if (gt) gt.value = g.telegram || '';
        if (gw) gw.value = g.whatsapp || '';
        const cont = document.getElementById('teamsList');
        if (cont) {
            cont.innerHTML = '';
            (j.list || []).forEach(t => addTeamRow(t));
        }
    } catch (e) {
        console.error('Error cargando equipos:', e);
    }
}

async function saveTeams() {
    const msg = document.getElementById('teamsMsg');
    const val = (row, cls) => {
        const el = row.querySelector('.' + cls);
        return el ? el.value.trim() : '';
    };

    const list = [];
    const vistos = new Set();
    let invalidos = 0;
    document.querySelectorAll('#teamsList .team-row').forEach(row => {
        const prefix = val(row, 'team-prefix').toLowerCase();
        if (!prefix) return;                       // fila vacía: se ignora
        // Mismo alfabeto que los usernames, o el prefijo nunca matchearía.
        if (!/^[a-z0-9._-]{1,20}$/.test(prefix)) { invalidos++; return; }
        if (vistos.has(prefix)) { invalidos++; return; }
        vistos.add(prefix);
        list.push({
            prefix,
            name: val(row, 'team-name') || prefix,
            telegram: val(row, 'team-telegram'),
            whatsapp: val(row, 'team-whatsapp')
        });
    });

    const general = {
        telegram: (document.getElementById('teamsGeneralTelegram') || {}).value || '',
        whatsapp: (document.getElementById('teamsGeneralWhatsapp') || {}).value || ''
    };

    try {
        const r = await authFetch('/api/admin/teams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ general, list })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Error al guardar');
        if (msg) {
            msg.style.color = '#28a745';
            msg.textContent = `✅ Guardado: ${j.list.length} equipo(s)` +
                (invalidos ? ` — ⚠️ ${invalidos} fila(s) ignorada(s) por prefijo inválido o repetido` : '');
        }
        showToast('Equipos guardados', 'success');
        loadTeams();
    } catch (e) {
        if (msg) { msg.style.color = '#dc3545'; msg.textContent = '❌ ' + e.message; }
        showToast(e.message || 'Error al guardar equipos', 'error');
    }
}

async function loadRefundTiers() {
    const form = document.getElementById('refundTiersForm');
    const header = document.getElementById('refundTiersHeader');
    try {
        const r = await authFetch('/api/admin/refund-tiers');
        if (!r.ok) {
            // Sólo admin general puede verlo: si no, ocultamos la card.
            if (form) form.style.display = 'none';
            if (header) header.style.display = 'none';
            return;
        }
        if (form) form.style.display = '';
        if (header) header.style.display = '';
        const j = await r.json();
        const t = j.tiers || {};
        const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
        set('tierBronceUpTo', t.bronce && t.bronce.upTo);
        set('tierBroncePct', t.bronce && t.bronce.percent);
        set('tierPlataUpTo', t.plata && t.plata.upTo);
        set('tierPlataPct', t.plata && t.plata.percent);
        set('tierOroPct', t.oro && t.oro.percent);
    } catch (e) {
        console.error('Error cargando rangos de reembolso:', e);
    }
}

async function saveRefundTiers() {
    const msg = document.getElementById('refundTiersMsg');
    const num = (id) => {
        const el = document.getElementById(id);
        return el ? el.value : '';
    };
    const body = {
        bronceUpTo: num('tierBronceUpTo'),
        broncePct: num('tierBroncePct'),
        plataUpTo: num('tierPlataUpTo'),
        plataPct: num('tierPlataPct'),
        oroPct: num('tierOroPct')
    };
    try {
        const r = await authFetch('/api/admin/refund-tiers', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        const j = await r.json();
        if (!r.ok) {
            if (msg) { msg.style.color = '#ff6b6b'; msg.textContent = j.error || 'No se pudo guardar.'; }
            return;
        }
        const t = j.tiers || {};
        const tb = t.bronce || {}, tp = t.plata || {}, to = t.oro || {};
        if (msg) {
            msg.style.color = '#00c853';
            msg.textContent = `✅ Guardado: 🥉 hasta $${tb.upTo} = ${tb.percent}% · 🥈 hasta $${tp.upTo} = ${tp.percent}% · 🥇 ${to.percent}%`;
        }
        showToast('Rangos de reembolso actualizados', 'success');
    } catch (e) {
        if (msg) { msg.style.color = '#ff6b6b'; msg.textContent = 'Error de conexión.'; }
    }
}

// ====== Premios del Fueguito (solo admin general) ======
async function loadFireMilestones() {
    const form = document.getElementById('fireMilestonesForm');
    const header = document.getElementById('fireMilestonesHeader');
    try {
        const r = await authFetch('/api/admin/fire-milestones');
        if (!r.ok) { // no admin general → ocultar
            if (form) form.style.display = 'none';
            if (header) header.style.display = 'none';
            return;
        }
        if (form) form.style.display = '';
        if (header) header.style.display = '';
        const j = await r.json();
        const body = document.getElementById('fireMilestonesRows');
        if (body) body.innerHTML = '';
        (j.milestones || []).forEach(m => addFireMilestoneRow(m));
        if (!(j.milestones || []).length) addFireMilestoneRow();
    } catch (e) {
        if (form) form.style.display = 'none';
        if (header) header.style.display = 'none';
    }
}

function addFireMilestoneRow(m) {
    const body = document.getElementById('fireMilestonesRows');
    if (!body) return;
    m = m || {};
    const tr = document.createElement('tr');
    const inp = (cls, val, ph, min) => '<input type="' + (cls === 'fm-desc' ? 'text' : 'number') + '" class="' + cls + '" value="' + (val != null ? String(val).replace(/"/g, '&quot;') : '') + '" ' + (min != null ? 'min="' + min + '"' : '') + ' placeholder="' + (ph || '') + '" style="width:100%;background:rgba(0,0,0,0.35);border:1px solid rgba(212,175,55,0.35);color:#fff;padding:5px 7px;border-radius:6px;font-size:12px;">';
    tr.innerHTML =
        '<td style="min-width:80px;">' + inp('fm-day', m.day, 'ej. 10', 1) + '</td>' +
        '<td style="min-width:100px;">' + inp('fm-reward', m.reward, 'ej. 10000', 0) + '</td>' +
        '<td style="min-width:110px;">' + inp('fm-req', m.requireDeposits, '0 = sin requisito', 0) + '</td>' +
        '<td style="min-width:80px;">' + inp('fm-days', m.depositDays != null ? m.depositDays : 30, '30', 1) + '</td>' +
        '<td style="min-width:160px;">' + inp('fm-desc', m.desc, 'descripción') + '</td>' +
        '<td><button onclick="this.closest(\'tr\').remove()" title="Quitar" style="background:#7a1010;color:#fff;border:none;border-radius:6px;padding:5px 9px;cursor:pointer;">✕</button></td>';
    body.appendChild(tr);
}

async function saveFireMilestones() {
    const msg = document.getElementById('fireMilestonesMsg');
    const rows = Array.from(document.querySelectorAll('#fireMilestonesRows tr'));
    const milestones = rows.map(tr => ({
        day: parseInt((tr.querySelector('.fm-day') || {}).value, 10) || 0,
        reward: Math.round(Number((tr.querySelector('.fm-reward') || {}).value) || 0),
        requireDeposits: Math.round(Number((tr.querySelector('.fm-req') || {}).value) || 0),
        depositDays: parseInt((tr.querySelector('.fm-days') || {}).value, 10) || 30,
        desc: ((tr.querySelector('.fm-desc') || {}).value || '').trim()
    })).filter(m => m.day > 0 && m.reward > 0);
    if (!milestones.length) { if (msg) { msg.style.color = '#ff6b6b'; msg.textContent = 'Cargá al menos un premio con día y monto.'; } return; }
    try {
        const r = await authFetch('/api/admin/fire-milestones', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ milestones })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (msg) { msg.style.color = '#ff6b6b'; msg.textContent = j.error || 'No se pudo guardar.'; } return; }
        if (msg) { msg.style.color = '#7CFC00'; msg.textContent = 'Premios guardados ✅ (' + (j.milestones || []).length + ' premios).'; }
        const body = document.getElementById('fireMilestonesRows');
        if (body) { body.innerHTML = ''; (j.milestones || []).forEach(m => addFireMilestoneRow(m)); }
        showToast('Premios del Fueguito actualizados', 'success');
    } catch (e) {
        if (msg) { msg.style.color = '#ff6b6b'; msg.textContent = 'Error de conexión.'; }
    }
}

async function loadHgcashConfig() {
    const form = document.getElementById('hgcashConfigForm');
    const movPanel = document.getElementById('hgcashMovementsPanel');
    try {
        const r = await authFetch('/api/admin/hgcash/config');
        if (!r.ok) {
            // Sólo admin general puede verlo: si no, ocultamos la card.
            if (form) form.style.display = 'none';
            if (movPanel) movPanel.style.display = 'none';
            return;
        }
        if (form) form.style.display = '';
        if (movPanel) movPanel.style.display = '';
        loadHgcashMovements(1);
        loadHgcashBalance();
        startHgcashLive();
        const j = await r.json();
        const c = j.config || {};
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        set('hgcashAccountName', c.accountName || '');
        set('hgcashCbu', c.cbu || '');
        set('hgcashMode', c.mode || 'shadow');
        set('hgcashWindow', c.windowMinutes || 60);
        const en = document.getElementById('hgcashEnabled');
        if (en) en.checked = !!c.enabled;
        const status = document.getElementById('hgcashStatusLine');
        if (status) {
            const parts = [];
            parts.push(c.enabled ? '🟢 Integración ACTIVA' : '⚪ Integración apagada');
            parts.push(c.mode === 'auto' ? 'modo AUTO (carga sola)' : 'modo SOMBRA (no carga)');
            parts.push(j.secretConfigured ? 'firma ✅' : 'firma ❌ (falta HGCASH_WEBHOOK_SECRET en SSM)');
            parts.push(j.aiEnabled ? 'IA ✅' : 'IA ❌ (falta ANTHROPIC_API_KEY)');
            status.innerHTML = parts.join(' · ') +
                '<br><span style="color:#888;">Webhook a configurar en hgcash: <code>https://vipcargas.com' + (j.webhookUrl || '/api/hgcash/webhook') + '</code></span>';
        }
    } catch (e) {
        if (form) form.style.display = 'none';
        if (movPanel) movPanel.style.display = 'none';
    }
}

// Etiquetas legibles + color para el estado de match de un movimiento.
function hgcashStatusBadge(st) {
    const map = {
        pending:        ['Pendiente', '#d4820a'],
        claiming:       ['Procesando', '#888'],
        shadow_matched: ['Match (sombra)', '#2a6df0'],
        auto_charged:   ['Cargado ✓', '#0f8a2f'],
        manual_charged: ['Cargado manual ✓', '#0f8a2f'],
        no_match:       ['Sin match', '#888'],
        ignored:        ['Saliente', '#666'],
        error:          ['Error', '#dc3545'],
        duplicate:      ['Duplicado (no cargado)', '#7a1010'],
        needs_review:   ['⚠️ Revisar (posible duplicado)', '#b5651d']
    };
    const [label, color] = map[st] || [st || '—', '#888'];
    return '<span style="background:' + color + ';color:#fff;border-radius:9px;padding:2px 8px;font-size:10.5px;white-space:nowrap;">' + escapeHtml(label) + '</span>';
}

async function loadHgcashMovements(page = 1) {
    const body = document.getElementById('hgcashMovBody');
    const pag = document.getElementById('hgcashMovPagination');
    if (!body) return;
    window._hgcashPage = page;
    const status = (document.getElementById('hgcashMovFilter') || {}).value || '';
    try {
        const qs = new URLSearchParams({ page: String(page) });
        if (status) qs.set('status', status);
        const r = await authFetch('/api/admin/hgcash/movements?' + qs.toString());
        if (!r.ok) { body.innerHTML = '<tr><td colspan="10" style="color:#888;text-align:center;">Sin acceso o sin datos</td></tr>'; return; }
        const j = await r.json();
        const movs = j.movements || [];
        if (!movs.length) {
            body.innerHTML = '<tr><td colspan="10" style="color:#888;text-align:center;">No hay movimientos</td></tr>';
            if (pag) pag.innerHTML = '';
            return;
        }
        body.innerHTML = movs.map(m => {
            const fecha = m.createdAt ? fmtFechaHoraAR(m.createdAt) : '—';
            const dir = m.direction === 'Inbound' ? '⬇️ Entra' : (m.direction === 'Outbound' ? '⬆️ Sale' : '—');
            const monto = m.amount != null ? '$' + Number(m.amount).toLocaleString('es-AR') : (m.amountRaw || '—');
            const origen = m.fromName || '—';
            const cbuOrigen = m.fromCBU || '—';
            const destino = m.toName || '—';
            const cbuDestino = m.toCBU || '—';
            // En pagos (Outbound) el usuario viene del payout (payoutUsername); en cargas (Inbound) del match.
            const usuario = m.matchedUsername ? '@' + m.matchedUsername : (m.payoutUsername ? '@' + m.payoutUsername : '—');
            const op = m.coelsaCode || m.externalId || '—';
            return '<tr>' +
                '<td style="white-space:nowrap;">' + escapeHtml(fecha) + '</td>' +
                '<td>' + escapeHtml(dir) + '</td>' +
                '<td style="white-space:nowrap;">' + escapeHtml(monto) + '</td>' +
                '<td>' + escapeHtml(origen) + '</td>' +
                '<td style="font-size:11px;">' + escapeHtml(cbuOrigen) + '</td>' +
                '<td>' + escapeHtml(destino) + '</td>' +
                '<td style="font-size:11px;">' + escapeHtml(cbuDestino) + '</td>' +
                '<td>' + hgcashStatusBadge(m.matchStatus) + (m.chargeError ? '<br><span style="color:#dc3545;font-size:10px;">' + escapeHtml(String(m.chargeError).slice(0,60)) + '</span>' : '') + '</td>' +
                '<td>' + escapeHtml(usuario) + '</td>' +
                '<td style="font-size:11px;">' + escapeHtml(op) + '</td>' +
                '</tr>';
        }).join('');
        if (pag) {
            const totalPages = j.totalPages || 1;
            const cur = j.page || 1;
            const mk = (label, target, disabled) => '<button onclick="loadHgcashMovements(' + target + ')" ' + (disabled ? 'disabled' : '') + ' style="padding:5px 11px;background:' + (disabled ? '#1a1a2e' : '#2a2a3a') + ';color:' + (disabled ? '#444' : '#fff') + ';border:none;border-radius:6px;cursor:' + (disabled ? 'not-allowed' : 'pointer') + ';font-size:12px;">' + label + '</button>';
            pag.innerHTML = totalPages > 1
                ? mk('« Anterior', cur - 1, cur <= 1) + '<span style="font-size:12px;color:#aaa;">Página ' + cur + ' de ' + totalPages + '</span>' + mk('Siguiente »', cur + 1, cur >= totalPages)
                : '';
        }
    } catch (e) {
        body.innerHTML = '<tr><td colspan="10" style="color:#888;text-align:center;">Error cargando movimientos</td></tr>';
    }
}

// ── Saldo en vivo + actualización en tiempo real del panel hgcash ──────────
async function loadHgcashBalance() {
    const el = document.getElementById('hgcashBalanceVal');
    if (!el) return;
    try {
        const r = await authFetch('/api/admin/hgcash/balance');
        if (!r.ok) { el.textContent = '—'; return; }
        const j = await r.json();
        if (!j.enabled) { el.textContent = 'integración apagada'; return; }
        if (!j.accounts || !j.accounts.length) { el.textContent = 's/cuentas'; return; }
        el.innerHTML = j.accounts.map(a => {
            const net = (a.netBalance != null ? a.netBalance : a.balance) || 0;
            const cur = a.currency || 'ARS';
            const nm = a.name ? (escapeHtml(a.name) + ': ') : '';
            const st = (a.status && !/operativa|operative|active/i.test(a.status)) ? ' <span style="color:#dc3545;">(' + escapeHtml(a.status) + ')</span>' : '';
            return nm + '<b>$' + Number(net).toLocaleString('es-AR') + '</b> ' + escapeHtml(cur) + st;
        }).join(' &nbsp;|&nbsp; ');
    } catch (e) { el.textContent = '—'; }
}

function _hgcashPanelVisible() {
    const sec = document.getElementById('commandsSection');
    const panel = document.getElementById('hgcashMovementsPanel');
    return !!(sec && sec.classList.contains('active') && panel && panel.style.display !== 'none');
}

// Limpia los pagos VIEJOS colgados (en proceso/fallidos de hace +2h): consulta hgcash y
// marca los ya pagados como pagados (en silencio) y descarta los fallidos. NO mueve plata
// ni avisa al cliente. Los que sigan realmente pendientes NO se tocan.
async function cleanupOldPayouts() {
    if (!confirm('¿Limpiar TODOS los pagos viejos (de hace más de 2 horas) para que dejen de aparecer en los chats?\n\n• Los que ya se pagaron quedan marcados como pagados (en silencio)\n• El resto se DESCARTA (sale de la cola)\n• NO mueve plata ni devuelve fichas')) return;
    try {
        const r = await authFetch('/api/admin/payouts/cleanup-old', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hours: 2 })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { showToast(j.error || 'No se pudo limpiar', 'error'); return; }
        if ((j.total || 0) === 0) { showToast('No había pagos viejos para limpiar ✅', 'success'); return; }
        showToast('Listo: ' + (j.cancelled || 0) + ' descartados' + (j.paid ? ', ' + j.paid + ' marcados pagados' : '') + ' (de ' + j.total + ' viejos). Recargá los chats.', 'success');
        // Refrescar el banner del chat abierto (si hay) para que desaparezca el pago viejo.
        if (typeof selectedUserId !== 'undefined' && selectedUserId && typeof loadPayoutBanner === 'function') loadPayoutBanner(selectedUserId);
    } catch (e) { showToast('Error al limpiar', 'error'); }
}

let _hgcashLiveTimer = null;
let _hgcashLiveThrottle = 0;
// Refresco en vivo: sólo si el panel está visible. El saldo se refresca siempre; los
// movimientos sólo si el agente está en la página 1 (no le reseteamos la vista si paginó).
function hgcashLiveRefresh(force) {
    if (!_hgcashPanelVisible()) return;
    const now = Date.now();
    if (!force && now - _hgcashLiveThrottle < 2500) return;
    _hgcashLiveThrottle = now;
    loadHgcashBalance();
    if ((window._hgcashPage || 1) === 1) loadHgcashMovements(1);
}
function startHgcashLive() {
    if (_hgcashLiveTimer) return;
    _hgcashLiveTimer = setInterval(() => hgcashLiveRefresh(true), 25000);
}

async function saveHgcashConfig() {
    const accountName = (document.getElementById('hgcashAccountName') || {}).value || '';
    const cbu = (document.getElementById('hgcashCbu') || {}).value || '';
    const mode = (document.getElementById('hgcashMode') || {}).value || 'shadow';
    const windowMinutes = parseInt((document.getElementById('hgcashWindow') || {}).value, 10) || 60;
    const enabled = !!(document.getElementById('hgcashEnabled') || {}).checked;
    if (enabled && !accountName.trim() && !cbu.trim()) {
        showToast('Para activar cargá al menos el NOMBRE de tu cuenta hgcash (o el CBU)', 'error');
        return;
    }
    if (enabled && mode === 'auto' && !confirm('Vas a activar la CARGA AUTOMÁTICA real (modo auto). Las transferencias que matcheen se van a acreditar solas. ¿Confirmás?')) {
        return;
    }
    try {
        const r = await authFetch('/api/admin/hgcash/config', {
            method: 'POST',
            body: JSON.stringify({ accountName: accountName.trim(), cbu: cbu.trim(), mode, windowMinutes, enabled })
        });
        const j = await r.json();
        if (r.ok && j.success) {
            showToast('Banco automático guardado', 'success');
            loadHgcashConfig();
        } else {
            showToast(j.error || 'Error al guardar', 'error');
        }
    } catch (e) {
        showToast('Error de conexión', 'error');
    }
}

async function saveCBUConfig() {
    const bank = document.getElementById('cbuBank').value.trim();
    const titular = document.getElementById('cbuTitular').value.trim();
    const number = document.getElementById('cbuNumber').value.trim();
    const alias = document.getElementById('cbuAlias').value.trim();
    
    if (!number) {
        showToast('El CBU es requerido', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/cbu`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ bank, titular, number, alias })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast('CBU guardado correctamente', 'success');
        } else {
            showToast(data.error || 'Error al guardar CBU', 'error');
        }
    } catch (error) {
        console.error('Error saving CBU:', error);
        showToast('Error al guardar CBU', 'error');
    }
}

// ELIMINADAS 2026-08-14: loadCanalUrlConfig() y saveCanalUrl(). El campo
// "Canal Informativo" salió del panel — el canal ahora se configura por EQUIPO
// (card "👥 Equipos") y el botón 📢 del cliente lo resuelve el backend con el
// mismo criterio. Los endpoints /api/admin/config y /api/admin/canal-url siguen
// existiendo en el server como fallback legacy. Rollback: git revert.

async function loadCommunityConfig() {
    try {
        const response = await fetch(`${API_URL}/api/config/community`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (response.ok) {
            const data = await response.json();
            // Solo el soporte: el canal se edita en la card de Equipos.
            const supportInput = document.getElementById('communitySupportUrl');
            if (supportInput) supportInput.value = data.supportUrl || '';
        }
    } catch (error) {
        console.error('Error loading community config:', error);
    }
}

async function saveCommunityConfig() {
    const supportInput = document.getElementById('communitySupportUrl');
    const supportUrl = supportInput ? supportInput.value.trim() : '';
    try {
        // Se manda SOLO supportUrl: el canal ya no se edita acá (vive en Equipos).
        // El backend conserva el channelUrl guardado cuando no viene en el body,
        // así este guardado no le borra el valor legacy a nadie.
        const response = await fetch(`${API_URL}/api/admin/community`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ supportUrl })
        });
        const data = await response.json();
        if (response.ok) {
            showToast('Comunidad guardada correctamente', 'success');
        } else {
            showToast(data.error || data.message || 'Error al guardar comunidad', 'error');
        }
    } catch (error) {
        console.error('Error saving community config:', error);
        showToast('Error al guardar comunidad', 'error');
    }
}

async function loadSoporteVip() {
    try {
        const response = await fetch(`${API_URL}/api/config/soporte-vip`);
        if (response.ok) {
            const data = await response.json();
            const tg = document.getElementById('soporteTelegramHandle');
            const wa = document.getElementById('soporteWhatsappNumber');
            if (tg) tg.value = (data.telegram && data.telegram.handle) || data.handle || '';
            if (wa) wa.value = (data.whatsapp && data.whatsapp.number) || '';
        }
    } catch (error) {
        console.error('Error loading soporte:', error);
    }
}

async function saveSoporteVip() {
    const tg = document.getElementById('soporteTelegramHandle');
    const wa = document.getElementById('soporteWhatsappNumber');
    const telegramHandle = tg ? tg.value.trim() : '';
    const whatsappNumber = wa ? wa.value.trim() : '';
    try {
        const response = await fetch(`${API_URL}/api/admin/soporte-vip`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ telegramHandle, whatsappNumber })
        });
        const data = await response.json();
        if (response.ok) {
            if (tg) tg.value = (data.telegram && data.telegram.handle) || '';
            if (wa) wa.value = (data.whatsapp && data.whatsapp.number) || '';
            showToast('Soporte guardado', 'success');
        } else {
            showToast(data.error || 'Error al guardar', 'error');
        }
    } catch (error) {
        console.error('Error saving soporte:', error);
        showToast('Error al guardar', 'error');
    }
}

function showCreateCommandModal() {
    document.getElementById('commandName').value = '/';
    document.getElementById('commandDesc').value = '';
    document.getElementById('commandResponse').value = '';
    document.getElementById('commandModalTitle').textContent = 'Nuevo Comando';
    document.getElementById('commandModalAction').onclick = handleCreateCommand;
    showModal('commandModal');
}

function editCommand(name) {
    const cmd = commandsData.find(c => c.name === name);
    if (!cmd) return;
    
    document.getElementById('commandName').value = cmd.name;
    document.getElementById('commandDesc').value = cmd.description || '';
    document.getElementById('commandResponse').value = cmd.response || '';
    document.getElementById('commandModalTitle').textContent = 'Editar Comando';
    document.getElementById('commandModalAction').onclick = handleUpdateCommand;
    showModal('commandModal');
}

async function handleCreateCommand() {
    const name = document.getElementById('commandName').value.trim();
    const description = document.getElementById('commandDesc').value.trim();
    const response = document.getElementById('commandResponse').value.trim();
    
    if (!name || !name.startsWith('/')) {
        showToast('El comando debe empezar con /', 'error');
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/api/admin/commands`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ name, description, response })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            showToast('Comando creado correctamente', 'success');
            hideModal('commandModal');
            loadCommands();
        } else {
            showToast(data.error || 'Error al crear comando', 'error');
        }
    } catch (error) {
        console.error('Error creating command:', error);
        showToast('Error al crear comando', 'error');
    }
}

async function handleUpdateCommand() {
    await handleCreateCommand(); // El endpoint es el mismo para crear/actualizar
}

async function deleteCommand(name) {
    if (!confirm(`¿Estás seguro de eliminar el comando ${name}?`)) return;
    
    try {
        const response = await fetch(`${API_URL}/api/admin/commands/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            showToast('Comando eliminado correctamente', 'success');
            loadCommands();
        } else {
            const data = await response.json();
            showToast(data.error || 'Error al eliminar comando', 'error');
        }
    } catch (error) {
        console.error('Error deleting command:', error);
        showToast('Error al eliminar comando', 'error');
    }
}

// Global functions for inline handlers
window.viewUser = async function(userId) {
    const body = document.getElementById('userDetailBody');
    if (body) body.innerHTML = '<p style="color:#888">Cargando...</p>';
    showModal('userDetailModal');
    try {
        const res = await fetch(`${API_URL}/api/users/${encodeURIComponent(userId)}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al obtener usuario');
        const u = data.user || {};
        const blocked = u.isBlocked
            ? `<span style="color:#dc3545;font-weight:700">SÍ</span>${u.blockReason ? ` — <em style="color:#aaa">${escapeHtml(u.blockReason)}</em>` : ''}`
            : '<span style="color:#16a34a">No</span>';
        const lastLogin = u.lastLogin ? formatDate(u.lastLogin) : 'Nunca';
        const created = u.createdAt ? formatDate(u.createdAt) : '-';
        if (body) {
            body.innerHTML = `
                <div style="display:grid;gap:.6rem;font-size:.92rem;line-height:1.4">
                    <div><strong>Username:</strong> ${escapeHtml(u.username || '-')}</div>
                    <div><strong>Email:</strong> ${escapeHtml(u.email || '-')}</div>
                    <div><strong>Teléfono:</strong> ${escapeHtml(u.phone || '-')}</div>
                    <div><strong>Rol:</strong> <span class="role-badge ${escapeHtml(u.role || 'user')}">${escapeHtml(getRoleLabel(u.role) || u.role || '-')}</span></div>
                    <div><strong>Balance:</strong> ${formatMoney(u.balance || 0)}</div>
                    <div><strong>N° de cuenta:</strong> ${escapeHtml(u.accountNumber || u.accountId || '-')}</div>
                    <div><strong>Estado:</strong> ${escapeHtml(u.status || '-')}</div>
                    <div><strong>Bloqueado:</strong> ${blocked}</div>
                    <div><strong>Origen:</strong> ${escapeHtml(u.source || 'local')}</div>
                    <div><strong>Debe cambiar contraseña:</strong> ${u.mustChangePassword ? 'Sí' : 'No'}</div>
                    <div><strong>Último login:</strong> ${escapeHtml(lastLogin)}</div>
                    <div><strong>Fecha creación:</strong> ${escapeHtml(created)}</div>
                    <div><strong>JUGAYGANA ID:</strong> ${escapeHtml(u.jugayganaUserId || '-')}</div>
                    <div><strong>Tokens FCM:</strong> ${(u.fcmTokens && u.fcmTokens.length) || 0}</div>
                </div>
            `;
        }
    } catch (e) {
        if (body) body.innerHTML = `<p style="color:#f87171">❌ ${escapeHtml(e.message || 'Error')}</p>`;
    }
};

window.chatUser = function(userId) {
    selectConversation(userId, 'Usuario');
    switchSection('chats');
};

window.editCommand = editCommand;
window.deleteCommand = deleteCommand;

// ============================================
// PWA - INSTALACIÓN DE APP EN ANDROID
// ============================================

// Detectar si la app ya está instalada
function checkAppInstalled() {
    if (window.matchMedia('(display-mode: standalone)').matches || 
        window.navigator.standalone === true) {
        isAppInstalled = true;
        return true;
    }
    return false;
}

// Inicializar PWA - Escuchar evento beforeinstallprompt
function initPWA() {
    
    // Verificar si ya está instalada
    if (checkAppInstalled()) {
        hideInstallButton();
        return;
    }
    
    // Escuchar evento beforeinstallprompt
    window.addEventListener('beforeinstallprompt', (e) => {
        // Prevenir que el navegador muestre el prompt automático
        e.preventDefault();
        // Guardar el evento para usarlo después
        deferredInstallPrompt = e;
        // Mostrar el botón de instalación
        showInstallButton();
    });
    
    // Escuchar cuando la app es instalada
    window.addEventListener('appinstalled', (e) => {
        isAppInstalled = true;
        hideInstallButton();
        deferredInstallPrompt = null;
        showToast('✅ App instalada correctamente', 'success');
    });
    
    // Verificar periódicamente si el botón debe mostrarse
    setTimeout(() => {
        if (!isAppInstalled && deferredInstallPrompt) {
            showInstallButton();
        }
    }, 2000);
}

// Mostrar botón de instalación
function showInstallButton() {
    const installBtn = document.getElementById('installAppBtn');
    if (installBtn && !isAppInstalled) {
        installBtn.classList.remove('hidden');
    }
}

// Ocultar botón de instalación
function hideInstallButton() {
    const installBtn = document.getElementById('installAppBtn');
    if (installBtn) {
        installBtn.classList.add('hidden');
    }
}

// Manejar click en botón de instalación
async function handleInstallApp() {
    
    if (!deferredInstallPrompt) {
        showToast('La instalación no está disponible en este momento', 'info');
        return;
    }
    
    // Mostrar el prompt de instalación
    deferredInstallPrompt.prompt();
    
    // Esperar la respuesta del usuario
    const { outcome } = await deferredInstallPrompt.userChoice;
    
    if (outcome === 'accepted') {
        isAppInstalled = true;
        hideInstallButton();
    } else {
    }
    
    // Limpiar el prompt guardado
    deferredInstallPrompt = null;
}

// ============================================
// NOTIFICACIONES PUSH - SERVICE WORKER
// ============================================

// Registrar Service Worker para notificaciones push
async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        return false;
    }
    
    try {
        const registration = await navigator.serviceWorker.register('/admin-sw.js', { scope: '/adminprivado2026/' });
        
        // Escuchar mensajes del service worker
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data.type === 'NEW_MESSAGE') {
                // Mostrar notificación local si la app está abierta
                showBrowserNotification(
                    event.data.title,
                    event.data.body,
                    event.data.icon
                );
            }
        });
        
        return registration;
    } catch (error) {
        console.error('❌ Error registrando Service Worker:', error);
        return false;
    }
}

// Solicitar permiso para notificaciones
async function requestPushPermission() {
    if (!('Notification' in window)) {
        return false;
    }
    
    const permission = await Notification.requestPermission();
    
    if (permission === 'granted') {
        await registerServiceWorker();
        return true;
    }
    return false;
}

// Enviar notificación push cuando el admin envía mensaje
async function sendPushNotification(userId, message) {
    try {
        const response = await fetch(`${API_URL}/api/admin/send-notification`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: userId,
                title: '💬 Nuevo mensaje del soporte',
                body: message.type === 'image' ? '📸 Imagen' : message.content.substring(0, 100),
                icon: '/icons/icon-192x192.png',
                badge: '/icons/icon-72x72.png',
                tag: `chat-${userId}`,
                requireInteraction: false,
                data: {
                    url: '/',
                    userId: userId
                }
            })
        });
        
        if (response.ok) {
        }
    } catch (error) {
        console.error('❌ Error enviando notificación push:', error);
    }
}

// Crear elemento de mensaje optimizado
function createMessageElement(message) {
    // Fix #3: Mensajes de sistema (ej. cierre de chat) con estilo propio.
    // Los INTERNOS (adminOnly: el cliente NUNCA los recibió — cierre de chat,
    // alertas de bonus, comprobante repetido, etc.) van en VERDE con etiqueta
    // "🔒 INTERNO"; los automáticos que el cliente SÍ recibió quedan naranjas
    // con 🤖 (antes llevaban 🔒, engañoso: parecían internos y el cliente los
    // había visto).
    if (message.type === 'system') {
        const isInternal = message.adminOnly === true;
        const div = document.createElement('div');
        div.className = 'message system' + (isInternal ? ' internal' : '');
        div.dataset.messageid = message.id || '';
        // Mostrar la hora de envío también en los mensajes automáticos,
        // para poder corroborar a qué horario se enviaron y controlar demoras.
        const time = formatChatTime(message.timestamp || new Date());
        const badge = isInternal ? '<div class="internal-badge">🔒 INTERNO — el cliente NO lo ve</div>' : '';
        const icon = isInternal ? '' : '<span class="icon icon-robot"></span> ';
        div.innerHTML = `${badge}<div class="message-content">${icon}<span>${escapeHtml(message.content)}</span></div><div class="message-time system-time">${time}</div>`;
        return div;
    }
    
    const isOutgoing = getMessageType(message) === 'outgoing';
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    msgDiv.dataset.messageid = message.id;
    
    const time = formatChatTime(message.timestamp || new Date());
    const content = formatMessageContent(message);

    msgDiv.innerHTML = `
        <div class="message-header">
            <span class="icon icon-user"></span>
            <span>${escapeHtml(message.senderUsername || 'Usuario')}</span>
        </div>
        <div class="message-content">${content}</div>
        <div class="message-time">${time}</div>
    `;

    const lightboxImg = msgDiv.querySelector('[data-lightbox-src]');
    if (lightboxImg) {
        const src = lightboxImg.dataset.lightboxSrc;
        lightboxImg.addEventListener('click', function() {
            openLightbox(src);
        });
    }
    
    return msgDiv;
}

// Inicializar PWA al cargar
document.addEventListener('DOMContentLoaded', () => {
    initPWA();
    
    // Configurar botón de instalación
    const installBtn = document.getElementById('installAppBtn');
    if (installBtn) {
        installBtn.addEventListener('click', handleInstallApp);
    }
});

// Exponer funciones globales
window.handleInstallApp = handleInstallApp;
window.requestPushPermission = requestPushPermission;
// ============================================
// PANEL DE NOTIFICACIONES PUSH
// Ruta: /adminprivado2026/ → nav item "Notificaciones"
// ============================================

let notifCurrentPage = 1;

async function loadNotificationsPanel() {
    const filter = document.getElementById('notifUserFilter')?.value || 'all';
    await Promise.all([
        loadNotifStats(),
        loadNotifUsers(1, filter),
        loadNotifStrategy(),
        loadSchedules(),
        loadTagBroadcastOptions(),
        loadNotifBatches() // #149 lotes con regalo
    ]);
    try { updateGiftBatchModeUI(); updateGiftBatchAudienceUI(); } catch (_) {}
}

// ===== Notificaciones programadas =====
function updateSchedFields() {
    const mode = document.getElementById('schedMode').value;
    document.getElementById('schedRunAt').style.display = (mode === 'once') ? '' : 'none';
    document.getElementById('schedTime').style.display = (mode === 'once') ? 'none' : '';
    document.getElementById('schedDow').style.display = (mode === 'weekly') ? '' : 'none';
}

async function loadSchedules() {
    const el = document.getElementById('schedList');
    if (!el) return;
    try {
        const res = await fetch(`${API_URL}/api/notifications/strategy/schedules`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error');
        renderSchedules(data.schedules || []);
    } catch (e) {
        el.innerHTML = '<p style="color:#dc3545;font-size:.85rem;">No se pudieron cargar las programaciones.</p>';
    }
}

function renderSchedules(list) {
    const el = document.getElementById('schedList');
    if (!list.length) {
        el.innerHTML = '<p style="color:#888;font-size:.85rem;">No hay notificaciones programadas.</p>';
        return;
    }
    // bono_50/bono_100 quedan solo como label para schedules viejos en la lista (ya no se pueden crear ni se envían).
    const TYPE_LABELS = { bono_50: 'Bono 50% (ELIMINADO)', bono_100: 'Bono 100% (ELIMINADO)', invitacion: 'Invitación a jugar', regalo: 'Regalo', reembolso: 'Reembolso' };
    const DOW = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    el.innerHTML = list.map(s => {
        let cuando;
        if (s.mode === 'once') {
            cuando = 'Una vez — ' + (s.runAt ? fmtFechaHoraAR(s.runAt) : '—');
        } else if (s.mode === 'daily') {
            cuando = 'Todos los días a las ' + s.time;
        } else {
            cuando = (DOW[s.dayOfWeek] || '?') + ' a las ' + s.time;
        }
        const last = s.lastResult ? `<div style="font-size:.72rem;color:#888;margin-top:.2rem;">Último: ${escapeHtml(s.lastResult)}</div>` : '';
        return `
        <div style="border:1px solid #333;border-radius:8px;padding:.6rem .8rem;margin-bottom:.5rem;display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap;">
            <div>
                <div style="color:#fff;font-size:.86rem;font-weight:600;">${TYPE_LABELS[s.type] || s.type} → ${escapeHtml(s.plan)}</div>
                <div style="font-size:.78rem;color:#aaa;">${escapeHtml(cuando)}${s.enabled ? '' : ' · (pausada)'}</div>
                ${last}
            </div>
            <div style="display:flex;gap:.4rem;">
                <button class="btn btn-sm btn-secondary" onclick="toggleSchedule('${s._id}', ${s.enabled ? 'false' : 'true'})">${s.enabled ? '⏸ Pausar' : '▶ Activar'}</button>
                <button class="btn btn-sm btn-secondary" style="color:#dc3545" onclick="deleteSchedule('${s._id}')">🗑</button>
            </div>
        </div>`;
    }).join('');
}

async function addSchedule() {
    const type = document.getElementById('schedType').value;
    const plan = document.getElementById('schedPlan').value;
    const mode = document.getElementById('schedMode').value;
    const body = { type, plan, mode };
    if (mode === 'once') {
        const v = document.getElementById('schedRunAt').value;
        if (!v) { showToast('Elegí la fecha y hora', 'error'); return; }
        body.runAt = v;
    } else {
        const t = document.getElementById('schedTime').value;
        if (!t) { showToast('Elegí la hora', 'error'); return; }
        body.time = t;
        if (mode === 'weekly') body.dayOfWeek = document.getElementById('schedDow').value;
    }
    try {
        const res = await fetch(`${API_URL}/api/notifications/strategy/schedules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error');
        showToast('Notificación programada', 'success');
        loadSchedules();
    } catch (e) {
        showToast(e.message || 'Error al programar', 'error');
    }
}

async function toggleSchedule(id, enabled) {
    try {
        const res = await fetch(`${API_URL}/api/notifications/strategy/schedules/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ enabled })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error');
        loadSchedules();
    } catch (e) {
        showToast(e.message || 'Error', 'error');
    }
}

async function deleteSchedule(id) {
    if (!confirm('¿Eliminar esta notificación programada?')) return;
    try {
        const res = await fetch(`${API_URL}/api/notifications/strategy/schedules/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error');
        showToast('Programación eliminada', 'success');
        loadSchedules();
    } catch (e) {
        showToast(e.message || 'Error', 'error');
    }
}

window.updateSchedFields = updateSchedFields;
window.addSchedule = addSchedule;
window.toggleSchedule = toggleSchedule;
window.deleteSchedule = deleteSchedule;

// ===== Estrategia de Notificaciones (plantillas editables) =====
async function loadNotifStrategy() {
    const container = document.getElementById('notifStrategyContainer');
    if (!container) return;
    try {
        const res = await fetch(`${API_URL}/api/notifications/templates`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!res.ok || !data.templates) throw new Error(data.error || 'Error');
        renderNotifStrategy(data.templates);
    } catch (e) {
        container.innerHTML = '<p style="color:#dc3545;font-size:.85rem;">No se pudieron cargar las plantillas.</p>';
    }
}

function renderNotifStrategy(templates) {
    const container = document.getElementById('notifStrategyContainer');
    container.innerHTML = templates.map(t => {
        const titleAttr = escapeHtml(t.title).replace(/"/g, '&quot;');
        const durationRow = t.hasDuration ? `
            <div style="margin-top:.5rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
                <label style="font-size:.8rem;color:#aaa;">Tiempo limitado (horas):</label>
                <input type="number" class="form-input tpl-duration" value="${t.durationHours}" min="1" style="width:90px;">
                <span style="font-size:.74rem;color:#888;">Podés usar {horas} en el texto.</span>
            </div>` : '';
        const limitsNote = (t.category && t.limits)
            ? `<div style="font-size:.74rem;color:#888;margin-top:.45rem;">Tope mensual — Suave: ${t.limits.suave} · Normal: ${t.limits.normal} · Activo: ${t.limits.activo}</div>`
            : `<div style="font-size:.74rem;color:#888;margin-top:.45rem;">Sin tope mensual (se envía a todo el plan).</div>`;
        return `
        <div class="notif-tpl-card" data-type="${t.type}" style="border:1px solid #333;border-radius:10px;padding:1rem;margin-bottom:1rem;">
            <div style="font-weight:700;color:#fff;margin-bottom:.6rem;">${escapeHtml(t.label)}</div>
            <input type="text" class="form-input tpl-title" placeholder="Título" maxlength="100" value="${titleAttr}">
            <textarea class="form-input tpl-body" rows="2" placeholder="Texto de la notificación" maxlength="500" style="margin-top:.5rem;resize:vertical;">${escapeHtml(t.body)}</textarea>
            ${durationRow}
            ${limitsNote}
            <div style="display:flex;gap:.5rem;margin-top:.7rem;flex-wrap:wrap;align-items:center;">
                <button class="btn btn-sm btn-secondary" onclick="saveNotifTemplate('${t.type}')">💾 Guardar</button>
                <button class="btn btn-sm btn-secondary" onclick="testNotifTemplate('${t.type}')">🧪 Probar</button>
                <select class="tpl-plan form-input" style="min-width:150px;">
                    <option value="suave">Plan Suave</option>
                    <option value="normal">Plan Normal</option>
                    <option value="activo">Plan Activo</option>
                    <option value="solo_reembolsos">Solo reembolsos</option>
                    <option value="todos">Todos</option>
                </select>
                <button class="btn btn-sm btn-primary" onclick="launchNotifTemplate('${t.type}')">🚀 Lanzar</button>
            </div>
        </div>`;
    }).join('');
}

function _notifCardData(type) {
    const card = document.querySelector(`.notif-tpl-card[data-type="${type}"]`);
    if (!card) return null;
    const durEl = card.querySelector('.tpl-duration');
    return {
        title: card.querySelector('.tpl-title').value.trim(),
        body: card.querySelector('.tpl-body').value.trim(),
        durationHours: durEl ? parseInt(durEl.value, 10) : undefined,
        plan: card.querySelector('.tpl-plan').value
    };
}

async function saveNotifTemplate(type, silent) {
    const d = _notifCardData(type);
    if (!d) return false;
    if (!d.title || !d.body) {
        showToast('Completá el título y el texto', 'error');
        return false;
    }
    try {
        const res = await fetch(`${API_URL}/api/notifications/templates/${type}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ title: d.title, body: d.body, durationHours: d.durationHours })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error');
        if (!silent) showToast('Plantilla guardada', 'success');
        return true;
    } catch (e) {
        showToast(e.message || 'Error guardando la plantilla', 'error');
        return false;
    }
}

async function testNotifTemplate(type) {
    const username = (document.getElementById('notifTestUser')?.value || '').trim();
    if (!username) { showToast('Escribí el usuario de prueba arriba', 'error'); return; }
    if (!(await saveNotifTemplate(type, true))) return;
    try {
        const res = await fetch(`${API_URL}/api/notifications/strategy/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ type, username })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error');
        showToast(data.message || 'Prueba enviada', data.successCount > 0 ? 'success' : 'error');
    } catch (e) {
        showToast(e.message || 'Error enviando la prueba', 'error');
    }
}

async function launchNotifTemplate(type) {
    const d = _notifCardData(type);
    if (!d) return;
    if (!confirm(`¿Lanzar esta notificación al plan "${d.plan}"?\n\nSe envía a todos los usuarios de ese plan que tengan la app instalada.`)) return;
    if (!(await saveNotifTemplate(type, true))) return;
    try {
        const res = await fetch(`${API_URL}/api/notifications/strategy/launch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ type, plan: d.plan })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error');
        let msg = `${data.message} — enviadas: ${data.successCount}`;
        if (data.skippedCap > 0) msg += ` · ${data.skippedCap} omitidos por tope del mes`;
        showToast(msg, 'success');
    } catch (e) {
        showToast(e.message || 'Error lanzando la notificación', 'error');
    }
}

window.saveNotifTemplate = saveNotifTemplate;
window.testNotifTemplate = testNotifTemplate;
window.launchNotifTemplate = launchNotifTemplate;

async function loadNotifStats() {
    try {
        const res = await fetch(`${API_URL}/api/notifications/users-status?page=1&limit=1&filter=all`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!data.success) return;
        const s = data.stats;
        document.getElementById('notifTotalUsers').textContent = s.totalUsers;
        document.getElementById('notifWithToken').textContent = s.usersWithToken;
        document.getElementById('notifWithoutToken').textContent = s.usersWithoutToken;
        document.getElementById('notifCoverage').textContent = s.coverage + '%';
    } catch (e) {
        console.error('[Notif Panel] Error cargando stats:', e);
    }
}

async function loadNotifUsers(page = 1, filter = 'all') {
    notifCurrentPage = page;
    const limit = 50;
    const listEl = document.getElementById('notifUsersList');
    const pagEl = document.getElementById('notifPagination');
    if (listEl) listEl.innerHTML = '<p style="color:#888;text-align:center">Cargando...</p>';

    try {
        const res = await fetch(`${API_URL}/api/notifications/users-status?page=${page}&limit=${limit}&filter=${filter}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!data.success) { if (listEl) listEl.innerHTML = '<p style="color:#f00">Error al cargar</p>'; return; }

        if (!data.users || data.users.length === 0) {
            if (listEl) listEl.innerHTML = '<p style="color:#888;text-align:center">No hay usuarios con este filtro</p>';
            if (pagEl) pagEl.innerHTML = '';
            return;
        }

        const rows = data.users.map(u => `
            <tr>
                <td style="padding:.5rem .75rem">${escapeHtml(u.username)}</td>
                <td style="padding:.5rem .75rem;text-align:center">
                    ${u.hasToken
                        ? '<span style="color:#00ff88;font-size:.85rem">📱 App instalada</span>'
                        : '<span style="color:#888;font-size:.85rem">📵 Sin app</span>'}
                </td>
                <td style="padding:.5rem .75rem;color:#888;font-size:.8rem">
                    ${u.tokenUpdatedAt ? fmtFechaAR(u.tokenUpdatedAt) : '—'}
                </td>
                <td style="padding:.5rem .75rem;color:#888;font-size:.8rem">
                    ${u.lastLogin ? fmtFechaAR(u.lastLogin) : '—'}
                </td>
            </tr>
        `).join('');

        if (listEl) listEl.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:.9rem">
                <thead>
                    <tr style="border-bottom:1px solid rgba(255,255,255,.1);color:#aaa;font-size:.8rem">
                        <th style="padding:.5rem .75rem;text-align:left">Usuario</th>
                        <th style="padding:.5rem .75rem;text-align:center">Estado App</th>
                        <th style="padding:.5rem .75rem;text-align:left">Token actualizado</th>
                        <th style="padding:.5rem .75rem;text-align:left">Último login</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;

        // Pagination: show prev, up to 5 pages around current, and next
        if (pagEl) {
            const totalPages = data.pagination.pages;
            let btns = '';
            if (page > 1) btns += `<button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(${page - 1}, '${filter}')">◀ Ant</button>`;
            const startPage = Math.max(1, page - 2);
            const endPage = Math.min(totalPages, page + 2);
            if (startPage > 1) btns += `<button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(1, '${filter}')">1</button><span style="color:#888;padding:.25rem .25rem">…</span>`;
            for (let i = startPage; i <= endPage; i++) {
                btns += `<button class="btn btn-sm ${i === page ? 'btn-primary' : 'btn-secondary'}" onclick="loadNotifUsers(${i}, '${filter}')">${i}</button>`;
            }
            if (endPage < totalPages) btns += `<span style="color:#888;padding:.25rem .25rem">…</span><button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(${totalPages}, '${filter}')">${totalPages}</button>`;
            if (page < totalPages) btns += `<button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(${page + 1}, '${filter}')">Sig ▶</button>`;
            pagEl.innerHTML = btns;
        }
    } catch (e) {
        console.error('[Notif Panel] Error cargando usuarios:', e);
        if (listEl) listEl.innerHTML = '<p style="color:#f00;text-align:center">Error al cargar usuarios</p>';
    }
}

async function sendBatchNotification(batchOffset) {
    const title = document.getElementById('notifTitle')?.value?.trim();
    const body = document.getElementById('notifBody')?.value?.trim();
    const segment = document.getElementById('notifSegment')?.value || 'all';
    const batchSize = parseInt(document.getElementById('notifBatchSize')?.value || '100');
    const offset = (batchOffset !== undefined) ? parseInt(batchOffset) : (parseInt(document.getElementById('notifBatchOffset')?.value || '0') || 0);

    if (!title || !body) {
        showToast('❌ El título y el mensaje son obligatorios', 'error');
        return;
    }

    let usernames = null;
    if (segment === 'specific') {
        const raw = document.getElementById('notifUsernames')?.value || '';
        usernames = raw.split(/[\n,]+/).map(u => u.trim()).filter(Boolean);
        if (usernames.length === 0) {
            showToast('❌ Ingresá al menos un username en "Usuarios específicos"', 'error');
            return;
        }
    }

    const sendBtn = document.getElementById('notifSendBtn');
    const nextBtn = document.getElementById('notifNextBatchBtn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⏳ Enviando...'; }
    if (nextBtn) nextBtn.disabled = true;

    const resultEl = document.getElementById('notifResult');
    const resultContent = document.getElementById('notifResultContent');
    if (resultEl) resultEl.style.display = 'none';

    try {
        const res = await fetch(`${API_URL}/api/notifications/send-batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ title, body, batchSize, segment, batchOffset: offset, usernames })
        });
        const data = await res.json();

        if (resultEl) resultEl.style.display = 'block';
        if (resultContent) {
            if (data.success) {
                // Segmento vacío: ningún usuario del segmento tiene la app /
                // token de notificaciones. Mostramos un aviso claro en vez de
                // una grilla de ceros con "Total del segmento: undefined".
                if (!data.totalSegmentUsers) {
                    resultContent.innerHTML = `<p style="color:#fbbf24">⚠️ ${escapeHtml(data.message || 'Ningún usuario de este segmento tiene la app instalada o un token de notificaciones activo.')}</p>`;
                    showToast('⚠️ No hay usuarios con notificaciones activas en este segmento', 'info');
                    const statusEl0 = document.getElementById('notifBatchStatus');
                    if (statusEl0) statusEl0.style.display = 'none';
                    if (nextBtn) nextBtn.style.display = 'none';
                    return;
                }
                const pct = data.totalUsers > 0 ? Math.round((data.successCount / data.totalUsers) * 100) : 0;
                const sentNames = data.sentUsernames && data.sentUsernames.length > 0
                    ? `<details style="margin-top:.5rem"><summary style="cursor:pointer;color:#aaa;font-size:.85rem">Ver usuarios enviados (${data.sentUsernames.length}${data.sentUsernames.length < data.totalUsers ? '+' : ''})</summary><div style="margin-top:.5rem;max-height:160px;overflow-y:auto;font-size:.8rem;color:#ccc">${data.sentUsernames.map(u => escapeHtml(u)).join(', ')}</div></details>` : '';
                resultContent.innerHTML = `
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1rem;margin-bottom:1rem">
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#00ff88">${data.successCount}</div><div style="color:#aaa;font-size:.8rem">Aceptados por FCM</div></div>
                        <div style="text-align:center" id="batchConfirmedCell"><div style="font-size:1.5rem;font-weight:700;color:#22d3ee" id="batchConfirmedNum">0</div><div style="color:#aaa;font-size:.8rem">Confirmados (entregados)</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#f87171">${data.failureCount}</div><div style="color:#aaa;font-size:.8rem">Fallidos</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#fbbf24">${data.cleanedTokens}</div><div style="color:#aaa;font-size:.8rem">Tokens limpiados</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#6366f1">${data.totalUsers}</div><div style="color:#aaa;font-size:.8rem">En este lote</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700">${pct}%</div><div style="color:#aaa;font-size:.8rem">Tasa FCM</div></div>
                    </div>
                    <div style="font-size:.82rem;color:#aaa;margin-bottom:.5rem">Total del segmento: <strong>${data.totalSegmentUsers}</strong> | Enviados hasta ahora: <strong>${data.nextOffset}</strong> | Faltan: <strong style="color:${data.remaining > 0 ? '#fbbf24' : '#00ff88'}">${data.remaining}</strong></div>
                    <div id="batchDeliveryStatus" style="font-size:.78rem;color:#aaa;margin-bottom:.5rem;font-style:italic">⏳ Esperando confirmaciones de entrega del cliente…</div>
                    ${sentNames}
                    ${data.failedTokens && data.failedTokens.length > 0 ? `
                    <details style="margin-top:.5rem">
                        <summary style="cursor:pointer;color:#aaa;font-size:.85rem">Ver tokens fallidos (${data.failedTokens.length})</summary>
                        <div style="margin-top:.5rem;max-height:200px;overflow-y:auto">
                        ${data.failedTokens.map(f => `<div style="font-size:.8rem;padding:.25rem 0;border-bottom:1px solid rgba(255,255,255,.05)"><strong>${escapeHtml(f.username)}</strong> — ${escapeHtml(f.error || '')} ${f.cleaned ? '<span style="color:#fbbf24">(token limpiado)</span>' : ''}</div>`).join('')}
                        </div>
                    </details>` : ''}
                `;
                showToast(`✅ FCM aceptó ${data.successCount} envíos. Esperando confirmaciones reales...`, 'success');

                // ============================================
                // POLLING DE CONFIRMACIONES DE ENTREGA REAL
                // ============================================
                // FCM aceptar != entregado. El SW del cliente confirma cuando
                // realmente recibe el push. Polleamos batch-status durante 30s
                // y mostramos el conteo real. Pasados 30s sin confirmación, los
                // usuarios "Aceptados pero no Confirmados" son sospechosos
                // (token muerto, app desinstalada, datos borrados).
                if (data.batchId && data.successCount > 0) {
                    const _batchIdLocal = data.batchId;
                    let _polls = 0;
                    const _maxPolls = 15; // 15 × 2s = 30s
                    const _pollInterval = setInterval(async function () {
                        _polls++;
                        try {
                            const stRes = await fetch(`${API_URL}/api/notifications/batch-status/${encodeURIComponent(_batchIdLocal)}`, {
                                headers: { 'Authorization': `Bearer ${currentToken}` }
                            });
                            if (!stRes.ok) {
                                clearInterval(_pollInterval);
                                return;
                            }
                            const st = await stRes.json();
                            const numEl = document.getElementById('batchConfirmedNum');
                            const statusEl = document.getElementById('batchDeliveryStatus');
                            if (numEl) numEl.textContent = String(st.confirmed);
                            if (statusEl) {
                                const pendingNow = Math.max(0, st.sent - st.confirmed);
                                if (_polls >= _maxPolls) {
                                    statusEl.innerHTML = pendingNow === 0
                                        ? `✅ Todos los envíos confirmados (${st.confirmed}/${st.sent}).`
                                        : `⚠️ ${pendingNow} de ${st.sent} sin confirmación tras 30s — probablemente con token muerto (app desinstalada o datos borrados). FCM los aceptó pero nunca llegaron al dispositivo.`;
                                    statusEl.style.color = pendingNow === 0 ? '#22d3ee' : '#fbbf24';
                                    statusEl.style.fontStyle = 'normal';
                                    clearInterval(_pollInterval);
                                } else {
                                    statusEl.innerHTML = `⏳ ${st.confirmed}/${st.sent} confirmados (poll ${_polls}/${_maxPolls})…`;
                                }
                            }
                            if (st.confirmed >= st.sent && _polls >= 2) {
                                if (statusEl) {
                                    statusEl.innerHTML = `✅ Todos los envíos confirmados (${st.confirmed}/${st.sent}).`;
                                    statusEl.style.color = '#22d3ee';
                                    statusEl.style.fontStyle = 'normal';
                                }
                                clearInterval(_pollInterval);
                            }
                        } catch (e) {
                            console.warn('[Notif Panel] poll batch-status error:', e && e.message);
                        }
                    }, 2000);
                }

                // Update next-batch state
                const statusEl = document.getElementById('notifBatchStatus');
                if (statusEl) {
                    if (data.remaining > 0) {
                        statusEl.style.display = 'block';
                        statusEl.innerHTML = `📊 Enviados: ${data.nextOffset} / ${data.totalSegmentUsers} del segmento | Faltan: <strong>${data.remaining}</strong>`;
                        if (nextBtn) { nextBtn.style.display = ''; nextBtn.dataset.nextOffset = data.nextOffset; }
                    } else {
                        statusEl.style.display = 'block';
                        statusEl.innerHTML = `✅ Segmento completo: ${data.nextOffset} / ${data.totalSegmentUsers} enviados`;
                        if (nextBtn) nextBtn.style.display = 'none';
                    }
                }
                if (document.getElementById('notifBatchOffset')) {
                    document.getElementById('notifBatchOffset').value = data.nextOffset;
                }

                // Reload stats and token list after sending (tokens may have been cleaned)
                loadNotificationsPanel();
            } else {
                resultContent.innerHTML = `<p style="color:#f87171">❌ Error: ${escapeHtml(data.error || 'Error desconocido')}</p>`;
                showToast('❌ Error al enviar notificaciones', 'error');
            }
        }
    } catch (e) {
        showToast('❌ Error de conexión al enviar notificaciones', 'error');
        console.error('[Notif Panel] Error enviando:', e);
    } finally {
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '🚀 Enviar lote'; }
        if (nextBtn) nextBtn.disabled = false;
    }
}

function sendNextBatch() {
    const nextBtn = document.getElementById('notifNextBatchBtn');
    const nextOffset = parseInt(nextBtn?.dataset.nextOffset || '0');
    sendBatchNotification(nextOffset);
}

function resetNotifBatch() {
    const offsetInput = document.getElementById('notifBatchOffset');
    if (offsetInput) offsetInput.value = '0';
    const nextBtn = document.getElementById('notifNextBatchBtn');
    if (nextBtn) { nextBtn.style.display = 'none'; delete nextBtn.dataset.nextOffset; }
    const statusEl = document.getElementById('notifBatchStatus');
    if (statusEl) statusEl.style.display = 'none';
    showToast('Lote reiniciado desde el principio', 'info');
}

function updateNotifNextBatchVisibility() {
    const mode = document.querySelector('input[name="notifMode"]:checked')?.value || 'batch';
    if (mode === 'all_app') return; // handled by updateNotifModeUI
    const segment = document.getElementById('notifSegment')?.value || 'all';
    const offsetDiv = document.getElementById('notifOffsetDiv');
    if (offsetDiv) offsetDiv.style.display = (segment !== 'specific') ? 'block' : 'none';
}

function updateNotifModeUI() {
    const mode = document.querySelector('input[name="notifMode"]:checked')?.value || 'batch';
    const batchControls = document.getElementById('notifBatchControls');
    const allAppControls = document.getElementById('notifAllAppControls');
    const modeInfo = document.getElementById('notifModeInfo');

    if (mode === 'all_app') {
        if (batchControls) batchControls.style.display = 'none';
        if (allAppControls) allAppControls.style.display = '';
        if (modeInfo) {
            modeInfo.style.display = 'block';
            modeInfo.textContent = '📱 Se enviará a todos los usuarios que tengan la app instalada, automáticamente por lotes de 200.';
        }
    } else {
        if (batchControls) batchControls.style.display = 'flex';
        if (allAppControls) allAppControls.style.display = 'none';
        if (modeInfo) modeInfo.style.display = 'none';
        updateNotifNextBatchVisibility();
    }
}

// Tamaño de lote del envío masivo "Todos con app".
// 100 es conservador (menor riesgo de timeout/504 en el ALB) y match con el modo lote manual.
const NOTIF_ALL_APP_BATCH_SIZE = 100;
// Pausa entre lotes: aliviana presión sobre Mongo, FCM y el ALB.
const NOTIF_ALL_APP_BATCH_DELAY_MS = 800;

function _notifSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Envía notificación a TODOS los usuarios con app, en lotes secuenciales.
 *
 * Reglas críticas:
 * - NO reintenta automáticamente lotes fallidos. Reintentar un lote que ya
 *   envió parcialmente duplicaría mensajes a usuarios que ya recibieron, lo
 *   cual es muy molesto. Si un lote falla, se detiene todo y se muestra al
 *   admin exactamente hasta dónde se llegó, dándole la opción manual de
 *   reanudar desde el siguiente lote (no se duplica) o reintentar el lote
 *   fallido (con confirm explícito y aviso de duplicación).
 * - Avanza usando data.nextOffset (que ya descuenta tokens limpiados gracias
 *   al fix de notificationRoutes.js). Eso garantiza que ningún usuario se
 *   saltee aunque haya cleanup de tokens muertos en el medio.
 * - Limpieza de tokens muertos la hace el endpoint /send-batch en backend.
 *
 * @param {number} startOffset - offset desde donde arrancar (0 por default,
 *   o un valor mayor si el admin pidió reanudar tras una falla previa).
 */
async function sendAllWithApp(startOffset = 0) {
    const title = document.getElementById('notifTitle')?.value?.trim();
    const body = document.getElementById('notifBody')?.value?.trim();
    if (!title || !body) {
        showToast('❌ El título y el mensaje son obligatorios', 'error');
        return;
    }

    // Confirmación al iniciar desde 0 (operación que puede tardar varios minutos)
    if (startOffset === 0) {
        if (!confirm('Vas a enviar a TODOS los usuarios con app instalada. Puede tardar varios minutos según la cantidad de usuarios. ¿Continuar?')) return;
    }

    const sendBtn = document.getElementById('notifSendAllBtn');
    const progressEl = document.getElementById('notifAllAppProgress');
    const resultEl = document.getElementById('notifResult');
    const resultContent = document.getElementById('notifResultContent');

    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⏳ Enviando...'; }
    if (progressEl) {
        progressEl.style.display = 'block';
        progressEl.textContent = startOffset === 0
            ? '🔄 Iniciando envío masivo...'
            : `🔄 Reanudando desde el usuario N° ${startOffset}...`;
    }

    let offset = startOffset;
    let totalSent = 0, totalFailed = 0, totalCleaned = 0, totalSegment = 0;
    let batchNum = 0;
    let failed = false, failedReason = '', failedAtOffset = null;
    const startedAt = Date.now();

    try {
        while (true) {
            batchNum++;
            const lblOffset = offset;
            if (progressEl) {
                progressEl.textContent = `🔄 Lote ${batchNum} (desde usuario N° ${lblOffset})...`;
            }

            // 1) Llamada al backend con manejo robusto de errores
            let response;
            try {
                response = await fetch(`${API_URL}/api/notifications/send-batch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
                    body: JSON.stringify({
                        title, body,
                        batchSize: NOTIF_ALL_APP_BATCH_SIZE,
                        segment: 'all',
                        batchOffset: offset
                    })
                });
            } catch (networkErr) {
                // Error de red: la request puede haber llegado al server o no, no podemos saberlo.
                // No reintentamos para no duplicar.
                failed = true;
                failedAtOffset = offset;
                failedReason = `Error de red: ${networkErr.message || networkErr}`;
                console.error('[Notif Panel] Network error en lote', batchNum, networkErr);
                break;
            }

            if (!response.ok) {
                failed = true;
                failedAtOffset = offset;
                let errMsg = `HTTP ${response.status}`;
                try {
                    const errData = await response.json();
                    if (errData && errData.error) errMsg += ` — ${errData.error}`;
                } catch (_) { /* respuesta no es JSON parseable */ }
                failedReason = errMsg;
                break;
            }

            let data;
            try {
                data = await response.json();
            } catch (jsonErr) {
                failed = true;
                failedAtOffset = offset;
                failedReason = 'Respuesta del servidor inválida (no es JSON)';
                break;
            }

            if (!data.success) {
                failed = true;
                failedAtOffset = offset;
                failedReason = data.error || 'El servidor reportó fallo sin detalle';
                break;
            }

            // 2) Lote OK: contabilizar resultados
            totalSent += data.successCount || 0;
            totalFailed += data.failureCount || 0;
            totalCleaned += data.cleanedTokens || 0;
            totalSegment = data.totalSegmentUsers || totalSegment;

            if (progressEl) {
                progressEl.textContent =
                    `✅ Lote ${batchNum} OK — Enviados acumulados: ${totalSent} | ` +
                    `Tokens limpiados: ${totalCleaned} | Faltan: ${data.remaining}`;
            }

            // 3) Verificar fin del segmento
            if (!data.remaining || data.remaining <= 0) {
                break;
            }

            // 4) Avanzar al próximo offset confirmado por el server (ya descuenta limpiados)
            offset = data.nextOffset;

            // 5) Pausa entre lotes para no saturar
            await _notifSleep(NOTIF_ALL_APP_BATCH_DELAY_MS);
        }
    } catch (e) {
        failed = true;
        failedReason = `Error inesperado: ${e.message || e}`;
        console.error('[Notif Panel] Error inesperado en sendAllWithApp:', e);
    } finally {
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '📤 Enviar a TODOS con app'; }
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

    // 6) Render del resultado final
    if (resultEl) resultEl.style.display = 'block';
    if (resultContent) {
        const headerHtml = failed
            ? `<div style="margin-bottom:.75rem;padding:.7rem 1rem;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.4);border-radius:8px;color:#fca5a5">
                 ⚠️ <strong>Envío detenido en el lote ${batchNum}</strong> (offset ${failedAtOffset}) tras ${elapsedSec}s.<br>
                 <span style="font-size:.85rem">Motivo: ${escapeHtml(failedReason)}</span>
               </div>`
            : `<div style="margin-bottom:.75rem;padding:.7rem 1rem;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.4);border-radius:8px;color:#86efac">
                 ✅ <strong>Envío completo</strong> en ${batchNum} lotes (${elapsedSec}s)
               </div>`;

        const statsHtml = `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1rem">
                <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#00ff88">${totalSent}</div><div style="color:#aaa;font-size:.8rem">Enviados</div></div>
                <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#f87171">${totalFailed}</div><div style="color:#aaa;font-size:.8rem">Fallos individuales</div></div>
                <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#fbbf24">${totalCleaned}</div><div style="color:#aaa;font-size:.8rem">Tokens limpiados</div></div>
                <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#6366f1">${totalSegment}</div><div style="color:#aaa;font-size:.8rem">Total con app</div></div>
                <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700">${batchNum}</div><div style="color:#aaa;font-size:.8rem">Lotes ejecutados</div></div>
            </div>`;

        let resumeHtml = '';
        if (failed && failedAtOffset !== null) {
            const resumeOffset = failedAtOffset + NOTIF_ALL_APP_BATCH_SIZE;
            resumeHtml = `
                <div style="margin-top:1rem;padding:.85rem 1rem;background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.3);border-radius:8px;font-size:.88rem;line-height:1.45">
                    <div style="margin-bottom:.5rem;color:#e0e0e0">
                        <strong>El lote en offset ${failedAtOffset} NO se reintentó automáticamente</strong> para evitar duplicar mensajes a usuarios que ya hayan recibido.
                    </div>
                    <div style="margin-bottom:.7rem;color:#cbd5e1">Tenés dos opciones para continuar:</div>
                    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                        <button class="btn btn-primary btn-sm" onclick="resumeSendAllWithApp(${resumeOffset})" style="background:linear-gradient(135deg,#059669,#10b981)">
                            ▶ Reanudar desde usuario N° ${resumeOffset} (recomendado)
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="retrySendAllWithApp(${failedAtOffset})">
                            🔁 Reintentar el lote fallido (offset ${failedAtOffset})
                        </button>
                    </div>
                    <div style="margin-top:.6rem;color:#aaa;font-size:.78rem;line-height:1.4">
                        ⚠️ <strong>Reanudar</strong> avanza al siguiente lote: cero riesgo de duplicar, pero si el lote ${failedAtOffset} alcanzó a enviar a algunos usuarios antes de fallar, esos usuarios ya recibieron y los demás del mismo lote se saltarán.<br>
                        ⚠️ <strong>Reintentar</strong> el lote fallido vuelve a procesar los 100 usuarios desde offset ${failedAtOffset}: usalo solo si estás seguro de que el lote NO alcanzó a enviar nada (ej. error de red antes de llegar al server).
                    </div>
                </div>`;
        }

        resultContent.innerHTML = headerHtml + statsHtml + resumeHtml;
    }

    if (progressEl) {
        progressEl.textContent = failed
            ? `❌ Detenido en lote ${batchNum} (offset ${failedAtOffset}). Enviados hasta ahora: ${totalSent}.`
            : `✅ Envío completo: ${totalSent} enviados a usuarios con app.`;
    }

    if (!failed) {
        showToast(`✅ Enviado a ${totalSent} usuarios con app`, 'success');
    } else {
        showToast(`⚠️ Envío detenido en lote ${batchNum}. ${totalSent} enviados hasta ahora.`, 'warning');
    }

    loadNotificationsPanel();
}

// Reanuda el envío masivo desde un offset específico (sin reintentar el lote fallido).
function resumeSendAllWithApp(offset) {
    sendAllWithApp(offset);
}

// Reintenta el lote fallido (puede duplicar mensajes — requiere confirm explícito).
function retrySendAllWithApp(offset) {
    if (!confirm(
        `¿Reintentar el lote en offset ${offset}?\n\n` +
        `⚠️ ATENCIÓN: si el lote llegó a enviar a algunos usuarios antes de fallar, ` +
        `esos usuarios van a recibir el mensaje DOS VECES. ` +
        `Solo confirmá si estás seguro de que el lote no alcanzó a enviar nada ` +
        `(por ejemplo, si fue un error de red antes de llegar al servidor).`
    )) return;
    sendAllWithApp(offset);
}

async function cleanInvalidTokens() {
    if (!confirm('¿Verificar y limpiar tokens inválidos? Esto enviará una notificación de prueba silenciosa a cada usuario con token. Puede tardar unos minutos.')) return;

    const btn = document.querySelector('button[onclick="cleanInvalidTokens()"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Verificando...'; }

    try {
        const res = await fetch(`${API_URL}/api/notifications/verify-tokens`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ sendTest: false })
        });
        const data = await res.json();
        if (data.success) {
            const r = data.results;
            showToast(`🧹 Verificación completada: ${r.valid} válidos, ${r.invalid} inválidos, ${r.cleaned} limpiados`, 'success');
            loadNotificationsPanel();
        } else {
            showToast('❌ Error en verificación de tokens', 'error');
        }
    } catch (e) {
        showToast('❌ Error de conexión', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🧹 Limpiar tokens inválidos'; }
    }
}

// Mostrar/ocultar campo de usuarios específicos según segmento seleccionado
document.addEventListener('DOMContentLoaded', () => {
    const segmentSelect = document.getElementById('notifSegment');
    if (segmentSelect) {
        segmentSelect.addEventListener('change', () => {
            const specificDiv = document.getElementById('notifSpecificUsers');
            if (specificDiv) specificDiv.style.display = segmentSelect.value === 'specific' ? 'block' : 'none';
            updateNotifNextBatchVisibility();
        });
    }

    // Inicializar UI de modo de notificaciones
    updateNotifModeUI();

    // Búsqueda de usuarios en la sección Usuarios
    const searchUsersInput = document.getElementById('searchUsers');
    if (searchUsersInput) {
        searchUsersInput.addEventListener('input', debounce(() => {
            filterAndRenderUsers();
        }, 300));
    }
});

// Exponer funciones del panel de notificaciones al scope global (usadas por onclick)
window.loadNotificationsPanel = loadNotificationsPanel;
window.loadNotifUsers = loadNotifUsers;
window.sendBatchNotification = sendBatchNotification;
window.sendNextBatch = sendNextBatch;
window.resetNotifBatch = resetNotifBatch;
window.cleanInvalidTokens = cleanInvalidTokens;
window.updateNotifModeUI = updateNotifModeUI;
window.sendAllWithApp = sendAllWithApp;
window.resumeSendAllWithApp = resumeSendAllWithApp;
window.retrySendAllWithApp = retrySendAllWithApp;
window.applyDatosRange = applyDatosRange;

// =============================================
// PANEL DE REFERIDOS - ADMIN
// =============================================

function escHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtARS(n) {
    return '$' + new Intl.NumberFormat('es-AR').format(Math.round(n || 0));
}

function fmtDate(d) {
    if (!d) return '—';
    return fmtFechaAR(d) || '—';
}

function fmtPeriod(pk) {
    if (!pk) return '—';
    const [y, m] = pk.split('-');
    return `${m}/${y}`;
}

// Cached referrers for client-side quick filters
let cachedReferrers = [];

async function loadAdminReferralSummary() {
    const container = document.getElementById('referralTopList');
    const summaryContainer = document.getElementById('referralGlobalSummary');
    if (!container) return;
    container.innerHTML = '<span style="color:#888;">Cargando...</span>';
    // Always load payouts independently
    loadAdminReferralPayouts();
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/summary`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!res.ok) { container.innerHTML = '<span style="color:#ff4444;">Error cargando datos.</span>'; return; }
        const data = await res.json();
        const referrers = data.data?.topReferrers || [];
        const summary = data.data?.summary || {};

        // Cache for quick filters
        cachedReferrers = referrers;

        // Render global dashboard cards
        if (summaryContainer) {
            const card = (value, label, color, bg) =>
                `<div style="background:${bg};border:1px solid ${color}33;border-radius:10px;padding:14px 10px;text-align:center;">
                    <div style="font-size:22px;font-weight:bold;color:${color};">${value}</div>
                    <div style="font-size:11px;color:#888;margin-top:4px;">${label}</div>
                 </div>`;
            summaryContainer.innerHTML =
                card(summary.totalReferrers || 0, 'Referidores activos', '#d4af37', 'rgba(212,175,55,0.05)') +
                card(summary.totalReferred || 0, 'Usuarios referidos', '#00ff88', 'rgba(0,255,136,0.05)') +
                card(fmtARS(summary.totalHistoricalPaid || 0), 'Total pagado', '#00ff88', 'rgba(0,255,136,0.05)') +
                card(fmtARS(summary.totalPending || 0), 'Pendiente de pago', '#f7931e', 'rgba(247,147,30,0.05)') +
                card(fmtARS(summary.totalGenerated || 0), 'Total generado', '#b0b0b0', 'rgba(255,255,255,0.03)') +
                card(summary.totalPayouts || 0, 'Pagos realizados', '#888', 'rgba(255,255,255,0.03)') +
                card(fmtARS(summary.currentPeriodPending || 0), `Pendiente ${summary.currentPeriodKey || ''}`, '#f7931e', 'rgba(247,147,30,0.05)');
        }

        if (referrers.length === 0) {
            container.innerHTML = '<span style="color:#888;">No hay referidores activos todavía.</span>';
            return;
        }

        renderReferrersTable(referrers);
    } catch (e) {
        container.innerHTML = '<span style="color:#ff4444;">Error: ' + e.message + '</span>';
    }
}

/**
 * Render the referrers table with an optional client-side filter.
 * filter: 'all' | 'pending' | 'failed'
 */
function renderReferrersTable(referrers) {
    const container = document.getElementById('referralTopList');
    if (!container) return;

    if (referrers.length === 0) {
        container.innerHTML = '<span style="color:#888;">No hay referidores que coincidan con el filtro.</span>';
        return;
    }

    const payoutStatusBadge = (status) => {
        if (!status) return '<span style="color:#444;font-size:10px;">—</span>';
        if (status === 'paid') return '<span style="background:rgba(0,255,136,0.12);border:1px solid rgba(0,255,136,0.35);color:#00ff88;font-size:10px;border-radius:4px;padding:2px 6px;">✅ Pagado</span>';
        if (status === 'failed') return '<span style="background:rgba(255,68,68,0.12);border:1px solid rgba(255,68,68,0.35);color:#ff4444;font-size:10px;border-radius:4px;padding:2px 6px;">❌ Fallido</span>';
        if (status === 'pending') return '<span style="background:rgba(247,147,30,0.12);border:1px solid rgba(247,147,30,0.35);color:#f7931e;font-size:10px;border-radius:4px;padding:2px 6px;">⏳ Pendiente</span>';
        return `<span style="color:#888;font-size:10px;">${escHtml(status)}</span>`;
    };

    container.innerHTML = `
    <div style="overflow-x:auto;">
    <table id="referrersTableEl" style="width:100%;border-collapse:collapse;min-width:780px;">
        <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);">
            <th style="padding:7px 6px;">Usuario</th>
            <th style="padding:7px 6px;">Código</th>
            <th style="padding:7px 6px;text-align:center;">Referidos</th>
            <th style="padding:7px 6px;text-align:right;">Total Pagado</th>
            <th style="padding:7px 6px;text-align:right;">Pendiente</th>
            <th style="padding:7px 6px;text-align:right;">Total Generado</th>
            <th style="padding:7px 6px;">Último Pago</th>
            <th style="padding:7px 6px;">Último Estado</th>
            <th style="padding:7px 6px;">Acciones</th>
        </tr></thead>
        <tbody>
        ${referrers.map(r => {
            const fs = r.financialStats || {};
            const hasPending = (fs.totalPendingCommission || 0) > 0;
            return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                <td style="padding:7px 6px;color:#fff;font-weight:bold;">${r.username}${r.excludedFromReferral ? ' <span style="color:#ff4444;font-size:10px;">EXCLUIDO</span>' : ''}</td>
                <td style="padding:7px 6px;color:#d4af37;letter-spacing:2px;font-size:12px;">${r.referralCode || '—'}</td>
                <td style="padding:7px 6px;color:#00ff88;font-weight:bold;text-align:center;">${r.totalReferreds}</td>
                <td style="padding:7px 6px;color:#00ff88;text-align:right;">${fmtARS(fs.totalSettledCommission || 0)}</td>
                <td style="padding:7px 6px;text-align:right;">
                    <span style="color:${hasPending?'#f7931e':'#888'};font-weight:${hasPending?'bold':'normal'};">${fmtARS(fs.totalPendingCommission || 0)}</span>
                    ${hasPending ? '<span style="color:#f7931e;font-size:10px;margin-left:4px;">●</span>' : ''}
                </td>
                <td style="padding:7px 6px;color:#b0b0b0;text-align:right;">${fmtARS(fs.totalGenerated || 0)}</td>
                <td style="padding:7px 6px;color:#888;font-size:11px;">${fs.lastPayoutDate ? fmtFechaAR(fs.lastPayoutDate) : '—'}</td>
                <td style="padding:7px 6px;">${payoutStatusBadge(fs.latestPayoutStatus)}</td>
                <td style="padding:7px 6px;"><button onclick="loadAdminUserReferrals('${r.id}')" style="background:rgba(212,175,55,0.1);border:1px solid #d4af37;color:#d4af37;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;">Ver detalle</button></td>
            </tr>`;
        }).join('')}
        </tbody>
    </table>
    </div>`;
}

/**
 * Filter the referrers table client-side (no extra API call).
 * mode: 'all' | 'pending' | 'failed'
 */
function filterReferrersTable(mode) {
    // Highlight active filter button
    ['referralFilterAll', 'referralFilterPending', 'referralFilterFailed'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.style.opacity = '0.5';
        btn.style.fontWeight = 'normal';
    });
    const activeId = mode === 'pending' ? 'referralFilterPending' : mode === 'failed' ? 'referralFilterFailed' : 'referralFilterAll';
    const activeBtn = document.getElementById(activeId);
    if (activeBtn) { activeBtn.style.opacity = '1'; activeBtn.style.fontWeight = 'bold'; }

    if (!cachedReferrers.length) return;

    let filtered = cachedReferrers;
    if (mode === 'pending') {
        filtered = cachedReferrers.filter(r => (r.financialStats?.totalPendingCommission || 0) > 0);
    } else if (mode === 'failed') {
        filtered = cachedReferrers.filter(r => r.financialStats?.latestPayoutStatus === 'failed');
    }
    renderReferrersTable(filtered);
}

async function loadAdminReferralPayouts() {
    const container = document.getElementById('referralPayoutList');
    if (!container) return;
    container.innerHTML = '<span style="color:#888;font-size:12px;">Cargando...</span>';
    try {
        const statusFilter = document.getElementById('referralPayoutFilterStatus')?.value || '';
        const deltaFilter = document.getElementById('referralPayoutFilterDelta')?.value || '';
        const periodFilter = document.getElementById('referralPayoutFilterPeriod')?.value?.trim() || '';
        const usernameFilter = document.getElementById('referralPayoutFilterUsername')?.value?.trim() || '';
        const params = new URLSearchParams({ limit: 100 }); // 100 payouts to support period-grouped display (multiple payouts per referrer/period)
        if (statusFilter) params.append('status', statusFilter);
        if (deltaFilter) params.append('isDelta', deltaFilter);
        if (periodFilter && /^\d{4}-\d{2}$/.test(periodFilter)) params.append('period', periodFilter);
        if (usernameFilter) params.append('username', usernameFilter);

        const res = await fetch(`${API_URL}/api/referrals/admin/payouts?${params}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!res.ok) {
            container.innerHTML = '<span style="color:#ff4444;font-size:12px;">Error cargando historial de pagos.</span>';
            return;
        }
        const data = await res.json();
        const payouts = data.data?.payouts || [];
        if (payouts.length === 0) {
            container.innerHTML = '<span style="color:#888;padding:12px;display:block;">No hay pagos registrados para los filtros aplicados.</span>';
            return;
        }

        const statusBadge = (s, isDelta, idx) => {
            const color = s === 'paid' ? '#00ff88' : s === 'failed' ? '#ff4444' : '#f7931e';
            const label = s === 'paid' ? '✅ Pagado' : s === 'failed' ? '❌ Fallido' : '⏳ Pendiente';
            const seqLabel = idx > 1 || isDelta
                ? `<span style="background:rgba(212,175,55,0.15);border:1px solid rgba(212,175,55,0.4);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 5px;margin-left:5px;">Δ pago #${idx}</span>`
                : '';
            return `<span style="color:${color};font-size:11px;">${label}</span>${seqLabel}`;
        };

        // Group by period for sectioned display
        const byPeriod = new Map();
        for (const p of payouts) {
            const key = p.periodKey || '?';
            if (!byPeriod.has(key)) byPeriod.set(key, []);
            byPeriod.get(key).push(p);
        }

        let html = '';
        for (const [pk, periodPayouts] of byPeriod) {
            const periodLabel = periodPayouts[0].periodLabel || pk;
            const periodTotal = periodPayouts.filter(p => p.status === 'paid').reduce((s, p) => s + (p.totalCommissionAmount || 0), 0);
            const hasMultiple = periodPayouts.some(p => (p.payoutIndex || 1) > 1 || p.isDelta);

            html += `
            <div style="margin-bottom:16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(212,175,55,0.15);">
                    <span style="color:#d4af37;font-weight:bold;font-size:13px;">📅 ${escHtml(periodLabel)}</span>
                    <div style="display:flex;align-items:center;gap:10px;">
                        ${hasMultiple ? '<span style="background:rgba(212,175,55,0.1);border:1px solid rgba(212,175,55,0.3);color:#d4af37;font-size:10px;border-radius:4px;padding:2px 7px;">múltiples pagos</span>' : ''}
                        <span style="color:#888;font-size:11px;">Total acreditado: <strong style="color:#00ff88;">${fmtARS(periodTotal)}</strong></span>
                    </div>
                </div>
                <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;min-width:600px;">
                    <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.08);">
                        <th style="padding:6px 6px;">Referidor</th>
                        <th style="padding:6px 6px;text-align:right;">Monto Acreditado</th>
                        <th style="padding:6px 6px;text-align:center;">Referidos</th>
                        <th style="padding:6px 6px;">Estado / Liquidación</th>
                        <th style="padding:6px 6px;">Fecha Pago</th>
                        <th style="padding:6px 6px;font-size:10px;">ID</th>
                    </tr></thead>
                    <tbody>
                    ${periodPayouts.map(p => {
                        const rowBg = p.isDelta || (p.payoutIndex || 1) > 1 ? 'background:rgba(212,175,55,0.02);' : '';
                        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);${rowBg}">
                            <td style="padding:6px 6px;color:#fff;font-weight:bold;">
                                ${escHtml(p.referrerUsername)}
                                <button onclick="loadAdminUserReferrals('${escHtml(p.referrerUserId || '')}');document.getElementById('referralUserDetail')?.scrollIntoView({behavior:'smooth'})"
                                    style="background:none;border:1px solid rgba(212,175,55,0.4);color:#d4af37;padding:1px 6px;border-radius:4px;cursor:pointer;font-size:10px;margin-left:5px;">detalle</button>
                            </td>
                            <td style="padding:6px 6px;color:#d4af37;font-weight:bold;text-align:right;">${fmtARS(p.totalCommissionAmount || 0)}</td>
                            <td style="padding:6px 6px;color:#00ff88;text-align:center;">${p.referralCount || 0}</td>
                            <td style="padding:6px 6px;">${statusBadge(p.status, p.isDelta, p.payoutIndex || 1)}</td>
                            <td style="padding:6px 6px;color:#888;font-size:11px;">${p.creditedAt ? fmtFechaHoraAR(p.creditedAt) : '—'}</td>
                            <td style="padding:6px 6px;color:#444;font-size:10px;font-family:monospace;">${(p.id || '').substring(0, 8)}…</td>
                        </tr>`;
                    }).join('')}
                    </tbody>
                </table>
                </div>
            </div>`;
        }

        container.innerHTML = `
            <div style="color:#888;font-size:11px;margin-bottom:12px;">
                ${payouts.length} pago(s) — ordenado por período más reciente
            </div>
            ${html}`;
    } catch (e) {
        container.innerHTML = '<span style="color:#ff4444;font-size:12px;">Error cargando historial de pagos.</span>';
    }
}

async function loadAdminUserReferrals(userId) {
    const detailPanel = document.getElementById('referralUserDetail');
    const detailContent = document.getElementById('referralUserDetailContent');
    if (detailPanel) detailPanel.style.display = 'block';
    if (detailContent) detailContent.innerHTML = '<span style="color:#888;">Cargando detalle...</span>';
    // Scroll to detail
    if (detailPanel) detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/users/${userId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!res.ok) {
            if (detailContent) detailContent.innerHTML = '<span style="color:#ff4444;">Error cargando detalle del referidor.</span>';
            return;
        }
        const data = await res.json();
        const d = data.data;
        const u = d.user;
        const fs = d.financialSummary || {};

        const referredRows = (d.referredUsers || []).map(ru => `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                <td style="padding:5px 6px;color:#fff;">${ru.username}</td>
                <td style="padding:5px 6px;color:#b0b0b0;font-size:11px;">${fmtDate(ru.referredAt)}</td>
                <td style="padding:5px 6px;">
                    <span style="color:${ru.referralStatus==='active'?'#00ff88':ru.referralStatus==='referred'?'#f7931e':'#888'};font-size:11px;">${ru.referralStatus || '—'}</span>
                </td>
                <td style="padding:5px 6px;color:${ru.excludedFromReferral?'#ff4444':'#888'};font-size:11px;">${ru.excludedFromReferral ? '❌ Excluido' : '✅ Activo'}</td>
            </tr>
        `).join('');

        // Enriched commission rows with paid/pending breakdown
        const commissionRows = (d.commissions || []).slice(0, 30).map(c => {
            const alreadyPaid = c.alreadyPaidAmount != null ? c.alreadyPaidAmount : (c.settledCommissionAmount || 0);
            // pendingAmount from API is always commissionAmount when > 0 (status-independent)
            const pending = c.pendingAmount != null ? c.pendingAmount : (c.commissionAmount > 0 ? c.commissionAmount : 0);
            const isDelta = c.isDelta || alreadyPaid > 0;
            const statusColor = c.status === 'paid' ? '#00ff88' : c.status === 'calculated' ? '#f7931e' : c.status === 'excluded' ? '#ff4444' : '#888';
            const statusLabel = c.status === 'paid' ? '✅ Pagado' : c.status === 'calculated' ? '⏳ Pendiente' : c.status === 'excluded' ? '🚫 Excluido' : c.status;
            return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);${isDelta?'background:rgba(212,175,55,0.03);':''}">
                <td style="padding:5px 6px;color:#b0b0b0;">${fmtPeriod(c.periodKey)}${isDelta?'<span style="color:#d4af37;font-size:10px;margin-left:3px;">Δ</span>':''}</td>
                <td style="padding:5px 6px;color:#fff;">${c.referredUsername}</td>
                <td style="padding:5px 6px;color:#888;text-align:right;">${fmtARS(c.totalOwnerRevenue)}</td>
                <td style="padding:5px 6px;color:#00ff88;text-align:right;font-size:11px;">${fmtARS(alreadyPaid)}</td>
                <td style="padding:5px 6px;text-align:right;">
                    <span style="color:${pending>0?'#f7931e':'#888'};font-weight:${pending>0?'bold':'normal'};">${fmtARS(pending)}</span>
                </td>
                <td style="padding:5px 6px;color:#d4af37;font-weight:bold;text-align:right;">${fmtARS(alreadyPaid + pending)}</td>
                <td style="padding:5px 6px;"><span style="color:${statusColor};font-size:11px;">${statusLabel}</span></td>
            </tr>`;
        }).join('');

        // Group payouts by period to show settlement timeline
        const payoutsByPeriod = new Map();
        for (const p of (d.payouts || [])) {
            const key = p.periodKey || '?';
            if (!payoutsByPeriod.has(key)) payoutsByPeriod.set(key, []);
            payoutsByPeriod.get(key).push(p);
        }

        let payoutTimelineHtml = '';
        for (const [pk, pps] of payoutsByPeriod) {
            const periodLbl = (pps[0].periodLabel || fmtPeriod(pk));
            const periodSum = pps.filter(p => p.status === 'paid').reduce((s, p) => s + (p.totalCommissionAmount || 0), 0);
            const multiPayout = pps.length > 1;
            payoutTimelineHtml += `
            <div style="margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <span style="color:#d4af37;font-size:12px;font-weight:bold;">📅 ${escHtml(periodLbl)}</span>
                    <div style="display:flex;align-items:center;gap:8px;">
                        ${multiPayout ? `<span style="background:rgba(212,175,55,0.12);border:1px solid rgba(212,175,55,0.35);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 6px;">${pps.length} pagos en este período</span>` : ''}
                        <span style="color:#888;font-size:11px;">Total: <strong style="color:#00ff88;">${fmtARS(periodSum)}</strong></span>
                    </div>
                </div>
                ${pps.map((p, i) => {
                    const isDelta = p.isDelta || (p.payoutIndex || 1) > 1;
                    const statusColor = p.status === 'paid' ? '#00ff88' : p.status === 'failed' ? '#ff4444' : '#f7931e';
                    const statusLabel = p.status === 'paid' ? '✅ Pagado' : p.status === 'failed' ? '❌ Fallido' : '⏳ Pendiente';
                    return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;${i > 0 ? 'border-top:1px solid rgba(255,255,255,0.04);' : ''}">
                        <span style="color:#888;font-size:11px;min-width:50px;">Pago ${p.payoutIndex ? `#${p.payoutIndex}` : '#1'}</span>
                        ${isDelta ? '<span style="background:rgba(212,175,55,0.15);border:1px solid rgba(212,175,55,0.4);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 5px;">Δ delta</span>' : '<span style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#888;font-size:10px;border-radius:4px;padding:1px 5px;">base</span>'}
                        <span style="color:#d4af37;font-weight:bold;min-width:80px;text-align:right;">${fmtARS(p.totalCommissionAmount)}</span>
                        <span style="color:${statusColor};font-size:11px;">${statusLabel}</span>
                        <span style="color:#888;font-size:11px;margin-left:auto;">${fmtDate(p.creditedAt)}</span>
                    </div>`;
                }).join('')}
            </div>`;
        }

        if (detailContent) {
            detailContent.innerHTML = `
                <!-- Financial header -->
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">USUARIO</div>
                        <div style="color:#fff;font-weight:bold;">${u.username}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">CÓDIGO</div>
                        <div style="color:#d4af37;letter-spacing:2px;font-weight:bold;">${u.referralCode || '—'}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">REFERIDOS</div>
                        <div style="color:#00ff88;font-weight:bold;font-size:20px;">${d.totalReferred}</div>
                    </div>
                    <div style="background:rgba(0,255,136,0.03);border:1px solid rgba(0,255,136,0.15);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">TOTAL PAGADO</div>
                        <div style="color:#00ff88;font-weight:bold;">${fmtARS(fs.totalSettledCommission || d.totalCommissionHistorical || 0)}</div>
                    </div>
                    <div style="background:rgba(247,147,30,0.03);border:1px solid rgba(247,147,30,0.15);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">PENDIENTE</div>
                        <div style="color:#f7931e;font-weight:bold;">${fmtARS(fs.totalPendingCommission || 0)}</div>
                    </div>
                    <div style="background:rgba(212,175,55,0.03);border:1px solid rgba(212,175,55,0.12);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">TOTAL GENERADO</div>
                        <div style="color:#d4af37;font-weight:bold;">${fmtARS(fs.totalGeneratedCommission || 0)}</div>
                    </div>
                    ${u.excludedFromReferral ? '<div style="background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:10px;text-align:center;grid-column:span 2;"><span style="color:#ff4444;font-size:12px;">⚠️ USUARIO EXCLUIDO DEL SISTEMA DE REFERIDOS</span></div>' : ''}
                </div>

                ${d.referredUsers && d.referredUsers.length > 0 ? `
                <div style="margin-bottom:16px;">
                    <h4 style="color:#d4af37;margin-bottom:8px;font-size:13px;">👥 Usuarios Referidos (${d.referredUsers.length})</h4>
                    <div style="overflow-x:auto;">
                    <table style="width:100%;border-collapse:collapse;min-width:400px;">
                        <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);">
                            <th style="padding:5px 6px;">Usuario</th>
                            <th style="padding:5px 6px;">Registro</th>
                            <th style="padding:5px 6px;">Estado</th>
                            <th style="padding:5px 6px;">Acceso</th>
                        </tr></thead>
                        <tbody>${referredRows}</tbody>
                    </table>
                    </div>
                </div>` : '<div style="color:#888;font-size:12px;margin-bottom:14px;">Sin usuarios referidos en la base de datos.</div>'}

                ${d.commissions && d.commissions.length > 0 ? `
                <div style="margin-bottom:16px;">
                    <h4 style="color:#d4af37;margin-bottom:8px;font-size:13px;">💰 Historial de Comisiones <span style="color:#888;font-size:11px;font-weight:normal;">(Δ = comisión delta tras pago previo)</span></h4>
                    <div style="overflow-x:auto;">
                    <table style="width:100%;border-collapse:collapse;min-width:600px;">
                        <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);">
                            <th style="padding:5px 6px;">Período</th>
                            <th style="padding:5px 6px;">Referido</th>
                            <th style="padding:5px 6px;text-align:right;">Rev. Dueño</th>
                            <th style="padding:5px 6px;text-align:right;color:#00ff88;">Ya Pagado</th>
                            <th style="padding:5px 6px;text-align:right;color:#f7931e;">Pendiente</th>
                            <th style="padding:5px 6px;text-align:right;">Total</th>
                            <th style="padding:5px 6px;">Estado</th>
                        </tr></thead>
                        <tbody>${commissionRows}</tbody>
                    </table>
                    </div>
                </div>` : '<div style="color:#888;font-size:12px;margin-bottom:14px;">Sin comisiones calculadas aún. Usá Preview/Calcular para generar los datos.</div>'}

                ${d.payouts && d.payouts.length > 0 ? `
                <div>
                    <h4 style="color:#d4af37;margin-bottom:8px;font-size:13px;">📤 Historial de Pagos Realizados <span style="color:#888;font-size:11px;font-weight:normal;">(Δ = pago delta, liquidación posterior al corte inicial)</span></h4>
                    ${payoutTimelineHtml}
                </div>` : '<div style="color:#888;font-size:12px;">Sin pagos realizados aún.</div>'}
            `;
        }
    } catch (e) {
        if (detailContent) detailContent.innerHTML = '<span style="color:#ff4444;">Error: ' + e.message + '</span>';
    }
}

async function loadAdminReferralRelationships() {
    const container = document.getElementById('referralRelationshipsList');
    if (!container) return;
    container.innerHTML = '<span style="color:#888;">Cargando relaciones...</span>';
    const referrerFilter = document.getElementById('referralRelFilterReferrer')?.value?.trim() || '';
    const referredFilter = document.getElementById('referralRelFilterReferred')?.value?.trim() || '';
    const params = new URLSearchParams({ limit: 200 });
    if (referrerFilter) params.append('referrerUsername', referrerFilter);
    if (referredFilter) params.append('referredUsername', referredFilter);
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/relationships?${params}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!res.ok) {
            container.innerHTML = '<span style="color:#ff4444;">Error cargando relaciones. Verificar que el endpoint exista.</span>';
            return;
        }
        const data = await res.json();
        const rels = data.data?.relationships || [];
        const msg = data.data?.message || null;

        if (rels.length === 0) {
            container.innerHTML = `<div style="color:#888;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;">
                ${msg || 'No se encontraron relaciones de referido.'}
                <br><br>
                <span style="color:#f7931e;font-size:12px;">
                    ℹ️ Si ya se realizó un registro con código de referido, verificá que el campo <code>referredByUserId</code> esté guardado en ese usuario.
                    Si la cuenta fue creada antes de este fix, la atribución no se habrá guardado.
                </span>
            </div>`;
            return;
        }

        container.innerHTML = `
            <div style="margin-bottom:8px;font-size:12px;color:#888;">Total: ${data.data?.pagination?.total || rels.length} relaciones encontradas</div>
            <table style="width:100%;border-collapse:collapse;">
                <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);">
                    <th style="padding:6px 4px;">Referidor</th>
                    <th style="padding:6px 4px;">Código usado</th>
                    <th style="padding:6px 4px;">Referido</th>
                    <th style="padding:6px 4px;">Usuario JG</th>
                    <th style="padding:6px 4px;">Fecha registro</th>
                    <th style="padding:6px 4px;">Estado</th>
                    <th style="padding:6px 4px;">Excluido</th>
                </tr></thead>
                <tbody>
                ${rels.map(r => `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:5px 4px;">
                        <span style="color:#d4af37;font-weight:bold;">${r.referrer?.username || '—'}</span>
                        ${r.referrer?.id ? `<button onclick="loadAdminUserReferrals('${r.referrer.id}')" style="background:rgba(212,175,55,0.1);border:1px solid #d4af37;color:#d4af37;padding:2px 6px;border-radius:4px;cursor:pointer;font-size:10px;margin-left:4px;">Detalle</button>` : ''}
                    </td>
                    <td style="padding:5px 4px;color:#d4af37;letter-spacing:1px;font-size:12px;">${r.codeUsed || '—'}</td>
                    <td style="padding:5px 4px;color:#fff;">${r.referredUsername}</td>
                    <td style="padding:5px 4px;color:#888;font-size:11px;">${r.jugayganaUsername || r.referredUsername}</td>
                    <td style="padding:5px 4px;color:#b0b0b0;font-size:11px;">${fmtDate(r.referredAt)}</td>
                    <td style="padding:5px 4px;">
                        <span style="color:${r.referralStatus==='active'?'#00ff88':r.referralStatus==='referred'?'#f7931e':'#888'};font-size:11px;">${r.referralStatus || '—'}</span>
                    </td>
                    <td style="padding:5px 4px;color:${r.excludedFromReferral?'#ff4444':'#888'};font-size:11px;">${r.excludedFromReferral ? '❌' : '✅'}</td>
                </tr>`).join('')}
                </tbody>
            </table>
        `;
    } catch (e) {
        container.innerHTML = '<span style="color:#ff4444;">Error: ' + e.message + '</span>';
    }
}

function renderReferralCalcResult(data, container, actionLabel) {
    if (!container) return;
    if (!data) { container.innerHTML = '<span style="color:#ff4444;">Sin datos en la respuesta.</span>'; return; }

    const statusColor = (s) => {
        if (s === 'calculated') return '#d4af37';
        if (s === 'skipped') return '#888';
        if (s === 'excluded') return '#ff4444';
        if (s === 'error') return '#ff6666';
        if (s === 'paid') return '#00ff88';
        return '#b0b0b0';
    };

    const details = data.details || [];
    const errors = data.errors || [];

    let html = `
        <div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;">
            <div style="font-size:14px;font-weight:bold;color:#d4af37;margin-bottom:8px;">📊 ${actionLabel} — Período ${fmtPeriod(data.periodKey)} ${data.dryRun ? '<span style="color:#888;font-size:11px;">(PREVIEW - no guardado)</span>' : ''}</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;">
                <div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.2);border-radius:6px;padding:8px;text-align:center;">
                    <div style="color:#00ff88;font-size:18px;font-weight:bold;">${data.referrersProcessed}</div>
                    <div style="color:#888;font-size:11px;">Referidores procesados</div>
                </div>
                <div style="background:rgba(212,175,55,0.05);border:1px solid rgba(212,175,55,0.2);border-radius:6px;padding:8px;text-align:center;">
                    <div style="color:#d4af37;font-size:18px;font-weight:bold;">${data.referredsProcessed}</div>
                    <div style="color:#888;font-size:11px;">Referidos procesados</div>
                </div>
                <div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.2);border-radius:6px;padding:8px;text-align:center;">
                    <div style="color:#00ff88;font-size:18px;font-weight:bold;">${data.commissionsCreated}</div>
                    <div style="color:#888;font-size:11px;">Comisiones generadas</div>
                </div>
                <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:8px;text-align:center;">
                    <div style="color:#888;font-size:18px;font-weight:bold;">${data.commissionsSkipped}</div>
                    <div style="color:#888;font-size:11px;">Sin revenue</div>
                </div>
                ${data.commissionsExcluded > 0 ? `
                <div style="background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:6px;padding:8px;text-align:center;">
                    <div style="color:#ff4444;font-size:18px;font-weight:bold;">${data.commissionsExcluded}</div>
                    <div style="color:#888;font-size:11px;">Excluidos</div>
                </div>` : ''}
            </div>
        </div>`;

    if (data.referrersProcessed === 0) {
        html += `<div style="background:rgba(247,147,30,0.08);border:1px solid rgba(247,147,30,0.3);border-radius:8px;padding:12px;margin-bottom:10px;color:#f7931e;font-size:13px;">
            ⚠️ <strong>Sin referidores procesados.</strong><br>
            Esto significa que ningún usuario tiene el campo <code>referredByUserId</code> guardado en la base de datos.<br>
            Las cuentas creadas con código de referido antes del fix no tienen atribución guardada.
            Para verificar, usá la sección <strong>"Relaciones de Referido (Auditoría)"</strong>.
        </div>`;
    }

    if (details.length > 0) {
        const revenueOkLabel = (d) => {
            if (d.status === 'excluded') return '<span style="color:#ff4444;font-size:10px;">excluido</span>';
            if (d.status === 'error') return '<span style="color:#ff6666;font-size:10px;">❌ error</span>';
            if (d.revenueOk === false) return '<span style="color:#ff6666;font-size:10px;">❌ error</span>';
            if (d.revenueOk === true) return '<span style="color:#00ff88;font-size:10px;">✓ ok</span>';
            return '<span style="color:#888;font-size:10px;">—</span>';
        };
        html += `<div style="margin-bottom:10px;">
            <div style="font-size:12px;color:#888;margin-bottom:6px;font-weight:600;">DETALLE POR REFERIDO:</div>
            <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;min-width:700px;">
                <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);">
                    <th style="padding:4px 6px;">Referido</th>
                    <th style="padding:4px 6px;">Usuario JG</th>
                    <th style="padding:4px 6px;">Período</th>
                    <th style="padding:4px 6px;">Revenue ok</th>
                    <th style="padding:4px 6px;">GGR</th>
                    <th style="padding:4px 6px;">Rev. Dueño</th>
                    <th style="padding:4px 6px;color:#00ff88;">Ya Pagado</th>
                    <th style="padding:4px 6px;color:#f7931e;">Pendiente</th>
                    <th style="padding:4px 6px;">Estado</th>
                    <th style="padding:4px 6px;">Nota</th>
                </tr></thead>
                <tbody>
                ${details.map(d => {
                    const alreadyPaid = d.alreadySettledCommission || 0;
                    const pending = d.commissionAmount || 0;
                    const isDelta = d.isDelta || alreadyPaid > 0;
                    return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);${isDelta?'background:rgba(212,175,55,0.02);':''}">
                        <td style="padding:4px 6px;color:#fff;font-size:12px;">${escHtml(d.referredUsername)}${isDelta?'<span style="color:#d4af37;font-size:10px;margin-left:3px;" title="Delta: pago incremental">Δ</span>':''}</td>
                        <td style="padding:4px 6px;color:#aaa;font-size:11px;">${escHtml(d.jugayganaUsername != null ? d.jugayganaUsername : d.referredUsername)}</td>
                        <td style="padding:4px 6px;color:#888;font-size:11px;">${escHtml(d.periodKey || data.periodKey || '')}</td>
                        <td style="padding:4px 6px;">${revenueOkLabel(d)}</td>
                        <td style="padding:4px 6px;color:#b0b0b0;font-size:12px;">${d.status !== 'error' ? fmtARS(d.totalGgr != null ? d.totalGgr : 0) : '—'}</td>
                        <td style="padding:4px 6px;color:#b0b0b0;font-size:12px;">${d.status !== 'error' ? fmtARS(d.totalOwnerRevenue) : '—'}</td>
                        <td style="padding:4px 6px;color:#00ff88;font-size:12px;">${fmtARS(alreadyPaid)}</td>
                        <td style="padding:4px 6px;color:${pending>0?'#f7931e':'#888'};font-weight:${pending>0?'bold':'normal'};font-size:12px;">${fmtARS(pending)}</td>
                        <td style="padding:4px 6px;"><span style="color:${statusColor(d.status)};font-size:11px;">${escHtml(d.status)}</span></td>
                        <td style="padding:4px 6px;color:#888;font-size:10px;max-width:200px;word-break:break-word;">${escHtml(d.reason || '')}</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
            </div>
        </div>`;
    }

    if (errors.length > 0) {
        html += `<div style="background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:10px;margin-bottom:10px;">
            <div style="color:#ff4444;font-size:12px;margin-bottom:6px;font-weight:600;">ERRORES EN REVENUE (${errors.length}):</div>
            ${errors.map(e => `<div style="color:#ff8888;font-size:11px;margin-bottom:4px;">
                • <strong>${escHtml(e.referredUsername || '?')}</strong>${e.jugayganaUsername && e.jugayganaUsername !== e.referredUsername ? ` <span style="color:#888;">(JG: ${escHtml(e.jugayganaUsername)})</span>` : ''}
                ${e.periodKey ? `<span style="color:#888;"> período ${escHtml(e.periodKey)}</span>` : ''}
                → <span style="color:#ff6666;">${escHtml(e.error)}</span>
                ${e.statusCode ? `<span style="color:#888;font-size:10px;"> [HTTP ${e.statusCode}]</span>` : ''}
                ${e.providerResponse ? `<details style="margin-top:2px;"><summary style="color:#888;font-size:10px;cursor:pointer;">detalle proveedor</summary><pre style="color:#aaa;font-size:10px;white-space:pre-wrap;word-break:break-all;margin:2px 0 0 0;">${escHtml(e.providerResponse)}</pre></details>` : ''}
            </div>`).join('')}
        </div>`;
    }

    container.innerHTML = html;
}

function renderReferralCalcError(message, container) {
    if (!container) return;
    container.innerHTML = `<div style="background:rgba(255,68,68,0.08);border:1px solid rgba(255,68,68,0.3);border-radius:8px;padding:12px;">
        <div style="color:#ff4444;font-size:13px;font-weight:bold;margin-bottom:6px;">❌ Error en la operación</div>
        <div style="color:#ff8888;font-size:12px;">${escHtml(message)}</div>
    </div>`;
}

// Lee la respuesta de un endpoint de referidos de forma segura. Si el body no
// es JSON (típicamente porque el balanceador devolvió un 504/502 HTML al
// cortar una operación que tardó demasiado), tira un error claro en vez del
// críptico "JSON.parse: unexpected character at line 1 column 1".
async function parseReferralJson(res) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        if (res.status === 504 || res.status === 502 || res.status === 408) {
            throw new Error('La operación tardó demasiado y el servidor cortó la conexión (timeout). Reintentá, o probá calculando un referidor específico.');
        }
        throw new Error(`El servidor respondió en un formato inesperado (HTTP ${res.status || '?'}). Suele ser un timeout — reintentá en un momento.`);
    }
}

async function adminReferralPreview() {
    const period = document.getElementById('referralPeriodInput')?.value?.trim();
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        showToast('⚠️ Ingresá el período en formato YYYY-MM', 'error'); return;
    }
    const resultDiv = document.getElementById('referralActionResult');
    if (resultDiv) resultDiv.innerHTML = '<span style="color:#888;">Calculando preview...</span>';
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ periodKey: period })
        });
        const data = await parseReferralJson(res);
        if (!res.ok || data.status !== 'success') {
            renderReferralCalcError(data.message || data.error || `HTTP ${res.status}`, resultDiv);
            return;
        }
        renderReferralCalcResult(data.data, resultDiv, '🔍 Preview');
    } catch (e) {
        renderReferralCalcError('Error de red: ' + e.message, resultDiv);
    }
}

async function adminReferralCalculate() {
    const period = document.getElementById('referralPeriodInput')?.value?.trim();
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        showToast('⚠️ Ingresá el período en formato YYYY-MM', 'error'); return;
    }
    if (!confirm(`¿Calcular comisiones de referidos para ${period}? Esto guardará los cálculos en la base de datos.`)) return;
    const resultDiv = document.getElementById('referralActionResult');
    if (resultDiv) resultDiv.innerHTML = '<span style="color:#888;">Calculando...</span>';
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/calculate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ periodKey: period })
        });
        const data = await parseReferralJson(res);
        if (!res.ok || data.status !== 'success') {
            renderReferralCalcError(data.message || data.error || `HTTP ${res.status}`, resultDiv);
            showToast('❌ Error en cálculo', 'error');
            return;
        }
        renderReferralCalcResult(data.data, resultDiv, '📊 Cálculo');
        showToast('✅ Cálculo completado', 'success');
    } catch (e) {
        renderReferralCalcError('Error de red: ' + e.message, resultDiv);
        showToast('❌ Error en cálculo', 'error');
    }
}

async function adminReferralPayout() {
    const period = document.getElementById('referralPeriodInput')?.value?.trim();
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        showToast('⚠️ Ingresá el período en formato YYYY-MM', 'error'); return;
    }
    if (!confirm(`⚠️ ¿Ejecutar pagos de referidos para ${period}? Esta acción acreditará fichas REALMENTE. Solo continuar si el cálculo fue verificado.`)) return;
    const resultDiv = document.getElementById('referralActionResult');
    if (resultDiv) resultDiv.innerHTML = '<span style="color:#888;">Procesando pagos...</span>';
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/payout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ periodKey: period })
        });
        const data = await parseReferralJson(res);
        const result = (data && data.data) || {};
        const created = result.payoutsCreated || 0;
        const failed = result.payoutsFailed || 0;
        const skipped = result.payoutsSkipped || 0;
        const details = result.details || [];
        const errors = result.errors || [];

        const renderPayoutResult = () => {
            const statusColor = data.status === 'success' ? '#00ff88' : data.status === 'partial' ? '#f7931e' : '#ff4444';
            const statusIcon = data.status === 'success' ? '✅' : data.status === 'partial' ? '⚠️' : '❌';

            let html = `
            <div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;">
                <div style="font-size:14px;font-weight:bold;color:${statusColor};margin-bottom:8px;">${statusIcon} Resultado del Pago — Período ${fmtPeriod(period)}</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:10px;">
                    <div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.2);border-radius:6px;padding:8px;text-align:center;">
                        <div style="color:#00ff88;font-size:18px;font-weight:bold;">${created}</div>
                        <div style="color:#888;font-size:11px;">Pagos creados</div>
                    </div>
                    <div style="background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:6px;padding:8px;text-align:center;">
                        <div style="color:${failed > 0 ? '#ff4444' : '#888'};font-size:18px;font-weight:bold;">${failed}</div>
                        <div style="color:#888;font-size:11px;">Con error</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px;text-align:center;">
                        <div style="color:#888;font-size:18px;font-weight:bold;">${skipped}</div>
                        <div style="color:#888;font-size:11px;">Omitidos ($0)</div>
                    </div>
                </div>`;

            if (details.length > 0) {
                html += `<div style="margin-top:8px;">
                    <div style="color:#888;font-size:11px;margin-bottom:6px;font-weight:600;">DETALLE POR REFERIDOR:</div>
                    ${details.map(d => {
                        const isDelta = d.isDelta || (d.payoutIndex || 1) > 1;
                        const dColor = d.status === 'paid' ? '#00ff88' : '#ff4444';
                        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                            <span style="color:#fff;font-weight:bold;min-width:100px;">${escHtml(d.referrerUsername)}</span>
                            ${isDelta ? '<span style="background:rgba(212,175,55,0.15);border:1px solid rgba(212,175,55,0.4);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 5px;">Δ delta</span>' : ''}
                            <span style="color:#d4af37;font-weight:bold;min-width:80px;text-align:right;">${fmtARS(d.amount || 0)}</span>
                            <span style="color:#00ff88;font-size:11px;">${d.referralCount || 0} referido(s)</span>
                            <span style="color:#888;font-size:11px;">pago #${d.payoutIndex || 1}</span>
                            <span style="color:${dColor};font-size:11px;margin-left:auto;">${d.status === 'paid' ? '✅ Acreditado' : '❌ Error'}</span>
                        </div>`;
                    }).join('')}
                </div>`;
            }

            if (errors.length > 0) {
                html += `<div style="background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:10px;margin-top:10px;">
                    <div style="color:#ff4444;font-size:12px;margin-bottom:6px;font-weight:600;">ERRORES (${errors.length}):</div>
                    ${errors.map(e => {
                        const who = e.referrer || e.referrerUsername || 'desconocido';
                        const rawMsg = e.message || e.error;
                        const msg = typeof rawMsg === 'string' ? rawMsg
                            : (rawMsg && (rawMsg.message || rawMsg.reason || rawMsg.code))
                                ? (rawMsg.message || rawMsg.reason || String(rawMsg.code))
                                : 'Error desconocido';
                        return `<div style="color:#ff8888;font-size:11px;margin-bottom:4px;">• <strong>${escHtml(who)}</strong> → ${escHtml(msg)}</div>`;
                    }).join('')}
                </div>`;
            }

            html += '</div>';
            return html;
        };

        if (!res.ok) {
            const errMsg = data?.message || data?.error || 'Error desconocido';
            if (resultDiv) resultDiv.innerHTML = `<div style="color:#ff4444;padding:8px;">❌ Error al procesar pagos: ${escHtml(errMsg)}</div>`;
            showToast('❌ Error en pagos', 'error');
        } else if (created > 0 && failed === 0) {
            if (resultDiv) resultDiv.innerHTML = renderPayoutResult();
            showToast('✅ Pagos procesados', 'success');
        } else if (created > 0 && failed > 0) {
            if (resultDiv) resultDiv.innerHTML = renderPayoutResult();
            showToast('⚠️ Pagos parciales', 'warning');
        } else if (failed > 0) {
            if (resultDiv) resultDiv.innerHTML = renderPayoutResult();
            showToast('❌ Error en pagos', 'error');
        } else if (skipped > 0 && created === 0 && failed === 0) {
            if (resultDiv) resultDiv.innerHTML = `<div style="color:#888;padding:8px;">ℹ️ Sin pagos pendientes para ${period} (${skipped} ya procesado(s) o sin monto).</div>`;
            showToast('ℹ️ Sin pagos pendientes', 'info');
        } else {
            if (resultDiv) resultDiv.innerHTML = '<span style="color:#f7931e;">Sin datos de pago para el período indicado.</span>';
        }
        loadAdminReferralSummary();
    } catch (e) {
        if (resultDiv) resultDiv.innerHTML = '<span style="color:#ff4444;">Error: ' + escHtml(e.message) + '</span>';
        showToast('❌ Error en pagos', 'error');
    }
}

// Exponer funciones de referidos al scope global
window.loadAdminReferralSummary = loadAdminReferralSummary;
window.loadAdminReferralPayouts = loadAdminReferralPayouts;
window.loadAdminUserReferrals = loadAdminUserReferrals;
window.loadAdminReferralRelationships = loadAdminReferralRelationships;
window.adminReferralPreview = adminReferralPreview;
window.adminReferralCalculate = adminReferralCalculate;
window.adminReferralPayout = adminReferralPayout;

// ============================================
// CAMBIAR CONTRASEÑA PROPIA DEL ADMIN
// ============================================
function showChangeOwnPasswordModal() {
    document.getElementById('ownCurrentPassword').value = '';
    document.getElementById('ownNewPassword').value = '';
    document.getElementById('ownConfirmPassword').value = '';
    showModal('changeOwnPasswordModal');
}

async function handleChangeOwnPassword() {
    const currentPassword = document.getElementById('ownCurrentPassword').value;
    const newPassword = document.getElementById('ownNewPassword').value;
    const confirmPassword = document.getElementById('ownConfirmPassword').value;
    const btn = document.getElementById('confirmOwnPasswordBtn');

    if (!currentPassword) {
        showToast('Ingresá tu contraseña actual', 'error');
        return;
    }
    if (!newPassword || newPassword.length < 6) {
        showToast('La nueva contraseña debe tener al menos 6 caracteres', 'error');
        return;
    }
    if (newPassword !== confirmPassword) {
        showToast('Las contraseñas no coinciden', 'error');
        return;
    }

    setButtonLoading(btn, true, 'Cambiando...');
    try {
        const response = await fetch(`${API_URL}/api/admin/change-own-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al cambiar contraseña');
        showToast('✅ Contraseña cambiada correctamente', 'success');
        hideModal('changeOwnPasswordModal');
    } catch (error) {
        showToast(error.message || 'Error al cambiar contraseña', 'error');
    } finally {
        setButtonLoading(btn, false, '🔑 Cambiar contraseña');
    }
}

window.showChangeOwnPasswordModal = showChangeOwnPasswordModal;
window.handleChangeOwnPassword = handleChangeOwnPassword;

// ============================================
// SMS MASIVO PANEL
// ============================================

// Códigos de país LATAM válidos (espejo del listado de server.js)
const SMS_VALID_COUNTRY_CODES = [
    '+54', '+591', '+55', '+56', '+57', '+506', '+53', '+593',
    '+503', '+502', '+504', '+52', '+505', '+507', '+595', '+51', '+1', '+598', '+58'
];

const SMS_FAKE_PATTERN = /^(\d)\1+$|^1234567890$|^0987654321$|^12345678$|^01234567$/;

const SMS_COSTO_POR_MENSAJE = 0.006;


function actualizarContadorSms() {
    const textarea = document.getElementById('smsMensaje');
    const counter = document.getElementById('smsContadorNum');
    if (!textarea || !counter) return;
    const remaining = 160 - textarea.value.length;
    counter.textContent = remaining;
    counter.style.color = remaining < 20 ? '#ef4444' : remaining < 40 ? '#f59e0b' : '#86efac';
}

async function previewSmsMasivo() {
    const mensaje = (document.getElementById('smsMensaje')?.value || '').trim();
    if (!mensaje) {
        showToast('Escribí el mensaje SMS antes de ver los destinatarios', 'error');
        return;
    }
    if (mensaje.length > 160) {
        showToast('El mensaje supera los 160 caracteres', 'error');
        return;
    }

    const btn = document.getElementById('smsPreviewBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Cargando...'; }

    // Ocultar resultados anteriores
    const panelPreview = document.getElementById('smsPreviewPanel');
    const panelResultados = document.getElementById('smsResultados');
    if (panelPreview) panelPreview.style.display = 'none';
    if (panelResultados) panelResultados.style.display = 'none';

    try {
        const filters = obtenerFiltrosSms();
        const onlyVerified = document.getElementById('bulkSmsOnlyVerified')?.checked === true;
        const res = await fetch(`${API_URL}/api/admin/bulk-sms/preview`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ filters, onlyVerified, password: _smsPassword })
        });
        const data = await res.json();
        if (!res.ok && data.code === 'SMS_PASSWORD') { _smsRelock(data.error); return; }
        if (!res.ok) throw new Error(data.error || 'Error al cargar destinatarios');

        renderSmsPreview(data);
        if (panelPreview) panelPreview.style.display = '';
    } catch (error) {
        showToast(error.message || 'Error al cargar destinatarios', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔍 Ver destinatarios'; }
    }
}

function obtenerFiltrosSms() {
    const filtros = {};
    if (document.getElementById('smsFiltroConsentimiento')?.checked) filtros.smsConsent = true;
    if (document.getElementById('smsFiltroActivos')?.checked) filtros.isActive = true;
    return filtros;
}

function renderSmsPreview(data) {
    const resumen = document.getElementById('smsPreviewResumen');
    const tabla = document.getElementById('smsPreviewTabla');
    const costo = document.getElementById('smsEstimadoCosto');
    const sendBtn = document.getElementById('smsSendBtn');

    if (resumen) {
        resumen.innerHTML = `
            <div style="background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;">
                📦 Total en DB: <strong>${data.total}</strong>
            </div>
            <div style="background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;color:#86efac;">
                ✅ Válidos: <strong>${data.valid}</strong>
            </div>
            <div style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;color:#fca5a5;">
                ❌ Descartados: <strong>${data.invalid}</strong>
            </div>
        `;
    }

    if (costo) {
        const estimado = (data.valid * SMS_COSTO_POR_MENSAJE).toFixed(2);
        costo.textContent = `Costo estimado: ~$${estimado} USD`;
    }

    if (sendBtn) {
        sendBtn.disabled = data.valid === 0;
    }

    if (tabla) {
        if (!data.recipients || data.recipients.length === 0) {
            tabla.innerHTML = '<tr><td colspan="3" style="padding:.8rem;text-align:center;color:#888;">Sin destinatarios</td></tr>';
            return;
        }
        tabla.innerHTML = data.recipients.map(r => `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                <td style="padding:.5rem .8rem;">${escapeHtml(r.username)}</td>
                <td style="padding:.5rem .8rem;font-family:monospace;font-size:.8rem;">${escapeHtml(r.phone || '-')}</td>
                <td style="padding:.5rem .8rem;">
                    ${r.valid
                        ? '<span style="color:#86efac;">✅ Válido</span>'
                        : `<span style="color:#fca5a5;">❌ ${escapeHtml(r.reason || 'Inválido')}</span>`}
                </td>
            </tr>
        `).join('');
    }
}

function confirmarEnvioSmsMasivo() {
    const mensaje = (document.getElementById('smsMensaje')?.value || '').trim();
    if (!mensaje) { showToast('El mensaje está vacío', 'error'); return; }

    const resumenEl = document.getElementById('smsPreviewResumen');
    const validMatch = resumenEl ? resumenEl.textContent.match(/Válidos:\s*(\d+)/) : null;
    const totalMatch = resumenEl ? resumenEl.textContent.match(/Total en DB:\s*(\d+)/) : null;
    const validCount = validMatch ? parseInt(validMatch[1], 10) : 0;
    const totalCount = totalMatch ? parseInt(totalMatch[1], 10) : validCount;

    if (validCount === 0) { showToast('No hay destinatarios válidos para enviar', 'error'); return; }

    const estimado = (validCount * SMS_COSTO_POR_MENSAJE).toFixed(2);
    const onlyVerified = document.getElementById('bulkSmsOnlyVerified')?.checked === true;

    let confirmMsg;
    if (!onlyVerified) {
        confirmMsg = `⚠️ Vas a enviar SMS a TODOS los usuarios con teléfono cargado, incluyendo los que NO verificaron su número.\n\n` +
            `Esto puede:\n` +
            `- Generar SMS fallidos a números inválidos.\n` +
            `- Llegar a usuarios que no dieron consentimiento explícito.\n\n` +
            `Total en DB: ${totalCount} | Válidos: ${validCount}\n` +
            `Costo estimado (sobre válidos): $${estimado} USD\n\n` +
            `¿Continuar?`;
    } else {
        confirmMsg = `¿Estás seguro?\n\nSe enviarán ${validCount} SMS.\nCosto estimado: $${estimado} USD\n\nEsta acción no se puede deshacer.`;
    }

    if (!confirm(confirmMsg)) return;

    enviarSmsMasivo(mensaje);
}

async function enviarSmsMasivo(mensaje) {
    const sendBtn = document.getElementById('smsSendBtn');
    const previewBtn = document.getElementById('smsPreviewBtn');
    const progreso = document.getElementById('smsProgreso');
    const progresoTexto = document.getElementById('smsProgresoTexto');
    const previewPanel = document.getElementById('smsPreviewPanel');
    const resultados = document.getElementById('smsResultados');

    if (sendBtn) { sendBtn.disabled = true; }
    if (previewBtn) { previewBtn.disabled = true; }
    if (progreso) { progreso.style.display = ''; }
    if (progresoTexto) { progresoTexto.textContent = 'Enviando SMS masivo... (esto puede demorar varios minutos)'; }
    if (previewPanel) previewPanel.style.display = 'none';
    if (resultados) resultados.style.display = 'none';

    try {
        const filters = obtenerFiltrosSms();
        const onlyVerified = document.getElementById('bulkSmsOnlyVerified')?.checked === true;
        const res = await fetch(`${API_URL}/api/admin/bulk-sms`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ message: mensaje, filters, onlyVerified, password: _smsPassword })
        });
        const data = await res.json();
        if (!res.ok && data.code === 'SMS_PASSWORD') { _smsRelock(data.error); return; }
        if (!res.ok) throw new Error(data.error || 'Error al enviar SMS masivo');

        if (progreso) progreso.style.display = 'none';
        renderSmsResultados(data);
        if (resultados) resultados.style.display = '';

        showToast(`✅ Enviados: ${data.sent} | ⚠️ Saltados (teléfono inválido): ${data.discarded || 0} | ❌ Errores: ${data.failed}`, 'success');
    } catch (error) {
        if (progreso) progreso.style.display = 'none';
        showToast(error.message || 'Error al enviar SMS masivo', 'error');
        if (sendBtn) sendBtn.disabled = false;
        if (previewPanel) previewPanel.style.display = '';
    } finally {
        if (previewBtn) previewBtn.disabled = false;
    }
}

function renderSmsResultados(data) {
    const resumen = document.getElementById('smsResultadosResumen');
    const tabla = document.getElementById('smsResultadosTabla');

    if (resumen) {
        resumen.innerHTML = `
            <div style="background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;color:#86efac;">
                ✅ Enviados: <strong>${data.sent}</strong>
            </div>
            <div style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;color:#fca5a5;">
                ❌ Fallidos: <strong>${data.failed}</strong>
            </div>
            <div style="background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;color:#fcd34d;">
                ⚠️ Descartados: <strong>${data.discarded || 0}</strong>
            </div>
            <div style="background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;">
                📦 Total: <strong>${data.total}</strong>
            </div>
        `;
    }

    if (tabla) {
        if (!data.results || data.results.length === 0) {
            tabla.innerHTML = '<tr><td colspan="4" style="padding:.8rem;text-align:center;color:#888;">Sin resultados</td></tr>';
            return;
        }
        tabla.innerHTML = data.results.map(r => {
            let statusHtml;
            if (r.status === 'sent') {
                statusHtml = '<span style="color:#86efac;">✅ Enviado</span>';
            } else if (r.status === 'discarded') {
                statusHtml = '<span style="color:#fcd34d;">⚠️ Descartado</span>';
            } else {
                statusHtml = '<span style="color:#fca5a5;">❌ Fallido</span>';
            }
            const detalle = r.error || r.reason || '-';
            return `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:.5rem .8rem;">${escapeHtml(r.username)}</td>
                    <td style="padding:.5rem .8rem;font-family:monospace;font-size:.8rem;">${escapeHtml(r.phone || '-')}</td>
                    <td style="padding:.5rem .8rem;">${statusHtml}</td>
                    <td style="padding:.5rem .8rem;font-size:.8rem;color:#aaa;">${escapeHtml(detalle)}</td>
                </tr>
            `;
        }).join('');
    }
}

function reiniciarSmsMasivo() {
    const ids = ['smsPreviewPanel', 'smsProgreso', 'smsResultados'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const textarea = document.getElementById('smsMensaje');
    if (textarea) textarea.value = '';
    actualizarContadorSms();
    const sendBtn = document.getElementById('smsSendBtn');
    if (sendBtn) sendBtn.disabled = false;
    const previewBtn = document.getElementById('smsPreviewBtn');
    if (previewBtn) previewBtn.disabled = false;
}

window.actualizarContadorSms = actualizarContadorSms;
window.previewSmsMasivo = previewSmsMasivo;
window.confirmarEnvioSmsMasivo = confirmarEnvioSmsMasivo;
window.reiniciarSmsMasivo = reiniciarSmsMasivo;

// ============================================================
// PUBLICISTAS Y CAMPAÑAS
// ============================================================

let _campaignsCache = [];

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatARS(n) {
    if (typeof n !== 'number' || isNaN(n)) return '$0';
    return '$' + Math.round(n).toLocaleString('es-AR');
}

function buildCampaignLink(code) {
    // Usar la URL pública canónica (inyectada por el server desde
    // PUBLIC_BASE_URL env var, default https://vipcargas.com) en vez de
    // window.location.origin — el admin suele cargarse desde el dominio
    // interno de AWS y eso ensucia los links que se le pasan al publicista.
    let baseUrl = (window.__VIP_PUBLIC_BASE_URL__ || '').trim();
    // Si el placeholder no fue reemplazado (dev local sin server render),
    // fallback al dominio público hardcodeado.
    if (!baseUrl || baseUrl.indexOf('PLACEHOLDER') !== -1) {
        baseUrl = 'https://vipcargas.com';
    }
    baseUrl = baseUrl.replace(/\/$/, '');
    return `${baseUrl}/${encodeURIComponent(code)}`;
}

async function loadCampaigns() {
    const container = document.getElementById('campaignsList');
    if (!container) return;
    container.innerHTML = '<span style="color:#888;">Cargando…</span>';
    try {
        const response = await fetch(`${API_URL}/api/admin/campaigns`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!response.ok) throw new Error('Failed to load');
        const data = await response.json();
        _campaignsCache = data.campaigns || [];
        renderCampaigns();
    } catch (err) {
        container.innerHTML = `<span style="color:#ff6666;">Error cargando campañas: ${escapeHtml(err.message)}</span>`;
    }
}

function renderCampaigns() {
    const container = document.getElementById('campaignsList');
    if (!container) return;
    if (_campaignsCache.length === 0) {
        container.innerHTML = '<span style="color:#888;">No hay campañas creadas todavía. Hacé clic en "+ Nueva campaña" para empezar.</span>';
        return;
    }
    container.innerHTML = _campaignsCache.map(c => `
        <div style="background:#1a1a2e;border:1px solid ${c.isActive ? 'rgba(0,255,136,0.3)' : 'rgba(255,255,255,0.1)'};border-radius:10px;padding:14px;display:grid;gap:8px;${!c.isActive ? 'opacity:0.55;' : ''}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                <div>
                    <strong style="color:#d4af37;font-size:14px;">${escapeHtml(c.publisher)}</strong>
                    <span style="color:#888;font-size:12px;margin-left:6px;">${escapeHtml(c.name)}</span>
                </div>
                <span style="font-family:monospace;background:rgba(212,175,55,0.15);color:#d4af37;padding:3px 8px;border-radius:6px;font-size:12px;">${escapeHtml(c.code)}</span>
            </div>
            <div style="display:flex;gap:14px;font-size:12px;color:#aaa;flex-wrap:wrap;">
                <span>👁️ ${c.clicks || 0} clics</span>
                <span>📝 ${c.registrations || 0} registros</span>
                <span>Comisión: ${c.commissionType === 'none' ? '—' : (c.commissionType === 'cpa' ? formatARS(c.commissionValue) + ' / FTD' : c.commissionValue + '% rev')}</span>
                <span>${c.isActive ? '🟢 Activa' : '🔴 Inactiva'}</span>
                ${c.hasJugayganaCreds ? '<span style="color:#4caf50;">🔐 Cuenta JG propia</span>' : '<span style="color:#888;">🔐 Usa master</span>'}
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button onclick="copyCampaignLink('${escapeHtml(c.code)}')" style="background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.4);color:#00ff88;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:11px;">📋 Copiar link</button>
                <button onclick="viewCampaignStats('${escapeHtml(c.code)}')" style="background:rgba(212,175,55,0.1);border:1px solid #d4af37;color:#d4af37;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:11px;">📊 Ver detalle</button>
                <button onclick="editCampaign('${escapeHtml(c.code)}')" style="background:rgba(99,102,241,0.1);border:1px solid #6366f1;color:#a5b4fc;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:11px;">✏️ Editar</button>
                ${c.isActive ? `<button onclick="deactivateCampaign('${escapeHtml(c.code)}')" style="background:rgba(255,80,80,0.1);border:1px solid #ff5050;color:#ff8888;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:11px;">🛑 Desactivar</button>` : `<button onclick="reactivateCampaign('${escapeHtml(c.code)}')" style="background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.4);color:#00ff88;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:11px;">✅ Reactivar</button>`}
                <button onclick="deleteCampaignPermanent('${escapeHtml(c.code)}')" style="background:rgba(180,40,40,0.18);border:1px solid #b42828;color:#ff6b6b;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:11px;">🗑️ Borrar definitivamente</button>
            </div>
        </div>
    `).join('');
}

function copyCampaignLink(code) {
    const link = buildCampaignLink(code);
    navigator.clipboard.writeText(link).then(
        () => showToast(`Link copiado: ${link}`, 'success'),
        () => showToast('No se pudo copiar — copialo manualmente: ' + link, 'info')
    );
}

// Limpia los campos de creds del modal de Campaña y deja la UI en estado neutro.
function _resetCampaignCredsForm(hasCreds) {
    document.getElementById('campaignFormJgUsername').value = '';
    document.getElementById('campaignFormJgPassword').value = '';
    document.getElementById('campaignFormJgPassword').placeholder = hasCreds
        ? '(dejar vacío para no cambiarla)'
        : 'mínimo 6 caracteres';
    document.getElementById('campaignFormJgPasswordHint').textContent = hasCreds
        ? 'Cuenta configurada — escribí una nueva contraseña sólo si la querés cambiar.'
        : 'Se guarda cifrada en la DB.';
    document.getElementById('campaignFormCredsStatus').textContent = hasCreds
        ? '· cuenta propia configurada'
        : '· sin configurar (usa la master)';
    document.getElementById('campaignFormCredsStatus').style.color = hasCreds ? '#4caf50' : '#888';
    document.getElementById('campaignFormTestCredsBtn').style.display = hasCreds ? '' : 'none';
    document.getElementById('campaignFormClearCredsBtn').style.display = hasCreds ? '' : 'none';
    document.getElementById('campaignFormTestCredsResult').textContent = '';
    // Flag interna: en edit, si el usuario tocó "quitar creds", marcamos para enviar
    // clearJugayganaCreds:true al PUT.
    window._campaignFormClearCreds = false;
}

// === Editor de influencers de la campaña ===
// Lista en memoria mientras el modal está abierto: [{ name, isActive }].
function _renderCampaignInfluencers() {
    const listEl = document.getElementById('campaignFormInfluencersList');
    const countEl = document.getElementById('campaignFormInfluencersCount');
    const arr = window._campaignFormInfluencers || [];
    if (countEl) countEl.textContent = arr.length ? `· ${arr.length} cargado(s)` : '· ninguno';
    if (!listEl) return;
    if (arr.length === 0) {
        listEl.innerHTML = '<span style="color:#888;font-size:11.5px;">Sin influencers cargados.</span>';
        return;
    }
    listEl.innerHTML = arr.map((inf, i) => {
        const renamed = inf.orig && inf.orig.toLowerCase() !== inf.name.toLowerCase();
        const hint = renamed ? `<span style="color:#d4af37;font-size:10px;white-space:nowrap;" title="Se renombrará al guardar y se reasignarán sus usuarios">✎ antes: ${_safe(inf.orig)}</span>` : '';
        return `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#1a1a2e;border-radius:6px;">
            <span style="flex:1;color:${inf.isActive ? '#fff' : '#666'};font-size:13px;${inf.isActive ? '' : 'text-decoration:line-through;'}">${_safe(inf.name)} ${hint}</span>
            <label style="display:flex;align-items:center;gap:4px;color:#888;font-size:11px;cursor:pointer;white-space:nowrap;">
                <input type="checkbox" ${inf.isActive ? 'checked' : ''} onchange="toggleCampaignInfluencer(${i})"> activo
            </label>
            <button type="button" onclick="renameCampaignInfluencer(${i})" title="Renombrar" style="padding:3px 8px;background:#2a2a3e;color:#d4af37;border:1px solid rgba(212,175,55,0.3);border-radius:5px;cursor:pointer;font-size:11px;">✏️</button>
            <button type="button" onclick="removeCampaignInfluencer(${i})" style="padding:3px 8px;background:#3a1a1a;color:#ff6666;border:1px solid rgba(255,80,80,0.3);border-radius:5px;cursor:pointer;font-size:11px;">✕</button>
        </div>`;
    }).join('');
}

function addCampaignInfluencer() {
    const input = document.getElementById('campaignFormInfluencerInput');
    const name = (input.value || '').trim().slice(0, 80);
    if (!name) return;
    const arr = window._campaignFormInfluencers || (window._campaignFormInfluencers = []);
    if (arr.some(x => x.name.toLowerCase() === name.toLowerCase())) {
        showToast('Ese influencer ya está en la lista', 'error');
        return;
    }
    arr.push({ name, isActive: true });
    input.value = '';
    _renderCampaignInfluencers();
}

function removeCampaignInfluencer(idx) {
    const arr = window._campaignFormInfluencers || [];
    arr.splice(idx, 1);
    _renderCampaignInfluencers();
}

function toggleCampaignInfluencer(idx) {
    const arr = window._campaignFormInfluencers || [];
    if (arr[idx]) arr[idx].isActive = !arr[idx].isActive;
    _renderCampaignInfluencers();
}

// Renombrar un influencer (corregir un typo). El cambio queda pendiente y se
// aplica al "Guardar": el backend migra los usuarios del nombre viejo al nuevo
// (las stats por influencer se calculan en vivo sobre User.acquisitionInfluencer).
function renameCampaignInfluencer(idx) {
    const arr = window._campaignFormInfluencers || [];
    const inf = arr[idx];
    if (!inf) return;
    const nuevo = (prompt(`Nuevo nombre para el influencer "${inf.name}":`, inf.name) || '').trim().slice(0, 80);
    if (!nuevo || nuevo === inf.name) return;
    if (arr.some((x, j) => j !== idx && x.name.toLowerCase() === nuevo.toLowerCase())) {
        showToast('Ya existe otro influencer con ese nombre', 'error');
        return;
    }
    inf.name = nuevo;
    _renderCampaignInfluencers();
}

window.addCampaignInfluencer = addCampaignInfluencer;
window.removeCampaignInfluencer = removeCampaignInfluencer;
window.toggleCampaignInfluencer = toggleCampaignInfluencer;
window.renameCampaignInfluencer = renameCampaignInfluencer;

function showCreateCampaignModal() {
    document.getElementById('campaignFormTitle').textContent = 'Nueva campaña';
    document.getElementById('campaignFormMode').value = 'create';
    document.getElementById('campaignFormOriginalCode').value = '';
    document.getElementById('campaignFormCode').value = '';
    document.getElementById('campaignFormCode').disabled = false;
    document.getElementById('campaignFormPublisher').value = '';
    document.getElementById('campaignFormName').value = '';
    document.getElementById('campaignFormCommissionType').value = 'none';
    document.getElementById('campaignFormCommissionValue').value = '0';
    document.getElementById('campaignFormNotes').value = '';
    document.getElementById('campaignFormActiveRow').style.display = 'none';
    document.getElementById('campaignFormError').style.display = 'none';
    _resetCampaignCredsForm(false);
    window._campaignFormInfluencers = [];
    _renderCampaignInfluencers();
    showModal('campaignFormModal');
    document.getElementById('campaignFormModal').style.display = 'flex';
}

function editCampaign(code) {
    const campaign = _campaignsCache.find(c => c.code === code);
    if (!campaign) return showToast('Campaña no encontrada', 'error');
    document.getElementById('campaignFormTitle').textContent = 'Editar campaña ' + code;
    document.getElementById('campaignFormMode').value = 'edit';
    document.getElementById('campaignFormOriginalCode').value = code;
    document.getElementById('campaignFormCode').value = code;
    document.getElementById('campaignFormCode').disabled = true;
    document.getElementById('campaignFormPublisher').value = campaign.publisher || '';
    document.getElementById('campaignFormName').value = campaign.name || '';
    document.getElementById('campaignFormCommissionType').value = campaign.commissionType || 'none';
    document.getElementById('campaignFormCommissionValue').value = campaign.commissionValue || 0;
    document.getElementById('campaignFormNotes').value = campaign.notes || '';
    document.getElementById('campaignFormActiveRow').style.display = '';
    document.getElementById('campaignFormIsActive').checked = campaign.isActive !== false;
    document.getElementById('campaignFormError').style.display = 'none';
    // Creds JUGAYGANA: NUNCA mostramos el password (el backend ni lo devuelve).
    // En edit, el username sí lo precargamos para que el admin lo vea.
    _resetCampaignCredsForm(!!campaign.hasJugayganaCreds);
    if (campaign.jugayganaUsername) {
        document.getElementById('campaignFormJgUsername').value = campaign.jugayganaUsername;
    }
    window._campaignFormInfluencers = (campaign.influencers || []).map(x => ({
        name: x.name, isActive: x.isActive !== false, orig: x.name
    }));
    _renderCampaignInfluencers();
    showModal('campaignFormModal');
    document.getElementById('campaignFormModal').style.display = 'flex';
}

// Botón "Probar login": pega contra el endpoint test-jugaygana-creds usando
// las creds YA guardadas (no las que están en el form). Sirve para validar
// que las creds persistidas siguen funcionando.
async function testCampaignJgCreds() {
    const code = document.getElementById('campaignFormOriginalCode').value;
    if (!code) return;
    const resultEl = document.getElementById('campaignFormTestCredsResult');
    resultEl.textContent = 'Probando…';
    resultEl.style.color = '#888';
    try {
        const r = await fetch(`${API_URL}/api/admin/campaigns/${encodeURIComponent(code)}/test-jugaygana-creds`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await r.json();
        if (r.ok && data.ok) {
            resultEl.textContent = '✓ Login OK (parentId=' + (data.parentId || '?') + ')';
            resultEl.style.color = '#4caf50';
        } else {
            resultEl.textContent = '✗ ' + (data.error || 'Falló');
            resultEl.style.color = '#ff6666';
        }
    } catch (e) {
        resultEl.textContent = '✗ Error de conexión';
        resultEl.style.color = '#ff6666';
    }
}

// Marca para limpiar las creds al guardar (sólo en edit).
function clearCampaignJgCreds() {
    if (!confirm('¿Quitar la cuenta JUGAYGANA del publicista? Los próximos usuarios creados por su publisher_admin van a usar la cuenta master.')) return;
    window._campaignFormClearCreds = true;
    document.getElementById('campaignFormJgUsername').value = '';
    document.getElementById('campaignFormJgPassword').value = '';
    document.getElementById('campaignFormCredsStatus').textContent = '· se quitará al guardar';
    document.getElementById('campaignFormCredsStatus').style.color = '#ff9800';
    document.getElementById('campaignFormTestCredsResult').textContent = '';
}

window.testCampaignJgCreds = testCampaignJgCreds;
window.clearCampaignJgCreds = clearCampaignJgCreds;

function closeCampaignFormModal() {
    hideModal('campaignFormModal');
    document.getElementById('campaignFormModal').style.display = '';
}

async function submitCampaignForm() {
    const mode = document.getElementById('campaignFormMode').value;
    const code = document.getElementById('campaignFormCode').value.trim().toUpperCase();
    const publisher = document.getElementById('campaignFormPublisher').value.trim();
    const name = document.getElementById('campaignFormName').value.trim();
    const commissionType = document.getElementById('campaignFormCommissionType').value;
    const commissionValue = parseFloat(document.getElementById('campaignFormCommissionValue').value) || 0;
    const notes = document.getElementById('campaignFormNotes').value.trim();
    const errorDiv = document.getElementById('campaignFormError');

    errorDiv.style.display = 'none';

    if (!code || !publisher || !name) {
        errorDiv.textContent = 'Código, publicista y nombre son obligatorios';
        errorDiv.style.display = '';
        return;
    }
    if (mode === 'create' && !/^[A-Z0-9_-]{3,40}$/.test(code)) {
        errorDiv.textContent = 'Código inválido (3-40 caracteres, A-Z 0-9 _ -)';
        errorDiv.style.display = '';
        return;
    }

    const body = { publisher, name, commissionType, commissionValue, notes };

    // Influencers del publicista (lista completa → reemplaza la guardada).
    body.influencers = (window._campaignFormInfluencers || []).map(x => ({
        name: x.name, isActive: x.isActive !== false
    }));
    // Renombrados: influencers que ya existían y cambiaron de nombre → el backend
    // migra sus usuarios (acquisitionInfluencer) del nombre viejo al nuevo.
    const renames = (window._campaignFormInfluencers || [])
        .filter(x => x.orig && x.orig.trim() && x.orig.toLowerCase() !== x.name.toLowerCase())
        .map(x => ({ from: x.orig, to: x.name }));
    if (renames.length) body.renames = renames;

    // Creds JUGAYGANA del publicista (opcionales).
    const jgUsername = document.getElementById('campaignFormJgUsername').value.trim();
    const jgPassword = document.getElementById('campaignFormJgPassword').value;

    if (window._campaignFormClearCreds === true) {
        // El admin tocó "Quitar cuenta" en edit. Le pedimos al backend que
        // borre las creds enteras (independientemente de lo que esté en los inputs).
        body.clearJugayganaCreds = true;
    } else {
        // Mandar las creds solo si hay algo cargado. El backend valida la pareja
        // (en create exige ambos; en edit, password vacío = mantener).
        if (jgUsername) body.jugayganaUsername = jgUsername;
        if (jgPassword) body.jugayganaPassword = jgPassword;
        // Para create exigimos ambos arriba en validación cliente.
        if (mode === 'create') {
            if ((jgUsername && !jgPassword) || (!jgUsername && jgPassword)) {
                errorDiv.textContent = 'Si configurás cuenta JUGAYGANA, completá usuario Y contraseña';
                errorDiv.style.display = '';
                return;
            }
        }
    }

    try {
        let response;
        if (mode === 'create') {
            response = await fetch(`${API_URL}/api/admin/campaigns`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify({ code, ...body })
            });
        } else {
            const originalCode = document.getElementById('campaignFormOriginalCode').value;
            body.isActive = document.getElementById('campaignFormIsActive').checked;
            response = await fetch(`${API_URL}/api/admin/campaigns/${encodeURIComponent(originalCode)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify(body)
            });
        }
        const data = await response.json();
        if (!response.ok) {
            errorDiv.textContent = data.error || 'Error al guardar';
            errorDiv.style.display = '';
            return;
        }
        showToast(data.renamedUsers ? `Campaña guardada · ${data.renamedUsers} usuario(s) reasignado(s) al renombrar` : 'Campaña guardada', 'success');
        closeCampaignFormModal();
        loadCampaigns();
    } catch (err) {
        errorDiv.textContent = 'Error de conexión: ' + err.message;
        errorDiv.style.display = '';
    }
}

async function deactivateCampaign(code) {
    if (!confirm(`¿Desactivar la campaña ${code}? Las atribuciones ya hechas se mantienen, pero ya no se aceptarán nuevos registros con este código.`)) return;
    try {
        const response = await fetch(`${API_URL}/api/admin/campaigns/${encodeURIComponent(code)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            return showToast(data.error || 'Error al desactivar', 'error');
        }
        showToast('Campaña desactivada', 'success');
        loadCampaigns();
    } catch (err) {
        showToast('Error de conexión', 'error');
    }
}

async function deleteCampaignPermanent(code) {
    if (!confirm(`⚠️ ¿BORRAR DEFINITIVAMENTE la campaña ${code}?\n\nEsto la elimina de la base de datos (NO se puede deshacer) junto con sus historias de influencer. Los usuarios ya captados se conservan, pero pierden la referencia a este publicista.\n\nSi solo querés frenarla, usá "Desactivar".`)) return;
    if (!confirm(`Confirmá una vez más: se borra ${code} para SIEMPRE.`)) return;
    try {
        const response = await fetch(`${API_URL}/api/admin/campaigns/${encodeURIComponent(code)}/permanent`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            return showToast(data.error || 'Error al borrar', 'error');
        }
        showToast(`Campaña ${code} borrada definitivamente${data.attributedUsers ? ` (${data.attributedUsers} usuarios conservados)` : ''}`, 'success');
        loadCampaigns();
    } catch (err) {
        showToast('Error de conexión', 'error');
    }
}
window.deleteCampaignPermanent = deleteCampaignPermanent;

async function reactivateCampaign(code) {
    try {
        const response = await fetch(`${API_URL}/api/admin/campaigns/${encodeURIComponent(code)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ isActive: true })
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            return showToast(data.error || 'Error al reactivar', 'error');
        }
        showToast('Campaña reactivada', 'success');
        loadCampaigns();
    } catch (err) {
        showToast('Error de conexión', 'error');
    }
}

let _campaignStatsCurrentCode = null;

async function viewCampaignStats(code) {
    _campaignStatsCurrentCode = code;
    document.getElementById('campaignStatsTitle').textContent = code;
    document.getElementById('campaignStatsSubtitle').textContent = '';
    document.getElementById('campaignStatsContent').innerHTML = 'Cargando…';
    showModal('campaignStatsModal');
    document.getElementById('campaignStatsModal').style.display = 'flex';

    try {
        const response = await fetch(`${API_URL}/api/admin/campaigns/${encodeURIComponent(code)}/stats`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!response.ok) throw new Error('Failed to load stats');
        const { campaign, stats, commission } = await response.json();

        document.getElementById('campaignStatsTitle').textContent = `${campaign.publisher} — ${campaign.name}`;
        document.getElementById('campaignStatsSubtitle').textContent = `Código: ${campaign.code} · ${campaign.isActive ? '🟢 Activa' : '🔴 Inactiva'}`;

        const crClickReg = stats.crClickToRegister !== null ? (stats.crClickToRegister * 100).toFixed(1) + '%' : '—';
        const crRegFtd = stats.crRegisterToFtd !== null ? (stats.crRegisterToFtd * 100).toFixed(1) + '%' : '—';
        const commissionLabel = campaign.commissionType === 'none'
            ? '—'
            : (campaign.commissionType === 'cpa'
                ? `${formatARS(campaign.commissionValue)} × ${stats.ftd} FTD = ${formatARS(commission)}`
                : `${campaign.commissionValue}% × ${formatARS(stats.netRevenue)} = ${formatARS(commission)}`);

        document.getElementById('campaignStatsContent').innerHTML = `
            <div style="background:rgba(0,0,0,0.4);border:1px solid rgba(212,175,55,0.2);border-radius:8px;padding:12px;margin-bottom:12px;">
                <div style="font-size:11px;color:#aaa;margin-bottom:4px;">Link para el publicista</div>
                <code style="display:block;background:#0d0d1a;padding:8px;border-radius:6px;color:#00ff88;font-size:12px;word-break:break-all;">${escapeHtml(buildCampaignLink(campaign.code))}</code>
                <button onclick="copyCampaignLink('${escapeHtml(campaign.code)}')" style="margin-top:8px;background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.4);color:#00ff88;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:11px;">📋 Copiar</button>
            </div>
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;">
                <div style="background:rgba(0,0,0,0.4);padding:12px;border-radius:8px;">
                    <div style="font-size:11px;color:#aaa;">Clics</div>
                    <div style="font-size:24px;color:#d4af37;font-weight:bold;">${stats.clicks}</div>
                </div>
                <div style="background:rgba(0,0,0,0.4);padding:12px;border-radius:8px;">
                    <div style="font-size:11px;color:#aaa;">Registros</div>
                    <div style="font-size:24px;color:#d4af37;font-weight:bold;">${stats.registrations}</div>
                    <div style="font-size:10px;color:#888;">CR: ${crClickReg}</div>
                </div>
                <div style="background:rgba(0,0,0,0.4);padding:12px;border-radius:8px;">
                    <div style="font-size:11px;color:#aaa;">FTD</div>
                    <div style="font-size:24px;color:#00ff88;font-weight:bold;">${stats.ftd}</div>
                    <div style="font-size:10px;color:#888;">CR: ${crRegFtd}</div>
                </div>
                <div style="background:rgba(0,0,0,0.4);padding:12px;border-radius:8px;">
                    <div style="font-size:11px;color:#aaa;">Revenue (depósitos)</div>
                    <div style="font-size:20px;color:#00ff88;font-weight:bold;">${formatARS(stats.totalRevenue)}</div>
                </div>
                <div style="background:rgba(0,0,0,0.4);padding:12px;border-radius:8px;">
                    <div style="font-size:11px;color:#aaa;">Retiros</div>
                    <div style="font-size:20px;color:#ff8888;font-weight:bold;">${formatARS(stats.totalWithdrawals)}</div>
                </div>
                <div style="background:rgba(212,175,55,0.1);padding:12px;border-radius:8px;border:1px solid rgba(212,175,55,0.3);">
                    <div style="font-size:11px;color:#aaa;">Ganancia neta</div>
                    <div style="font-size:20px;color:#d4af37;font-weight:bold;">${formatARS(stats.netRevenue)}</div>
                </div>
            </div>
            <div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.3);padding:12px;border-radius:8px;margin-top:12px;">
                <div style="font-size:11px;color:#aaa;margin-bottom:4px;">Comisión calculada</div>
                <div style="font-size:14px;color:#fff;">${commissionLabel}</div>
                <div style="font-size:11px;color:#888;margin-top:4px;">Esta cifra es informativa — los pagos se hacen manualmente.</div>
            </div>
            <div id="campaignStatsUsers" style="margin-top:14px;">
                <div style="font-size:12px;color:#aaa;">Cargando usuarios registrados…</div>
            </div>
        `;

        // Cargar la lista de usuarios registrados por esta pauta (best-effort).
        loadCampaignUsers(code);
    } catch (err) {
        document.getElementById('campaignStatsContent').innerHTML = `<span style="color:#ff6666;">Error: ${escapeHtml(err.message)}</span>`;
    }
}

// Carga y renderiza, dentro del modal de estadísticas, la lista de usuarios
// que se registraron por una campaña. Es best-effort: si falla, no rompe el
// resto del modal. Verifica _campaignStatsCurrentCode para no pisar el
// contenido si el admin abrió otra campaña mientras cargaba.
async function loadCampaignUsers(code) {
    const container = document.getElementById('campaignStatsUsers');
    if (!container) return;
    try {
        const response = await fetch(`${API_URL}/api/admin/campaigns/${encodeURIComponent(code)}/users?limit=500`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!response.ok) throw new Error('No se pudo cargar la lista de usuarios');
        const { users } = await response.json();

        if (_campaignStatsCurrentCode !== code) return;
        const cont = document.getElementById('campaignStatsUsers');
        if (!cont) return;

        if (!users || users.length === 0) {
            cont.innerHTML = `<div style="font-size:12px;color:#888;border-top:1px solid rgba(212,175,55,0.2);padding-top:10px;">Todavía no hay usuarios registrados por esta pauta.</div>`;
            return;
        }

        const rows = users.map((u) => {
            const fecha = u.acquiredAt || u.createdAt;
            const fechaStr = fecha
                ? fmtFechaAR(fecha)
                : '—';
            const phone = u.phone ? escapeHtml(u.phone) : '<span style="color:#888;">sin teléfono</span>';
            const verif = u.phoneVerified ? '✅' : (u.phoneVerificationPending ? '⏳' : '—');
            return `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:6px 8px;color:#fff;">${escapeHtml(u.username || '')}</td>
                    <td style="padding:6px 8px;color:#ccc;">${phone}</td>
                    <td style="padding:6px 8px;text-align:center;" title="Teléfono verificado">${verif}</td>
                    <td style="padding:6px 8px;text-align:right;color:#00ff88;">${formatARS(u.balance || 0)}</td>
                    <td style="padding:6px 8px;text-align:right;color:#aaa;">${fechaStr}</td>
                </tr>`;
        }).join('');

        cont.innerHTML = `
            <div style="border-top:1px solid rgba(212,175,55,0.2);padding-top:12px;">
                <div style="font-size:13px;color:#d4af37;font-weight:bold;margin-bottom:8px;">
                    👥 Usuarios registrados por esta pauta (${users.length})
                </div>
                <div style="max-height:260px;overflow-y:auto;background:rgba(0,0,0,0.4);border-radius:8px;">
                    <table style="width:100%;border-collapse:collapse;font-size:12px;">
                        <thead>
                            <tr style="position:sticky;top:0;background:#13132a;color:#aaa;">
                                <th style="padding:6px 8px;text-align:left;">Usuario</th>
                                <th style="padding:6px 8px;text-align:left;">Teléfono</th>
                                <th style="padding:6px 8px;text-align:center;">Verif.</th>
                                <th style="padding:6px 8px;text-align:right;">Balance</th>
                                <th style="padding:6px 8px;text-align:right;">Registro</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>`;
    } catch (err) {
        const cont = document.getElementById('campaignStatsUsers');
        if (cont && _campaignStatsCurrentCode === code) {
            cont.innerHTML = `<div style="font-size:12px;color:#ff6666;">No se pudo cargar la lista de usuarios registrados.</div>`;
        }
    }
}

function closeCampaignStatsModal() {
    hideModal('campaignStatsModal');
    document.getElementById('campaignStatsModal').style.display = '';
}

function editCampaignFromStats() {
    if (!_campaignStatsCurrentCode) return;
    closeCampaignStatsModal();
    editCampaign(_campaignStatsCurrentCode);
}

window.loadCampaigns = loadCampaigns;
window.showCreateCampaignModal = showCreateCampaignModal;
window.editCampaign = editCampaign;
window.deactivateCampaign = deactivateCampaign;
window.reactivateCampaign = reactivateCampaign;
window.copyCampaignLink = copyCampaignLink;
window.submitCampaignForm = submitCampaignForm;
window.closeCampaignFormModal = closeCampaignFormModal;
window.viewCampaignStats = viewCampaignStats;
window.closeCampaignStatsModal = closeCampaignStatsModal;
window.editCampaignFromStats = editCampaignFromStats;

// =========================================================================
// RULETA DIARIA — helpers locales (la base vieja no tiene authFetch global).
// =========================================================================
function rouletteAuthFetch(url, opts) {
    const o = opts || {};
    o.headers = Object.assign({}, o.headers || {}, { 'Authorization': 'Bearer ' + currentToken });
    return fetch(API_URL + url, o);
}
function rouletteEscapeJsArg(v) {
    return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]/g, '');
}

// =========================================================================
// RULETA DIARIA — panel admin: stats + historial
// =========================================================================
// Cargar el budget diario de la ruleta cuando entra a la sección.
async function loadRouletteBudget() {
    try {
        const r = await rouletteAuthFetch('/api/admin/roulette/budget');
        const d = await r.json();
        if (!r.ok || !d.success) return;
        const enabledEl = document.getElementById('rouletteBudgetEnabled');
        const amtEl = document.getElementById('rouletteBudgetARS');
        const statusEl = document.getElementById('rouletteBudgetStatus');
        if (enabledEl) enabledEl.checked = !!d.enabled;
        if (amtEl) amtEl.value = d.dailyBudgetARS || '';
        if (statusEl) {
            const fmt = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
            const pct = d.dailyBudgetARS > 0 ? Math.round((d.spentToday / d.dailyBudgetARS) * 100) : 0;
            const pctColor = pct >= 80 ? '#ff8080' : (pct >= 50 ? '#ffaa66' : '#aaffaa');
            statusEl.innerHTML = '📅 Hoy (' + escapeHtml(d.dateKey) + '): <strong>' + fmt(d.spentToday) + '</strong> gastados · ' + d.winnersToday + ' ganadores' +
                (d.dailyBudgetARS > 0 ? ' · <span style="color:' + pctColor + ';">' + pct + '%</span> del tope' : '');
        }
    } catch (_) {}
}

async function saveRouletteBudget() {
    const enabled = document.getElementById('rouletteBudgetEnabled')?.checked;
    const amt = parseInt(document.getElementById('rouletteBudgetARS')?.value || '0', 10) || 0;
    if (enabled && amt <= 0) {
        showToast('Si activás el tope, poné un monto > 0', 'error');
        return;
    }
    try {
        const r = await rouletteAuthFetch('/api/admin/roulette/budget', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, dailyBudgetARS: amt })
        });
        const d = await r.json();
        if (!r.ok || !d.success) {
            showToast(d.error || 'Error al guardar', 'error');
            return;
        }
        showToast('✅ Budget guardado', 'success');
        loadRouletteBudget();
    } catch (e) {
        showToast('Error al guardar', 'error');
    }
}

// Reinicia la ruleta del día: borra los giros de HOY para que todos puedan
// volver a girar. Confirmación obligatoria — es una acción destructiva.
async function resetRouletteDaily() {
    if (!confirm('¿Reiniciar la ruleta de HOY?\n\nTodos los que ya giraron hoy van a poder girar de nuevo. Los premios ya acreditados NO se tocan.')) return;
    const notify = !!(document.getElementById('rouletteResetNotify') || {}).checked;
    const box = document.getElementById('rouletteResetStatus');
    if (box) { box.style.color = '#aaa'; box.textContent = '⏳ Reiniciando…'; }
    try {
        const r = await rouletteAuthFetch('/api/admin/roulette/reset-daily', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notify: notify })
        });
        const d = await r.json();
        if (!r.ok || !d.success) throw new Error(d.error || 'No se pudo reiniciar');
        let msg = '✅ Ruleta reiniciada — ' + (d.deleted || 0) + ' giro(s) borrado(s). Todos pueden girar de nuevo.';
        if (d.notified != null) msg += ' 📲 Notif enviada a ' + d.notified + ' usuarios.';
        if (box) { box.style.color = '#66ff99'; box.textContent = msg; }
        if (typeof loadRouletteAdmin === 'function') loadRouletteAdmin();
    } catch (e) {
        if (box) { box.style.color = '#ff8080'; box.textContent = '❌ ' + (e.message || e); }
    }
}

// Probar el giro de la ruleta a nombre de un user (simulación) — no
// afecta el spin real ni acredita plata. Solo muestra qué premio le
// habría salido con la tabla de probabilidades vigente.
async function rouletteTestSpin() {
    const username = (document.getElementById('rouletteTestUsername')?.value || '').trim();
    const box = document.getElementById('rouletteTestResult');
    if (!username) {
        if (box) box.innerHTML = '<div style="color:#ff8080;padding:6px;font-size:12px;">Falta el username</div>';
        return;
    }
    if (box) box.innerHTML = '<div style="color:#aaa;text-align:center;padding:6px;font-size:12px;">⏳ Girando…</div>';
    try {
        const r = await rouletteAuthFetch('/api/admin/roulette/test-spin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        const d = await r.json();
        if (!r.ok || !d.success) {
            if (box) box.innerHTML = '<div style="color:#ff8080;padding:6px;font-size:12px;">❌ ' + escapeHtml(d.error || 'Error') + '</div>';
            return;
        }
        const won = (d.prize.prizeARS || 0) > 0;
        const color = won ? '#ffd700' : '#888';
        const bg = won ? 'rgba(255,215,0,0.10)' : 'rgba(255,255,255,0.04)';
        const border = won ? '#ffd700' : 'rgba(255,255,255,0.18)';
        if (box) {
            box.innerHTML =
                '<div style="background:' + bg + ';border:1.5px solid ' + border + ';border-radius:9px;padding:10px 12px;display:flex;align-items:center;gap:10px;">' +
                    '<div style="font-size:30px;line-height:1;">' + (d.prize.emoji || '🎲') + '</div>' +
                    '<div style="flex:1;">' +
                        '<div style="color:' + color + ';font-weight:900;font-size:14px;">' + escapeHtml(d.prize.prizeLabel) + (won ? ' · $' + Number(d.prize.prizeARS).toLocaleString('es-AR') : '') + '</div>' +
                        '<div style="color:#aaa;font-size:11px;">A nombre de <strong>@' + escapeHtml(d.username) + '</strong> · peso ' + d.prize.weight + ' · simulación, no afecta nada real.</div>' +
                    '</div>' +
                '</div>';
        }
    } catch (e) {
        if (box) box.innerHTML = '<div style="color:#ff8080;padding:6px;font-size:12px;">Error: ' + escapeHtml(e.message || '') + '</div>';
    }
}

// Buscador de usuario en el historial (filtra server-side por substring;
// las tarjetas de stats siguen mostrando el total del período).
let _rouletteSearchTimer = null;
function rouletteSearchChanged() {
    clearTimeout(_rouletteSearchTimer);
    _rouletteSearchTimer = setTimeout(loadRouletteAdmin, 350);
}
async function loadRouletteAdmin() {
    const days = parseInt((document.getElementById('rouletteDays') || {}).value || '14', 10) || 14;
    const search = (document.getElementById('rouletteSearchInput')?.value || '').trim();
    const body = document.getElementById('rouletteAdminBody');
    if (!body) return;
    body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    // Cargar budget en paralelo (no bloqueante).
    loadRouletteBudget();
    try {
        const [statsResp, historyResp] = await Promise.all([
            rouletteAuthFetch('/api/admin/roulette/stats?days=' + days),
            rouletteAuthFetch('/api/admin/roulette/history?pageSize=100' + (search ? '&username=' + encodeURIComponent(search) : ''))
        ]);
        // Si el admin siguió tipeando mientras cargaba, esta respuesta ya es vieja.
        const nowSearch = (document.getElementById('rouletteSearchInput')?.value || '').trim();
        if (nowSearch !== search) return;
        const stats = await statsResp.json();
        const history = await historyResp.json();
        if (!statsResp.ok || !stats.success) {
            body.innerHTML = '<div style="color:#ff8080;text-align:center;padding:14px;">' + escapeHtml(stats.error || 'Error') + '</div>';
            return;
        }
        const t = stats.totals || {};
        const fmtMoney = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
        const fmtNum = (n) => Number(n || 0).toLocaleString('es-AR');

        let html = '';

        // === Stats arriba (totales del periodo) ===
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:14px;">';
        html += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,215,0,0.35);border-radius:10px;padding:11px;text-align:center;"><div style="color:#aaa;font-size:10.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">Giros totales</div><div style="color:#ffd700;font-size:22px;font-weight:900;margin-top:2px;">' + fmtNum(t.spinsTotal) + '</div></div>';
        html += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(102,255,102,0.35);border-radius:10px;padding:11px;text-align:center;"><div style="color:#aaa;font-size:10.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">Ganadores</div><div style="color:#66ff66;font-size:22px;font-weight:900;margin-top:2px;">' + fmtNum(t.winnersTotal) + '</div><div style="color:#888;font-size:10px;">' + (t.spinsTotal > 0 ? ((t.winnersTotal / t.spinsTotal * 100).toFixed(1) + '%') : '—') + '</div></div>';
        html += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,215,0,0.35);border-radius:10px;padding:11px;text-align:center;"><div style="color:#aaa;font-size:10.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">$ Regalado</div><div style="color:#ffd700;font-size:22px;font-weight:900;margin-top:2px;">' + fmtMoney(t.givenTotal) + '</div></div>';
        if (t.pendingTotal > 0) html += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,128,128,0.35);border-radius:10px;padding:11px;text-align:center;"><div style="color:#aaa;font-size:10.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">$ Pendiente</div><div style="color:#ff8080;font-size:22px;font-weight:900;margin-top:2px;">' + fmtMoney(t.pendingTotal) + '</div><div style="color:#888;font-size:10px;">credit fallido</div></div>';
        html += '</div>';

        // === Por día ===
        if ((stats.byDay || []).length > 0) {
            html += '<h3 style="color:#ffd700;font-size:12px;margin:14px 0 8px;letter-spacing:1.5px;text-transform:uppercase;">📅 Por día</h3>';
            html += '<div style="background:rgba(0,0,0,0.20);border-radius:8px;overflow:hidden;margin-bottom:14px;">';
            html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
            html += '<thead><tr style="background:rgba(255,215,0,0.08);color:#ffd700;text-align:left;">';
            html += '<th style="padding:8px 10px;font-weight:800;">Fecha</th>';
            html += '<th style="padding:8px 10px;font-weight:800;text-align:right;">Giros</th>';
            html += '<th style="padding:8px 10px;font-weight:800;text-align:right;">Ganadores</th>';
            html += '<th style="padding:8px 10px;font-weight:800;text-align:right;">$ Regalado</th>';
            html += '<th style="padding:8px 10px;font-weight:800;text-align:right;">$ Pendiente</th>';
            html += '</tr></thead><tbody>';
            for (const d of stats.byDay) {
                html += '<tr style="border-top:1px solid rgba(255,255,255,0.05);">';
                html += '<td style="padding:7px 10px;color:#fff;font-weight:700;">' + escapeHtml(d._id) + '</td>';
                html += '<td style="padding:7px 10px;text-align:right;color:#ddd;">' + fmtNum(d.spins) + '</td>';
                html += '<td style="padding:7px 10px;text-align:right;color:#66ff66;font-weight:700;">' + fmtNum(d.winners) + '</td>';
                html += '<td style="padding:7px 10px;text-align:right;color:#ffd700;font-weight:800;">' + fmtMoney(d.totalGiven) + '</td>';
                html += '<td style="padding:7px 10px;text-align:right;color:' + (d.totalPending > 0 ? '#ff8080' : '#888') + ';">' + (d.totalPending > 0 ? fmtMoney(d.totalPending) : '—') + '</td>';
                html += '</tr>';
            }
            html += '</tbody></table></div>';
        }

        // === Por premio ===
        if ((stats.byPrize || []).length > 0) {
            html += '<h3 style="color:#ffd700;font-size:12px;margin:14px 0 8px;letter-spacing:1.5px;text-transform:uppercase;">🎯 Por premio</h3>';
            html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">';
            for (const p of stats.byPrize) {
                const isWin = Number(p._id) > 0;
                const color = !isWin ? '#888' : (p._id >= 10000 ? '#ffd700' : (p._id >= 1000 ? '#ff8c5a' : '#aaffaa'));
                html += '<div style="background:rgba(0,0,0,0.30);border:1px solid ' + color + '40;border-radius:8px;padding:8px 12px;">';
                html += '<div style="color:' + color + ';font-weight:900;font-size:13px;">' + (isWin ? '$' + fmtNum(p._id) : 'SIN PREMIO') + '</div>';
                html += '<div style="color:#ddd;font-size:11px;">' + fmtNum(p.count) + ' veces</div>';
                html += '</div>';
            }
            html += '</div>';
        }

        // === Historial reciente ===
        html += '<h3 style="color:#ffd700;font-size:12px;margin:18px 0 8px;letter-spacing:1.5px;text-transform:uppercase;">'
            + (search ? ('🔎 Giros de «' + escapeHtml(search) + '» (últimos 100)') : '🏆 Quién ganó qué (últimos 100)') + '</h3>';
        const items = (history && history.items) || [];
        if (items.length === 0) {
            html += search
                ? '<div style="color:#aaa;text-align:center;padding:20px;background:rgba(255,255,255,0.03);border-radius:8px;">Sin giros para «' + escapeHtml(search) + '».</div>'
                : '<div style="color:#aaa;text-align:center;padding:20px;background:rgba(255,255,255,0.03);border-radius:8px;">Todavía nadie giró la ruleta.</div>';
        } else {
            html += '<div style="background:rgba(0,0,0,0.20);border-radius:8px;overflow:hidden;max-height:60vh;overflow-y:auto;">';
            html += '<table style="width:100%;border-collapse:collapse;font-size:11.5px;">';
            html += '<thead style="position:sticky;top:0;background:#2d0052;z-index:1;"><tr style="color:#ffd700;text-align:left;">';
            html += '<th style="padding:8px 10px;font-weight:800;">Cuándo</th>';
            html += '<th style="padding:8px 10px;font-weight:800;">Usuario</th>';
            html += '<th style="padding:8px 10px;font-weight:800;text-align:right;">Premio</th>';
            html += '<th style="padding:8px 10px;font-weight:800;text-align:center;">Estado</th>';
            html += '<th style="padding:8px 10px;font-weight:800;">tx / Acción</th>';
            html += '</tr></thead><tbody>';
            for (const it of items) {
                const when = it.spunAt ? fmtFechaHoraAR(it.spunAt) : '—';
                const statusBadge = {
                    no_prize:      '<span style="background:rgba(136,136,136,0.15);color:#aaa;border:1px solid #888;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:800;">SIN PREMIO</span>',
                    won:           '<span style="background:rgba(255,170,102,0.15);color:#ffaa66;border:1px solid #ffaa66;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:800;">⏳ PROCESANDO</span>',
                    credited:      '<span style="background:rgba(102,255,102,0.15);color:#66ff66;border:1px solid #66ff66;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:800;">✅ ACREDITADO</span>',
                    credit_failed: '<span style="background:rgba(255,128,128,0.15);color:#ff8080;border:1px solid #ff8080;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:800;">❌ FALLO</span>'
                }[it.status] || it.status;
                html += '<tr style="border-top:1px solid rgba(255,255,255,0.05);">';
                html += '<td style="padding:7px 10px;color:#aaa;font-size:10.5px;white-space:nowrap;">' + escapeHtml(when) + '</td>';
                html += '<td style="padding:7px 10px;color:#fff;font-weight:700;">' + escapeHtml(it.username || '?') + '</td>';
                html += '<td style="padding:7px 10px;text-align:right;color:' + (it.prizeARS >= 10000 ? '#ffd700' : (it.prizeARS >= 1000 ? '#ff8c5a' : (it.prizeARS > 0 ? '#aaffaa' : '#888'))) + ';font-weight:800;">' + (it.prizeARS > 0 ? fmtMoney(it.prizeARS) : '—') + '</td>';
                html += '<td style="padding:7px 10px;text-align:center;">' + statusBadge + '</td>';
                html += '<td style="padding:7px 10px;color:#888;font-size:10px;font-family:monospace;">';
                if (it.status === 'credited' && it.creditTxId) {
                    html += escapeHtml(String(it.creditTxId).slice(0, 18));
                } else if (it.status === 'credit_failed') {
                    html += '<button onclick="retryRouletteCredit(\'' + rouletteEscapeJsArg(it.id) + '\')" style="background:rgba(0,212,255,0.10);color:#00d4ff;border:1px solid rgba(0,212,255,0.40);padding:3px 8px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;">🔁 Reintentar</button>';
                } else {
                    html += '—';
                }
                html += '</td>';
                html += '</tr>';
            }
            html += '</tbody></table></div>';
        }

        body.innerHTML = html;
    } catch (e) {
        body.innerHTML = '<div style="color:#ff8080;text-align:center;padding:14px;">Error de conexión: ' + escapeHtml(e.message || '') + '</div>';
    }
}

async function retryRouletteCredit(spinId) {
    if (!confirm('¿Reintentar la acreditación de este premio? Va a llamar a JUGAYGANA para acreditar al saldo del user.')) return;
    try {
        const r = await rouletteAuthFetch('/api/admin/roulette/' + encodeURIComponent(spinId) + '/retry-credit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const d = await r.json();
        if (!r.ok || !d.success) { alert('❌ ' + (d.error || 'Error')); return; }
        showToast('✅ Acreditado · tx ' + (d.transactionId || 'OK'), 'success');
        loadRouletteAdmin();
    } catch (e) {
        alert('Error de conexión');
    }
}


// =========================================================================
// AUTOMATIZACION DE NOTIFICACIONES — panel admin (reglas + sugerencias)
// =========================================================================
// authFetch: fetch autenticado para esta seccion (la base vieja no lo tiene
// global). Agrega el Bearer y, si hay body, el Content-Type JSON.
function authFetch(url, opts) {
    const o = opts || {};
    o.headers = Object.assign({}, o.headers || {}, { 'Authorization': 'Bearer ' + currentToken });
    if (o.body && !o.headers['Content-Type']) o.headers['Content-Type'] = 'application/json';
    return fetch(API_URL + url, o);
}

// ============================================================
// CENTRAL + REEMBOLSOS — vistas de datos del admin
// ============================================================
function _centEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function _centMoney(n) {
    return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}
function _centNum(n) {
    return (Number(n) || 0).toLocaleString('es-AR');
}
function _centDate(d) {
    if (!d) return '—';
    return fmtFechaHoraAR(d) || '—';
}
function _centStatCard(icon, value, label, color) {
    return '<div class="stat-card" style="border-color:' + color + '">'
        + '<span style="font-size:1.3rem">' + icon + '</span>'
        + '<span class="stat-number" style="color:' + color + '">' + value + '</span>'
        + '<span class="stat-label">' + label + '</span></div>';
}
function _centCopyEl(btn) {
    const code = btn.parentElement.querySelector('code');
    if (!code) return;
    const txt = code.textContent;
    const done = function () {
        const orig = btn.textContent;
        btn.textContent = '✓ Copiado';
        setTimeout(function () { btn.textContent = orig; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done).catch(function () { showToast('No se pudo copiar', 'error'); });
    } else {
        showToast('Copiá el token manualmente', 'warning');
    }
}

// --- Ingresos diarios ---
async function loadCentralIngresos() {
    const body = document.getElementById('centralIngresosBody');
    if (!body) return;
    const sel = document.getElementById('centralIngresosDays');
    const days = sel ? sel.value : 30;
    body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    try {
        const r = await authFetch('/api/admin/central/ingresos?days=' + encodeURIComponent(days));
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Error');
        const rows = j.rows || [];
        const t = j.totals || { count: 0, amount: 0, avgPerDay: 0 };
        let html = '<div class="stats-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px;">';
        html += _centStatCard('💰', _centMoney(t.amount), 'Total depositado', '#ffc107');
        html += _centStatCard('💳', _centNum(t.count), 'Depósitos', '#2196f3');
        html += _centStatCard('📅', _centMoney(t.avgPerDay), 'Promedio por día', '#4caf50');
        html += '</div>';
        if (!rows.length) {
            html += '<div class="empty-state"><p>Sin depósitos en el período.</p></div>';
        } else {
            html += '<table class="data-table"><thead><tr><th>Día</th>'
                + '<th style="text-align:right;">Depósitos</th>'
                + '<th style="text-align:right;">Usuarios</th>'
                + '<th style="text-align:right;">Total</th></tr></thead><tbody>';
            rows.forEach(function (row) {
                html += '<tr><td>' + _centEsc(row.date) + '</td>'
                    + '<td style="text-align:right;">' + _centNum(row.count) + '</td>'
                    + '<td style="text-align:right;">' + _centNum(row.uniqueUsers) + '</td>'
                    + '<td style="text-align:right;color:#ffc107;font-weight:700;">' + _centMoney(row.amount) + '</td></tr>';
            });
            html += '</tbody></table>';
        }
        body.innerHTML = html;
    } catch (e) {
        body.innerHTML = '<div class="empty-state"><p>❌ ' + _centEsc(e.message) + '</p></div>';
    }
}

// --- Usuarios con app (token completo) ---
let _centAppUsers = [];
let _centAppUsersSummary = {};
async function loadCentralAppUsers() {
    const body = document.getElementById('centralAppUsersBody');
    if (!body) return;
    body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    try {
        const r = await authFetch('/api/admin/central/app-users');
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Error');
        _centAppUsers = j.users || [];
        _centAppUsersSummary = j.summary || {};
        renderCentralAppUsers();
    } catch (e) {
        body.innerHTML = '<div class="empty-state"><p>❌ ' + _centEsc(e.message) + '</p></div>';
    }
}
function renderCentralAppUsers() {
    const body = document.getElementById('centralAppUsersBody');
    if (!body) return;
    const s = _centAppUsersSummary || {};
    const searchEl = document.getElementById('centralAppUsersSearch');
    const filterEl = document.getElementById('centralAppUsersFilter');
    const q = (searchEl ? searchEl.value : '').trim().toLowerCase();
    const filter = filterEl ? filterEl.value : 'all';
    let list = _centAppUsers.slice();
    if (q) list = list.filter(function (u) { return (u.username || '').toLowerCase().indexOf(q) !== -1; });
    if (filter === 'standalone') list = list.filter(function (u) { return u.standalone; });
    if (filter === 'granted') list = list.filter(function (u) { return u.notifPermission === 'granted'; });

    let html = '<div class="stats-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px;">';
    html += _centStatCard('📱', _centNum(s.total), 'Con token FCM', '#2196f3');
    html += _centStatCard('✅', _centNum(s.standalone), 'App instalada', '#4caf50');
    html += _centStatCard('🔔', _centNum(s.granted), 'Notifs activas', '#d4af37');
    html += _centStatCard('🎁', _centNum(s.conBono), 'Cobraron bono', '#ff9800');
    html += '</div>';

    if (!list.length) {
        body.innerHTML = html + '<div class="empty-state"><p>Sin usuarios para mostrar.</p></div>';
        return;
    }
    list.forEach(function (u) { html += _centAppUserCard(u); });
    body.innerHTML = html;
}
function _centAppUserCard(u) {
    const planLabels = { suave: 'Suave', normal: 'Normal', activo: 'Activo', solo_reembolsos: 'Solo reembolsos' };
    const npColors = { granted: '#4caf50', denied: '#ff5050', default: '#ff9800' };
    const np = u.notifPermission || 'default';
    let badges = '';
    if (u.standalone) {
        badges += '<span style="background:rgba(76,175,80,0.18);color:#4caf50;font-size:9.5px;font-weight:800;padding:2px 7px;border-radius:8px;">📲 App</span>';
    } else {
        badges += '<span style="background:rgba(255,255,255,0.07);color:#888;font-size:9.5px;font-weight:800;padding:2px 7px;border-radius:8px;">🌐 Navegador</span>';
    }
    badges += '<span style="background:rgba(0,0,0,0.30);color:' + (npColors[np] || '#ff9800') + ';font-size:9.5px;font-weight:800;padding:2px 7px;border-radius:8px;">🔔 ' + _centEsc(np) + '</span>';
    if (u.installBonusClaimed) {
        badges += '<span style="background:rgba(255,152,0,0.18);color:#ff9800;font-size:9.5px;font-weight:800;padding:2px 7px;border-radius:8px;">🎁 Bono</span>';
    }
    if (u.notificationPlan) {
        badges += '<span style="background:rgba(212,175,55,0.15);color:#d4af37;font-size:9.5px;font-weight:800;padding:2px 7px;border-radius:8px;">' + _centEsc(planLabels[u.notificationPlan] || u.notificationPlan) + '</span>';
    }
    let tokensHtml = '';
    (u.tokens || []).forEach(function (t) {
        const ctx = t.context === 'standalone' ? '📲 App instalada'
            : (t.context === 'browser' ? '🌐 Navegador' : '— sin contexto');
        tokensHtml += '<div style="margin-top:8px;padding:8px;background:rgba(0,0,0,0.40);border-radius:6px;">'
            + '<div style="font-size:10px;color:#888;margin-bottom:4px;">' + ctx
            + ' · permiso: ' + _centEsc(t.notifPermission || 's/d')
            + ' · ' + _centDate(t.updatedAt) + '</div>'
            + '<code style="display:block;font-family:monospace;font-size:10px;color:#d4af37;word-break:break-all;line-height:1.45;">' + _centEsc(t.token) + '</code>'
            + '<button onclick="_centCopyEl(this)" style="margin-top:5px;background:rgba(212,175,55,0.15);color:#d4af37;border:1px solid rgba(212,175,55,0.40);border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;cursor:pointer;">Copiar token</button>'
            + '</div>';
    });
    return '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:9px;padding:11px 13px;margin-bottom:8px;">'
        + '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">'
        + '<strong style="color:#fff;font-size:13px;">' + _centEsc(u.username) + '</strong>' + badges + '</div>'
        + '<details style="margin-top:7px;">'
        + '<summary style="cursor:pointer;color:#d4af37;font-size:11px;list-style:none;">▸ Ver token completo y detalle (' + (u.tokenCount || 0) + ')</summary>'
        + '<div style="margin-top:7px;font-size:11px;color:#bbb;line-height:1.7;">'
        + 'Teléfono: ' + _centEsc(u.phone || '—')
        + ' &nbsp;·&nbsp; Último ingreso: ' + _centDate(u.lastLogin)
        + ' &nbsp;·&nbsp; Registrado: ' + _centDate(u.createdAt)
        + tokensHtml + '</div></details></div>';
}

// --- Bono por instalar la app (cupón 100% próxima carga; antes $5.000) ---
async function loadCentralWelcomeBonus() {
    const body = document.getElementById('centralWelcomeBonusBody');
    if (!body) return;
    body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    try {
        const r = await authFetch('/api/admin/central/welcome-bonus');
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Error');
        const users = j.users || [];
        const planLabels = { suave: 'Suave', normal: 'Normal', activo: 'Activo', solo_reembolsos: 'Solo reembolsos' };
        let html = '<div class="stats-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px;">';
        html += _centStatCard('🎁', _centNum(j.count), 'Lo reclamaron', '#ff9800');
        html += _centStatCard('⏳', _centNum(j.couponPending || 0), 'Cupón 100% pendiente', '#00c853');
        html += _centStatCard('✔️', _centNum(j.couponUsed || 0), 'Cupón 100% usado', '#4caf50');
        html += _centStatCard('💸', _centMoney(j.totalPaid), 'Pagado legacy ($5.000)', '#ffc107');
        html += _centStatCard('✅', _centNum(j.stillInstalled), 'Siguen con la app', '#4caf50');
        html += '</div>';
        if (!users.length) {
            html += '<div class="empty-state"><p>Todavía nadie reclamó el bono.</p></div>';
        } else {
            html += '<table class="data-table"><thead><tr><th>Usuario</th><th>Reclamó el</th><th>Bono</th>'
                + '<th>App</th><th>Notifs</th><th>Plan</th><th>Último ingreso</th></tr></thead><tbody>';
            users.forEach(function (u) {
                const appCell = u.appInstalled
                    ? '<span style="color:#4caf50;font-weight:700;">📲 Sí</span>'
                    : (u.hasToken ? '<span style="color:#ff9800;">🌐 Navegador</span>'
                        : '<span style="color:#ff5050;font-weight:700;">❌ Sin app</span>');
                const npColor = u.notifPermission === 'granted' ? '#4caf50'
                    : (u.notifPermission === 'denied' ? '#ff5050' : '#ff9800');
                const bonusCell = u.bonusKind === 'cupon'
                    ? (u.coupon100Pending
                        ? '<span style="color:#00c853;font-weight:700;">🎟️ 100% PENDIENTE</span>'
                        : '<span style="color:#8bc34a;">🎟️ 100% usado' + (u.coupon100UsedBy ? ' (' + _centEsc(u.coupon100UsedBy) + ')' : '') + '</span>')
                    : '<span style="color:#ffc107;">💸 $5.000 legacy</span>';
                html += '<tr><td><strong>' + _centEsc(u.username) + '</strong></td>'
                    + '<td>' + _centDate(u.claimedAt) + '</td>'
                    + '<td>' + bonusCell + '</td>'
                    + '<td>' + appCell + '</td>'
                    + '<td><span style="color:' + npColor + ';">' + _centEsc(u.notifPermission || 's/d') + '</span></td>'
                    + '<td>' + _centEsc(planLabels[u.notificationPlan] || u.notificationPlan || '—') + '</td>'
                    + '<td>' + _centDate(u.lastLogin) + '</td></tr>';
            });
            html += '</tbody></table>';
        }
        body.innerHTML = html;
    } catch (e) {
        body.innerHTML = '<div class="empty-state"><p>❌ ' + _centEsc(e.message) + '</p></div>';
    }
}

// --- Cuentas sospechosas (anti-multicuenta) ---
let _suspiciousData = { byPhone: [], byIp: [], byFcmToken: [], summary: {} };
let _suspiciousTab = 'phone';

async function loadSuspiciousAccounts() {
    const body = document.getElementById('suspiciousAccountsBody');
    if (!body) return;
    body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    try {
        const bonusOnly = document.getElementById('suspiciousBonusOnly');
        const qs = bonusOnly && bonusOnly.checked ? '?bonusOnly=1' : '';
        const r = await authFetch('/api/admin/suspicious-accounts' + qs);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Error');
        _suspiciousData = {
            byPhone: j.byPhone || [],
            byIp: j.byIp || [],
            byFcmToken: j.byFcmToken || [],
            summary: j.summary || {}
        };
        renderSuspiciousAccounts();
    } catch (e) {
        body.innerHTML = '<div class="empty-state"><p>❌ ' + _centEsc(e.message) + '</p></div>';
    }
}

function switchSuspiciousTab(tab) {
    _suspiciousTab = tab;
    document.querySelectorAll('[data-suspicious-tab]').forEach(function (btn) {
        const active = btn.dataset.suspiciousTab === tab;
        btn.style.background = active ? 'rgba(212,175,55,0.18)' : 'rgba(255,255,255,0.05)';
        btn.style.color = active ? '#d4af37' : '#bbb';
        btn.style.borderColor = active ? 'rgba(212,175,55,0.40)' : 'rgba(255,255,255,0.15)';
    });
    renderSuspiciousAccounts();
}

function renderSuspiciousAccounts() {
    const body = document.getElementById('suspiciousAccountsBody');
    if (!body) return;
    const s = _suspiciousData.summary || {};

    let html = '<div class="stats-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px;">';
    html += _centStatCard('👥', _centNum(s.totalUsersAffected), 'Cuentas en grupos', '#ff5050');
    html += _centStatCard('📱', _centNum(s.groupsByPhone), 'Grupos por teléfono', '#2196f3');
    html += _centStatCard('🌐', _centNum(s.groupsByIp), 'Grupos por IP', '#ff9800');
    html += _centStatCard('📲', _centNum(s.groupsByFcmToken), 'Grupos por dispositivo', '#d4af37');
    html += '</div>';

    let groups, keyLabel, keyField;
    if (_suspiciousTab === 'phone') {
        groups = _suspiciousData.byPhone;
        keyLabel = '📱 Teléfono';
        keyField = 'phone';
    } else if (_suspiciousTab === 'ip') {
        groups = _suspiciousData.byIp;
        keyLabel = '🌐 IP de registro';
        keyField = 'registrationIp';
    } else {
        groups = _suspiciousData.byFcmToken;
        keyLabel = '📲 Token FCM (dispositivo)';
        keyField = 'fcmToken';
    }

    if (!groups || !groups.length) {
        html += '<div class="empty-state"><p>✅ Sin grupos sospechosos para este criterio.</p></div>';
        body.innerHTML = html;
        return;
    }

    groups.forEach(function (g) {
        html += _suspiciousGroupCard(g, keyLabel, keyField);
    });
    body.innerHTML = html;
}

function _suspiciousGroupCard(g, keyLabel, keyField) {
    const keyVal = g[keyField];
    const fullVal = g.fcmTokenFull || keyVal;
    const users = g.users || [];
    const bonusCount = g.bonusClaimedCount || 0;
    const dangerColor = bonusCount >= 2 ? '#ff5050' : (bonusCount === 1 ? '#ff9800' : '#888');

    let usersHtml = '<table class="data-table" style="margin-top:8px;">'
        + '<thead><tr>'
        + '<th>Usuario</th>'
        + '<th>Teléfono</th>'
        + '<th>Registrado</th>'
        + '<th>Bono</th>'
        + '<th>Estado</th>'
        + '<th></th>'
        + '</tr></thead><tbody>';
    users.forEach(function (u) {
        const bonusCell = u.installBonusClaimed
            ? '<span style="color:#ff9800;font-weight:700;">🎁 ' + _centDate(u.installBonusClaimedAt) + '</span>'
            : '<span style="color:#666;">—</span>';
        const statusCell = u.isBlocked
            ? '<span style="color:#ff5050;font-weight:700;">🚫 Bloqueado</span>'
            : '<span style="color:#4caf50;">✅ Activo</span>';
        usersHtml += '<tr>'
            + '<td><strong style="color:#fff;">' + _centEsc(u.username) + '</strong></td>'
            + '<td style="color:#bbb;">' + _centEsc(u.phone || '—') + '</td>'
            + '<td style="color:#888;font-size:11px;">' + _centDate(u.createdAt) + '</td>'
            + '<td>' + bonusCell + '</td>'
            + '<td>' + statusCell + '</td>'
            + '<td><button onclick="_suspiciousOpenUser(\'' + _centEsc(u.username) + '\')" style="background:rgba(212,175,55,0.15);color:#d4af37;border:1px solid rgba(212,175,55,0.40);border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;cursor:pointer;">Ver chat</button></td>'
            + '</tr>';
    });
    usersHtml += '</tbody></table>';

    const keyDisplay = keyVal ? _centEsc(keyVal) : '<em style="color:#666;">sin dato</em>';
    const copyBtn = fullVal
        ? '<button onclick="_suspiciousCopy(this, \'' + _centEsc(String(fullVal).replace(/'/g, "\\'")) + '\')" style="margin-left:8px;background:rgba(212,175,55,0.15);color:#d4af37;border:1px solid rgba(212,175,55,0.40);border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;cursor:pointer;">📋 Copiar</button>'
        : '';

    return '<div style="background:rgba(255,255,255,0.03);border:1px solid ' + dangerColor + '55;border-radius:9px;padding:13px;margin-bottom:10px;">'
        + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">'
        + '<span style="background:rgba(255,80,80,0.18);color:' + dangerColor + ';font-size:11px;font-weight:800;padding:3px 9px;border-radius:8px;">' + g.count + ' cuentas</span>'
        + '<span style="background:rgba(255,152,0,0.18);color:#ff9800;font-size:11px;font-weight:800;padding:3px 9px;border-radius:8px;">🎁 ' + bonusCount + ' cobraron bono</span>'
        + '<span style="color:#888;font-size:11px;">' + keyLabel + ':</span>'
        + '<code style="color:#d4af37;font-family:monospace;font-size:11px;word-break:break-all;">' + keyDisplay + '</code>'
        + copyBtn
        + '</div>'
        + usersHtml
        + '</div>';
}

function _suspiciousCopy(btnEl, value) {
    try {
        navigator.clipboard.writeText(value);
        const orig = btnEl.innerText;
        btnEl.innerText = '✅ Copiado';
        setTimeout(function () { btnEl.innerText = orig; }, 1500);
    } catch (e) {
        showToast('No se pudo copiar', 'error');
    }
}

function _suspiciousOpenUser(username) {
    // Lleva a la sección Usuarios para buscar la cuenta. (Antes intentaba llamar
    // a openChatByUsername, una función que nunca existió — rama muerta eliminada.)
    switchSection('users');
    showToast('Buscá "' + username + '" en la lista de usuarios.', 'info');
}

// --- Reembolsos reclamados ---
function _centRefundCard(title, t, color) {
    t = t || {};
    const z = { count: 0, amount: 0 };
    const win = function (label, w) {
        w = w || z;
        return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;">'
            + '<span style="color:#aaa;">' + label + '</span>'
            + '<span style="color:#fff;font-weight:700;">' + _centMoney(w.amount)
            + ' <span style="color:#888;font-weight:400;">(' + (w.count || 0) + ')</span></span></div>';
    };
    return '<div style="background:rgba(255,255,255,0.03);border:1px solid ' + color + '55;border-radius:10px;padding:13px;">'
        + '<h3 style="margin:0 0 8px;color:' + color + ';font-size:13px;">' + title + '</h3>'
        + win('Últimas 24 h', t.d1)
        + win('Últimos 7 días', t.d7)
        + win('Últimos 30 días', t.d30)
        + '<div style="border-top:1px solid rgba(255,255,255,0.10);margin-top:5px;padding-top:5px;">'
        + win('Histórico', t.all) + '</div></div>';
}
// Buscador de usuario (filtra la tabla server-side; las tarjetas siguen globales).
let _reembSearchTimer = null;
function reembSearchChanged() {
    clearTimeout(_reembSearchTimer);
    _reembSearchTimer = setTimeout(loadReembolsos, 350);
}
function reembClearSearch() {
    const inp = document.getElementById('reembSearchInput');
    if (inp) inp.value = '';
    loadReembolsos();
}
async function loadReembolsos() {
    const body = document.getElementById('reembolsosBody');
    if (!body) return;
    const search = (document.getElementById('reembSearchInput')?.value || '').trim();
    const clearBtn = document.getElementById('reembSearchClear');
    if (clearBtn) clearBtn.style.display = search ? '' : 'none';
    body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    try {
        const r = await authFetch('/api/admin/reembolsos' + (search ? ('?search=' + encodeURIComponent(search)) : ''));
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Error');
        // Si el usuario siguió tipeando mientras cargaba, esta respuesta ya es vieja.
        const nowSearch = (document.getElementById('reembSearchInput')?.value || '').trim();
        if (nowSearch !== search) return;
        const types = j.types || {};
        const recent = j.recent || [];
        const typeLabels = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual' };
        let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:18px;">';
        html += _centRefundCard('📅 Diarios', types.daily, '#4caf50');
        html += _centRefundCard('📆 Semanales', types.weekly, '#2196f3');
        html += _centRefundCard('🗓️ Mensuales', types.monthly, '#d4af37');
        html += '</div>';
        html += '<h3 style="color:#d4af37;font-size:12.5px;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;">'
            + (search ? ('Reembolsos de «' + _centEsc(search) + '»') : 'Últimos reembolsos reclamados') + '</h3>';
        if (!recent.length) {
            html += search
                ? '<div class="empty-state"><p>Sin reembolsos para «' + _centEsc(search) + '».</p></div>'
                : '<div class="empty-state"><p>Todavía nadie reclamó reembolsos.</p></div>';
        } else {
            html += '<table class="data-table"><thead><tr><th>Usuario</th><th>Tipo</th>'
                + '<th style="text-align:right;">Monto</th><th style="text-align:right;">%</th>'
                + '<th>Fecha</th></tr></thead><tbody>';
            recent.forEach(function (rc) {
                html += '<tr><td><strong>' + _centEsc(rc.username) + '</strong></td>'
                    + '<td>' + _centEsc(typeLabels[rc.type] || rc.type) + '</td>'
                    + '<td style="text-align:right;color:#ffc107;font-weight:700;">' + _centMoney(rc.amount) + '</td>'
                    + '<td style="text-align:right;">' + _centNum(rc.percentage) + '%</td>'
                    + '<td>' + _centDate(rc.claimedAt) + '</td></tr>';
            });
            html += '</tbody></table>';
        }
        body.innerHTML = html;
    } catch (e) {
        body.innerHTML = '<div class="empty-state"><p>❌ ' + _centEsc(e.message) + '</p></div>';
    }
}

// ============================================================
// CONTROL DE DEMORAS DE RESPUESTA EN CHATS (SLA de atención)
// ============================================================
let _cdPage = 1;
let _cdThresholdSeconds = 120;

function _cdDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + 'm' + (s ? ' ' + s + 's' : '');
    const h = Math.floor(m / 60), mm = m % 60;
    return h + 'h' + (mm ? ' ' + mm + 'm' : '');
}

function _cdQuery() {
    const p = new URLSearchParams();
    const from = document.getElementById('cdFrom')?.value;
    const to = document.getElementById('cdTo')?.value;
    const status = document.getElementById('cdStatus')?.value;
    const cat = document.getElementById('cdCategory')?.value;
    const minMin = parseInt(document.getElementById('cdMinDelay')?.value, 10);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (status) p.set('status', status);
    if (cat) p.set('category', cat);
    if (Number.isFinite(minMin) && minMin > 0) p.set('minDelay', String(minMin * 60)); // min → seg
    p.set('page', String(_cdPage));
    p.set('limit', '50');
    return p.toString();
}

// Badge de cola (cargas/pagos) para las tablas.
function _cdCatBadge(cat) {
    if (cat === 'pagos') return '<span style="background:rgba(255,82,82,0.15);color:#ff8a8a;border:1px solid rgba(255,82,82,0.4);border-radius:5px;padding:1px 6px;font-size:10.5px;white-space:nowrap;">💸 Pagos</span>';
    if (cat === 'cargas') return '<span style="background:rgba(0,200,120,0.12);color:#7fe0a8;border:1px solid rgba(0,200,120,0.35);border-radius:5px;padding:1px 6px;font-size:10.5px;white-space:nowrap;">💳 Cargas</span>';
    // Registros viejos (anteriores al deploy del cambio): sin dato de cola.
    return '<span style="color:#888;font-size:10.5px;" title="Registro previo a la separación por cola">—</span>';
}

async function loadChatDelays() {
    const waitingEl = document.getElementById('chatDelaysWaiting');
    const histEl = document.getElementById('chatDelaysHistory');
    if (waitingEl) waitingEl.innerHTML = '<div style="color:#aaa;padding:14px;">⏳ Cargando…</div>';
    try {
        const r = await authFetch('/api/admin/chat-delays?' + _cdQuery());
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('Error ' + r.status));

        _cdThresholdSeconds = j.thresholdSeconds || 120;
        const _cdThresholdPagos = j.thresholdPagosSeconds || 1800;
        const thrInput = document.getElementById('chatDelayThresholdInput');
        if (thrInput && document.activeElement !== thrInput) {
            thrInput.value = Math.round(_cdThresholdSeconds / 60);
        }
        const thrPagosInput = document.getElementById('chatDelayThresholdPagosInput');
        if (thrPagosInput && document.activeElement !== thrPagosInput) {
            thrPagosInput.value = Math.round(_cdThresholdPagos / 60);
        }
        const hint = document.getElementById('chatDelayThresholdHint');
        if (hint) hint.textContent = '(cargas: ' + _cdDur(_cdThresholdSeconds) + ' · pagos: ' + _cdDur(_cdThresholdPagos) + ')';

        // Resumen
        const s = j.summary || {};
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('cdWaitingNow', s.waitingNowCount || 0);
        set('cdCount', s.count || 0);
        set('cdAvg', s.count ? _cdDur(s.avgDelaySeconds) : '—');
        set('cdWorst', s.count ? _cdDur(s.worstDelaySeconds) : '—');
        set('cdUnanswered', s.unansweredCount || 0);

        // Badge en el nav
        const badge = document.getElementById('chatDelaysWaitingBadge');
        if (badge) {
            if (s.waitingNowCount > 0) { badge.textContent = s.waitingNowCount; badge.classList.remove('hidden'); }
            else badge.classList.add('hidden');
        }

        renderChatDelaysWaiting(j.waiting || []);
        renderChatDelaysHistory(j.delays || []);
        renderChatDelaysPagination(j.pagination || { page: 1, pages: 1, total: 0 });
    } catch (e) {
        if (waitingEl) waitingEl.innerHTML = '<div class="empty-state"><p>❌ ' + _centEsc(e.message) + '</p></div>';
    }
}

function renderChatDelaysWaiting(waiting) {
    const el = document.getElementById('chatDelaysWaiting');
    if (!el) return;
    if (!waiting.length) {
        el.innerHTML = '<div style="color:#6fcf6f;padding:12px;background:rgba(0,255,136,0.05);border-radius:8px;">✅ Nadie esperando respuesta por encima del umbral.</div>';
        return;
    }
    let html = '<table class="data-table"><thead><tr><th>Cliente</th><th>Cola</th><th>Mensaje</th>'
        + '<th style="text-align:right;">Esperando</th><th>Asignado a</th></tr></thead><tbody>';
    waiting.forEach(function (w) {
        html += '<tr style="cursor:pointer;" onclick="openChatFromDelay(\'' + _centEsc(w.userId) + '\')">'
            + '<td><strong>' + _centEsc(w.username) + '</strong></td>'
            + '<td>' + _cdCatBadge(w.category) + '</td>'
            + '<td style="max-width:320px;color:#ccc;">' + _centEsc(w.preview || '—') + '</td>'
            + '<td style="text-align:right;color:#ffb300;font-weight:800;">' + _cdDur(w.waitingSeconds) + '</td>'
            + '<td style="color:#aaa;">' + _centEsc(w.assignedTo || '—') + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
}

function renderChatDelaysHistory(delays) {
    const el = document.getElementById('chatDelaysHistory');
    if (!el) return;
    if (!delays.length) {
        el.innerHTML = '<div class="empty-state"><p>No hay demoras registradas con este filtro.</p></div>';
        return;
    }
    let html = '<table class="data-table"><thead><tr><th>Cliente</th><th>Cola</th><th>Mensaje</th>'
        + '<th style="text-align:right;">Demora</th><th>Estado</th><th>Respondió</th>'
        + '<th>Vía</th><th>Fecha del mensaje</th></tr></thead><tbody>';
    delays.forEach(function (d) {
        const respondido = d.status === 'responded';
        const estado = respondido
            ? '<span style="color:#6fcf6f;font-weight:700;">Respondida</span>'
            : '<span style="color:#ff5252;font-weight:700;">Sin responder</span>';
        const _viaMap = { command: 'comando', message: 'mensaje', operation: 'carga/retiro' };
        const via = _viaMap[d.respondedVia] || '—';
        html += '<tr style="cursor:pointer;" onclick="openChatFromDelay(\'' + _centEsc(d.userId) + '\')">'
            + '<td><strong>' + _centEsc(d.username) + '</strong></td>'
            + '<td>' + _cdCatBadge(d.category) + '</td>'
            + '<td style="max-width:300px;color:#ccc;">' + _centEsc(d.userMessagePreview || '—') + '</td>'
            + '<td style="text-align:right;font-weight:800;color:' + (respondido ? '#ffc107' : '#ff5252') + ';">' + _cdDur(d.delaySeconds) + '</td>'
            + '<td>' + estado + '</td>'
            + '<td style="color:#ccc;">' + _centEsc(d.respondedByUsername || '—') + '</td>'
            + '<td style="color:#aaa;">' + via + '</td>'
            + '<td style="color:#aaa;white-space:nowrap;">' + fmtFechaHoraAR(d.userMessageAt) + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
}

function renderChatDelaysPagination(pag) {
    const el = document.getElementById('chatDelaysPagination');
    if (!el) return;
    const pages = pag.pages || 1;
    if (pages <= 1) { el.innerHTML = '<span style="color:#888;font-size:11px;">' + (pag.total || 0) + ' demora(s)</span>'; return; }
    const prevDis = _cdPage <= 1 ? 'disabled' : '';
    const nextDis = _cdPage >= pages ? 'disabled' : '';
    el.innerHTML =
        '<button class="btn btn-secondary btn-sm" ' + prevDis + ' onclick="chatDelaysGoPage(' + (_cdPage - 1) + ')">◀ Anterior</button>'
        + '<span style="color:#bbb;font-size:12px;">Página ' + _cdPage + ' de ' + pages + ' · ' + (pag.total || 0) + ' total</span>'
        + '<button class="btn btn-secondary btn-sm" ' + nextDis + ' onclick="chatDelaysGoPage(' + (_cdPage + 1) + ')">Siguiente ▶</button>';
}

function chatDelaysGoPage(p) {
    if (p < 1) return;
    _cdPage = p;
    loadChatDelays();
}

function applyChatDelaysFilter() {
    _cdPage = 1;
    loadChatDelays();
}

function clearChatDelaysFilter() {
    ['cdFrom', 'cdTo', 'cdMinDelay'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const st = document.getElementById('cdStatus'); if (st) st.value = '';
    const cat = document.getElementById('cdCategory'); if (cat) cat.value = '';
    _cdPage = 1;
    loadChatDelays();
}

async function saveChatDelayThreshold() {
    const mins = parseInt(document.getElementById('chatDelayThresholdInput')?.value, 10);
    const minsPagos = parseInt(document.getElementById('chatDelayThresholdPagosInput')?.value, 10);
    if (!Number.isFinite(mins) || mins < 1 || mins > 1440 || !Number.isFinite(minsPagos) || minsPagos < 1 || minsPagos > 1440) {
        showToast('Umbrales inválidos (1 a 1440 minutos cada uno)', 'error');
        return;
    }
    try {
        const r = await authFetch('/api/admin/chat-delays/config', {
            method: 'POST',
            body: JSON.stringify({ thresholdSeconds: mins * 60, thresholdPagosSeconds: minsPagos * 60 })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Error');
        showToast(`Umbrales guardados · cargas ${mins} min · pagos ${minsPagos} min`, 'success');
        loadChatDelays();
    } catch (e) {
        showToast('❌ ' + e.message, 'error');
    }
}

// Abrir el chat del cliente desde una fila de demora (va a la sección Chats).
function openChatFromDelay(userId) {
    if (!userId) return;
    switchSection('chats');
    const conv = conversations.find(c => c.userId === userId);
    if (conv) {
        selectConversation(userId, conv.username);
    } else {
        // No está en la lista actual (otra pestaña): lo seleccionamos igual por id.
        selectConversation(userId, userId);
    }
}

let _autoRulesCache = [];
let _autoSuggestionsCache = [];
let _autoActiveTab = 'rules';
let _autoEditingRuleId = null;
const _autoDayOfWeekLabels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const _autoCategoryLabels = {
    refund: 'Recordatorios de reembolso',
    welcome: 'Follow-ups de bienvenida',
    engagement: 'Engagement / por plan votado',
    recovery: 'Recuperación de inactivos',
    giveaway: 'Regalos automáticos',
    whatsapp: 'Para agentes (WhatsApp)'
};

function loadAutomations() {
    Promise.all([_autoFetchRules(), _autoFetchSuggestions()]).then(function () {
        _autoRenderActiveTab();
    });
}

async function _autoFetchRules() {
    try {
        const r = await authFetch('/api/admin/notification-rules');
        const j = await r.json();
        _autoRulesCache = j.rules || [];
    } catch (e) { console.warn('autoFetchRules', e); }
}

async function _autoFetchSuggestions() {
    try {
        const r = await authFetch('/api/admin/notification-rules/suggestions?status=pending');
        const j = await r.json();
        _autoSuggestionsCache = j.suggestions || [];
        const count = j.pendingCount || 0;
        const badge = document.getElementById('autoPendingCountBadge');
        const navBadge = document.getElementById('automationsBadge');
        if (count > 0) {
            if (badge) { badge.textContent = String(count); badge.style.display = ''; }
            if (navBadge) { navBadge.textContent = String(count); navBadge.style.display = ''; }
        } else {
            if (badge) badge.style.display = 'none';
            if (navBadge) navBadge.style.display = 'none';
        }
    } catch (e) { console.warn('autoFetchSuggestions', e); }
}

function switchAutomationsTab(tab) {
    _autoActiveTab = tab;
    document.querySelectorAll('.auto-tab-btn').forEach(function (b) {
        const isActive = b.getAttribute('data-tab') === tab;
        b.style.background = isActive ? 'rgba(212,175,55,0.15)' : 'rgba(0,0,0,0.30)';
        b.style.color = isActive ? '#d4af37' : '#aaa';
        b.style.borderColor = isActive ? 'rgba(212,175,55,0.45)' : 'rgba(255,255,255,0.10)';
    });
    _autoRenderActiveTab();
}

function _autoRenderActiveTab() {
    const c = document.getElementById('automationsContent');
    if (!c) return;
    c.innerHTML = (_autoActiveTab === 'pending') ? _autoRenderPendingTab() : _autoRenderRulesTab();
}

// ============= TAB: REGLAS =============
function _autoRenderRulesTab() {
    if (_autoRulesCache.length === 0) {
        return '<div class="empty-state" style="padding:30px;text-align:center;color:#aaa;">No hay reglas todavía. Se crean solas cuando arranca el servidor.</div>';
    }
    const byCat = {};
    for (const r of _autoRulesCache) {
        (byCat[r.category] = byCat[r.category] || []).push(r);
    }
    let html = '';
    for (const cat of Object.keys(byCat)) {
        html += '<div style="margin-bottom:16px;">';
        html += '<h4 style="color:#d4af37;font-size:12px;margin:8px 0;text-transform:uppercase;letter-spacing:1px;">' + escapeHtml(_autoCategoryLabels[cat] || cat) + ' <span style="color:#666;font-weight:400;">' + byCat[cat].length + '</span></h4>';
        html += '<div style="display:flex;flex-direction:column;gap:6px;">';
        for (const r of byCat[cat]) html += _autoRenderRuleCard(r);
        html += '</div></div>';
    }
    return html;
}

function _autoRenderRuleCard(r) {
    const enabledColor = r.enabled ? '#25d366' : '#666';
    const enabledLabel = r.enabled ? 'ACTIVA' : 'PAUSADA';
    const cs = r.cronSchedule || {};
    let when = '—';
    if (r.triggerType === 'cron' && cs.hour != null) {
        const h = String(cs.hour).padStart(2, '0');
        const m = String(cs.minute || 0).padStart(2, '0');
        when = h + ':' + m;
        if (cs.dayOfWeek != null) when = _autoDayOfWeekLabels[cs.dayOfWeek] + ' ' + when;
        else if (cs.dayOfMonth != null) when = 'Día ' + cs.dayOfMonth + ' del mes ' + when;
        else when = 'Cada día ' + when;
    }
    const lastFired = r.lastFiredAt ? fmtFechaHoraAR(r.lastFiredAt) : 'Nunca';
    const bonusBadge = (r.bonus && r.bonus.type !== 'none')
        ? '<span style="background:rgba(255,170,68,0.15);color:#ffaa44;font-size:10px;padding:2px 7px;border-radius:8px;font-weight:700;margin-left:5px;">💸 ' + r.bonus.type + ' $' + (r.bonus.amount || 0) + '</span>'
        : '';
    const apprBadge = r.requiresAdminApproval
        ? '<span style="background:rgba(255,80,80,0.15);color:#ff5050;font-size:10px;padding:2px 7px;border-radius:8px;font-weight:700;margin-left:5px;">✋ Requiere aprobar</span>'
        : '';
    const chargeBonusBadge = (r.chargeBonus && Number(r.chargeBonus.percent) > 0)
        ? '<span style="background:rgba(255,215,0,0.15);color:#ffd700;font-size:10px;padding:2px 7px;border-radius:8px;font-weight:700;margin-left:5px;">🎁 Bono ' + r.chargeBonus.percent + '% · ' + (r.chargeBonus.durationMinutes || 120) + 'min</span>'
        : '';

    return '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">' +
            '<div style="flex:1;min-width:240px;">' +
                '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;">' +
                    '<span style="background:rgba(0,212,255,0.20);color:#00d4ff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:6px;">' + escapeHtml(r.code) + '</span>' +
                    '<span style="color:' + enabledColor + ';font-size:10px;font-weight:700;">' + enabledLabel + '</span>' +
                    bonusBadge + chargeBonusBadge + apprBadge +
                '</div>' +
                '<div style="color:#fff;font-size:13px;font-weight:600;margin-bottom:3px;">' + escapeHtml(r.name) + '</div>' +
                '<div style="color:#888;font-size:11px;line-height:1.5;">⏰ ' + when + ' · 🎯 ' + escapeHtml(r.audienceType) + '</div>' +
                '<div style="color:#aaa;font-size:11px;margin-top:5px;font-style:italic;">"' + escapeHtml(r.title) + ' — ' + escapeHtml(r.body.slice(0, 80)) + (r.body.length > 80 ? '…' : '') + '"</div>' +
                '<div style="color:#666;font-size:10px;margin-top:5px;">Último disparo: ' + lastFired + ' · Total: ' + (r.totalFiresLifetime || 0) + ' envíos · ' + (r.totalSuggestionsLifetime || 0) + ' sugerencias</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button onclick="autoToggleRule(\'' + r.id + '\')" style="padding:6px 11px;font-size:11px;font-weight:700;background:' + (r.enabled ? 'rgba(255,80,80,0.15)' : 'rgba(37,211,102,0.15)') + ';color:' + (r.enabled ? '#ff5050' : '#25d366') + ';border:1px solid currentColor;border-radius:6px;cursor:pointer;">' + (r.enabled ? '⏸ Pausar' : '▶ Activar') + '</button>' +
                '<button onclick="autoEditRule(\'' + r.id + '\')" style="padding:6px 11px;font-size:11px;font-weight:700;background:rgba(0,212,255,0.15);color:#00d4ff;border:1px solid rgba(0,212,255,0.40);border-radius:6px;cursor:pointer;">✏ Editar</button>' +
                '<button onclick="autoTestFireRule(\'' + r.id + '\')" style="padding:6px 11px;font-size:11px;font-weight:700;background:rgba(155,48,255,0.15);color:#c89bff;border:1px solid rgba(155,48,255,0.40);border-radius:6px;cursor:pointer;">🧪 Probar</button>' +
            '</div>' +
        '</div>' +
    '</div>';
}

async function autoToggleRule(id) {
    const r = _autoRulesCache.find(function (x) { return x.id === id; });
    if (!r) return;
    try {
        const resp = await authFetch('/api/admin/notification-rules/' + id, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: !r.enabled })
        });
        const j = await resp.json();
        if (j.success) {
            showToast(j.rule.enabled ? '▶ Regla activada' : '⏸ Regla pausada', 'success');
            await _autoFetchRules();
            _autoRenderActiveTab();
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

function autoEditRule(id) {
    const r = _autoRulesCache.find(function (x) { return x.id === id; });
    if (!r) return;
    _autoEditingRuleId = id;
    const modal = document.getElementById('autoRuleEditModal');
    const body = document.getElementById('autoRuleEditBody');
    if (!modal || !body) return;
    body.innerHTML =
        '<div style="margin-bottom:10px;color:#888;font-size:11px;"><strong>' + escapeHtml(r.code) + '</strong> · ' + escapeHtml(r.name) + '</div>' +
        '<label style="display:block;color:#aaa;font-size:11px;margin-bottom:4px;">Título</label>' +
        '<input type="text" id="autoEditTitle" value="' + escapeHtml(r.title) + '" maxlength="60" style="width:100%;padding:9px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.4);color:#fff;font-size:13px;box-sizing:border-box;margin-bottom:10px;">' +
        '<label style="display:block;color:#aaa;font-size:11px;margin-bottom:4px;">Cuerpo del mensaje</label>' +
        '<textarea id="autoEditBody" maxlength="180" style="width:100%;padding:9px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.4);color:#fff;font-size:13px;box-sizing:border-box;margin-bottom:10px;min-height:80px;">' + escapeHtml(r.body) + '</textarea>' +
        '<div style="display:flex;gap:8px;margin-bottom:10px;">' +
            '<div style="flex:1;"><label style="display:block;color:#aaa;font-size:11px;margin-bottom:4px;">Hora ART (0-23)</label><input type="number" id="autoEditHour" value="' + ((r.cronSchedule && r.cronSchedule.hour) || 0) + '" min="0" max="23" style="width:100%;padding:9px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.4);color:#fff;font-size:13px;box-sizing:border-box;"></div>' +
            '<div style="flex:1;"><label style="display:block;color:#aaa;font-size:11px;margin-bottom:4px;">Minuto</label><input type="number" id="autoEditMinute" value="' + ((r.cronSchedule && r.cronSchedule.minute) || 0) + '" min="0" max="59" style="width:100%;padding:9px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.4);color:#fff;font-size:13px;box-sizing:border-box;"></div>' +
        '</div>' +
        '<label style="display:block;color:#aaa;font-size:11px;margin-bottom:4px;">Cooldown (minutos por usuario, default 1440 = 24h)</label>' +
        '<input type="number" id="autoEditCooldown" value="' + (r.cooldownMinutes || 1440) + '" min="0" style="width:100%;padding:9px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.4);color:#fff;font-size:13px;box-sizing:border-box;">' +
        '<div style="margin-top:12px;padding:11px;background:rgba(255,215,0,0.06);border:1px solid rgba(255,215,0,0.30);border-radius:8px;">' +
            '<div style="color:#ffd700;font-weight:800;font-size:11.5px;margin-bottom:7px;">🎁 BONO DE CARGA (opcional)</div>' +
            '<div style="color:#999;font-size:10.5px;line-height:1.5;margin-bottom:8px;">Si ponés un % mayor a 0, cada usuario que reciba este push queda con una bonificación vigente: ese % extra sobre su próxima carga, válido por 1 sola carga. El agente lo ve en el chat. 0 = sin bono.</div>' +
            '<div style="display:flex;gap:8px;">' +
                '<div style="flex:1;"><label style="display:block;color:#aaa;font-size:11px;margin-bottom:4px;">% de bono</label><input type="number" id="autoEditBonusPercent" value="' + ((r.chargeBonus && r.chargeBonus.percent) || 0) + '" min="0" max="1000" style="width:100%;padding:9px;border-radius:6px;border:1px solid rgba(255,215,0,0.30);background:rgba(0,0,0,0.4);color:#ffd700;font-weight:800;font-size:13px;box-sizing:border-box;"></div>' +
                '<div style="flex:1;"><label style="display:block;color:#aaa;font-size:11px;margin-bottom:4px;">Dura (minutos)</label><input type="number" id="autoEditBonusMins" value="' + ((r.chargeBonus && r.chargeBonus.durationMinutes) || 120) + '" min="5" style="width:100%;padding:9px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.4);color:#fff;font-size:13px;box-sizing:border-box;"></div>' +
            '</div>' +
        '</div>';
    modal.style.display = 'flex';
}

function closeAutoRuleEdit() {
    const modal = document.getElementById('autoRuleEditModal');
    if (modal) modal.style.display = 'none';
    _autoEditingRuleId = null;
}

async function saveAutoRuleEdit() {
    if (!_autoEditingRuleId) return;
    const titleEl = document.getElementById('autoEditTitle');
    const bodyEl = document.getElementById('autoEditBody');
    const title = titleEl && titleEl.value.trim();
    const body = bodyEl && bodyEl.value.trim();
    const hour = Number(document.getElementById('autoEditHour').value);
    const minute = Number(document.getElementById('autoEditMinute').value);
    const cooldown = Number(document.getElementById('autoEditCooldown').value);
    const bonusPercent = Math.max(0, Number(document.getElementById('autoEditBonusPercent').value) || 0);
    const bonusMins = Math.max(5, Number(document.getElementById('autoEditBonusMins').value) || 120);
    if (!title || !body) { showToast('Falta título o cuerpo', 'error'); return; }
    if (!isFinite(hour) || hour < 0 || hour > 23) { showToast('Hora inválida', 'error'); return; }
    const cur = _autoRulesCache.find(function (r) { return r.id === _autoEditingRuleId; });
    try {
        const resp = await authFetch('/api/admin/notification-rules/' + _autoEditingRuleId, {
            method: 'PATCH',
            body: JSON.stringify({
                title: title, body: body,
                cronSchedule: {
                    hour: hour, minute: minute,
                    dayOfWeek: cur && cur.cronSchedule ? cur.cronSchedule.dayOfWeek : null,
                    dayOfMonth: cur && cur.cronSchedule ? cur.cronSchedule.dayOfMonth : null
                },
                cooldownMinutes: cooldown,
                chargeBonus: { percent: bonusPercent, durationMinutes: bonusMins }
            })
        });
        const j = await resp.json();
        if (j.success) {
            showToast('✅ Cambios guardados', 'success');
            closeAutoRuleEdit();
            await _autoFetchRules();
            _autoRenderActiveTab();
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

async function autoTestFireRule(id) {
    try {
        const resp = await authFetch('/api/admin/notification-rules/' + id + '/test-fire', { method: 'POST' });
        const j = await resp.json();
        if (j.success) {
            const sample = (j.audienceSample || []).slice(0, 5).join(', ');
            alert('🧪 Dry run\nRegla: ' + j.ruleCode + '\nAudiencia resuelta: ' + j.audienceCount + ' usuarios\n\nMuestra: ' + (sample || '(vacío)') + '\n\nNo se envió nada.');
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// ============= TAB: PENDIENTES (sugerencias) =============
function _autoRenderPendingTab() {
    if (_autoSuggestionsCache.length === 0) {
        return '<div class="empty-state" style="padding:30px;text-align:center;color:#aaa;">✅ Sin sugerencias pendientes. Cuando una regla dispare, aparecerá acá.</div>';
    }
    let html = '<div style="display:flex;flex-direction:column;gap:14px;">';
    for (const s of _autoSuggestionsCache) {
        const ageMin = Math.floor((Date.now() - new Date(s.suggestedAt).getTime()) / 60000);
        const expHours = Math.max(0, Math.floor((new Date(s.expiresAt).getTime() - Date.now()) / 3600000));
        const bonusText = (s.bonus && s.bonus.type !== 'none')
            ? '💸 ' + s.bonus.type + ' $' + s.bonus.amount + ' x ' + s.audienceCount + ' usuarios'
            : '📢 Sin bonus, solo push';
        const audWrapId = 'sug-aud-' + s.id;
        const audList = (s.audienceUsernames || []).slice(0, 500);
        const audHtml = audList.length > 0
            ? audList.map(function (u) { return '<span style="display:inline-block;background:rgba(0,212,255,0.10);color:#9be8ff;font-size:11px;padding:3px 8px;border-radius:5px;margin:2px;">' + escapeHtml(u) + '</span>'; }).join('')
            : '<span style="color:#888;font-size:11px;">(sin usuarios en la lista)</span>';
        const audMore = (s.audienceUsernames && s.audienceUsernames.length > 500)
            ? '<div style="margin-top:6px;color:#888;font-size:10px;">+ ' + (s.audienceUsernames.length - 500) + ' usuarios más (no mostrados)</div>'
            : '';

        html += '<div style="background:rgba(255,170,68,0.05);border:1px solid rgba(255,170,68,0.30);border-radius:10px;padding:14px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
                '<div style="flex:1;min-width:240px;">' +
                    '<div style="margin-bottom:5px;">' +
                        '<span style="background:rgba(0,212,255,0.20);color:#00d4ff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:6px;">' + escapeHtml(s.ruleCode) + '</span> ' +
                        '<span style="color:#888;font-size:11px;margin-left:4px;">hace ' + ageMin + ' min · expira en ' + expHours + 'h</span>' +
                    '</div>' +
                    '<div style="color:#fff;font-size:13px;font-weight:600;margin-bottom:3px;">' + escapeHtml(s.ruleName) + '</div>' +
                    '<div style="color:#ffaa44;font-size:11px;font-weight:700;">' + bonusText + '</div>' +
                '</div>' +
            '</div>' +
            '<div style="margin-bottom:10px;">' +
                '<label style="display:block;color:#aaa;font-size:11px;font-weight:700;margin-bottom:4px;">Título</label>' +
                '<input id="sug-title-' + s.id + '" type="text" maxlength="200" value="' + escapeHtml(s.title) + '" style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.30);color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:6px;font-size:13px;box-sizing:border-box;" />' +
            '</div>' +
            '<div style="margin-bottom:10px;">' +
                '<label style="display:block;color:#aaa;font-size:11px;font-weight:700;margin-bottom:4px;">Cuerpo</label>' +
                '<textarea id="sug-body-' + s.id + '" maxlength="1000" rows="3" style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.30);color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:6px;font-size:13px;resize:vertical;box-sizing:border-box;">' + escapeHtml(s.body) + '</textarea>' +
            '</div>' +
            '<div style="margin-bottom:10px;">' +
                '<button onclick="autoToggleAudience(\'' + s.id + '\')" style="padding:6px 12px;font-size:11px;font-weight:700;background:rgba(0,212,255,0.10);color:#00d4ff;border:1px solid rgba(0,212,255,0.30);border-radius:6px;cursor:pointer;">👥 Ver afectados (' + s.audienceCount + ')</button>' +
                '<div id="' + audWrapId + '" style="display:none;margin-top:8px;padding:8px;background:rgba(0,0,0,0.20);border-radius:6px;max-height:200px;overflow-y:auto;">' +
                    audHtml + audMore +
                '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button onclick="autoSaveSuggestionEdits(\'' + s.id + '\')" style="padding:8px 14px;font-size:12px;font-weight:700;background:rgba(0,212,255,0.15);color:#00d4ff;border:1px solid rgba(0,212,255,0.40);border-radius:7px;cursor:pointer;">💾 Guardar cambios</button>' +
                '<button onclick="autoApproveSuggestion(\'' + s.id + '\')" style="padding:8px 14px;font-size:12px;font-weight:700;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;border:none;border-radius:7px;cursor:pointer;">✅ Aprobar y enviar</button>' +
                '<button onclick="autoRejectSuggestion(\'' + s.id + '\')" style="padding:8px 14px;font-size:12px;font-weight:700;background:rgba(255,80,80,0.15);color:#ff5050;border:1px solid rgba(255,80,80,0.40);border-radius:7px;cursor:pointer;">❌ Descartar</button>' +
            '</div>' +
        '</div>';
    }
    html += '</div>';
    return html;
}

function autoToggleAudience(id) {
    const el = document.getElementById('sug-aud-' + id);
    if (!el) return;
    el.style.display = (el.style.display === 'none' || !el.style.display) ? 'block' : 'none';
}

async function autoSaveSuggestionEdits(id) {
    const s = _autoSuggestionsCache.find(function (x) { return x.id === id; });
    if (!s) return;
    const tEl = document.getElementById('sug-title-' + id);
    const bEl = document.getElementById('sug-body-' + id);
    if (!tEl || !bEl) return;
    const title = (tEl.value || '').trim();
    const body = (bEl.value || '').trim();
    if (!title || !body) {
        showToast('Título y cuerpo no pueden estar vacíos', 'error');
        return;
    }
    if (title === s.title && body === s.body) {
        showToast('No hay cambios para guardar', 'info');
        return;
    }
    try {
        const resp = await authFetch('/api/admin/notification-rules/suggestions/' + id, {
            method: 'PUT',
            body: JSON.stringify({ title: title, body: body })
        });
        const j = await resp.json();
        if (j.success) {
            s.title = j.title;
            s.body = j.body;
            showToast('✅ Cambios guardados', 'success');
        } else {
            showToast(j.error || 'Error guardando', 'error');
        }
    } catch (e) {
        showToast('Error de conexión', 'error');
    }
}

async function autoApproveSuggestion(id) {
    const s = _autoSuggestionsCache.find(function (x) { return x.id === id; });
    if (!s) return;
    if (!confirm('¿Aprobar y enviar?\n\n' + s.audienceCount + ' usuarios recibirán: "' + s.title + '"')) return;
    try {
        const resp = await authFetch('/api/admin/notification-rules/suggestions/' + id + '/approve', { method: 'POST' });
        const j = await resp.json();
        if (j.success) {
            let msg = '✅ Push enviado · ' + (j.pushDelivered || 0) + ' entregados, ' + (j.pushFailed || 0) + ' con token inválido';
            if (j.sendError) msg = '⚠️ Aprobada pero envío falló: ' + j.sendError;
            showToast(msg, j.sendError ? 'error' : 'success');
            await _autoFetchSuggestions();
            _autoRenderActiveTab();
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

async function autoRejectSuggestion(id) {
    const reason = prompt('Razón del descarte (opcional):', '');
    if (reason === null) return;
    try {
        const resp = await authFetch('/api/admin/notification-rules/suggestions/' + id + '/reject', {
            method: 'POST',
            body: JSON.stringify({ reason: reason })
        });
        const j = await resp.json();
        if (j.success) {
            showToast('Descartada', 'info');
            await _autoFetchSuggestions();
            _autoRenderActiveTab();
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}


// =========================================================================
// RESEÑAS — panel admin de moderación (aprobar / ocultar / borrar)
// =========================================================================
let _reviewsCache = [];
let _reviewsFilter = 'all';

function loadReviews() {
    _reviewsFetch();
}

async function _reviewsFetch() {
    const body = document.getElementById('reviewsAdminBody');
    if (body) body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    try {
        const r = await authFetch('/api/admin/reviews?status=' + _reviewsFilter);
        const j = await r.json();
        _reviewsCache = j.items || [];
        const navBadge = document.getElementById('reviewsBadge');
        if (navBadge) {
            if (j.pendingCount > 0) { navBadge.textContent = String(j.pendingCount); navBadge.style.display = ''; }
            else navBadge.style.display = 'none';
        }
        _reviewsRender();
    } catch (e) {
        if (body) body.innerHTML = '<div style="color:#ff8080;text-align:center;padding:14px;">Error de conexión</div>';
    }
}

function reviewsSetFilter(f) {
    _reviewsFilter = f;
    document.querySelectorAll('.reviews-filter-btn').forEach(function (b) {
        const on = b.getAttribute('data-f') === f;
        b.style.background = on ? 'rgba(212,175,55,0.15)' : 'rgba(0,0,0,0.30)';
        b.style.color = on ? '#d4af37' : '#aaa';
        b.style.borderColor = on ? 'rgba(212,175,55,0.45)' : 'rgba(255,255,255,0.10)';
    });
    _reviewsFetch();
}

function _reviewStarsTxt(n) {
    const v = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    let h = '';
    for (let i = 1; i <= 5; i++) h += (i <= v ? '★' : '☆');
    return h;
}

function _reviewsRender() {
    const body = document.getElementById('reviewsAdminBody');
    if (!body) return;
    if (_reviewsCache.length === 0) {
        body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">No hay reseñas para este filtro.</div>';
        return;
    }
    let html = '<div style="display:flex;flex-direction:column;gap:8px;">';
    for (const r of _reviewsCache) {
        const when = r.createdAt ? fmtFechaHoraAR(r.createdAt) : '';
        const bucketColor = r.bucket === 'bueno' ? '#25d366' : (r.bucket === 'regular' ? '#ffaa44' : '#ff5050');
        html += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,255,255,0.08);border-left:3px solid ' + bucketColor + ';border-radius:9px;padding:11px;">';
        html += '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start;">';
        html += '<div style="flex:1;min-width:220px;">';
        html += '<div style="margin-bottom:3px;"><span style="color:#ffd700;font-size:14px;">' + _reviewStarsTxt(r.stars) + '</span> <strong style="color:#fff;font-size:12px;margin-left:6px;">' + escapeHtml(r.username) + '</strong>';
        html += r.approved
            ? ' <span style="background:rgba(37,211,102,0.15);color:#25d366;font-size:9px;font-weight:800;padding:1px 6px;border-radius:6px;">PUBLICADA</span>'
            : ' <span style="background:rgba(255,170,68,0.15);color:#ffaa44;font-size:9px;font-weight:800;padding:1px 6px;border-radius:6px;">PENDIENTE</span>';
        html += '</div>';
        html += '<div style="color:#ddd;font-size:12px;line-height:1.4;">"' + escapeHtml(r.comment || '(sin comentario)') + '"</div>';
        if (r.contactPhone) html += '<div style="color:#888;font-size:10px;margin-top:3px;">📞 ' + escapeHtml(r.contactPhone) + '</div>';
        html += '<div style="color:#666;font-size:10px;margin-top:3px;">' + escapeHtml(when) + '</div>';
        html += '</div>';
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        if (r.approved) {
            html += '<button onclick="reviewSetApproved(\'' + r.id + '\',false)" style="padding:6px 10px;font-size:11px;font-weight:700;background:rgba(255,170,68,0.15);color:#ffaa44;border:1px solid rgba(255,170,68,0.40);border-radius:6px;cursor:pointer;">👁 Ocultar</button>';
        } else {
            html += '<button onclick="reviewSetApproved(\'' + r.id + '\',true)" style="padding:6px 10px;font-size:11px;font-weight:700;background:rgba(37,211,102,0.15);color:#25d366;border:1px solid rgba(37,211,102,0.40);border-radius:6px;cursor:pointer;">✅ Aprobar</button>';
        }
        html += '<button onclick="reviewDelete(\'' + r.id + '\')" style="padding:6px 10px;font-size:11px;font-weight:700;background:rgba(255,80,80,0.15);color:#ff5050;border:1px solid rgba(255,80,80,0.40);border-radius:6px;cursor:pointer;">🗑</button>';
        html += '</div></div></div>';
    }
    html += '</div>';
    body.innerHTML = html;
}

async function reviewSetApproved(id, approved) {
    try {
        const r = await authFetch('/api/admin/reviews/' + id + '/approve', {
            method: 'POST',
            body: JSON.stringify({ approved: approved })
        });
        const j = await r.json();
        if (j.success) {
            showToast(approved ? '✅ Reseña publicada' : '👁 Reseña ocultada', 'success');
            _reviewsFetch();
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

async function reviewDelete(id) {
    if (!confirm('¿Borrar esta reseña? No se puede deshacer.')) return;
    try {
        const r = await authFetch('/api/admin/reviews/' + id, { method: 'DELETE' });
        const j = await r.json();
        if (j.success) {
            showToast('Reseña borrada', 'info');
            _reviewsFetch();
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}


// =========================================================================
// BONO DE CARGA — banner en el chat del admin (lo ve el agente que contesta).
// =========================================================================
async function loadChatPromoBonus(username) {
    const el = document.getElementById('chatPromoBonusBanner');
    if (!el) return;
    el.style.display = '';
    el.style.padding = '8px 14px';
    el.style.fontSize = '12px';
    el.style.borderBottom = '1px solid rgba(0,0,0,0.30)';
    el.style.background = 'rgba(0,0,0,0.20)';
    el.innerHTML = '<span style="color:#888;">⏳ Verificando promoción…</span>';
    if (!username) { el.style.display = 'none'; return; }
    try {
        const r = await authFetch('/api/admin/promo-bonus?username=' + encodeURIComponent(username));
        const j = await r.json();
        const b = j && j.bonus;
        if (!b) {
            el.style.background = 'rgba(120,120,120,0.18)';
            el.innerHTML = '<span style="color:#bbb;">🚫 Sin promoción vigente para este cliente.</span>';
            return;
        }
        const mins = Math.max(0, Math.round((new Date(b.expiresAt).getTime() - Date.now()) / 60000));
        const minsTxt = mins >= 120 ? Math.round(mins / 60) + ' hs' : mins + ' min';
        // Lotes con regalo (2026-08-10): pueden ser % o REGALO de $ fijo — el
        // agente lo suma en la carga igual que un %. El origen muestra el lote.
        const esFijo = Number(b.montoFijoARS) > 0 && !(Number(b.percent) > 0);
        const origen = b.sourceRuleCode === 'lote'
            ? escapeHtml(b.sourceRuleName || 'lote')
            : 'regla ' + escapeHtml(b.sourceRuleCode || '-');
        // #263: bono de lote AUTOMÁTICO — lo aplica el sistema en la carga
        // (manual sin bonus / hgcash). El cartel es informativo: no hay que
        // marcar nada; el botón solo CANCELA el bono si hiciera falta.
        if (b.autoApply) {
            const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
            const franja = (b.applyFromMin != null && b.applyToMin != null) ? ' de ' + hm(b.applyFromMin) + ' a ' + hm(b.applyToMin) + ' (hora AR)' : '';
            const alcance = b.applyScope === 'all'
                ? 'en TODAS sus cargas' + franja + ' hasta que venza · aplicado ' + (b.usesCount || 0) + ' ' + ((b.usesCount || 0) === 1 ? 'vez' : 'veces')
                : 'en su PRÓXIMA carga' + franja;
            el.style.background = 'linear-gradient(90deg,#0b6e8f,#084d66)';
            el.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:#fff;">' +
                '<span style="font-size:18px;">⚡</span>' +
                '<div style="flex:1;min-width:120px;"><strong style="font-size:13px;">BONO AUTOMÁTICO: +' + b.percent + '% ' + alcance + '</strong>' +
                '<div style="font-size:11px;opacity:0.9;">Se suma SOLO al cargar (transferencia automática o carga manual sin bonus) — NO hay que marcar nada · ' + (b.rolloverX != null ? (b.rolloverX > 0 ? 'rollover x' + b.rolloverX : 'sin rollover') : 'rollover global') + ' · Vence en ' + minsTxt + ' · ' + origen + '</div></div>' +
                '<button onclick="markChatPromoBonusUsed(\'' + b.id + '\', true)" style="background:rgba(255,255,255,0.85);color:#7a1f1f;border:none;border-radius:7px;padding:6px 11px;font-weight:800;font-size:11.5px;cursor:pointer;">✕ Cancelar bono</button>' +
                '</div>';
            return;
        }
        const tituloBono = esFijo
            ? 'REGALO PENDIENTE: $' + Number(b.montoFijoARS).toLocaleString('es-AR') + ' — sumáselo en su próxima carga'
            : 'BONO VIGENTE: ' + b.percent + '% en la carga';
        el.style.background = 'linear-gradient(90deg,#0f8a2f,#0a6b25)';
        el.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:#fff;">' +
            '<span style="font-size:18px;">🎁</span>' +
            '<div style="flex:1;min-width:120px;"><strong style="font-size:13px;">' + tituloBono + '</strong>' +
            '<div style="font-size:11px;opacity:0.9;">Vence en ' + minsTxt + ' · ' + origen + '</div></div>' +
            '<button onclick="markChatPromoBonusUsed(\'' + b.id + '\')" style="background:#fff;color:#0a7a2f;border:none;border-radius:7px;padding:6px 11px;font-weight:800;font-size:11.5px;cursor:pointer;">✓ Marcar usado</button>' +
            '</div>';
    } catch (e) {
        el.style.display = 'none';
    }
}


async function markChatPromoBonusUsed(id, esCancelar) {
    const msg = esCancelar
        ? '¿CANCELAR el bono automático? El cliente deja de recibir el % en sus cargas desde ahora.'
        : '¿Marcar el bono como usado? Vale por 1 sola carga — después de esto el cliente no lo tiene más.';
    if (!confirm(msg)) return;
    try {
        const r = await authFetch('/api/admin/promo-bonus/' + id + '/use', { method: 'POST' });
        const j = await r.json();
        if (j.success) {
            showToast('Bono marcado como usado', 'success');
            const el = document.getElementById('chatPromoBonusBanner');
            if (el) {
                el.style.background = 'rgba(120,120,120,0.18)';
                el.innerHTML = '<span style="color:#bbb;">🚫 Sin promoción vigente para este cliente.</span>';
            }
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}


function updateGiftBatchModeUI() {
    const mode = document.querySelector('input[name="giftBatchMode"]:checked');
    const wrap = document.getElementById('giftBatchCodeWrap');
    if (wrap) wrap.style.display = (mode && mode.value === 'window') ? 'none' : '';
    updateGiftBatchTypeUI();
}

// El rollover aplica a todo regalo de FICHAS (siempre se acreditan solas:
// por código al canjear, por tiempo al enviarse el lote). Con % se oculta.
function updateGiftBatchTypeUI() {
    const tipo = (document.querySelector('input[name="giftBatchType"]:checked') || {}).value || 'percent';
    const wrap = document.getElementById('giftBatchRolloverWrap');
    // #263: cómo se aplica el % (auto / agente), alcance y franja horaria.
    const applyWrap = document.getElementById('giftBatchApplyWrap');
    if (applyWrap) applyWrap.style.display = (tipo === 'percent') ? '' : 'none';
    const apply = (document.querySelector('input[name="giftBatchApply"]:checked') || {}).value || 'auto';
    // Rollover: fichas siempre; % solo si es automático (el agente pone el suyo).
    if (wrap) wrap.style.display = (tipo === 'fixed' || apply === 'auto') ? '' : 'none';
    const scope = (document.querySelector('input[name="giftBatchScope"]:checked') || {}).value || 'first';
    const scopeW = document.getElementById('giftBatchScopeWrap');
    const winW = document.getElementById('giftBatchWindowWrap');
    if (scopeW) scopeW.style.display = apply === 'auto' ? '' : 'none';
    if (winW) winW.style.display = apply === 'auto' ? 'flex' : 'none';
    const hint = document.getElementById('giftBatchApplyHint');
    if (hint) {
        const from = (document.getElementById('giftBatchApplyFrom') || {}).value || '';
        const to = (document.getElementById('giftBatchApplyTo') || {}).value || '';
        const franja = (from && to) ? ' solo entre las ' + from + ' y las ' + to + ' (hora AR)' : '';
        hint.textContent = apply === 'agent'
            ? 'Modo viejo: el cajero ve el cartel verde y suma el % a mano.'
            : scope === 'all'
                ? '⚡ Se suma solo en TODAS las cargas del cliente' + franja + ', hasta que venza la vigencia. Nadie tiene que marcar nada.'
                : '⚡ Se suma solo en la PRIMERA carga del cliente' + franja + ' (después queda consumido). Nadie tiene que marcar nada.';
    }
}

function updateGiftBatchSegHint() {
    const base = (document.getElementById('giftBatchSegBase') || {}).value || 'nodeposit';
    const h = document.getElementById('giftBatchSegHint');
    if (!h) return;
    h.textContent = base === 'nodeposit'
        ? 'Ex-cargadores: cargaron alguna vez y su ÚLTIMA carga fue hace ≥ X días. Van primero los que cargaron más recientemente.'
        : base === 'deposited'
            ? 'Cargadores activos: su última carga fue dentro de los últimos X días. Van primero los que más $ cargaron.'
            : 'Sin entrar a la app hace ≥ X días (o nunca). Van primero los más recientes (más probables de volver).';
}

function updateGiftBatchAudienceUI() {
    const aud = (document.querySelector('input[name="giftBatchAudience"]:checked') || {}).value || 'list';
    const listW = document.getElementById('giftBatchListWrap');
    const inacW = document.getElementById('giftBatchInactiveWrap');
    const allN = document.getElementById('giftBatchAllNote');
    const pubW = document.getElementById('giftBatchPublicWrap');
    if (listW) listW.style.display = aud === 'list' ? '' : 'none';
    if (inacW) inacW.style.display = aud === 'inactive' ? 'flex' : 'none';
    if (aud === 'inactive') updateGiftBatchSegHint();
    if (allN) allN.style.display = aud === 'all' ? '' : 'none';
    if (pubW) pubW.style.display = aud === 'public' ? '' : 'none';
    // Código público: siempre es "con código" (no hay a quién notificar) →
    // forzar el modo y ocultar la fila de modo para no confundir.
    if (aud === 'public') {
        const codeRadio = document.querySelector('input[name="giftBatchMode"][value="code"]');
        if (codeRadio) codeRadio.checked = true;
        updateGiftBatchModeUI();
    }
    const modeRadios = document.querySelectorAll('input[name="giftBatchMode"]');
    modeRadios.forEach((r) => { r.disabled = aud === 'public' && r.value === 'window'; });
}

// Arma la parte de AUDIENCIA del body (compartida por preview y envío).
// Devuelve null si falta algo (ya avisa con toast).
function _giftBatchAudiencePayload() {
    const aud = (document.querySelector('input[name="giftBatchAudience"]:checked') || {}).value || 'list';
    if (aud === 'list') {
        const usernames = _giftBatchUsernames();
        if (!usernames.length) { showToast('Pegá al menos un username', 'error'); return null; }
        return { audienceType: 'list', usernames };
    }
    if (aud === 'inactive') {
        // #263: segmento fino (base + mín. cargas + mín. $ + publicista + cupo)
        const days = Number((document.getElementById('giftBatchInactiveDays') || {}).value);
        if (!Number.isFinite(days) || days < 1) { showToast('Poné los días (X)', 'error'); return null; }
        const limitRaw = ((document.getElementById('giftBatchInactiveLimit') || {}).value || '').trim();
        const v = (id) => ((document.getElementById(id) || {}).value || '').trim();
        return {
            audienceType: 'segment',
            segBase: v('giftBatchSegBase') || 'nodeposit',
            audienceDays: days,
            minDeposits: v('giftBatchMinDeposits') === '' ? null : Number(v('giftBatchMinDeposits')),
            minTotalArs: v('giftBatchMinTotal') === '' ? null : Number(v('giftBatchMinTotal')),
            campaign: v('giftBatchCampaign'),
            audienceLimit: limitRaw === '' ? null : Number(limitRaw)
        };
    }
    if (aud === 'public') {
        const maxRaw = ((document.getElementById('giftBatchMaxClaims') || {}).value || '').trim();
        return { audienceType: 'public', maxClaims: maxRaw === '' ? null : Number(maxRaw) };
    }
    return { audienceType: 'all' };
}

function _giftBatchSegmentTxt(a) {
    const base = a.segBase === 'nologin' ? ('sin entrar ≥' + a.audienceDays + 'd')
        : a.segBase === 'deposited' ? ('cargaron en los últimos ' + a.audienceDays + 'd')
        : ('sin cargar ≥' + a.audienceDays + 'd');
    const ex = [];
    if (a.minDeposits > 0) ex.push('≥' + a.minDeposits + ' cargas');
    if (a.minTotalArs > 0) ex.push('≥$' + Number(a.minTotalArs).toLocaleString('es-AR'));
    if (a.campaign) ex.push('publicista ' + a.campaign);
    return base + (ex.length ? ' · ' + ex.join(' · ') : '') + (a.audienceLimit ? ' (cupo ' + a.audienceLimit + ')' : '');
}

function genGiftBatchCode() {
    const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 8; i++) c += AB[Math.floor(Math.random() * AB.length)];
    const input = document.getElementById('giftBatchCode');
    if (input) input.value = c;
}

function _giftBatchUsernames() {
    const raw = (document.getElementById('giftBatchUsers') || {}).value || '';
    return raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

function _giftBatchChannelChip(ch) {
    if (ch === 'app') return '<span style="color:#00ff88;">📱 app</span>';
    if (ch === 'browser') return '<span style="color:#4fc3f7;">🌐 navegador</span>';
    return '<span style="color:#ff9d76;">🔕 sin notis</span>';
}

// Corre el preview y devuelve el json (o null). renderInBox=true lo pinta.
async function _runGiftBatchPreview(renderInBox) {
    const audience = _giftBatchAudiencePayload();
    if (!audience) return null;
    const box = document.getElementById('giftBatchPreview');
    if (renderInBox && box) box.innerHTML = '<p style="color:#888;font-size:.82rem">Armando la audiencia...</p>';
    try {
        const r = await authFetch('/api/admin/notif-batches/preview', {
            method: 'POST', body: JSON.stringify(audience)
        });
        const j = await r.json();
        if (!r.ok) { if (renderInBox && box) box.innerHTML = ''; showToast(j.error || 'No se pudo validar', 'error'); return null; }
        if (renderInBox && box) {
            const t = j.totals || {};
            let html = '<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:.75rem;font-size:.82rem;">' +
                '<div style="margin-bottom:.5rem;color:#ccc;"><b>' + t.ok + '</b> destinatarios — ' +
                '📱 ' + t.app + ' con app · 🌐 ' + t.browser + ' navegador · 🔕 <b style="color:#ff9d76;">' + t.none + ' SIN notis</b> (solo les llega el mensaje al chat)</div>' +
                '<div style="display:flex;flex-wrap:wrap;gap:.35rem;">' +
                (j.users || []).map((u) => '<span style="background:rgba(0,0,0,0.3);border-radius:6px;padding:2px 8px;">' + escapeHtml(u.username) + ' ' + _giftBatchChannelChip(u.channel) + '</span>').join('') +
                '</div>';
            if (j.truncated) {
                html += '<div style="margin-top:.4rem;color:#999;">… y ' + j.truncated + ' más (los totales de arriba son completos).</div>';
            }
            if (j.notFound && j.notFound.length) {
                html += '<div style="margin-top:.5rem;color:#ff6b6b;">❌ No existen: ' + j.notFound.map(escapeHtml).join(', ') + '</div>';
            }
            if (j.skipped && j.skipped.length) {
                html += '<div style="margin-top:.25rem;color:#ffaa44;">🚫 Bloqueados (no se les envía): ' + j.skipped.map(escapeHtml).join(', ') + '</div>';
            }
            html += '</div>';
            box.innerHTML = html;
        }
        return j;
    } catch (e) {
        if (renderInBox && box) box.innerHTML = '';
        showToast('Error de conexión', 'error');
        return null;
    }
}

async function previewGiftBatch() { await _runGiftBatchPreview(true); }

async function sendGiftBatch() {
    const mode = (document.querySelector('input[name="giftBatchMode"]:checked') || {}).value || 'code';
    const giftType = (document.querySelector('input[name="giftBatchType"]:checked') || {}).value || 'percent';
    const amount = Number((document.getElementById('giftBatchAmount') || {}).value);
    const validHours = Number((document.getElementById('giftBatchHours') || {}).value);
    const message = ((document.getElementById('giftBatchMessage') || {}).value || '').trim();
    if (!Number.isFinite(amount) || amount < 1) { showToast('Poné el monto del regalo (% o $)', 'error'); return; }
    if (!Number.isFinite(validHours) || validHours < 1 || validHours > 168) { showToast('La vigencia va de 1 a 168 horas', 'error'); return; }
    const audience = _giftBatchAudiencePayload();
    if (!audience) return;
    const esPublico = audience.audienceType === 'public';
    if (!esPublico && message.length < 5) { showToast('Escribí el mensaje (mínimo 5 caracteres)', 'error'); return; }
    // El conteo REAL sale del server (para inactivos/todos no se sabe
    // client-side). El código público no tiene audiencia que validar.
    let count = 0;
    if (!esPublico) {
        const prev = await _runGiftBatchPreview(false);
        if (!prev) return;
        count = (prev.totals && prev.totals.ok) || 0;
        if (!count) { showToast('La audiencia quedó vacía', 'error'); return; }
    }
    const rolloverX = 0; // JUGAYGANA: sin rollover
    const esFichas = giftType === 'fixed';
    // #263: aplicación del %
    const applyMode = (document.querySelector('input[name="giftBatchApply"]:checked') || {}).value || 'auto';
    const applyScope = (document.querySelector('input[name="giftBatchScope"]:checked') || {}).value || 'first';
    const applyFrom = ((document.getElementById('giftBatchApplyFrom') || {}).value || '').trim();
    const applyTo = ((document.getElementById('giftBatchApplyTo') || {}).value || '').trim();
    if (!esFichas && applyMode === 'auto' && ((applyFrom && !applyTo) || (!applyFrom && applyTo))) {
        showToast('La franja horaria necesita DESDE y HASTA (o dejá los dos vacíos)', 'error'); return;
    }
    const franjaTxt = (applyFrom && applyTo) ? ' de ' + applyFrom + ' a ' + applyTo + ' (hora AR)' : '';
    const regaloTxt = giftType === 'percent'
        ? (applyMode === 'agent'
            ? ('+' + amount + '% en próxima carga (lo aplica el agente, cartel verde)')
            : ('+' + amount + '% AUTOMÁTICO en ' + (applyScope === 'all' ? 'TODAS sus cargas' : 'su PRIMERA carga') + franjaTxt + ' — se suma solo, nadie marca nada · bono con ' + (rolloverX > 0 ? 'rollover x' + rolloverX : 'SIN rollover (retirable)')))
        : ('$' + amount.toLocaleString('es-AR') + ' en fichas — SE ACREDITAN SOLAS');
    const modoTxt = mode === 'code' ? 'CON CÓDIGO (solo los del lote pueden canjearlo)' : ('POR TIEMPO (' + validHours + 'hs)');
    const audTxt = esPublico ? ('📣 CÓDIGO PÚBLICO — cualquier cliente registrado' + (audience.maxClaims ? ' (cupo ' + audience.maxClaims + ' canjes)' : ' (SIN cupo)')) :
        audience.audienceType === 'all' ? '🌍 LOTE COMPLETO' :
        audience.audienceType === 'segment' ? ('🎯 ' + _giftBatchSegmentTxt(audience)) :
        audience.audienceType === 'inactive' ? ('😴 inactivos ≥' + audience.audienceDays + ' días' + (audience.audienceLimit ? ' (cupo ' + audience.audienceLimit + ')' : '')) :
        '📋 lista pegada';
    let notaFinal;
    if (esPublico && esFichas) {
        notaFinal = '⚠️ Cualquier cliente que consiga el código recibe $' + amount.toLocaleString('es-AR') + ' AUTOMÁTICO (una vez por cuenta' + (audience.maxClaims ? ', máx ' + audience.maxClaims + ' canjes en total' : ', SIN CUPO TOTAL — pensalo bien') + '). Los topes anti-abuso por usuario aplican igual.';
    } else if (esPublico) {
        notaFinal = 'Cualquier cliente que consiga el código activa su +' + amount + '% (cartel verde al agente), una vez por cuenta.';
    } else if (esFichas && mode === 'code') {
        notaFinal = '⚠️ La plata se acredita AUTOMÁTICAMENTE cuando cada uno canjea su código — sin intervención del agente.';
    } else if (esFichas) {
        notaFinal = '🚨 ATENCIÓN: se le acreditan $' + amount.toLocaleString('es-AR') + ' A CADA UNO apenas se envíe el lote — TOTAL ≈ $' + (amount * count).toLocaleString('es-AR') + ', automático, sin intervención del agente.';
    } else if (applyMode === 'auto') {
        notaFinal = '⚡ El % se suma SOLO cuando cada cliente carga (transferencia automática o carga manual sin bonus)' + (applyScope === 'all' ? ', en TODAS sus cargas' : ', una sola vez') + franjaTxt + ', hasta que venza la vigencia. Nadie tiene que marcar nada.';
    } else {
        notaFinal = 'El regalo lo aplicás VOS en la carga (cartel verde del chat).';
    }
    const confirmMsg = esPublico
        ? '¿Crear el código público?\n\nRegalo: ' + regaloTxt + '\nAudiencia: ' + audTxt + '\nVigencia: ' + validHours + 'hs\n\n' + notaFinal + ' No se envía ninguna notificación: el código lo subís vos a Telegram/redes.'
        : '¿Enviar el lote?\n\nRegalo: ' + regaloTxt + '\nModo: ' + modoTxt + '\nAudiencia: ' + audTxt + '\nDestinatarios: ' + count + '\n\n' + notaFinal + ' El envío sale en segundo plano y se reanuda solo si el server se reinicia.';
    if (!confirm(confirmMsg)) return;
    const btn = document.getElementById('giftBatchSendBtn');
    const st = document.getElementById('giftBatchStatus');
    if (btn) btn.disabled = true;
    if (st) st.textContent = 'Enviando...';
    try {
        const r = await authFetch('/api/admin/notif-batches', {
            method: 'POST',
            body: JSON.stringify({
                mode, giftType, amount, validHours, message, rolloverX,
                applyMode, applyScope, applyFrom, applyTo,
                ...audience,
                name: ((document.getElementById('giftBatchName') || {}).value || '').trim(),
                title: ((document.getElementById('giftBatchTitle') || {}).value || '').trim(),
                code: mode === 'code' ? ((document.getElementById('giftBatchCode') || {}).value || '').trim() : null
            })
        });
        const j = await r.json();
        if (!r.ok || !j.success) {
            showToast(j.error || 'No se pudo enviar el lote', 'error');
            if (st) st.textContent = '';
            return;
        }
        const t = j.totals || {};
        if (j.isPublic) {
            showToast('Código público ' + j.code + ' creado', 'success');
            if (st) st.textContent = '✅ ' + (j.message || 'Código ' + j.code + ' listo para subir a Telegram/redes');
        } else {
            showToast('Lote enviado a ' + t.recipients + ' usuarios' + (j.code ? ' — código ' + j.code : ''), 'success');
            if (st) st.textContent = '✅ ' + t.recipients + ' destinatarios' + (j.code ? ' · código ' + j.code : '') + ' · las notificaciones salen en segundo plano';
        }
        ['giftBatchAmount', 'giftBatchMessage', 'giftBatchUsers', 'giftBatchName', 'giftBatchCode', 'giftBatchTitle', 'giftBatchApplyFrom', 'giftBatchApplyTo'].forEach((id) => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        const prev = document.getElementById('giftBatchPreview'); if (prev) prev.innerHTML = '';
        loadNotifBatches();
    } catch (e) {
        showToast('Error de conexión', 'error');
        if (st) st.textContent = '';
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function loadNotifBatches() {
    const box = document.getElementById('notifBatchesList');
    if (!box) return;
    try {
        const r = await authFetch('/api/admin/notif-batches');
        if (!r.ok) { box.innerHTML = '<p style="color:#888;text-align:center;font-size:.85rem">Sin permiso para ver el historial.</p>'; return; }
        const j = await r.json();
        const rows = j.batches || [];
        if (!rows.length) { box.innerHTML = '<p style="color:#888;text-align:center;font-size:.85rem">Todavía no se envió ningún lote.</p>'; return; }
        box.innerHTML = rows.map((b) => {
            const fecha = new Date(b.sentAt).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            const vencido = new Date(b.expiresAt).getTime() <= Date.now();
            const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
            const franjaH = (b.applyFromMin != null && b.applyToMin != null) ? ' ' + hm(b.applyFromMin) + '-' + hm(b.applyToMin) : '';
            const aplic = b.giftType === 'percent'
                ? (b.applyMode === 'auto'
                    ? ' <span style="color:#7fd7ff;" title="Se suma solo en la carga">⚡ auto · ' + (b.applyScope === 'all' ? 'todas las cargas' : '1ª carga') + franjaH + (Number(b.rolloverX) > 0 ? ' · x' + b.rolloverX : ' · sin rollover') + '</span>'
                    : ' <span style="color:#aaa;">🧑‍💼 agente</span>')
                : '';
            const regalo = (b.giftType === 'percent' ? ('+' + b.amount + '%') : ('$' + Number(b.amount).toLocaleString('es-AR'))) + aplic;
            const modo = b.mode === 'code' ? ('🔑 ' + escapeHtml(b.code || '')) : ('⏰ ' + b.validHours + 'hs');
            const aud = b.isPublic ? ('📣 código público' + (b.maxClaims ? ' (cupo ' + b.maxClaims + ')' : '')) :
                b.audienceType === 'segment' ? ('🎯 ' + escapeHtml(b.audienceLabel || 'segmento')) :
                b.audienceType === 'all' ? '🌍 todos' :
                b.audienceType === 'inactive' ? ('😴 inactivos ≥' + (b.audienceDays || '?') + 'd' + (b.audienceLimit ? ' (cupo ' + b.audienceLimit + ')' : '')) :
                '📋 lista';
            const envio = b.isPublic
                ? (b.claimed + ' canjes' + (b.maxClaims ? ' de ' + b.maxClaims : ''))
                : b.pendientes > 0
                ? '<span style="color:#ffd166;">⏳ enviando (' + (b.total - b.pendientes) + '/' + b.total + ')</span>'
                : b.delivered + ' notificados';
            return '<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:.7rem .9rem;margin-bottom:.5rem;font-size:.82rem;">' +
                '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:.4rem;align-items:center;">' +
                    '<div><b style="color:#d4af37;">' + regalo + '</b> · ' + modo + ' · ' + aud +
                        (b.name ? ' · <span style="color:#ccc;">' + escapeHtml(b.name) + '</span>' : '') +
                        (vencido ? ' · <span style="color:#888;">vencido</span>' : ' · <span style="color:#00ff88;">vigente</span>') + '</div>' +
                    '<button class="btn btn-secondary btn-sm" onclick="toggleNotifBatchDetail(\'' + b.id + '\')">👥 Ver lote</button>' +
                '</div>' +
                '<div style="color:#999;margin-top:.25rem;">' + fecha + ' · envió <b>' + escapeHtml(b.sentBy || '-') + '</b> · ' +
                    b.total + ' destinatarios · ' + envio + ' · ' + b.claimed + ' con bono' +
                    (b.sinNotis ? ' · <span style="color:#ff9d76;">' + b.sinNotis + ' sin notis</span>' : '') + '</div>' +
                '<div id="notifBatchDetail_' + b.id + '" style="display:none;margin-top:.5rem;"></div>' +
            '</div>';
        }).join('');
    } catch (e) {
        box.innerHTML = '<p style="color:#888;text-align:center;font-size:.85rem">Error cargando el historial.</p>';
    }
}

async function toggleNotifBatchDetail(id) {
    const box = document.getElementById('notifBatchDetail_' + id);
    if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = '<p style="color:#888;font-size:.8rem">Cargando detalle...</p>';
    try {
        const r = await authFetch('/api/admin/notif-batches/' + id);
        const j = await r.json();
        if (!r.ok) { box.innerHTML = '<p style="color:#ff6b6b;font-size:.8rem">' + escapeHtml(j.error || 'Error') + '</p>'; return; }
        const recs = j.recipients || [];
        // Lotes grandes (completo/inactivos): renderizar hasta 400 filas para
        // no reventar el DOM; los totales de la fila de arriba son completos.
        const MAX_ROWS = 400;
        const shown = recs.slice(0, MAX_ROWS);
        box.innerHTML = '<div style="max-height:260px;overflow-y:auto;background:rgba(0,0,0,0.25);border-radius:6px;padding:.5rem;">' +
            shown.map((u) => {
                let estado;
                if (u.creditedAt) estado = '<span style="color:#00ff88;">💰 acreditado automático</span>';
                else if (u.creditError) estado = '<span style="color:#ff6b6b;" title="' + escapeHtml(u.creditError) + '">⚠ sin acreditar: ' + escapeHtml(u.creditError) + '</span>';
                else if (u.bonusStatus === 'used' && u.autoApply) estado = '<span style="color:#7fd7ff;">⚡ aplicado solo' + (u.usesTotalBonus > 0 ? ' ($' + Number(u.usesTotalBonus).toLocaleString('es-AR') + ')' : '') + (u.usedBy ? ' · ' + escapeHtml(u.usedBy) : '') + '</span>';
                else if (u.bonusStatus === 'used') estado = '<span style="color:#888;">✔ usado por ' + escapeHtml(u.usedBy || '-') + '</span>';
                else if (u.bonusStatus === 'active' && u.autoApply) estado = '<span style="color:#7fd7ff;">⚡ bono AUTO activo' + (u.applyScope === 'all' ? ' · aplicado ' + (u.usesCount || 0) + 'x' + (u.usesTotalBonus > 0 ? ' ($' + Number(u.usesTotalBonus).toLocaleString('es-AR') + ')' : '') : '') + '</span>';
                else if (u.bonusStatus === 'active') estado = '<span style="color:#00ff88;">🎁 bono ACTIVO</span>';
                else if (u.bonusStatus === 'expired') estado = '<span style="color:#888;">⏰ bono vencido</span>';
                else if (u.claimedAt) estado = '<span style="color:#00ff88;">canjeado</span>';
                else estado = '<span style="color:#aaa;">sin canjear</span>';
                const entrega = u.delivery === 'socket' ? '🟢 en la app' :
                    u.delivery === 'push' ? '🔔 push' :
                    u.delivery === 'error' ? '<span style="color:#ff6b6b;">⚠ push falló</span>' :
                    u.delivery === 'none' ? '<span style="color:#ff9d76;">solo chat</span>' : '⏳ enviando';
                return '<div style="display:flex;justify-content:space-between;gap:.5rem;padding:2px 4px;font-size:.78rem;border-bottom:1px solid rgba(255,255,255,0.05);">' +
                    '<span>' + escapeHtml(u.username) + ' ' + _giftBatchChannelChip(u.channel) + '</span>' +
                    '<span>' + entrega + ' · ' + estado + '</span>' +
                '</div>';
            }).join('') +
            (recs.length > MAX_ROWS ? '<div style="color:#999;font-size:.78rem;padding:4px;text-align:center;">… y ' + (recs.length - MAX_ROWS) + ' más</div>' : '') +
        '</div>';
    } catch (e) {
        box.innerHTML = '<p style="color:#ff6b6b;font-size:.8rem">Error de conexión</p>';
    }
}

// =========================================================================
// ESTRATEGIA DE BONOS POR ENCUESTA — panel admin
// =========================================================================
async function loadBonusStrategy() {
    const body = document.getElementById('bonusStrategyBody');
    if (body) body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    try {
        const r = await authFetch('/api/admin/bonus-strategy');
        const j = await r.json();
        if (!j.success) { if (body) body.innerHTML = '<div style="color:#ff8080;text-align:center;padding:14px;">Error</div>'; return; }
        _renderBonusStrategy(j.config || {}, j.stats || {});
    } catch (e) {
        if (body) body.innerHTML = '<div style="color:#ff8080;text-align:center;padding:14px;">Error de conexión</div>';
    }
}

function _bsField(id, label, value, type, extra) {
    return '<div style="flex:1;min-width:90px;"><label style="display:block;color:#aaa;font-size:11px;margin-bottom:3px;">' + label + '</label>' +
        '<input id="' + id + '" type="' + (type || 'text') + '" value="' + escapeHtml(String(value == null ? '' : value)) + '" ' + (extra || '') +
        ' style="width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.4);color:#fff;font-size:13px;"></div>';
}

function _bsStepBlock(n, step) {
    let h = '<div style="background:rgba(255,215,0,0.05);border:1px solid rgba(255,215,0,0.25);border-radius:10px;padding:13px;margin-bottom:12px;">';
    h += '<div style="color:#ffd700;font-weight:900;font-size:12px;margin-bottom:8px;">PASO ' + n + ' — bono de ' + (step.percent || 0) + '%</div>';
    h += '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
        _bsField('bsS' + n + 'Percent', '% de bono', step.percent, 'number', 'min="1" max="30"') +
        _bsField('bsS' + n + 'Dur', 'Dura (minutos)', step.durationMinutes, 'number', 'min="5"') +
        '</div>';
    h += '<div style="margin-bottom:8px;">' + _bsField('bsS' + n + 'Title', 'Título del push', step.title, 'text', 'maxlength="120"') + '</div>';
    h += '<label style="display:block;color:#aaa;font-size:11px;margin-bottom:3px;">Cuerpo del push</label>' +
        '<textarea id="bsS' + n + 'Body" maxlength="300" style="width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.4);color:#fff;font-size:13px;min-height:54px;">' + escapeHtml(step.body || '') + '</textarea>';
    h += '</div>';
    return h;
}

function _bsPlanRow(plan, label, pd) {
    return '<div style="margin-bottom:8px;"><div style="color:#fff;font-size:12px;font-weight:700;margin-bottom:4px;">' + label + '</div>' +
        '<div style="display:flex;gap:8px;">' +
        _bsField('bsD' + plan + '1', 'Paso 1 — horas tras votar', pd.step1Hours, 'number', 'min="0"') +
        _bsField('bsD' + plan + '2', 'Paso 2 — horas tras votar', pd.step2Hours, 'number', 'min="0"') +
        '</div></div>';
}

function _renderBonusStrategy(cfg, stats) {
    const body = document.getElementById('bonusStrategyBody');
    if (!body) return;
    const s1 = cfg.step1 || {}, s2 = cfg.step2 || {};
    const pd = cfg.planDelays || {};
    let html = '';

    // Estado + botón lanzar/pausar.
    html += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:' + (cfg.isActive ? 'rgba(37,211,102,0.10)' : 'rgba(0,0,0,0.30)') + ';border:1px solid ' + (cfg.isActive ? 'rgba(37,211,102,0.40)' : 'rgba(255,255,255,0.12)') + ';border-radius:10px;padding:13px;margin-bottom:14px;">';
    html += '<div style="flex:1;min-width:180px;"><div style="font-weight:900;font-size:14px;color:' + (cfg.isActive ? '#25d366' : '#aaa') + ';">' + (cfg.isActive ? '🟢 ESTRATEGIA ACTIVA' : '⚪ ESTRATEGIA PAUSADA') + '</div>';
    html += '<div style="color:#888;font-size:11px;margin-top:3px;">' + (stats.inscriptos || 0) + ' inscriptos · ' + (stats.sinPasos || 0) + ' sin pasos · ' + (stats.recibieron50 || 0) + ' con bono 50% · ' + (stats.completaron || 0) + ' completaron</div></div>';
    html += '<button onclick="toggleBonusStrategy(' + (cfg.isActive ? 'false' : 'true') + ')" style="' + (cfg.isActive ? 'background:rgba(255,80,80,0.15);color:#ff5050;border:1px solid rgba(255,80,80,0.4)' : 'background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;border:none') + ';padding:10px 18px;border-radius:9px;font-weight:900;font-size:13px;cursor:pointer;">' + (cfg.isActive ? '⏸ Pausar' : '🚀 Lanzar estrategia') + '</button>';
    html += '</div>';

    html += _bsStepBlock(1, s1);
    html += _bsStepBlock(2, s2);

    // Retrasos por plan.
    html += '<div style="background:rgba(0,212,255,0.05);border:1px solid rgba(0,212,255,0.25);border-radius:10px;padding:13px;margin-bottom:12px;">';
    html += '<div style="color:#00d4ff;font-weight:900;font-size:12px;margin-bottom:4px;">⏱ RETRASOS POR PLAN</div>';
    html += '<div style="color:#999;font-size:10.5px;line-height:1.5;margin-bottom:10px;">Cuántas horas después de votar la encuesta recibe cada paso, según lo que votó. (solo_reembolsos no entra a la estrategia.)</div>';
    html += _bsPlanRow('suave', '🟢 Plan SUAVE', pd.suave || {});
    html += _bsPlanRow('normal', '🟡 Plan NORMAL', pd.normal || {});
    html += _bsPlanRow('activo', '🔴 Plan ACTIVO', pd.activo || {});
    html += '</div>';

    html += '<button onclick="saveBonusStrategy()" style="width:100%;background:linear-gradient(135deg,#d4af37,#ffd700);color:#000;border:none;padding:12px;border-radius:10px;font-weight:900;font-size:13px;cursor:pointer;">💾 Guardar configuración</button>';

    body.innerHTML = html;
}

async function toggleBonusStrategy(active) {
    if (active && !confirm('¿Lanzar la estrategia?\n\nSe va a inscribir a todos los que ya votaron la encuesta y van a empezar a recibir los bonos según su plan.')) return;
    try {
        const r = await authFetch('/api/admin/bonus-strategy/activate', {
            method: 'POST',
            body: JSON.stringify({ active: active })
        });
        const j = await r.json();
        if (j.success) {
            showToast(active ? ('🚀 Estrategia lanzada' + (j.backfilled ? (' · ' + j.backfilled + ' inscriptos') : '')) : '⏸ Estrategia pausada', 'success');
            loadBonusStrategy();
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

async function saveBonusStrategy() {
    const num = function (id) { return Number(document.getElementById(id).value); };
    const val = function (id) { return (document.getElementById(id).value || '').trim(); };
    const payload = {
        step1: { percent: num('bsS1Percent'), durationMinutes: num('bsS1Dur'), title: val('bsS1Title'), body: val('bsS1Body') },
        step2: { percent: num('bsS2Percent'), durationMinutes: num('bsS2Dur'), title: val('bsS2Title'), body: val('bsS2Body') },
        planDelays: {
            suave: { step1Hours: num('bsDsuave1'), step2Hours: num('bsDsuave2') },
            normal: { step1Hours: num('bsDnormal1'), step2Hours: num('bsDnormal2') },
            activo: { step1Hours: num('bsDactivo1'), step2Hours: num('bsDactivo2') }
        }
    };
    if (!payload.step1.title || !payload.step1.body || !payload.step2.title || !payload.step2.body) {
        showToast('Faltan título o cuerpo en algún paso', 'error');
        return;
    }
    try {
        const r = await authFetch('/api/admin/bonus-strategy', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const j = await r.json();
        if (j.success) {
            showToast('✅ Configuración guardada', 'success');
            loadBonusStrategy();
        } else {
            showToast(j.error || 'Error', 'error');
        }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// ============================================================
// ENCUESTA — estrategia de notificaciones por grupo (Fase 3)
// ============================================================
const ENC_GROUPS = [
    { key: 'suave',  label: '🌙 Suave' },
    { key: 'normal', label: '⚖️ Normal' },
    { key: 'activo', label: '🔥 Activo' }
];
const ENC_DOW = [
    { dow: 1, n: 'Lun' }, { dow: 2, n: 'Mar' }, { dow: 3, n: 'Mié' },
    { dow: 4, n: 'Jue' }, { dow: 5, n: 'Vie' }, { dow: 6, n: 'Sáb' }, { dow: 0, n: 'Dom' }
];

function _encArtDow() {
    const art = new Date(Date.now() - 3 * 3600 * 1000);
    return art.getUTCDay();
}

function _encInput(id, value, min, max) {
    return '<input type="number" id="' + id + '" value="' + value + '" min="' + min + '" max="' + max + '" '
        + 'style="width:58px;box-sizing:border-box;background:rgba(0,0,0,0.45);color:#ffd700;border:1px solid rgba(255,215,0,0.35);border-radius:6px;padding:6px;font-size:12px;font-weight:800;text-align:center;">';
}

async function loadEncuesta() {
    const body = document.getElementById('encuestaBody');
    if (!body) return;
    body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    try {
        const headers = { 'Authorization': `Bearer ${currentToken}` };
        const [cfgR, statsR, calR, repR] = await Promise.all([
            fetch(`${API_URL}/api/admin/encuesta/config`, { headers }),
            fetch(`${API_URL}/api/admin/encuesta/stats`, { headers }),
            fetch(`${API_URL}/api/admin/encuesta/calendar`, { headers }),
            fetch(`${API_URL}/api/admin/encuesta/reportes`, { headers })
        ]);
        const cfg = (await cfgR.json()).config || {};
        const stats = await statsR.json();
        const cal = (await calR.json()).calendar || {};
        const rep = await repR.json();
        _encuestaRender(cfg, stats, cal, rep);
    } catch (e) {
        body.innerHTML = '<div style="color:#ff6b6b;text-align:center;padding:24px;">Error cargando la encuesta.</div>';
    }
}

function _encuestaRender(cfg, stats, cal, rep) {
    const body = document.getElementById('encuestaBody');
    if (!body) return;
    const active = cfg.isActive === true;
    const st = (stats && stats.stats) || {};
    const todayDow = _encArtDow();
    let h = '';

    // --- Activación ---
    h += '<div style="background:' + (active ? 'rgba(102,255,102,0.10)' : 'rgba(255,255,255,0.04)')
        + ';border:1.5px solid ' + (active ? '#66ff66' : 'rgba(255,255,255,0.15)')
        + ';border-radius:12px;padding:14px;margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">';
    h += '<div style="flex:1;min-width:160px;">'
        + '<div style="font-weight:900;font-size:14px;color:' + (active ? '#66ff66' : '#fff') + ';">'
        + (active ? '🟢 Estrategia ACTIVA' : '⚪ Estrategia en pausa') + '</div>'
        + '<div style="color:#aaa;font-size:11px;margin-top:2px;">'
        + (active ? 'El motor está disparando los pushes según el calendario.'
                  : 'El motor está dormido: no se manda ningún push hasta lanzarla.') + '</div></div>';
    h += active
        ? '<button onclick="encuestaToggleActive(false)" style="background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff;border:none;border-radius:9px;padding:10px 18px;font-weight:900;font-size:13px;cursor:pointer;">⏸ Pausar</button>'
        : '<button onclick="encuestaToggleActive(true)" style="background:linear-gradient(135deg,#00cc6a,#00ff88);color:#000;border:none;border-radius:9px;padding:10px 18px;font-weight:900;font-size:13px;cursor:pointer;">🚀 Lanzar estrategia</button>';
    h += '</div>';

    // --- Distribución de votos ---
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">👥 Cómo votó la gente</h3>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:18px;">';
    [['suave', '🌙 Suave'], ['normal', '⚖️ Normal'], ['activo', '🔥 Activo'], ['solo_reembolsos', '💰 Solo reemb.'], ['sinVotar', '❔ Sin votar']].forEach(function (g) {
        h += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(212,175,55,0.25);border-radius:10px;padding:10px;text-align:center;">'
            + '<div style="font-size:20px;font-weight:900;color:#ffd700;">' + (st[g[0]] || 0) + '</div>'
            + '<div style="font-size:10px;color:#bbb;">' + g[1] + '</div></div>';
    });
    h += '</div>';

    // --- Historial de votos ---
    const ultVotos = (stats && stats.ultimosVotos) || [];
    const votosDia = (stats && stats.votosPorDia) || [];
    const planEmoji = { suave: '🌙', normal: '⚖️', activo: '🔥', solo_reembolsos: '💰' };
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">🗳️ Qué fue votando la gente</h3>';
    h += '<div style="overflow-x:auto;margin-bottom:10px;"><table style="width:100%;border-collapse:collapse;min-width:380px;">';
    h += '<tr style="color:#888;font-size:9px;text-transform:uppercase;"><th style="text-align:left;padding:5px;">Día</th><th style="padding:5px;">🌙</th><th style="padding:5px;">⚖️</th><th style="padding:5px;">🔥</th><th style="padding:5px;">💰</th><th style="padding:5px;">Total</th></tr>';
    votosDia.forEach(function (d) {
        h += '<tr style="border-top:1px solid rgba(255,255,255,0.05);font-size:11px;">'
            + '<td style="padding:5px;color:#ddd;">' + d.fecha + '</td>'
            + '<td style="padding:5px;text-align:center;color:#bbb;">' + d.suave + '</td>'
            + '<td style="padding:5px;text-align:center;color:#bbb;">' + d.normal + '</td>'
            + '<td style="padding:5px;text-align:center;color:#bbb;">' + d.activo + '</td>'
            + '<td style="padding:5px;text-align:center;color:#bbb;">' + d.solo_reembolsos + '</td>'
            + '<td style="padding:5px;text-align:center;color:#ffd700;font-weight:800;">' + d.total + '</td></tr>';
    });
    h += '</table></div>';
    h += '<div style="color:#888;font-size:10px;margin-bottom:4px;">Últimos votos:</div>';
    if (ultVotos.length) {
        h += '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:18px;">';
        ultVotos.forEach(function (v) {
            h += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,255,255,0.07);border-radius:7px;padding:6px 9px;font-size:11px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
                + '<span style="color:#fff;font-weight:700;">' + _escInac(v.username) + '</span>'
                + '<span style="color:#c9a0ff;">' + (planEmoji[v.plan] || '') + ' ' + _escInac(v.plan) + '</span>'
                + '<span style="color:#777;margin-left:auto;">' + (v.votedAt ? fmtFechaHoraAR(v.votedAt) : '') + '</span></div>';
        });
        h += '</div>';
    } else {
        h += '<div style="color:#777;font-size:11px;margin-bottom:18px;">Todavía no hay votos registrados.</div>';
    }

    // --- Matriz de grupos ---
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">⚙️ Matriz de grupos (por semana)</h3>';
    h += '<div style="background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;margin-bottom:18px;">';
    h += '<table style="width:100%;border-collapse:collapse;">';
    h += '<tr style="color:#888;font-size:9.5px;text-transform:uppercase;">'
        + '<th style="text-align:left;padding:4px;">Grupo</th>'
        + '<th style="padding:4px;">Bonos / sem</th>'
        + '<th style="padding:4px;">Incentivos / sem</th></tr>';
    ENC_GROUPS.forEach(function (g) {
        const cc = (cfg.cohorts && cfg.cohorts[g.key]) || { bonosPorSemana: 0, incentivosPorSemana: 0 };
        h += '<tr>'
            + '<td style="padding:6px 4px;color:#fff;font-weight:700;font-size:12px;">' + g.label + '</td>'
            + '<td style="padding:6px 4px;text-align:center;">' + _encInput('encInp_' + g.key + '_bonos', cc.bonosPorSemana, 0, 14) + '</td>'
            + '<td style="padding:6px 4px;text-align:center;">' + _encInput('encInp_' + g.key + '_inc', cc.incentivosPorSemana, 0, 21) + '</td>'
            + '</tr>';
    });
    h += '</table>';
    h += '<div style="color:#777;font-size:10px;margin-top:6px;">💰 Solo reembolsos: nunca recibe marketing (solo recordatorios de reembolso).</div>';
    h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">';
    h += '<div style="flex:1;min-width:130px;"><label style="display:block;color:#888;font-size:10px;margin-bottom:3px;">% de bonos (separá con coma)</label>'
        + '<input type="text" id="encInp_percents" value="' + ((cfg.bonoPercents || [15, 30]).join(',')) + '" style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.45);color:#ffd700;border:1px solid rgba(255,215,0,0.35);border-radius:6px;padding:7px;font-size:12px;font-weight:800;"></div>';
    h += '<div style="flex:1;min-width:130px;"><label style="display:block;color:#888;font-size:10px;margin-bottom:3px;">Vigencia del bono (horas)</label>'
        + '<input type="number" id="encInp_vigencia" value="' + (cfg.bonoVigenciaHoras || 48) + '" min="1" max="720" style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.45);color:#ffd700;border:1px solid rgba(255,215,0,0.35);border-radius:6px;padding:7px;font-size:12px;font-weight:800;"></div>';
    h += '</div>';
    h += '<button onclick="encuestaSaveConfig()" style="margin-top:12px;width:100%;background:linear-gradient(135deg,#d4af37,#ffd700);color:#000;border:none;border-radius:9px;padding:11px;font-weight:900;font-size:13px;cursor:pointer;">💾 Guardar matriz</button>';
    h += '</div>';

    // --- Calendario semanal ---
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">📅 Calendario semanal</h3>';
    h += '<div style="overflow-x:auto;margin-bottom:18px;"><table style="width:100%;border-collapse:collapse;min-width:600px;">';
    h += '<tr><th style="padding:5px;"></th>';
    ENC_DOW.forEach(function (d) {
        const isToday = d.dow === todayDow;
        h += '<th style="padding:5px;font-size:10px;color:' + (isToday ? '#ffd700' : '#888') + ';">' + d.n + (isToday ? ' •' : '') + '</th>';
    });
    h += '</tr>';
    ENC_GROUPS.forEach(function (g) {
        const slots = (cal && cal[g.key]) || [];
        h += '<tr><td style="padding:5px;color:#fff;font-weight:700;font-size:11px;white-space:nowrap;">' + g.label + '</td>';
        ENC_DOW.forEach(function (d) {
            let slot = null;
            for (let i = 0; i < slots.length; i++) { if (slots[i].dow === d.dow) { slot = slots[i]; break; } }
            const isToday = d.dow === todayDow;
            h += '<td style="padding:3px;border:1px solid rgba(255,255,255,0.06);vertical-align:top;' + (isToday ? 'background:rgba(255,215,0,0.07);' : '') + '">';
            if (slot) {
                const bono = slot.type === 'bono';
                h += '<div style="background:' + (bono ? 'rgba(0,255,136,0.12)' : 'rgba(157,78,221,0.15)') + ';border-radius:5px;padding:3px 4px;">'
                    + '<div style="font-weight:900;font-size:9.5px;color:' + (bono ? '#00ff88' : '#c9a0ff') + ';">' + (bono ? '🎁 Bono ' + slot.percent + '%' : '📣 Incentivo') + '</div>'
                    + '<div style="color:#999;font-size:8.5px;">' + (slot.horaTxt || (slot.hora + ':00')) + ' hs</div></div>';
            }
            h += '</td>';
        });
        h += '</tr>';
    });
    h += '</table></div>';

    // --- Push de HOY (verificación) ---
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">🔎 Push de HOY (para verificar)</h3>';
    h += '<div style="display:flex;flex-direction:column;gap:6px;">';
    ENC_GROUPS.forEach(function (g) {
        const slots = (cal && cal[g.key]) || [];
        let today = null;
        for (let i = 0; i < slots.length; i++) { if (slots[i].dow === todayDow) { today = slots[i]; break; } }
        h += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:9px 11px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
        h += '<span style="color:#fff;font-weight:800;font-size:12px;min-width:80px;">' + g.label + '</span>';
        if (today) {
            const bono = today.type === 'bono';
            h += '<span style="color:' + (bono ? '#00ff88' : '#c9a0ff') + ';font-weight:800;font-size:11px;">' + (bono ? '🎁 Bono ' + today.percent + '%' : '📣 Incentivo') + ' · ' + (today.horaTxt || (today.hora + ':00')) + '</span>';
            h += '<span style="color:#bbb;font-size:11px;flex:1;min-width:140px;">' + today.title + '</span>';
        } else {
            h += '<span style="color:#666;font-size:11px;">— sin push hoy —</span>';
        }
        h += '</div>';
    });
    h += '</div>';

    // --- Reportes diarios + ROI ---
    const tot = (rep && rep.totales) || { pushes: 0, bonosCreados: 0, bonosUsados: 0, ingreso: 0, costo: 0 };
    const usoRate = tot.bonosCreados > 0 ? Math.round(tot.bonosUsados / tot.bonosCreados * 100) : 0;
    const ingreso = Math.round(tot.ingreso || 0);
    const costo = Math.round(tot.costo || 0);
    const roiNeto = ingreso - costo;
    const fmt = function (n) { return '$' + Number(n || 0).toLocaleString('es-AR'); };
    h += '<h3 style="color:#d4af37;font-size:13px;margin:18px 0 8px;">📈 Reportes diarios y ROI (últimos ' + ((rep && rep.dias) || 14) + ' días)</h3>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(102px,1fr));gap:8px;margin-bottom:10px;">';
    [
        ['📤 Pushes', String(tot.pushes), '#fff'],
        ['✅ Bonos usados', String(tot.bonosUsados), '#ffd700'],
        ['📊 % de uso', usoRate + '%', '#c9a0ff'],
        ['💵 Ingreso', fmt(ingreso), '#00ff88'],
        ['🎁 Costo bonos', fmt(costo), '#ff8888'],
        ['📈 ROI neto', fmt(roiNeto), roiNeto >= 0 ? '#00ff88' : '#ff5050']
    ].forEach(function (c) {
        h += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(212,175,55,0.25);border-radius:10px;padding:10px;text-align:center;">'
            + '<div style="font-size:17px;font-weight:900;color:' + c[2] + ';">' + c[1] + '</div>'
            + '<div style="font-size:10px;color:#bbb;">' + c[0] + '</div></div>';
    });
    h += '</div>';
    h += '<div style="color:#777;font-size:10px;margin-bottom:8px;">El <strong style="color:#00ff88;">ingreso</strong> es el total de las cargas hechas con bono; el <strong style="color:#ff8888;">costo</strong> es el % regalado. <strong style="color:#c9a0ff;">ROI neto</strong> = ingreso − costo. El monto de la carga se toma automático cuando el depósito incluye bono.</div>';
    h += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;min-width:480px;">';
    h += '<tr style="color:#888;font-size:9px;text-transform:uppercase;"><th style="text-align:left;padding:5px;">Día</th><th style="padding:5px;">Pushes</th><th style="padding:5px;">Usados</th><th style="padding:5px;">Ingreso</th><th style="padding:5px;">Costo</th><th style="padding:5px;">ROI neto</th></tr>';
    ((rep && rep.reportes) || []).forEach(function (d) {
        const dRoi = Math.round((d.ingreso || 0) - (d.costo || 0));
        h += '<tr style="border-top:1px solid rgba(255,255,255,0.05);font-size:11px;">'
            + '<td style="padding:5px;color:#ddd;">' + d.fecha + '</td>'
            + '<td style="padding:5px;text-align:center;color:#fff;">' + d.pushes + '</td>'
            + '<td style="padding:5px;text-align:center;color:#ffd700;">' + d.bonosUsados + '</td>'
            + '<td style="padding:5px;text-align:center;color:#00ff88;">' + fmt(Math.round(d.ingreso || 0)) + '</td>'
            + '<td style="padding:5px;text-align:center;color:#ff8888;">' + fmt(Math.round(d.costo || 0)) + '</td>'
            + '<td style="padding:5px;text-align:center;color:' + (dRoi >= 0 ? '#00ff88' : '#ff5050') + ';">' + fmt(dRoi) + '</td></tr>';
    });
    h += '</table></div>';

    body.innerHTML = h;
}

async function encuestaToggleActive(activate) {
    try {
        const headers = { 'Authorization': `Bearer ${currentToken}` };
        const r0 = await fetch(`${API_URL}/api/admin/encuesta/config`, { headers });
        const cfg = (await r0.json()).config || {};
        cfg.isActive = !!activate;
        const r = await fetch(`${API_URL}/api/admin/encuesta/config`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${currentToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        const j = await r.json();
        if (j.success) {
            showToast(activate ? '🚀 Estrategia lanzada' : '⏸ Estrategia pausada', 'success');
            loadEncuesta();
        } else { showToast(j.error || 'Error', 'error'); }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

async function encuestaSaveConfig() {
    try {
        const headers = { 'Authorization': `Bearer ${currentToken}` };
        const r0 = await fetch(`${API_URL}/api/admin/encuesta/config`, { headers });
        const cfg = (await r0.json()).config || {};
        if (!cfg.cohorts) cfg.cohorts = {};
        ['suave', 'normal', 'activo'].forEach(function (k) {
            const be = document.getElementById('encInp_' + k + '_bonos');
            const ie = document.getElementById('encInp_' + k + '_inc');
            const b = parseInt(be && be.value, 10);
            const i = parseInt(ie && ie.value, 10);
            cfg.cohorts[k] = {
                bonosPorSemana: isFinite(b) ? b : 0,
                incentivosPorSemana: isFinite(i) ? i : 0
            };
        });
        const pctEl = document.getElementById('encInp_percents');
        const pct = ((pctEl && pctEl.value) || '').split(',').map(function (x) { return parseInt(x.trim(), 10); }).filter(function (x) { return isFinite(x) && x > 0; });
        if (pct.length) cfg.bonoPercents = pct;
        const vigEl = document.getElementById('encInp_vigencia');
        const vig = parseInt(vigEl && vigEl.value, 10);
        if (isFinite(vig)) cfg.bonoVigenciaHoras = vig;
        const r = await fetch(`${API_URL}/api/admin/encuesta/config`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${currentToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        const j = await r.json();
        if (j.success) { showToast('✅ Matriz guardada', 'success'); loadEncuesta(); }
        else { showToast(j.error || 'Error', 'error'); }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// ============================================================
// INACTIVOS — recuperación escalonada 7/14/30 días
// ============================================================
function _escInac(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
}

async function loadInactivos() {
    const body = document.getElementById('inactivosBody');
    if (!body) return;
    body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    try {
        const headers = { 'Authorization': `Bearer ${currentToken}` };
        const [cfgR, statsR, reactR] = await Promise.all([
            fetch(`${API_URL}/api/admin/inactividad/config`, { headers }),
            fetch(`${API_URL}/api/admin/inactividad/stats`, { headers }),
            fetch(`${API_URL}/api/admin/reactivacion/stats?days=14`, { headers })
        ]);
        const cfg = (await cfgR.json()).config || {};
        const stats = await statsR.json();
        let react = null;
        try { react = reactR.ok ? await reactR.json() : null; } catch (_) { react = null; }
        _inactivosRender(cfg, stats, react);
    } catch (e) {
        body.innerHTML = '<div style="color:#ff6b6b;text-align:center;padding:24px;">Error cargando.</div>';
    }
}

// Tope del regalo de ticket alto (espejo del backend, para los inputs del panel).
const REGALO_TA_MAX_ARS_UI = 3000;

// Tablero de seguimiento de las estrategias de reactivación (qué se dispara,
// cuántos reciben, cuántos reclaman, por estrategia + por día). Datos de
// /api/admin/reactivacion/stats (agrega los PromoBonus por sourceRuleCode).
function _reactivacionDashboardHtml(react) {
    if (!react || !Array.isArray(react.strategies)) return '';
    const strategies = react.strategies;
    const totals = react.totals || { creados: 0, reclamados: 0, ingreso: 0, tasaReclamo: 0 };
    const byDay = (react.byDay || []).slice(0, 14);
    const money = n => '$' + (Number(n) || 0).toLocaleString('es-AR');
    let h = '';
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">📊 Seguimiento de estrategias de reactivación <span style="color:#777;font-weight:400;">(últimos ' + (react.days || 14) + ' días)</span></h3>';
    h += '<div style="background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;margin-bottom:18px;">';
    // Tarjetas resumen
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:12px;">';
    h += '<div style="background:rgba(0,0,0,0.3);border:1px solid rgba(108,170,255,0.25);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:19px;font-weight:900;color:#6cf;">' + totals.creados + '</div><div style="font-size:10px;color:#bbb;">Bonos enviados</div></div>';
    h += '<div style="background:rgba(0,0,0,0.3);border:1px solid rgba(76,175,80,0.25);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:19px;font-weight:900;color:#4caf50;">' + totals.reclamados + '</div><div style="font-size:10px;color:#bbb;">Reclamados</div></div>';
    h += '<div style="background:rgba(0,0,0,0.3);border:1px solid rgba(255,215,0,0.25);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:19px;font-weight:900;color:#ffd700;">' + (totals.tasaReclamo || 0) + '%</div><div style="font-size:10px;color:#bbb;">Tasa de reclamo</div></div>';
    h += '<div style="background:rgba(0,0,0,0.3);border:1px solid rgba(76,175,80,0.25);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:16px;font-weight:900;color:#4caf50;">' + money(totals.ingreso) + '</div><div style="font-size:10px;color:#bbb;">$ cargado por reclamos</div></div>';
    h += '</div>';
    // Tabla por estrategia
    if (strategies.length) {
        h += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:11.5px;">';
        h += '<thead><tr style="color:#6cf;text-align:left;background:#15152a;">'
            + '<th style="padding:6px;">Estrategia</th>'
            + '<th style="padding:6px;text-align:right;">Enviados</th>'
            + '<th style="padding:6px;text-align:right;">Reclamados</th>'
            + '<th style="padding:6px;text-align:right;">Tasa</th>'
            + '<th style="padding:6px;text-align:right;">Activos</th>'
            + '<th style="padding:6px;text-align:right;">$ Reclamos</th></tr></thead><tbody>';
        strategies.forEach(function (s) {
            h += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">'
                + '<td style="padding:6px;color:#fff;font-weight:600;">' + _escInac(s.label) + '</td>'
                + '<td style="padding:6px;text-align:right;color:#6cf;">' + s.creados + '</td>'
                + '<td style="padding:6px;text-align:right;color:#4caf50;">' + s.reclamados + '</td>'
                + '<td style="padding:6px;text-align:right;color:#ffd700;">' + (s.tasaReclamo || 0) + '%</td>'
                + '<td style="padding:6px;text-align:right;color:#aaa;">' + (s.activos || 0) + '</td>'
                + '<td style="padding:6px;text-align:right;color:#4caf50;">' + money(s.ingreso) + '</td></tr>';
        });
        h += '</tbody></table></div>';
    } else {
        h += '<div style="color:#777;font-size:11px;">Todavía no hay datos de estrategias en el período.</div>';
    }
    // Mini serie por día
    if (byDay.length) {
        h += '<div style="margin-top:12px;"><div style="color:#888;font-size:10px;text-transform:uppercase;margin-bottom:5px;">Por día (enviados · reclamados)</div>';
        h += '<div style="display:flex;flex-direction:column;gap:3px;">';
        byDay.forEach(function (d) {
            h += '<div style="display:flex;gap:8px;font-size:11px;align-items:center;">'
                + '<span style="color:#777;width:90px;">' + _escInac(d.date) + '</span>'
                + '<span style="color:#6cf;">📤 ' + d.creados + '</span>'
                + '<span style="color:#4caf50;">✅ ' + d.reclamados + '</span></div>';
        });
        h += '</div></div>';
    }
    h += '<p style="color:#777;font-size:10px;margin:10px 0 0;">Los regalos de ticket alto se reclaman con soporte (no se marcan "reclamado" solos): mirá "Enviados" para esa fila.</p>';
    h += '</div>';
    return h;
}

function _inactivosRender(cfg, stats, react) {
    const body = document.getElementById('inactivosBody');
    if (!body) return;
    const active = cfg.isActive === true;
    const pasos = cfg.pasos || [];
    const rta = cfg.regaloTicketAlto || {};
    const tramos = (stats && stats.tramos) || [];
    const ultimos = (stats && stats.ultimos) || [];
    const selStyle = 'background:rgba(0,0,0,0.45);color:#ffd700;border:1px solid rgba(255,215,0,0.35);border-radius:6px;padding:6px;font-size:11px;font-weight:800;';
    let h = '';

    // --- Activación ---
    h += '<div style="background:' + (active ? 'rgba(102,255,102,0.10)' : 'rgba(255,255,255,0.04)')
        + ';border:1.5px solid ' + (active ? '#66ff66' : 'rgba(255,255,255,0.15)')
        + ';border-radius:12px;padding:14px;margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">';
    h += '<div style="flex:1;min-width:160px;">'
        + '<div style="font-weight:900;font-size:14px;color:' + (active ? '#66ff66' : '#fff') + ';">'
        + (active ? '🟢 Recuperación ACTIVA' : '⚪ Recuperación en pausa') + '</div>'
        + '<div style="color:#aaa;font-size:11px;margin-top:2px;">'
        + (active ? 'El motor está contactando a los inactivos según la escalera.'
                  : 'El motor está dormido. Al activarlo se empieza a contactar a los inactivos actuales.') + '</div></div>';
    h += active
        ? '<button onclick="inactivosToggleActive(false)" style="background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff;border:none;border-radius:9px;padding:10px 18px;font-weight:900;font-size:13px;cursor:pointer;">⏸ Pausar</button>'
        : '<button onclick="inactivosToggleActive(true)" style="background:linear-gradient(135deg,#00cc6a,#00ff88);color:#000;border:none;border-radius:9px;padding:10px 18px;font-weight:900;font-size:13px;cursor:pointer;">🚀 Activar recuperación</button>';
    h += '</div>';

    // --- Inactivos por tramo ---
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">📉 Inactivos por tramo</h3>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:18px;">';
    tramos.forEach(function (t) {
        const premio = t.tipo === 'regalo' ? ('regalo $' + (t.montoARS || 0)) : ('bono ' + (t.percent || 0) + '%');
        h += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(212,175,55,0.25);border-radius:10px;padding:10px;text-align:center;">'
            + '<div style="font-size:20px;font-weight:900;color:#ffd700;">' + (t.inactivos || 0) + '</div>'
            + '<div style="font-size:10px;color:#bbb;">+' + t.dias + ' días · ' + premio + '</div></div>';
    });
    h += '</div>';

    // --- Escalera (config) ---
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">⚙️ Escalera de recuperación</h3>';
    h += '<div style="background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;margin-bottom:18px;">';
    h += '<table style="width:100%;border-collapse:collapse;">';
    h += '<tr style="color:#888;font-size:9px;text-transform:uppercase;">'
        + '<th style="padding:4px;">Días inactivo</th><th style="padding:4px;">Tipo</th>'
        + '<th style="padding:4px;">% bono</th><th style="padding:4px;">$ regalo</th></tr>';
    pasos.forEach(function (p, i) {
        h += '<tr>'
            + '<td style="padding:5px;text-align:center;">' + _encInput('inacInp_' + i + '_dias', p.dias, 1, 365) + '</td>'
            + '<td style="padding:5px;text-align:center;"><select id="inacInp_' + i + '_tipo" style="' + selStyle + '">'
            + '<option value="bono"' + (p.tipo !== 'regalo' ? ' selected' : '') + '>Bono %</option>'
            + '<option value="regalo"' + (p.tipo === 'regalo' ? ' selected' : '') + '>Regalo $</option></select></td>'
            + '<td style="padding:5px;text-align:center;">' + _encInput('inacInp_' + i + '_percent', p.percent, 0, 30) + '</td>'
            + '<td style="padding:5px;text-align:center;">' + _encInput('inacInp_' + i + '_monto', p.montoARS, 0, 10000000) + '</td>'
            + '</tr>';
    });
    h += '</table>';
    h += '<div style="margin-top:10px;"><label style="display:block;color:#888;font-size:10px;margin-bottom:3px;">Vigencia del bono (horas · máx 2)</label>'
        + '<input type="number" id="inacInp_vigencia" value="' + (cfg.bonoVigenciaHoras || 2) + '" min="1" max="2" style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.45);color:#ffd700;border:1px solid rgba(255,215,0,0.35);border-radius:6px;padding:7px;font-size:12px;font-weight:800;"></div>';
    h += '<p style="color:#777;font-size:10px;margin:8px 0 0;">El bono % está topeado a 30% y vence en 2h (después el botón de reclamo desaparece solo).</p>';
    h += '<button onclick="inactivosSaveConfig()" style="margin-top:12px;width:100%;background:linear-gradient(135deg,#d4af37,#ffd700);color:#000;border:none;border-radius:9px;padding:11px;font-weight:900;font-size:13px;cursor:pointer;">💾 Guardar escalera</button>';
    h += '</div>';

    // --- Regalo de reactivación TICKET ALTO ---
    const rtaOn = rta.enabled === true;
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">💎 Regalo para clientes de ticket alto</h3>';
    h += '<div style="background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;margin-bottom:18px;">';
    h += '<p style="color:#aaa;font-size:11px;margin:0 0 10px;">Regalo de monto fijo (máx $' + REGALO_TA_MAX_ARS_UI + ') para clientes de ticket alto que dejaron de cargar. "De vez en cuando": máximo 1 vez por mes por cliente. Se reclama con soporte (no es bono %).</p>';
    h += '<label style="display:flex;align-items:center;gap:8px;color:#fff;font-size:12px;margin-bottom:10px;cursor:pointer;">'
        + '<input type="checkbox" id="rtaInp_enabled" ' + (rtaOn ? 'checked' : '') + ' style="width:auto;"> Activar regalo de ticket alto</label>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;">';
    h += '<div><label style="display:block;color:#888;font-size:10px;margin-bottom:3px;">Días sin cargar</label>' + _encInput('rtaInp_dias', rta.dias != null ? rta.dias : 14, 1, 365) + '</div>';
    h += '<div><label style="display:block;color:#888;font-size:10px;margin-bottom:3px;">Monto regalo ($ · máx ' + REGALO_TA_MAX_ARS_UI + ')</label>' + _encInput('rtaInp_monto', rta.montoARS != null ? rta.montoARS : 3000, 1, REGALO_TA_MAX_ARS_UI) + '</div>';
    h += '<div><label style="display:block;color:#888;font-size:10px;margin-bottom:3px;">Ticket prom. mínimo ($)</label>' + _encInput('rtaInp_minticket', rta.minTicketARS != null ? rta.minTicketARS : 30000, 0, 100000000) + '</div>';
    h += '<div><label style="display:block;color:#888;font-size:10px;margin-bottom:3px;">Vigencia (horas · máx 168)</label>' + _encInput('rtaInp_vig', rta.vigenciaHoras != null ? rta.vigenciaHoras : 48, 1, 168) + '</div>';
    h += '</div>';
    h += '<button onclick="inactivosSaveConfig()" style="margin-top:12px;width:100%;background:linear-gradient(135deg,#8e44ad,#b06fd6);color:#fff;border:none;border-radius:9px;padding:11px;font-weight:900;font-size:13px;cursor:pointer;">💎 Guardar regalo ticket alto</button>';
    h += '</div>';

    // --- Seguimiento de estrategias de reactivación ---
    h += _reactivacionDashboardHtml(react);

    // --- Últimos disparos ---
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">🔎 Últimos disparos</h3>';
    if (ultimos.length) {
        h += '<div style="display:flex;flex-direction:column;gap:5px;">';
        ultimos.forEach(function (u) {
            const premio = u.tipo === 'regalo' ? ('🎁 $' + (u.montoARS || 0)) : ('🎁 ' + (u.percent || 0) + '%');
            h += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,255,255,0.07);border-radius:7px;padding:6px 9px;font-size:11px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
                + '<span style="color:#fff;font-weight:700;">' + _escInac(u.username) + '</span>'
                + '<span style="color:#c9a0ff;">+' + u.stepDias + 'd · ' + premio + '</span>'
                + '<span style="color:#777;margin-left:auto;">' + (u.firedAt ? fmtFechaHoraAR(u.firedAt) : '') + '</span></div>';
        });
        h += '</div>';
    } else {
        h += '<div style="color:#777;font-size:11px;">Todavía no hubo disparos.</div>';
    }

    body.innerHTML = h;
}

async function inactivosToggleActive(activate) {
    try {
        const headers = { 'Authorization': `Bearer ${currentToken}` };
        const r0 = await fetch(`${API_URL}/api/admin/inactividad/config`, { headers });
        const cfg = (await r0.json()).config || {};
        cfg.isActive = !!activate;
        const r = await fetch(`${API_URL}/api/admin/inactividad/config`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${currentToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        const j = await r.json();
        if (j.success) {
            showToast(activate ? '🚀 Recuperación activada' : '⏸ Recuperación pausada', 'success');
            loadInactivos();
        } else { showToast(j.error || 'Error', 'error'); }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

async function inactivosSaveConfig() {
    try {
        const headers = { 'Authorization': `Bearer ${currentToken}` };
        const r0 = await fetch(`${API_URL}/api/admin/inactividad/config`, { headers });
        const cfg = (await r0.json()).config || {};
        const pasos = [];
        let i = 0;
        while (document.getElementById('inacInp_' + i + '_dias')) {
            const tipoEl = document.getElementById('inacInp_' + i + '_tipo');
            pasos.push({
                dias: parseInt(document.getElementById('inacInp_' + i + '_dias').value, 10) || 7,
                tipo: (tipoEl && tipoEl.value === 'regalo') ? 'regalo' : 'bono',
                percent: parseInt(document.getElementById('inacInp_' + i + '_percent').value, 10) || 0,
                montoARS: parseInt(document.getElementById('inacInp_' + i + '_monto').value, 10) || 0
            });
            i++;
        }
        if (pasos.length) cfg.pasos = pasos;
        const vigEl = document.getElementById('inacInp_vigencia');
        const vig = parseInt(vigEl && vigEl.value, 10);
        if (isFinite(vig)) cfg.bonoVigenciaHoras = vig;
        // Regalo de ticket alto (si los inputs están en pantalla).
        const rtaEnabledEl = document.getElementById('rtaInp_enabled');
        if (rtaEnabledEl) {
            const num = (id, def) => { const v = parseInt((document.getElementById(id) || {}).value, 10); return isFinite(v) ? v : def; };
            cfg.regaloTicketAlto = {
                enabled: rtaEnabledEl.checked === true,
                dias: num('rtaInp_dias', 14),
                montoARS: num('rtaInp_monto', 3000),
                minTicketARS: num('rtaInp_minticket', 30000),
                vigenciaHoras: num('rtaInp_vig', 48)
            };
        }
        const r = await fetch(`${API_URL}/api/admin/inactividad/config`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${currentToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        const j = await r.json();
        if (j.success) { showToast('✅ Escalera guardada', 'success'); loadInactivos(); }
        else { showToast(j.error || 'Error', 'error'); }
    } catch (e) { showToast('Error de conexión', 'error'); }
}

// ============================================
// CUENTAS PUBLICISTAS (CRUD) — sólo admin general
// ============================================
// Carga la lista de cuentas publisher_admin y la renderiza con los datos de
// su campaña asociada + conteo de usuarios que cada una creó.

function _safe(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadPublisherAdmins() {
    const list = document.getElementById('publisherAdminsList');
    if (!list) return;
    list.innerHTML = '<span style="color:#888;">Cargando…</span>';
    try {
        const r = await fetch(`${API_URL}/api/admin/publisher-admins`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!r.ok) {
            list.innerHTML = '<span style="color:#ff6666;">Error cargando cuentas</span>';
            return;
        }
        const data = await r.json();
        const items = data.publisherAdmins || [];
        if (items.length === 0) {
            list.innerHTML = '<div style="color:#888;padding:20px;text-align:center;border:1px dashed rgba(255,255,255,0.1);border-radius:8px;">Todavía no hay cuentas de publicista. Tocá <strong style="color:#d4af37;">"+ Nueva cuenta"</strong> para crear la primera.</div>';
            return;
        }
        list.innerHTML = items.map(pa => {
            const campName = pa.campaign ? `${_safe(pa.campaign.publisher)} · ${_safe(pa.campaign.name)}` : '<span style="color:#ff6666;">Campaña no encontrada</span>';
            const inactiveBadge = !pa.isActive ? '<span style="background:#3a1a1a;color:#ff6666;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;">INACTIVA</span>' : '';
            const inactiveCamp = pa.campaign && pa.campaign.isActive === false ? '<span style="background:#3a1a1a;color:#ff6666;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;">CAMPAÑA INACTIVA</span>' : '';
            const lastLogin = pa.lastLogin ? fmtFechaHoraAR(pa.lastLogin) : '<em style="color:#666;">nunca</em>';
            return `
                <div style="background:#0d0d1a;border:1px solid rgba(212,175,55,0.2);border-radius:10px;padding:14px;display:grid;gap:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                        <div>
                            <strong style="color:#fff;font-size:15px;">${_safe(pa.username)}</strong>${inactiveBadge}${inactiveCamp}
                            <div style="color:#aaa;font-size:12px;margin-top:2px;">${campName}</div>
                        </div>
                        <div style="display:flex;gap:6px;">
                            <button onclick="showEditPublisherAdminModal('${_safe(pa.id)}')" style="padding:6px 12px;background:#2a2a3a;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">Editar</button>
                            <button onclick="togglePublisherAdminActive('${_safe(pa.id)}', ${!pa.isActive})" style="padding:6px 12px;background:${pa.isActive ? '#3a1a1a' : '#1a3a1a'};color:${pa.isActive ? '#ff6666' : '#4caf50'};border:none;border-radius:6px;cursor:pointer;font-size:12px;">${pa.isActive ? 'Desactivar' : 'Activar'}</button>
                        </div>
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;color:#aaa;font-size:11px;">
                        <div>👥 Usuarios creados: <strong style="color:#d4af37;">${pa.usersCreatedCount}</strong></div>
                        <div>📅 Creada: ${fmtFechaAR(pa.createdAt)}</div>
                        <div>🔑 Último login: ${lastLogin}</div>
                        <div>🎯 Código: <code style="color:#d4af37;">${_safe(pa.publisherCampaignCode)}</code></div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('loadPublisherAdmins:', e);
        list.innerHTML = '<span style="color:#ff6666;">Error de conexión</span>';
    }
}

// Cargar el <select> de campañas en el modal con las campañas activas.
async function _loadCampaignsIntoPaSelect(selectedCode) {
    const sel = document.getElementById('paFormCampaignCode');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Cargando —</option>';
    try {
        const r = await fetch(`${API_URL}/api/admin/campaigns`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await r.json();
        const all = data.campaigns || [];
        const active = all.filter(c => c.isActive !== false);
        if (active.length === 0) {
            sel.innerHTML = '<option value="">— No hay campañas activas —</option>';
            return;
        }
        sel.innerHTML = '<option value="">— Elegir campaña —</option>' + active.map(c =>
            `<option value="${_safe(c.code)}" ${c.code === selectedCode ? 'selected' : ''}>${_safe(c.publisher)} · ${_safe(c.name)} (${_safe(c.code)})</option>`
        ).join('');
    } catch (e) {
        sel.innerHTML = '<option value="">— Error cargando —</option>';
    }
}

function showCreatePublisherAdminModal() {
    document.getElementById('paFormMode').value = 'create';
    document.getElementById('paFormEditId').value = '';
    document.getElementById('paFormTitle').textContent = 'Nueva cuenta publicista';
    document.getElementById('paFormUsername').value = '';
    document.getElementById('paFormUsername').disabled = false;
    document.getElementById('paFormPassword').value = '';
    document.getElementById('paFormPasswordRequired').textContent = '*';
    document.getElementById('paFormPasswordHint').textContent = 'Se le pasa al publicista por WhatsApp. Él podrá cambiarla después.';
    document.getElementById('paFormEmail').value = '';
    document.getElementById('paFormPhone').value = '';
    document.getElementById('paFormActiveRow').style.display = 'none';
    document.getElementById('paFormError').style.display = 'none';
    _loadCampaignsIntoPaSelect();
    showModal('publisherAdminFormModal');
}

async function showEditPublisherAdminModal(paId) {
    // Cargar datos actuales de la lista (ya está en memoria como DOM, pero pedimos
    // de nuevo por simplicidad y para tener datos frescos).
    try {
        const r = await fetch(`${API_URL}/api/admin/publisher-admins`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await r.json();
        const pa = (data.publisherAdmins || []).find(x => x.id === paId);
        if (!pa) {
            showToast('Cuenta no encontrada', 'error');
            return;
        }
        document.getElementById('paFormMode').value = 'edit';
        document.getElementById('paFormEditId').value = pa.id;
        document.getElementById('paFormTitle').textContent = 'Editar cuenta publicista';
        document.getElementById('paFormUsername').value = pa.username;
        document.getElementById('paFormUsername').disabled = true; // inmutable
        document.getElementById('paFormPassword').value = '';
        document.getElementById('paFormPasswordRequired').textContent = '';
        document.getElementById('paFormPasswordHint').textContent = 'Sólo si querés cambiarla. Dejala vacía para mantener la actual.';
        document.getElementById('paFormEmail').value = pa.email || '';
        document.getElementById('paFormPhone').value = pa.phone || '';
        document.getElementById('paFormActiveRow').style.display = '';
        document.getElementById('paFormIsActive').checked = pa.isActive !== false;
        document.getElementById('paFormError').style.display = 'none';
        _loadCampaignsIntoPaSelect(pa.publisherCampaignCode);
        showModal('publisherAdminFormModal');
    } catch (e) {
        showToast('Error cargando cuenta', 'error');
    }
}

function closePublisherAdminFormModal() {
    hideModal('publisherAdminFormModal');
}

async function submitPublisherAdminForm() {
    const mode = document.getElementById('paFormMode').value;
    const errBox = document.getElementById('paFormError');
    errBox.style.display = 'none';

    const campaignCode = document.getElementById('paFormCampaignCode').value;
    const username = document.getElementById('paFormUsername').value.trim();
    const password = document.getElementById('paFormPassword').value;
    const email = document.getElementById('paFormEmail').value.trim();
    const phone = document.getElementById('paFormPhone').value.trim();

    if (!campaignCode) {
        errBox.textContent = 'Elegí una campaña';
        errBox.style.display = 'block';
        return;
    }

    try {
        let url, method, body;
        if (mode === 'create') {
            if (!username || !password) {
                errBox.textContent = 'Usuario y contraseña son obligatorios';
                errBox.style.display = 'block';
                return;
            }
            url = `${API_URL}/api/admin/publisher-admins`;
            method = 'POST';
            body = JSON.stringify({ campaignCode, username, password, email: email || null, phone: phone || null });
        } else {
            const id = document.getElementById('paFormEditId').value;
            const isActive = document.getElementById('paFormIsActive').checked;
            url = `${API_URL}/api/admin/publisher-admins/${encodeURIComponent(id)}`;
            method = 'PUT';
            const payload = { campaignCode, email: email || null, phone: phone || null, isActive };
            if (password) payload.password = password;
            body = JSON.stringify(payload);
        }

        const r = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body
        });
        const data = await r.json();
        if (!r.ok) {
            errBox.textContent = data.error || 'Error guardando';
            errBox.style.display = 'block';
            return;
        }
        closePublisherAdminFormModal();
        showToast(mode === 'create' ? 'Cuenta creada' : 'Cuenta actualizada', 'success');
        loadPublisherAdmins();
    } catch (e) {
        errBox.textContent = 'Error de conexión';
        errBox.style.display = 'block';
    }
}

async function togglePublisherAdminActive(paId, makeActive) {
    if (!confirm(makeActive ? '¿Reactivar esta cuenta?' : '¿Desactivar esta cuenta? El publicista no podrá entrar al panel.')) return;
    try {
        const r = await fetch(`${API_URL}/api/admin/publisher-admins/${encodeURIComponent(paId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ isActive: makeActive })
        });
        const data = await r.json();
        if (!r.ok) {
            showToast(data.error || 'Error', 'error');
            return;
        }
        showToast(makeActive ? 'Cuenta activada' : 'Cuenta desactivada', 'success');
        loadPublisherAdmins();
    } catch (e) {
        showToast('Error de conexión', 'error');
    }
}

window.showCreatePublisherAdminModal = showCreatePublisherAdminModal;
window.showEditPublisherAdminModal = showEditPublisherAdminModal;
window.closePublisherAdminFormModal = closePublisherAdminFormModal;
window.submitPublisherAdminForm = submitPublisherAdminForm;
window.togglePublisherAdminActive = togglePublisherAdminActive;

// ============================================
// DASHBOARD PUBLICISTAS — sólo admin general
// ============================================

async function loadPublishersDashboard() {
    const body = document.getElementById('publishersDashboardBody');
    if (!body) return;
    body.innerHTML = '<span style="color:#888;">Cargando…</span>';
    const from = document.getElementById('dashFrom')?.value || '';
    const to = document.getElementById('dashTo')?.value || '';
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    try {
        const r = await fetch(`${API_URL}/api/admin/publishers/dashboard?${qs.toString()}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!r.ok) {
            body.innerHTML = '<span style="color:#ff6666;">Error cargando dashboard</span>';
            return;
        }
        const data = await r.json();
        const rows = data.publishers || [];
        if (rows.length === 0) {
            body.innerHTML = '<div style="color:#888;padding:20px;text-align:center;border:1px dashed rgba(255,255,255,0.1);border-radius:8px;">No hay usuarios atribuidos en el rango seleccionado.</div>';
            return;
        }

        const totals = rows.reduce((acc, r) => {
            acc.users += r.users;
            acc.deposits += r.deposits;
            acc.withdrawals += r.withdrawals;
            return acc;
        }, { users: 0, deposits: 0, withdrawals: 0 });
        const totalsNet = totals.deposits - totals.withdrawals;
        const fmt = n => '$' + (Number(n) || 0).toLocaleString('es-AR');

        body.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px;">
                <div style="background:#0d0d1a;border:1px solid rgba(212,175,55,0.2);border-radius:8px;padding:12px;">
                    <div style="color:#888;font-size:10px;letter-spacing:1.2px;font-weight:700;">USUARIOS TOTALES</div>
                    <div style="font-size:22px;font-weight:bold;color:#d4af37;">${totals.users}</div>
                </div>
                <div style="background:#0d0d1a;border:1px solid rgba(76,175,80,0.2);border-radius:8px;padding:12px;">
                    <div style="color:#888;font-size:10px;letter-spacing:1.2px;font-weight:700;">CARGAS</div>
                    <div style="font-size:22px;font-weight:bold;color:#4caf50;">${fmt(totals.deposits)}</div>
                </div>
                <div style="background:#0d0d1a;border:1px solid rgba(255,102,102,0.2);border-radius:8px;padding:12px;">
                    <div style="color:#888;font-size:10px;letter-spacing:1.2px;font-weight:700;">RETIROS</div>
                    <div style="font-size:22px;font-weight:bold;color:#ff6666;">${fmt(totals.withdrawals)}</div>
                </div>
                <div style="background:#0d0d1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:12px;">
                    <div style="color:#888;font-size:10px;letter-spacing:1.2px;font-weight:700;">NETO</div>
                    <div style="font-size:22px;font-weight:bold;color:#fff;">${fmt(totalsNet)}</div>
                </div>
            </div>
            <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="background:#0d0d1a;color:#d4af37;text-align:left;">
                            <th style="padding:10px;border-bottom:1px solid rgba(212,175,55,0.2);">Publicista</th>
                            <th style="padding:10px;border-bottom:1px solid rgba(212,175,55,0.2);text-align:right;">Usuarios</th>
                            <th style="padding:10px;border-bottom:1px solid rgba(212,175,55,0.2);text-align:right;">Manual / Orgánico</th>
                            <th style="padding:10px;border-bottom:1px solid rgba(212,175,55,0.2);text-align:right;">Cargas</th>
                            <th style="padding:10px;border-bottom:1px solid rgba(212,175,55,0.2);text-align:right;">Retiros</th>
                            <th style="padding:10px;border-bottom:1px solid rgba(212,175,55,0.2);text-align:right;">Neto</th>
                            <th style="padding:10px;border-bottom:1px solid rgba(212,175,55,0.2);"></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(row => `
                            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                                <td style="padding:10px;color:#fff;font-weight:600;">${_safe(row.publisher)}</td>
                                <td style="padding:10px;text-align:right;color:#d4af37;font-weight:bold;">${row.users}</td>
                                <td style="padding:10px;text-align:right;color:#aaa;font-size:12px;">${row.usersManual} / ${row.usersOrganic}</td>
                                <td style="padding:10px;text-align:right;color:#4caf50;">${fmt(row.deposits)}</td>
                                <td style="padding:10px;text-align:right;color:#ff6666;">${fmt(row.withdrawals)}</td>
                                <td style="padding:10px;text-align:right;color:${row.netRevenue >= 0 ? '#fff' : '#ff6666'};font-weight:bold;">${fmt(row.netRevenue)}</td>
                                <td style="padding:10px;text-align:right;">
                                    <button onclick="openPublisherUsersModal('${_safe(row.publisher)}')" style="padding:5px 10px;background:#2a2a3a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">Ver usuarios</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    } catch (e) {
        console.error('loadPublishersDashboard:', e);
        body.innerHTML = '<span style="color:#ff6666;">Error de conexión</span>';
    }
}

function clearDashboardFilters() {
    const f = document.getElementById('dashFrom'); if (f) f.value = '';
    const t = document.getElementById('dashTo'); if (t) t.value = '';
    loadPublishersDashboard();
}

async function openPublisherUsersModal(publisher) {
    const titleEl = document.getElementById('puModalTitle');
    const bodyEl = document.getElementById('puModalBody');
    if (titleEl) titleEl.textContent = `Usuarios de ${publisher}`;
    if (bodyEl) bodyEl.innerHTML = 'Cargando…';
    showModal('publisherUsersModal');
    const from = document.getElementById('dashFrom')?.value || '';
    const to = document.getElementById('dashTo')?.value || '';
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    try {
        const r = await fetch(`${API_URL}/api/admin/publishers/${encodeURIComponent(publisher)}/users?${qs.toString()}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!r.ok) {
            if (bodyEl) bodyEl.innerHTML = '<span style="color:#ff6666;">Error cargando</span>';
            return;
        }
        const data = await r.json();
        const users = data.users || [];
        if (users.length === 0) {
            if (bodyEl) bodyEl.innerHTML = '<span style="color:#888;">Sin usuarios para este publicista en el rango seleccionado.</span>';
            return;
        }
        const fmt = n => '$' + (Number(n) || 0).toLocaleString('es-AR');
        bodyEl.innerHTML = `
            <div style="overflow-x:auto;max-height:60vh;">
                <table style="width:100%;border-collapse:collapse;font-size:12px;">
                    <thead>
                        <tr style="background:#0d0d1a;color:#d4af37;text-align:left;position:sticky;top:0;">
                            <th style="padding:8px;">Usuario</th>
                            <th style="padding:8px;">Origen</th>
                            <th style="padding:8px;">Creado</th>
                            <th style="padding:8px;">Creado por</th>
                            <th style="padding:8px;text-align:right;">Cargas</th>
                            <th style="padding:8px;text-align:right;">Retiros</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${users.map(u => `
                            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                                <td style="padding:8px;color:#fff;">${_safe(u.username)}</td>
                                <td style="padding:8px;color:${u.acquisitionSource === 'manual' ? '#d4af37' : '#aaa'};font-size:11px;">${u.acquisitionSource === 'manual' ? '👤 manual' : '🌐 orgánico'}</td>
                                <td style="padding:8px;color:#888;">${fmtFechaAR(u.createdAt)}</td>
                                <td style="padding:8px;color:#aaa;">${_safe(u.createdByEmployeeUsername || '—')}</td>
                                <td style="padding:8px;text-align:right;color:#4caf50;">${fmt(u.deposits)}</td>
                                <td style="padding:8px;text-align:right;color:#ff6666;">${fmt(u.withdrawals)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <div style="margin-top:8px;color:#888;font-size:11px;">${users.length} usuario(s)</div>
        `;
    } catch (e) {
        if (bodyEl) bodyEl.innerHTML = '<span style="color:#ff6666;">Error de conexión</span>';
    }
}

function closePublisherUsersModal() {
    hideModal('publisherUsersModal');
}

window.loadPublishersDashboard = loadPublishersDashboard;
window.clearDashboardFilters = clearDashboardFilters;
window.openPublisherUsersModal = openPublisherUsersModal;
window.closePublisherUsersModal = closePublisherUsersModal;

// ============================================
// ANÁLISIS / RANKING / RECUPERACIÓN DE PUBLICISTAS
// ============================================

function _scoreColor(score) {
    if (score >= 70) return '#4caf50';
    if (score >= 45) return '#d4af37';
    if (score >= 25) return '#ff9800';
    return '#ff5050';
}

async function loadPublishersRanking() {
    const body = document.getElementById('publishersRankingBody');
    if (!body) return;
    body.innerHTML = '<span style="color:#888;">Cargando ranking…</span>';
    try {
        const r = await fetch(`${API_URL}/api/admin/publishers/ranking`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!r.ok) { body.innerHTML = '<span style="color:#ff6666;">Error cargando ranking</span>'; return; }
        const data = await r.json();
        const rows = data.ranking || [];
        if (rows.length === 0) {
            body.innerHTML = '<div style="color:#888;padding:14px;text-align:center;border:1px dashed rgba(255,255,255,0.1);border-radius:8px;">No hay publicistas con clientes todavía.</div>';
            return;
        }
        const fmt = n => '$' + (Number(n) || 0).toLocaleString('es-AR');
        body.innerHTML = `
            <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
                    <thead>
                        <tr style="background:#15152a;color:#d4af37;text-align:left;">
                            <th style="padding:9px;">#</th>
                            <th style="padding:9px;">Publicista</th>
                            <th style="padding:9px;text-align:center;">Score</th>
                            <th style="padding:9px;text-align:right;">Clientes</th>
                            <th style="padding:9px;text-align:right;">🟢 Activos</th>
                            <th style="padding:9px;text-align:right;">🟡 Riesgo</th>
                            <th style="padding:9px;text-align:right;">🔴 Perdidos</th>
                            <th style="padding:9px;text-align:right;">💎 Ticket alto</th>
                            <th style="padding:9px;text-align:right;">Ticket prom.</th>
                            <th style="padding:9px;text-align:right;">Neto</th>
                            <th style="padding:9px;"></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map((p, i) => `
                            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                                <td style="padding:9px;color:#888;">${i + 1}</td>
                                <td style="padding:9px;color:#fff;font-weight:600;">${_safe(p.publisher)}</td>
                                <td style="padding:9px;text-align:center;">
                                    <span style="display:inline-block;min-width:34px;padding:3px 8px;border-radius:12px;font-weight:bold;color:#000;background:${_scoreColor(p.score)};">${p.score}</span>
                                </td>
                                <td style="padding:9px;text-align:right;color:#fff;">${p.clients}${p.neverDeposited ? `<span style="color:#666;font-size:10px;"> (+${p.neverDeposited} sin cargar)</span>` : ''}</td>
                                <td style="padding:9px;text-align:right;color:#4caf50;">${p.active}</td>
                                <td style="padding:9px;text-align:right;color:#ffb300;">${p.atRisk}</td>
                                <td style="padding:9px;text-align:right;color:#ff6666;">${p.lost}</td>
                                <td style="padding:9px;text-align:right;color:#d4af37;">${p.highTicketCount}</td>
                                <td style="padding:9px;text-align:right;color:#aaa;">${fmt(p.avgTicket)}</td>
                                <td style="padding:9px;text-align:right;color:${p.netRevenue >= 0 ? '#fff' : '#ff6666'};font-weight:bold;">${fmt(p.netRevenue)}</td>
                                <td style="padding:9px;text-align:right;">
                                    <button onclick="openPublisherAnalysis('${_safe(p.publisher)}')" style="padding:5px 10px;background:rgba(212,175,55,0.15);border:1px solid #d4af37;color:#d4af37;border-radius:5px;cursor:pointer;font-size:11px;white-space:nowrap;">Ver análisis</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`;
    } catch (e) {
        console.error('loadPublishersRanking:', e);
        body.innerHTML = '<span style="color:#ff6666;">Error de conexión</span>';
    }
}

function _renderClientRows(clients) {
    if (!clients || clients.length === 0) {
        return '<div style="color:#666;font-size:12px;padding:8px;">— sin clientes en este segmento —</div>';
    }
    const fmt = n => '$' + (Number(n) || 0).toLocaleString('es-AR');
    return `
        <div style="overflow-x:auto;max-height:280px;overflow-y:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr style="background:#15152a;color:#aaa;text-align:left;position:sticky;top:0;">
                    <th style="padding:6px;">Usuario</th>
                    <th style="padding:6px;text-align:right;">Total cargado</th>
                    <th style="padding:6px;text-align:right;">Cargas</th>
                    <th style="padding:6px;text-align:right;">Ticket prom.</th>
                    <th style="padding:6px;text-align:right;">Últ. carga</th>
                    <th style="padding:6px;"></th>
                </tr></thead>
                <tbody>
                    ${clients.map(c => `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                            <td style="padding:6px;color:#fff;">${_safe(c.username)}${c.highTicket ? ' 💎' : ''}${c.loyal ? ' 👑' : ''}</td>
                            <td style="padding:6px;text-align:right;color:#4caf50;">${fmt(c.totalDeposited)}</td>
                            <td style="padding:6px;text-align:right;color:#aaa;">${c.depositCount}</td>
                            <td style="padding:6px;text-align:right;color:#aaa;">${fmt(c.avgTicket)}</td>
                            <td style="padding:6px;text-align:right;color:#888;">${c.daysSinceLastDeposit == null ? '—' : ('hace ' + c.daysSinceLastDeposit + 'd')}</td>
                            <td style="padding:6px;"></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>`;
}

// Estado del análisis abierto (para los tabs y el render diferido del diario).
let _analysisState = { publisher: null, analysis: null, daily: null };

async function openPublisherAnalysis(publisher) {
    const titleEl = document.getElementById('paAnalysisTitle');
    const bodyEl = document.getElementById('paAnalysisBody');
    if (titleEl) titleEl.textContent = '📊 ' + publisher;
    if (bodyEl) bodyEl.innerHTML = '<span style="color:#888;">Cargando…</span>';
    _analysisState = { publisher, analysis: null, daily: null, influencers: null };
    showModal('publisherAnalysisModal');
    try {
        // Traemos análisis y diario en paralelo.
        const [aRes, dRes] = await Promise.all([
            fetch(`${API_URL}/api/admin/publishers/${encodeURIComponent(publisher)}/analysis`, { headers: { 'Authorization': `Bearer ${currentToken}` } }),
            fetch(`${API_URL}/api/admin/publishers/${encodeURIComponent(publisher)}/daily`, { headers: { 'Authorization': `Bearer ${currentToken}` } })
        ]);
        if (!aRes.ok) {
            const e = await aRes.json().catch(() => ({}));
            bodyEl.innerHTML = `<span style="color:#ff6666;">${_safe(e.error || 'Error cargando análisis')}</span>`;
            return;
        }
        _analysisState.analysis = await aRes.json();
        _analysisState.daily = dRes.ok ? await dRes.json() : { days: [], totals: {} };
        _renderAnalysisShell();
        switchAnalysisTab('new'); // arranca en "Usuarios nuevos"
    } catch (e) {
        bodyEl.innerHTML = '<span style="color:#ff6666;">Error de conexión</span>';
    }
}

// Cabecera (cards resumen) + barra de tabs + 3 contenedores de pestaña.
function _renderAnalysisShell() {
    const bodyEl = document.getElementById('paAnalysisBody');
    const { analysis } = _analysisState;
    const m = analysis.metrics;
    const fmt = n => '$' + (Number(n) || 0).toLocaleString('es-AR');
    const card = (label, val, color, sub) => `
        <div style="background:#0d0d1a;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;text-align:center;">
            <div style="color:#888;font-size:10px;letter-spacing:.5px;">${label}</div>
            <div style="font-size:20px;font-weight:bold;color:${color};">${val}</div>
            ${sub ? `<div style="color:#666;font-size:10px;">${sub}</div>` : ''}
        </div>`;

    const tabBtn = (key, label) => `
        <button class="pa-tab-btn" data-tab="${key}" onclick="switchAnalysisTab('${key}')"
            style="flex:1;padding:11px 8px;background:#0d0d1a;color:#aaa;border:1px solid rgba(255,255,255,0.08);border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">${label}</button>`;

    bodyEl.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px;">
            ${card('SCORE', m.score, _scoreColor(m.score))}
            ${card('CLIENTES', m.clients, '#fff', m.neverDeposited ? (m.neverDeposited + ' reg. sin cargar') : 'cargaron al menos 1 vez')}
            ${card('TICKET PROM.', fmt(m.avgTicket), '#d4af37')}
            ${card('NETO', fmt(m.netRevenue), m.netRevenue >= 0 ? '#4caf50' : '#ff6666')}
            ${card('RETENCIÓN', m.retentionRate + '%', '#4caf50')}
        </div>
        <div style="display:flex;gap:8px;margin-bottom:14px;">
            ${tabBtn('new', '✨ Usuarios nuevos')}
            ${tabBtn('loads', '💰 Cargas totales')}
            ${tabBtn('retention', '🔄 Retención')}
            ${tabBtn('influencers', '🎬 Por influencer')}
        </div>
        <div id="paTabContent"></div>
    `;
}

function switchAnalysisTab(tab) {
    // Resaltar el botón activo.
    document.querySelectorAll('.pa-tab-btn').forEach(b => {
        const active = b.dataset.tab === tab;
        b.style.background = active ? 'rgba(212,175,55,0.18)' : '#0d0d1a';
        b.style.color = active ? '#d4af37' : '#aaa';
        b.style.borderColor = active ? '#d4af37' : 'rgba(255,255,255,0.08)';
    });
    const c = document.getElementById('paTabContent');
    if (!c) return;
    if (tab === 'new') c.innerHTML = _renderTabNuevos();
    else if (tab === 'loads') c.innerHTML = _renderTabCargas();
    else if (tab === 'retention') c.innerHTML = _renderTabRetencion();
    else if (tab === 'influencers') _renderTabInfluencers(c);
}

// ----- Tab 4: Por influencer (se trae a demanda; no viene en el análisis base) -----
async function _renderTabInfluencers(container) {
    const { publisher } = _analysisState;
    if (!_analysisState.influencers) {
        container.innerHTML = '<span style="color:#888;font-size:13px;">Cargando…</span>';
        try {
            const r = await fetch(`${API_URL}/api/admin/publishers/${encodeURIComponent(publisher)}/influencers`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            });
            _analysisState.influencers = r.ok ? await r.json() : { influencers: [] };
        } catch (e) {
            container.innerHTML = '<span style="color:#ff6666;">Error cargando influencers</span>';
            return;
        }
    }
    const rows = _analysisState.influencers.influencers || [];
    if (rows.length === 0) {
        container.innerHTML = '<div style="color:#888;font-size:13px;padding:14px;text-align:center;">Este publicista no tiene influencers cargados.<br>Agregalos desde <strong>Publicistas y pautas → Editar campaña</strong> para ver el desglose.</div>';
        return;
    }
    // Código de campaña para el ranking por historias (los influencers de un
    // publicista comparten campaña en la práctica; tomamos el primero con código).
    const rankCampCode = (rows.find(r => r.campaignCode) || {}).campaignCode || '';
    container.innerHTML = `
        <p style="color:#888;font-size:11.5px;margin:0 0 10px;">Clientes del publicista desglosados por el influencer que los trajo. "Sin influencer" = usuarios sin asignar (orgánicos del link o creados antes de cargar la lista).</p>
        ${rankCampCode ? `<div style="margin:0 0 12px;"><button onclick="openInfluencerRanking('${_safe(rankCampCode)}')" style="padding:8px 14px;background:linear-gradient(135deg,#d4af37,#f0c850);border:none;color:#1a1a2e;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:800;">🏆 Ranking por historias (mejor → peor)</button></div>` : ''}
        <div style="overflow-x:auto;max-height:360px;overflow-y:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr style="background:#15152a;color:#6cf;text-align:left;position:sticky;top:0;">
                    <th style="padding:8px;">Influencer</th>
                    <th style="padding:8px;text-align:right;">Clientes</th>
                    <th style="padding:8px;text-align:right;">Registr.</th>
                    <th style="padding:8px;text-align:right;">$ Cargado</th>
                    <th style="padding:8px;text-align:right;">$ Neto</th>
                    <th style="padding:8px;text-align:right;">Ticket prom.</th>
                    <th style="padding:8px;text-align:right;">Retención</th>
                    <th style="padding:8px;text-align:center;">Acciones</th>
                </tr></thead>
                <tbody>
                    ${rows.map((r, i) => `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                            <td style="padding:8px;color:#fff;font-weight:600;">${_safe(r.influencer)}</td>
                            <td style="padding:8px;text-align:right;color:#fff;">${r.clients}${r.neverDeposited ? `<span style="color:#666;"> +${r.neverDeposited}</span>` : ''}</td>
                            <td style="padding:8px;text-align:right;color:#aaa;">${r.registered}</td>
                            <td style="padding:8px;text-align:right;color:#4caf50;">${_fmtMoney(r.deposits)}</td>
                            <td style="padding:8px;text-align:right;color:${r.netRevenue >= 0 ? '#fff' : '#ff6666'};">${_fmtMoney(r.netRevenue)}</td>
                            <td style="padding:8px;text-align:right;color:#d4af37;">${_fmtMoney(r.avgTicket)}</td>
                            <td style="padding:8px;text-align:right;color:#4caf50;">${r.retentionRate}%</td>
                            <td style="padding:8px;text-align:center;white-space:nowrap;">${r.campaignCode
                                ? `<button onclick="openInfluencerStoriesIdx(${i})" style="padding:5px 9px;background:rgba(108,170,255,0.15);border:1px solid #6cf;color:#6cf;border-radius:5px;cursor:pointer;font-size:11px;white-space:nowrap;">📖 Historias</button>
                                   <button onclick="openInfluencerUsersIdx(${i})" style="padding:5px 9px;background:rgba(212,175,55,0.15);border:1px solid #d4af37;color:#d4af37;border-radius:5px;cursor:pointer;font-size:11px;white-space:nowrap;margin-left:4px;">👥 Usuarios</button>`
                                : '<span style="color:#555;">—</span>'}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
}

const _fmtMoney = n => '$' + (Number(n) || 0).toLocaleString('es-AR');

// ----- Tab 1: Usuarios nuevos (FTD / ROAS) -----
function _renderTabNuevos() {
    const { daily, analysis } = _analysisState;
    const m = analysis.metrics;
    const days = daily.days || [];
    const t = daily.totals || {};
    const head = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:12px;">
            <div style="background:#0d0d1a;border:1px solid rgba(108,170,255,0.25);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">CLIENTES NUEVOS (rango)</div>
                <div style="font-size:22px;font-weight:bold;color:#6cf;">${t.ftdCount || 0}</div>
            </div>
            <div style="background:#0d0d1a;border:1px solid rgba(76,175,80,0.25);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">$ PRIMERAS CARGAS (FTD)</div>
                <div style="font-size:22px;font-weight:bold;color:#4caf50;">${_fmtMoney(t.ftdAmount)}</div>
            </div>
            <div style="background:#0d0d1a;border:1px solid rgba(212,175,55,0.25);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">NUEVOS QUE RECARGARON MISMO DÍA</div>
                <div style="font-size:22px;font-weight:bold;color:#d4af37;">${t.newReloadedClients || 0}</div>
            </div>
        </div>
        <p style="color:#888;font-size:11.5px;margin:0 0 10px;">FTD = primera carga histórica de cada cliente. Útil para el ROAS (comparar contra tu gasto de pauta diario). Rango: ${daily.from || '—'} → ${daily.to || '—'}.</p>`;
    if (days.length === 0) return head + '<div style="color:#888;font-size:13px;padding:14px;text-align:center;">Sin cargas en el rango (últimos 30 días).</div>';
    return head + `
        <div style="overflow-x:auto;max-height:340px;overflow-y:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr style="background:#15152a;color:#6cf;text-align:left;position:sticky;top:0;">
                    <th style="padding:8px;">Día (ART)</th>
                    <th style="padding:8px;text-align:right;">Clientes nuevos (FTD)</th>
                    <th style="padding:8px;text-align:right;">$ FTD</th>
                    <th style="padding:8px;text-align:right;">Nuevos que recargaron</th>
                    <th style="padding:8px;text-align:right;">Recargas mismo día</th>
                    <th style="padding:8px;text-align:right;">$ recargas</th>
                </tr></thead>
                <tbody>
                    ${days.map(d => `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                            <td style="padding:8px;color:#fff;">${d.date}</td>
                            <td style="padding:8px;text-align:right;color:#6cf;font-weight:bold;">${d.ftdCount}</td>
                            <td style="padding:8px;text-align:right;color:#4caf50;">${_fmtMoney(d.ftdAmount)}</td>
                            <td style="padding:8px;text-align:right;color:#d4af37;">${d.newReloadedClients}</td>
                            <td style="padding:8px;text-align:right;color:#d4af37;font-weight:bold;">${d.newReloadDeposits}</td>
                            <td style="padding:8px;text-align:right;color:#aaa;">${_fmtMoney(d.newReloadAmount)}</td>
                        </tr>`).join('')}
                </tbody>
                <tfoot><tr style="border-top:2px solid rgba(108,170,255,0.3);font-weight:bold;">
                    <td style="padding:8px;color:#6cf;">TOTAL</td>
                    <td style="padding:8px;text-align:right;color:#6cf;">${t.ftdCount || 0}</td>
                    <td style="padding:8px;text-align:right;color:#4caf50;">${_fmtMoney(t.ftdAmount)}</td>
                    <td style="padding:8px;text-align:right;color:#d4af37;">${t.newReloadedClients || 0}</td>
                    <td style="padding:8px;text-align:right;color:#d4af37;">${t.newReloadDeposits || 0}</td>
                    <td style="padding:8px;text-align:right;color:#aaa;">${_fmtMoney(t.newReloadAmount)}</td>
                </tr></tfoot>
            </table>
        </div>`;
}

// ----- Tab 2: Cargas totales -----
function _renderTabCargas() {
    const { daily, analysis } = _analysisState;
    const m = analysis.metrics;
    const days = daily.days || [];
    const t = daily.totals || {};
    const head = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:12px;">
            <div style="background:#0d0d1a;border:1px solid rgba(76,175,80,0.25);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">CARGAS TOTALES</div>
                <div style="font-size:22px;font-weight:bold;color:#4caf50;">${m.depositCount || 0}</div>
            </div>
            <div style="background:#0d0d1a;border:1px solid rgba(76,175,80,0.25);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">$ TOTAL CARGADO</div>
                <div style="font-size:22px;font-weight:bold;color:#4caf50;">${_fmtMoney(m.deposits)}</div>
            </div>
            <div style="background:#0d0d1a;border:1px solid rgba(255,102,102,0.25);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">$ RETIRADO</div>
                <div style="font-size:22px;font-weight:bold;color:#ff6666;">${_fmtMoney(m.withdrawals)}</div>
            </div>
            <div style="background:#0d0d1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">NETO</div>
                <div style="font-size:22px;font-weight:bold;color:${m.netRevenue >= 0 ? '#fff' : '#ff6666'};">${_fmtMoney(m.netRevenue)}</div>
            </div>
        </div>`;
    const dailyTable = days.length === 0
        ? '<div style="color:#888;font-size:13px;padding:10px;">Sin cargas en el rango.</div>'
        : `<div style="overflow-x:auto;max-height:240px;overflow-y:auto;margin-bottom:14px;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr style="background:#15152a;color:#4caf50;text-align:left;position:sticky;top:0;">
                    <th style="padding:8px;">Día (ART)</th>
                    <th style="padding:8px;text-align:right;">Cargas</th>
                    <th style="padding:8px;text-align:right;">$ Monto</th>
                </tr></thead>
                <tbody>${days.map(d => `
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                        <td style="padding:8px;color:#fff;">${d.date}</td>
                        <td style="padding:8px;text-align:right;color:#aaa;">${d.totalDeposits}</td>
                        <td style="padding:8px;text-align:right;color:#4caf50;">${_fmtMoney(d.totalAmount)}</td>
                    </tr>`).join('')}</tbody>
                <tfoot><tr style="border-top:2px solid rgba(76,175,80,0.3);font-weight:bold;">
                    <td style="padding:8px;color:#4caf50;">TOTAL</td>
                    <td style="padding:8px;text-align:right;color:#aaa;">${t.totalDeposits || 0}</td>
                    <td style="padding:8px;text-align:right;color:#4caf50;">${_fmtMoney(t.totalAmount)}</td>
                </tr></tfoot>
            </table></div>`;
    const valued = `
        <details style="background:#0d0d1a;border:1px solid rgba(212,175,55,0.25);border-radius:10px;margin-bottom:10px;" open>
            <summary style="cursor:pointer;padding:12px 14px;color:#d4af37;font-weight:700;">💎 Clientes ticket alto (${analysis.highTicket.length})</summary>
            <div style="padding:0 14px 14px;">${_renderClientRows(analysis.highTicket)}</div>
        </details>
        <details style="background:#0d0d1a;border:1px solid rgba(212,175,55,0.25);border-radius:10px;">
            <summary style="cursor:pointer;padding:12px 14px;color:#d4af37;font-weight:700;">👑 Clientes fieles — muchas cargas (${analysis.loyal.length})</summary>
            <div style="padding:0 14px 14px;">${_renderClientRows(analysis.loyal)}</div>
        </details>`;
    return head + dailyTable + valued;
}

// ----- Tab 3: Retención -----
function _renderTabRetencion() {
    const { analysis, publisher } = _analysisState;
    const m = analysis.metrics;
    const seg = analysis.segments;
    const pub = _analysisState.publisher;
    const segBlock = (titulo, color, clients, segKey, recover) => `
        <details style="background:#0d0d1a;border:1px solid ${color}33;border-radius:10px;margin-bottom:10px;" ${segKey === 'atRisk' || segKey === 'lost' ? 'open' : ''}>
            <summary style="cursor:pointer;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;">
                <span style="color:${color};font-weight:700;">${titulo} (${clients.length})</span>
                ${recover && clients.length > 0
                    ? `<button onclick="event.preventDefault();openRecoverModal('${_safe(pub)}','${segKey}','${clients.length}')" style="padding:5px 12px;background:${color};color:#000;border:none;border-radius:6px;cursor:pointer;font-size:11px;font-weight:bold;">📣 Recuperar</button>`
                    : ''}
            </summary>
            <div style="padding:0 14px 14px;">${_renderClientRows(clients)}</div>
        </details>`;
    return `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:12px;">
            <div style="background:#0d0d1a;border:1px solid rgba(76,175,80,0.25);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">🟢 ACTIVOS</div>
                <div style="font-size:22px;font-weight:bold;color:#4caf50;">${m.active}</div>
            </div>
            <div style="background:#0d0d1a;border:1px solid rgba(255,179,0,0.25);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">🟡 EN RIESGO</div>
                <div style="font-size:22px;font-weight:bold;color:#ffb300;">${m.atRisk}</div>
            </div>
            <div style="background:#0d0d1a;border:1px solid rgba(255,102,102,0.25);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">🔴 PERDIDOS</div>
                <div style="font-size:22px;font-weight:bold;color:#ff6666;">${m.lost}</div>
            </div>
            <div style="background:#0d0d1a;border:1px solid rgba(76,175,80,0.25);border-radius:8px;padding:12px;text-align:center;">
                <div style="color:#888;font-size:11px;">RETENCIÓN</div>
                <div style="font-size:22px;font-weight:bold;color:#4caf50;">${m.retentionRate}%</div>
            </div>
        </div>
        <p style="color:#888;font-size:11.5px;margin:0 0 10px;">Activo ≤7d desde última carga · En riesgo 8-21d · Perdido +21d. Mandá un push a "en riesgo" y "perdidos" para recuperarlos.</p>
        ${segBlock('🟡 EN RIESGO — se están yendo', '#ffb300', seg.atRisk, 'atRisk', true)}
        ${segBlock('🔴 PERDIDOS — recuperar', '#ff6666', seg.lost, 'lost', true)}
        ${segBlock('🟢 ACTIVOS', '#4caf50', seg.active, 'active', false)}
        ${m.neverDeposited ? `<div style="color:#666;font-size:12px;padding:8px 4px;">⚪ ${m.neverDeposited} registrado(s) todavía sin cargar (no cuentan como clientes).</div>` : ''}`;
}

// ============================================
// HISTORIAS DE INFLUENCER — costo / ROAS por publicación
// ============================================
let _storiesState = null;     // respuesta del backend para el influencer abierto
let _editingStoryId = null;   // id de historia en edición (null = alta nueva)

function _isFmtMoney(n) { return '$' + (Number(n) || 0).toLocaleString('es-AR'); }

async function openInfluencerStories(campaign, influencer) {
    document.getElementById('isCampaign').value = campaign;
    document.getElementById('isInfluencer').value = influencer;
    document.getElementById('isTitle').textContent = '🎬 ' + influencer;
    document.getElementById('isSubtitle').textContent = 'Campaña ' + campaign + ' · seguimiento de costo y ROAS por historia';
    _editingStoryId = null;
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    document.getElementById('isNewDate').value = `${yyyy}-${mm}-${dd}`;
    document.getElementById('isNewTime').value = '20:00';
    document.getElementById('isNewCost').value = '';
    document.getElementById('isNewLabel').value = '';
    document.getElementById('isAddBtn').textContent = 'Agregar';
    document.getElementById('isFormError').style.display = 'none';
    document.getElementById('isTableWrap').innerHTML = 'Cargando…';
    showModal('influencerStoriesModal');
    await loadInfluencerStories();
}

async function loadInfluencerStories() {
    const campaign = document.getElementById('isCampaign').value;
    const influencer = document.getElementById('isInfluencer').value;
    try {
        const qs = new URLSearchParams({ campaign, influencer });
        const r = await fetch(`${API_URL}/api/admin/influencer-stories?${qs.toString()}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        _storiesState = r.ok ? await r.json() : null;
        if (!_storiesState) {
            document.getElementById('isTableWrap').innerHTML = '<span style="color:#ff6666;">Error cargando historias</span>';
            return;
        }
    } catch (e) {
        document.getElementById('isTableWrap').innerHTML = '<span style="color:#ff6666;">Error de conexión</span>';
        return;
    }
    renderStoriesTable();
}

function renderStoriesTable() {
    if (!_storiesState) return;
    const wrap = document.getElementById('isTableWrap');
    const roasTarget = parseFloat(document.getElementById('isRoasTarget').value) || 0;
    const cpaParsed = parseFloat(document.getElementById('isCpaTarget').value);
    const cpaT = Number.isFinite(cpaParsed) ? cpaParsed : Infinity;
    const stories = _storiesState.stories || [];
    const t = _storiesState.totals || {};
    const before = _storiesState.before;

    const roasTxt = v => v == null ? '—' : (v.toFixed(2) + 'x');
    const roasColor = v => v == null ? '#888' : (v >= roasTarget ? '#4caf50' : '#ff6666');
    const pctTxt = v => v == null ? '—' : (Math.round(v * 100) + '%');
    const verdict = (r) => {
        if (!r.cost || r.cost <= 0) return '<span style="color:#888;">sin costo</span>';
        const ok = (r.roasNet != null && r.roasNet >= roasTarget) || (r.cpaPerRegistro != null && r.cpaPerRegistro <= cpaT);
        return ok
            ? '<span style="color:#4caf50;font-weight:bold;">🟢 Rentable</span>'
            : '<span style="color:#ff6666;font-weight:bold;">🔴 No</span>';
    };
    const fmtDate = (d) => d ? fmtFechaHoraAR(d) : '';

    if (stories.length === 0 && !before) {
        wrap.innerHTML = '<div style="color:#888;font-size:13px;padding:14px;text-align:center;">Todavía no cargaste historias para este influencer. Cargá la primera arriba ☝️</div>';
        return;
    }

    // Celdas de retención/calidad reutilizadas en fila normal, "antes" y total.
    const cellsCalidad = (r, dim) => `
            <td style="padding:8px;text-align:right;color:${dim ? '#888' : '#6cf'};">${pctTxt(r.conversionRate)}</td>
            <td style="padding:8px;text-align:right;color:${dim ? '#888' : '#ffd700'};white-space:nowrap;">${r.loyalCount || 0}<div style="color:#666;font-size:10px;">${pctTxt(r.loyalRate)}</div></td>
            <td style="padding:8px;text-align:right;color:${dim ? '#888' : '#4caf50'};white-space:nowrap;">${r.activeCount || 0}<div style="color:#666;font-size:10px;">${pctTxt(r.activeRate)}</div></td>
            <td style="padding:8px;text-align:right;color:${dim ? '#888' : '#fff'};white-space:nowrap;">${r.avgTicket == null ? '—' : _isFmtMoney(r.avgTicket)}</td>
            <td style="padding:8px;text-align:right;color:${dim ? '#888' : '#aaa'};white-space:nowrap;">${r.cpc == null ? '—' : _isFmtMoney(r.cpc)}${r.clicks ? `<div style="color:#666;font-size:10px;">${r.clicks} clk</div>` : ''}</td>`;

    const row = (r) => `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
            <td style="padding:8px;color:#fff;white-space:nowrap;">${r.number ? '<b>#' + r.number + '</b> ' : ''}${fmtDate(r.postedAt)}${r.label ? `<div style="color:#888;font-size:10px;">${_safe(r.label)}</div>` : ''}</td>
            <td style="padding:8px;text-align:right;color:#d4af37;white-space:nowrap;">${_isFmtMoney(r.cost)}</td>
            <td style="padding:8px;text-align:right;color:#fff;">${r.registros}</td>
            <td style="padding:8px;text-align:right;color:#fff;">${r.clientes}</td>
            ${cellsCalidad(r, false)}
            <td style="padding:8px;text-align:right;color:${r.cpaPerRegistro != null && r.cpaPerRegistro <= cpaT ? '#4caf50' : '#aaa'};white-space:nowrap;">${r.cpaPerRegistro == null ? '—' : _isFmtMoney(r.cpaPerRegistro)}</td>
            <td style="padding:8px;text-align:right;color:#4caf50;white-space:nowrap;">${_isFmtMoney(r.deposits)}</td>
            <td style="padding:8px;text-align:right;color:${r.net >= 0 ? '#fff' : '#ff6666'};white-space:nowrap;">${_isFmtMoney(r.net)}</td>
            <td style="padding:8px;text-align:right;font-weight:bold;color:${roasColor(r.roasNet)};">${roasTxt(r.roasNet)}</td>
            <td style="padding:8px;text-align:center;white-space:nowrap;">${verdict(r)}</td>
            <td style="padding:8px;text-align:center;white-space:nowrap;">
                <button onclick="editStory('${r.storyId}')" style="padding:3px 7px;background:#2a2a3a;color:#6cf;border:none;border-radius:4px;cursor:pointer;font-size:11px;">✎</button>
                <button onclick="deleteStory('${r.storyId}')" style="padding:3px 7px;background:#3a1a1a;color:#ff6666;border:none;border-radius:4px;cursor:pointer;font-size:11px;">🗑</button>
            </td>
        </tr>`;

    const beforeRow = before ? `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);opacity:.7;">
            <td style="padding:8px;color:#888;">Antes de la 1ª historia</td>
            <td style="padding:8px;text-align:right;color:#666;">—</td>
            <td style="padding:8px;text-align:right;color:#aaa;">${before.registros}</td>
            <td style="padding:8px;text-align:right;color:#aaa;">${before.clientes}</td>
            ${cellsCalidad(before, true)}
            <td style="padding:8px;text-align:right;color:#666;">—</td>
            <td style="padding:8px;text-align:right;color:#4caf50;">${_isFmtMoney(before.deposits)}</td>
            <td style="padding:8px;text-align:right;color:${before.net >= 0 ? '#aaa' : '#ff6666'};">${_isFmtMoney(before.net)}</td>
            <td style="padding:8px;text-align:right;color:#666;">—</td>
            <td style="padding:8px;text-align:center;color:#666;">—</td>
            <td style="padding:8px;"></td>
        </tr>` : '';

    wrap.innerHTML = `
        <div style="overflow-x:auto;max-height:420px;overflow-y:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr style="background:#15152a;color:#6cf;text-align:left;position:sticky;top:0;">
                    <th style="padding:8px;">Historia (fecha/hora)</th>
                    <th style="padding:8px;text-align:right;">Costo</th>
                    <th style="padding:8px;text-align:right;">Regist.</th>
                    <th style="padding:8px;text-align:right;">Cargaron</th>
                    <th style="padding:8px;text-align:right;" title="Registros que cargaron al menos una vez">Conv.</th>
                    <th style="padding:8px;text-align:right;" title="Clientes fieles (≥5 cargas)">Fieles</th>
                    <th style="padding:8px;text-align:right;" title="Clientes que siguen activos (cargaron ≤7 días)">Activos</th>
                    <th style="padding:8px;text-align:right;" title="Ticket promedio por carga">Ticket</th>
                    <th style="padding:8px;text-align:right;" title="Costo por click (clicks de la campaña en la ventana de la historia)">CPC</th>
                    <th style="padding:8px;text-align:right;">CPA</th>
                    <th style="padding:8px;text-align:right;">$ Cargado</th>
                    <th style="padding:8px;text-align:right;">$ Neto</th>
                    <th style="padding:8px;text-align:right;">ROAS</th>
                    <th style="padding:8px;text-align:center;">¿Rentable?</th>
                    <th style="padding:8px;text-align:center;">Acc.</th>
                </tr></thead>
                <tbody>
                    ${stories.map(row).join('')}
                    ${beforeRow}
                </tbody>
                <tfoot><tr style="border-top:2px solid rgba(108,170,255,0.3);font-weight:bold;">
                    <td style="padding:8px;color:#6cf;">TOTAL (${stories.length} historia/s)</td>
                    <td style="padding:8px;text-align:right;color:#d4af37;">${_isFmtMoney(t.cost)}</td>
                    <td style="padding:8px;text-align:right;color:#fff;">${t.registros || 0}</td>
                    <td style="padding:8px;text-align:right;color:#fff;">${t.clientes || 0}</td>
                    ${cellsCalidad(t, false)}
                    <td style="padding:8px;text-align:right;color:#aaa;">${t.cpaPerRegistro == null ? '—' : _isFmtMoney(t.cpaPerRegistro)}</td>
                    <td style="padding:8px;text-align:right;color:#4caf50;">${_isFmtMoney(t.deposits)}</td>
                    <td style="padding:8px;text-align:right;color:${(t.net || 0) >= 0 ? '#fff' : '#ff6666'};">${_isFmtMoney(t.net)}</td>
                    <td style="padding:8px;text-align:right;color:${roasColor(t.roasNet)};">${roasTxt(t.roasNet)}</td>
                    <td style="padding:8px;text-align:center;">${verdict(t)}</td>
                    <td style="padding:8px;"></td>
                </tr></tfoot>
            </table>
        </div>
        <p style="color:#666;font-size:11px;margin:10px 0 0;">Atribución por horario: cada historia se queda con los registros desde que subió hasta la próxima. <b>Conv.</b>=registros que cargaron · <b>Fieles</b>=clientes con ≥5 cargas · <b>Activos</b>=cargaron en los últimos 7 días · <b>CPC</b>=costo por click (clicks de la campaña en la ventana; se borran a los 90 días). Cargas/neto son de toda la vida de esos clientes (cohorte), así que el ROAS puede subir con el tiempo.</p>`;
}

async function submitNewStory() {
    const campaign = document.getElementById('isCampaign').value;
    const influencer = document.getElementById('isInfluencer').value;
    const date = document.getElementById('isNewDate').value;
    const time = document.getElementById('isNewTime').value || '20:00';
    const cost = document.getElementById('isNewCost').value;
    const label = document.getElementById('isNewLabel').value.trim();
    const errEl = document.getElementById('isFormError');
    const btn = document.getElementById('isAddBtn');
    errEl.style.display = 'none';

    if (!date) { errEl.textContent = 'Elegí la fecha de la historia'; errEl.style.display = 'block'; return; }
    if (cost === '' || isNaN(parseFloat(cost)) || parseFloat(cost) < 0) { errEl.textContent = 'Cargá un costo válido'; errEl.style.display = 'block'; return; }

    // Instante absoluto en la TZ del navegador (ART) → ISO UTC.
    const postedAt = new Date(`${date}T${time}`).toISOString();
    btn.disabled = true; btn.textContent = _editingStoryId ? 'Guardando…' : 'Agregando…';
    try {
        let r;
        if (_editingStoryId) {
            r = await fetch(`${API_URL}/api/admin/influencer-stories/${encodeURIComponent(_editingStoryId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
                body: JSON.stringify({ postedAt, cost: parseFloat(cost), label })
            });
        } else {
            r = await fetch(`${API_URL}/api/admin/influencer-stories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
                body: JSON.stringify({ campaign, influencer, postedAt, cost: parseFloat(cost), label })
            });
        }
        const data = await r.json();
        if (!r.ok) { errEl.textContent = data.error || 'Error al guardar'; errEl.style.display = 'block'; return; }
        _editingStoryId = null;
        document.getElementById('isNewCost').value = '';
        document.getElementById('isNewLabel').value = '';
        document.getElementById('isAddBtn').textContent = 'Agregar';
        await loadInfluencerStories();
    } catch (e) {
        errEl.textContent = 'Error de conexión'; errEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        if (!_editingStoryId) btn.textContent = 'Agregar';
    }
}

function editStory(id) {
    const s = (_storiesState && _storiesState.stories || []).find(x => x.storyId === id);
    if (!s) return;
    _editingStoryId = id;
    const d = new Date(s.postedAt);
    const yyyy = d.getFullYear(), mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0'), mi = String(d.getMinutes()).padStart(2, '0');
    document.getElementById('isNewDate').value = `${yyyy}-${mm}-${dd}`;
    document.getElementById('isNewTime').value = `${hh}:${mi}`;
    document.getElementById('isNewCost').value = s.cost;
    document.getElementById('isNewLabel').value = s.label || '';
    document.getElementById('isAddBtn').textContent = 'Guardar cambios';
    document.getElementById('isFormError').style.display = 'none';
    document.getElementById('isNewCost').focus();
}

async function deleteStory(id) {
    if (!confirm('¿Borrar esta historia? Los registros se reasignan a la historia anterior (por ventana horaria).')) return;
    try {
        const r = await fetch(`${API_URL}/api/admin/influencer-stories/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!r.ok) { showToast('No se pudo borrar', 'error'); return; }
        if (_editingStoryId === id) { _editingStoryId = null; document.getElementById('isAddBtn').textContent = 'Agregar'; }
        await loadInfluencerStories();
    } catch (e) { showToast('Error de conexión', 'error'); }
}

function closeInfluencerStoriesModal() { hideModal('influencerStoriesModal'); _storiesState = null; }

window.openInfluencerStories = openInfluencerStories;
window.loadInfluencerStories = loadInfluencerStories;
window.renderStoriesTable = renderStoriesTable;
window.submitNewStory = submitNewStory;
window.editStory = editStory;
window.deleteStory = deleteStory;
window.closeInfluencerStoriesModal = closeInfluencerStoriesModal;

// ----- Wrappers por índice (evitan escapar comillas del nombre en el onclick) -----
function _influencerRowAt(i) {
    const rows = (_analysisState && _analysisState.influencers && _analysisState.influencers.influencers) || [];
    return rows[i] || null;
}
function openInfluencerStoriesIdx(i) {
    const r = _influencerRowAt(i);
    if (r && r.campaignCode) openInfluencerStories(r.campaignCode, r.influencer);
}
function openInfluencerUsersIdx(i) {
    const r = _influencerRowAt(i);
    if (r && r.campaignCode) openInfluencerUsers(r.campaignCode, r.influencer);
}
window.openInfluencerStoriesIdx = openInfluencerStoriesIdx;
window.openInfluencerUsersIdx = openInfluencerUsersIdx;

// ============================================
// RANKING DE INFLUENCERS POR HISTORIAS (score combinado, ordenable)
// ============================================
let _rankingState = null;
let _rankingSort = 'score'; // columna de orden actual

async function openInfluencerRanking(campaignCode) {
    _rankingState = null;
    _rankingSort = 'score';
    document.getElementById('irSubtitle').textContent = '';
    document.getElementById('irTableWrap').innerHTML = 'Cargando…';
    showModal('influencerRankingModal');
    try {
        const r = await fetch(`${API_URL}/api/admin/influencer-stories/ranking?campaign=${encodeURIComponent(campaignCode)}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        _rankingState = r.ok ? await r.json() : null;
    } catch (e) { _rankingState = null; }
    if (!_rankingState) {
        document.getElementById('irTableWrap').innerHTML = '<span style="color:#ff6666;">Error cargando el ranking</span>';
        return;
    }
    const w = _rankingState.weights || {};
    document.getElementById('irSubtitle').innerHTML =
        `Publicista <b>${_safe(_rankingState.publisher || '')}</b> · campaña <b>${_safe(_rankingState.campaignCode)}</b>. `
        + `Score combinado: ROAS ${Math.round((w.roas || 0) * 100)}% + fieles ${Math.round((w.loyal || 0) * 100)}% + ticket ${Math.round((w.ticket || 0) * 100)}% + CPC ${Math.round((w.cpc || 0) * 100)}%. `
        + `Tocá un encabezado para reordenar.`;
    renderInfluencerRankingTable();
}

function rankSortBy(key) { _rankingSort = key; renderInfluencerRankingTable(); }

function renderInfluencerRankingTable() {
    if (!_rankingState) return;
    const wrap = document.getElementById('irTableWrap');
    const rows = (_rankingState.influencers || []).slice();
    if (rows.length === 0) {
        wrap.innerHTML = '<div style="color:#888;font-size:13px;padding:14px;text-align:center;">No hay influencers con historias en esta campaña.</div>';
        return;
    }
    // Orden: numérico desc por la métrica elegida (null al final).
    const key = _rankingSort;
    rows.sort((a, b) => {
        const va = a[key], vb = b[key];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return vb - va;
    });

    const pctTxt = v => v == null ? '—' : (Math.round(v * 100) + '%');
    const roasTxt = v => v == null ? '—' : (v.toFixed(2) + 'x');
    const medal = (i) => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + 'º';
    const scoreColor = s => s >= 70 ? '#4caf50' : s >= 40 ? '#d4af37' : '#ff6666';
    const arrow = (k) => key === k ? ' ▾' : '';
    const th = (k, label, alignR) => `<th onclick="rankSortBy('${k}')" style="padding:8px;cursor:pointer;text-align:${alignR ? 'right' : 'left'};white-space:nowrap;${key === k ? 'color:#fff;' : ''}" title="Ordenar por ${label}">${label}${arrow(k)}</th>`;

    wrap.innerHTML = `
        <div style="overflow-x:auto;max-height:60vh;overflow-y:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr style="background:#15152a;color:#6cf;position:sticky;top:0;">
                    <th style="padding:8px;text-align:left;">#</th>
                    <th style="padding:8px;text-align:left;">Influencer</th>
                    ${th('score', 'Score', true)}
                    ${th('roasNet', 'ROAS', true)}
                    ${th('loyalRate', 'Fieles', true)}
                    ${th('activeRate', 'Activos', true)}
                    ${th('avgTicket', 'Ticket', true)}
                    ${th('cpc', 'CPC', true)}
                    ${th('conversionRate', 'Conv.', true)}
                    ${th('clientes', 'Clientes', true)}
                    ${th('net', '$ Neto', true)}
                    ${th('storiesCount', 'Hist.', true)}
                </tr></thead>
                <tbody>
                    ${rows.map((r, i) => `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                            <td style="padding:8px;color:#aaa;">${medal(i)}</td>
                            <td style="padding:8px;color:#fff;font-weight:600;">${_safe(r.influencer)}</td>
                            <td style="padding:8px;text-align:right;font-weight:800;color:${scoreColor(r.score)};">${r.score}</td>
                            <td style="padding:8px;text-align:right;color:#fff;">${roasTxt(r.roasNet)}</td>
                            <td style="padding:8px;text-align:right;color:#ffd700;">${r.loyalCount || 0}<div style="color:#666;font-size:10px;">${pctTxt(r.loyalRate)}</div></td>
                            <td style="padding:8px;text-align:right;color:#4caf50;">${r.activeCount || 0}<div style="color:#666;font-size:10px;">${pctTxt(r.activeRate)}</div></td>
                            <td style="padding:8px;text-align:right;color:#d4af37;white-space:nowrap;">${r.avgTicket == null ? '—' : _isFmtMoney(r.avgTicket)}</td>
                            <td style="padding:8px;text-align:right;color:#aaa;white-space:nowrap;">${r.cpc == null ? '—' : _isFmtMoney(r.cpc)}${r.clicks ? `<div style="color:#666;font-size:10px;">${r.clicks} clk</div>` : ''}</td>
                            <td style="padding:8px;text-align:right;color:#6cf;">${pctTxt(r.conversionRate)}</td>
                            <td style="padding:8px;text-align:right;color:#fff;">${r.clientes || 0}</td>
                            <td style="padding:8px;text-align:right;color:${(r.net || 0) >= 0 ? '#fff' : '#ff6666'};white-space:nowrap;">${_isFmtMoney(r.net)}</td>
                            <td style="padding:8px;text-align:right;color:#888;">${r.storiesCount || 0}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>
        <p style="color:#666;font-size:11px;margin:10px 0 0;">El mismo influencer puede tener historias rentables y otras no: para ver historia por historia, cerrá este ranking y tocá <b>📖 Historias</b> en la fila del influencer. <b>Fieles</b>=clientes con ≥5 cargas · <b>Activos</b>=cargaron ≤7 días · <b>CPC</b>=costo por click (los clicks se borran a los 90 días, así que en historias viejas puede faltar).</p>`;
}

function closeInfluencerRankingModal() { hideModal('influencerRankingModal'); _rankingState = null; }
window.openInfluencerRanking = openInfluencerRanking;
window.rankSortBy = rankSortBy;
window.closeInfluencerRankingModal = closeInfluencerRankingModal;

// ============================================
// USUARIOS DE UN INFLUENCER — ver + reasignar (corregir errores del agente)
// ============================================
let _iuState = null;

async function openInfluencerUsers(campaign, influencer) {
    document.getElementById('iuCampaign').value = campaign;
    document.getElementById('iuInfluencer').value = influencer;
    document.getElementById('iuTitle').textContent = '👥 ' + influencer;
    document.getElementById('iuSubtitle').textContent = 'Campaña ' + campaign + ' · usuarios asignados a este influencer';
    document.getElementById('iuTableWrap').innerHTML = 'Cargando…';
    document.getElementById('iuPagination').innerHTML = '';
    showModal('influencerUsersModal');
    await loadInfluencerUsers(1);
}

async function loadInfluencerUsers(page = 1) {
    const campaign = document.getElementById('iuCampaign').value;
    const influencer = document.getElementById('iuInfluencer').value;
    try {
        const qs = new URLSearchParams({ campaign, influencer, page: String(page) });
        const r = await fetch(`${API_URL}/api/admin/influencer-users?${qs.toString()}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        _iuState = r.ok ? await r.json() : null;
        if (!_iuState) {
            document.getElementById('iuTableWrap').innerHTML = '<span style="color:#ff6666;">Error cargando usuarios</span>';
            return;
        }
    } catch (e) {
        document.getElementById('iuTableWrap').innerHTML = '<span style="color:#ff6666;">Error de conexión</span>';
        return;
    }
    renderInfluencerUsers();
}

function renderInfluencerUsers() {
    if (!_iuState) return;
    const wrap = document.getElementById('iuTableWrap');
    const pag = document.getElementById('iuPagination');
    const users = _iuState.users || [];
    if (users.length === 0) {
        wrap.innerHTML = '<div style="color:#888;font-size:13px;padding:14px;text-align:center;">Este influencer no tiene usuarios asignados.</div>';
        pag.innerHTML = '';
        return;
    }
    wrap.innerHTML = `
        <div style="overflow-x:auto;max-height:430px;overflow-y:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr style="background:#15152a;color:#d4af37;text-align:left;position:sticky;top:0;">
                    <th style="padding:8px;">Usuario</th>
                    <th style="padding:8px;">Registrado</th>
                    <th style="padding:8px;text-align:right;">Cargas</th>
                    <th style="padding:8px;text-align:right;">$ Cargado</th>
                    <th style="padding:8px;text-align:right;">$ Retirado</th>
                    <th style="padding:8px;text-align:right;">$ Neto</th>
                    <th style="padding:8px;text-align:center;">Acción</th>
                </tr></thead>
                <tbody>
                    ${users.map((u, i) => `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                            <td style="padding:8px;color:#fff;font-weight:600;">${_safe(u.username)}</td>
                            <td style="padding:8px;color:#888;white-space:nowrap;">${fmtFechaAR(u.createdAt)}</td>
                            <td style="padding:8px;text-align:right;color:#aaa;">${u.depositCount}</td>
                            <td style="padding:8px;text-align:right;color:#4caf50;">${_isFmtMoney(u.deposits)}</td>
                            <td style="padding:8px;text-align:right;color:#ff6666;">${_isFmtMoney(u.withdrawals)}</td>
                            <td style="padding:8px;text-align:right;color:${u.net >= 0 ? '#fff' : '#ff6666'};">${_isFmtMoney(u.net)}</td>
                            <td style="padding:8px;text-align:center;white-space:nowrap;">
                                <button onclick="openChangeInfluencerIdx(${i})" style="padding:4px 9px;background:#2a2a3a;color:#d4af37;border:1px solid rgba(212,175,55,0.4);border-radius:5px;cursor:pointer;font-size:11px;">✏️ Cambiar</button>
                            </td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>
        <p style="color:#666;font-size:11px;margin:10px 0 0;">Si un usuario quedó mal asignado, "Cambiar" lo reasigna al influencer correcto. Las cargas, retiros y conteos se recalculan solos bajo el nuevo influencer.</p>`;

    const page = _iuState.page || 1;
    const totalPages = _iuState.totalPages || 0;
    const total = _iuState.total || 0;
    if (totalPages <= 1) {
        pag.innerHTML = total > 0 ? `<span style="color:#888;font-size:12px;">${total} usuario(s)</span>` : '';
    } else {
        const mk = (label, target, disabled) => `<button onclick="loadInfluencerUsers(${target})" ${disabled ? 'disabled' : ''} style="padding:7px 14px;background:${disabled ? '#1a1a2e' : '#2a2a3a'};color:${disabled ? '#444' : '#fff'};border:none;border-radius:6px;cursor:${disabled ? 'not-allowed' : 'pointer'};font-size:13px;">${label}</button>`;
        pag.innerHTML = `${mk('← Anterior', page - 1, page <= 1)}
            <span style="color:#aaa;font-size:13px;">Página ${page} de ${totalPages} <span style="color:#666;">(${total})</span></span>
            ${mk('Siguiente →', page + 1, page >= totalPages)}`;
    }
}

function openChangeInfluencerIdx(i) {
    const u = (_iuState && _iuState.users || [])[i];
    if (!u) return;
    document.getElementById('ciUserId').value = u.id;
    document.getElementById('ciSubtitle').textContent = `Usuario: ${u.username} · actualmente en "${_iuState.influencer}"`;
    const sel = document.getElementById('ciSelect');
    const list = _iuState.availableInfluencers || [];
    sel.innerHTML = '<option value="">— Sin influencer —</option>' +
        list.map(inf => `<option value="${_safe(inf.name)}" ${inf.name === _iuState.influencer ? 'selected' : ''}>${_safe(inf.name)}${inf.isActive ? '' : ' (inactivo)'}</option>`).join('');
    document.getElementById('ciError').style.display = 'none';
    showModal('changeInfluencerModal');
}

async function submitChangeInfluencer() {
    const userId = document.getElementById('ciUserId').value;
    const influencer = document.getElementById('ciSelect').value;
    const errEl = document.getElementById('ciError');
    const btn = document.getElementById('ciSubmitBtn');
    errEl.style.display = 'none';
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
        const r = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(userId)}/change-influencer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ influencer })
        });
        const data = await r.json();
        if (!r.ok) { errEl.textContent = data.error || 'Error al reasignar'; errEl.style.display = 'block'; return; }
        hideModal('changeInfluencerModal');
        showToast('Influencer reasignado', 'success');
        // Recargar la lista del influencer actual (el usuario movido desaparece).
        await loadInfluencerUsers(_iuState.page || 1);
        // Invalidar el breakdown para que la pestaña "Por influencer" muestre números frescos.
        if (_analysisState && document.getElementById('paTabContent')) {
            _analysisState.influencers = null;
            switchAnalysisTab('influencers');
        }
    } catch (e) {
        errEl.textContent = 'Error de conexión'; errEl.style.display = 'block';
    } finally {
        btn.disabled = false; btn.textContent = 'Guardar';
    }
}

function closeInfluencerUsersModal() { hideModal('influencerUsersModal'); _iuState = null; }
function closeChangeInfluencerModal() { hideModal('changeInfluencerModal'); }

window.openInfluencerUsers = openInfluencerUsers;
window.loadInfluencerUsers = loadInfluencerUsers;
window.openChangeInfluencerIdx = openChangeInfluencerIdx;
window.submitChangeInfluencer = submitChangeInfluencer;
window.closeInfluencerUsersModal = closeInfluencerUsersModal;
window.closeChangeInfluencerModal = closeChangeInfluencerModal;

function closePublisherAnalysisModal() { hideModal('publisherAnalysisModal'); }

function openRecoverModal(publisher, segment, count) {
    document.getElementById('recoverPublisher').value = publisher;
    document.getElementById('recoverSegment').value = segment;
    const segLabel = segment === 'atRisk' ? 'EN RIESGO' : segment === 'lost' ? 'PERDIDOS' : segment;
    document.getElementById('recoverSubtitle').textContent = `Push a ${count} cliente(s) "${segLabel}" de ${publisher}`;
    document.getElementById('recoverTitle').value = '';
    document.getElementById('recoverBody').value = '';
    document.getElementById('recoverError').style.display = 'none';
    document.getElementById('recoverResult').style.display = 'none';
    showModal('publisherRecoverModal');
}

function closeRecoverModal() { hideModal('publisherRecoverModal'); }

async function submitRecover() {
    const publisher = document.getElementById('recoverPublisher').value;
    const segment = document.getElementById('recoverSegment').value;
    const title = document.getElementById('recoverTitle').value.trim();
    const body = document.getElementById('recoverBody').value.trim();
    const errEl = document.getElementById('recoverError');
    const okEl = document.getElementById('recoverResult');
    const btn = document.getElementById('recoverSendBtn');
    errEl.style.display = 'none'; okEl.style.display = 'none';
    if (!title || !body) {
        errEl.textContent = 'Completá título y mensaje'; errEl.style.display = 'block'; return;
    }
    btn.disabled = true; btn.textContent = 'Enviando...';
    try {
        const r = await fetch(`${API_URL}/api/admin/publishers/${encodeURIComponent(publisher)}/recover`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ segment, title, body })
        });
        const data = await r.json();
        if (!r.ok) {
            errEl.textContent = data.error || 'Error enviando'; errEl.style.display = 'block'; return;
        }
        okEl.textContent = `✓ Push enviado. Objetivo: ${data.targeted || 0} cliente(s)${data.delivered != null ? ', entregados: ' + data.delivered : ''}.`;
        okEl.style.display = 'block';
        setTimeout(() => closeRecoverModal(), 2500);
    } catch (e) {
        errEl.textContent = 'Error de conexión'; errEl.style.display = 'block';
    } finally {
        btn.disabled = false; btn.textContent = 'Enviar push';
    }
}

window.loadPublishersRanking = loadPublishersRanking;
window.openPublisherAnalysis = openPublisherAnalysis;
window.switchAnalysisTab = switchAnalysisTab;
window.closePublisherAnalysisModal = closePublisherAnalysisModal;
window.openRecoverModal = openRecoverModal;
window.closeRecoverModal = closeRecoverModal;
window.submitRecover = submitRecover;
