
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
                console.log('Socket no disponible:', e);
            }

            try {
                loadConversations();
            } catch (e) {
                console.log('Error cargando conversaciones:', e);
            }

            try {
                loadStats();
            } catch (e) {
                console.log('Error cargando stats:', e);
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
    console.log('[Admin Panel] Rol detectado:', currentAdmin?.role);

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
        // Cargar stats iniciales.
        loadPublisherAdminStats();
        return;
    }

    // Configurar pestañas visibles según el rol
    const tabOpen = document.querySelector('[data-tab="open"]');
    const tabClosed = document.querySelector('[data-tab="closed"]');
    const tabPayments = document.querySelector('[data-tab="payments"]');
    
    if (role === 'withdrawer') {
        // Withdrawer solo ve PAGOS
        if (tabOpen) tabOpen.style.display = 'none';
        if (tabClosed) tabClosed.style.display = 'none';
        if (tabPayments) tabPayments.style.display = 'flex';
        currentTab = 'payments';
    } else if (role === 'depositor') {
        // Depositer no ve PAGOS
        if (tabPayments) tabPayments.style.display = 'none';
        if (tabOpen) tabOpen.style.display = 'flex';
        if (tabClosed) tabClosed.style.display = 'flex';
        currentTab = 'open';
    } else {
        // Admin general ve todo
        if (tabOpen) tabOpen.style.display = 'flex';
        if (tabClosed) tabClosed.style.display = 'flex';
        if (tabPayments) tabPayments.style.display = 'flex';
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

    // Bonus directo: visible para admin y depositor
    const btnBonus = elements.btnBonus;
    if (btnBonus) {
        btnBonus.style.display = ['admin', 'depositor'].includes(role) ? '' : 'none';
    }

    // SMS Masivo: solo visible para admin general
    const smsNavItem = document.querySelector('.nav-item-sms-masivo');
    if (smsNavItem) {
        smsNavItem.style.display = role === 'admin' ? '' : 'none';
    }

    // Cuentas Publicistas y Dashboard Publicistas: sólo admin general
    const paNavItem = document.querySelector('.nav-item-publisher-admins');
    if (paNavItem) {
        paNavItem.style.display = role === 'admin' ? '' : 'none';
    }
    const dashNavItem = document.querySelector('.nav-item-publishers-dashboard');
    if (dashNavItem) {
        dashNavItem.style.display = role === 'admin' ? '' : 'none';
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

        // Recent users
        const recentBox = document.getElementById('paRecentUsers');
        if (!recentBox) return;
        if (!data.recentUsers || data.recentUsers.length === 0) {
            recentBox.innerHTML = '<span style="color:#888;font-size:13px;">Todavía no creaste usuarios.</span>';
        } else {
            recentBox.innerHTML = data.recentUsers.map(u => {
                const safe = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
                const dateStr = new Date(u.createdAt).toLocaleString('es-AR');
                return `<div style="display:flex;justify-content:space-between;padding:10px 12px;background:#1a1a2e;border-radius:6px;font-size:13px;">
                    <span style="color:#fff;font-weight:600;">${safe(u.username)}</span>
                    <span style="color:#888;">${safe(dateStr)}</span>
                </div>`;
            }).join('');
        }
    } catch (e) {
        console.error('[publisher_admin] loadPublisherAdminStats:', e);
    }
}

async function paCreateUser() {
    const usernameEl = document.getElementById('paNewUsername');
    const passwordEl = document.getElementById('paNewPassword');
    const phoneEl = document.getElementById('paNewPhone');
    const errBox = document.getElementById('paCreateError');
    const okBox = document.getElementById('paCreateSuccess');
    const btn = document.getElementById('paCreateBtn');

    if (errBox) errBox.style.display = 'none';
    if (okBox) okBox.style.display = 'none';

    const username = usernameEl?.value.trim();
    const password = passwordEl?.value;
    const phone = phoneEl?.value.trim();

    if (!username || !password) {
        if (errBox) {
            errBox.textContent = 'Usuario y contraseña son obligatorios';
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
            body: JSON.stringify({ username, password, phone: phone || null })
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
        // Recargar stats para reflejar el nuevo usuario
        loadPublisherAdminStats();
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

// Actualizar botones de acción según la pestaña actual
function updateActionButtonsByTab() {
    const btnPayments = elements.btnPayments;
    if (!btnPayments) return;
    
    const role = currentAdmin?.role;
    
    if (currentTab === 'payments') {
        // En pestaña Pagos: mostrar "Enviar a Abiertos" solo para admin general (no para withdrawer)
        if (role === 'withdrawer') {
            btnPayments.style.display = 'none';
        } else {
            btnPayments.style.display = '';
            btnPayments.innerHTML = '<span class="icon icon-exchange"></span> Enviar a Abiertos';
            btnPayments.onclick = sendToOpen;
        }
    } else {
        btnPayments.style.display = '';
        // En otras pestañas: mostrar "Enviar a Pagos"
        btnPayments.innerHTML = '<span class="icon icon-exchange"></span> Enviar a Pagos';
        btnPayments.onclick = sendToPayments;
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
        console.log('✅ Socket connected');
        socket.emit('authenticate', currentToken);
    });
    
    socket.on('authenticated', (data) => {
        if (data.success) {
            console.log('✅ Socket authenticated');
            joinAdminRoom();
        } else {
            console.error('❌ Socket authentication failed');
        }
    });
    
    // NEW MESSAGE - INSTANT
    socket.on('new_message', (data) => {
        console.log('📨 NEW_MESSAGE event received:', data);
        console.log('📨 Message content:', data.message?.content || data.content);
        console.log('📨 Sender role:', data.message?.senderRole || data.senderRole);
        console.log('📨 Sender ID:', data.message?.senderId || data.senderId);
        handleNewMessage(data);
    });
    
    // MESSAGE SENT CONFIRMATION
    socket.on('message_sent', (data) => {
        console.log('✅ Message sent:', data);
        // Update temp message with real one instead of adding duplicate
        const tempEl = document.querySelector('[data-messageid^="temp-"]');
        if (tempEl) {
            tempEl.dataset.messageid = data.id;
        }
    });
    
    // CHAT CLOSED - Mantener chat abierto para seguir respondiendo
    socket.on('chat_closed', (data) => {
        console.log('🔒 Chat cerrado:', data);
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
        console.log('🔄 Conversation updated:', data);
        if (data.userId !== selectedUserId) {
            incrementUnreadCount();
            playNotificationSound();
        }
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true);
    });
    
    // CHAT MOVED TO PAYMENTS
    socket.on('chat_moved', (data) => {
        console.log('💳 Chat moved to payments:', data);
        if (data.userId === selectedUserId) {
            selectedUserId = null;
            activeConversationId = null; // RACE CONDITION FIX
            elements.chatHeader.classList.add('hidden');
            elements.chatInputArea.classList.add('hidden');
            elements.chatMessages.innerHTML = `
                <div class="empty-state">
                    <span class="icon icon-comment-dots"></span>
                    <p>Chat enviado a pagos. Selecciona otra conversación.</p>
                </div>
            `;
        }
        // Invalidar cache de pestañas afectadas
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('payments');
        loadConversations(true);
        showToast('Chat enviado a pagos', 'info');
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
            // Conversación nueva o no visible: invalidar cache y recargar
            conversationsCacheByTab.delete(currentTab);
            loadConversations(true);
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
        loadStats();
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
        console.log('🔌 Socket disconnected');
    });

    // RECONNECT - Re-fetch conversations to recover any missed events
    socket.on('reconnect', () => {
        console.log('🔄 Socket reconnected — re-fetching conversations');
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true);
    });
    
    // ERROR
    socket.on('error', (data) => {
        console.error('❌ Socket error:', data);
        showToast(data.message || 'Error de conexión', 'error');
    });
}

// Reconciliación periódica: cada 60 segundos invalidar cache y recargar
// conversaciones para recuperar cualquier evento perdido por reconexión u otro motivo.
let reconciliationInterval = null;
function startConversationReconciliation() {
    if (reconciliationInterval) clearInterval(reconciliationInterval);
    reconciliationInterval = setInterval(() => {
        conversationsCacheByTab.delete(currentTab);
        loadConversations(false);
    }, 60000);
}

function joinAdminRoom() {
    socket.emit('join_admin_room');
}

function handleNewMessage(data) {
    const message = data.message || data;
    const senderId = message.senderId;
    const receiverId = message.receiverId;
    
    console.log('📨 handleNewMessage:', message.id, 'from:', senderId, 'to:', receiverId, 'selected:', selectedUserId);
    
    // CORREGIDO: Verificar si el mensaje ya fue procesado (evitar duplicados del socket)
    if (message.id) {
        if (processedMessageIds.has(message.id)) {
            console.log('⚠️ Mensaje ya procesado (ID en cache), ignorando:', message.id);
            return;
        }
        processedMessageIds.add(message.id);
    }
    
    // Verificar si el mensaje ya existe en el DOM
    if (message.id && elements.chatMessages.querySelector(`[data-messageid="${message.id}"]`)) {
        console.log('⚠️ Mensaje ya existe en DOM, ignorando');
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
                console.log('✅ Mensaje temporal actualizado con ID real:', message.id);
                return;
            }
        }
    }
    
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
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

/**
 * Actualización inteligente de una conversación en la lista (sin HTTP call).
 * Se llama cuando llega un mensaje nuevo de otro chat.
 */
function updateConversationInList(message) {
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    const isFromAdmin = adminRoles.includes(message.senderRole);
    const chatUserId = isFromAdmin ? message.receiverId : message.senderId;
    
    // Actualizar en el array conversations actual
    const convIndex = conversations.findIndex(c => c.userId === chatUserId);
    if (convIndex === -1) {
        // Conversación nueva o no visible: invalidar cache y recargar
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true);
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

// Cargar conversaciones con cache por pestaña
async function loadConversations(forceRefresh = false) {
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
        prefetchMessages(conversations.slice(0, 3));
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

function renderConversations() {
    if (conversations.length === 0) {
        elements.conversationsList.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comments"></span>
                <p>No hay conversaciones</p>
            </div>
        `;
        return;
    }
    
    elements.conversationsList.innerHTML = conversations.map(conv => `
        <div class="conversation-item ${conv.unread > 0 ? 'unread' : ''} ${conv.userId === selectedUserId ? 'active' : ''}" 
             data-userid="${escapeHtml(conv.userId)}" 
             data-username="${escapeHtml(conv.username)}">
            <div class="conv-avatar">
                <span class="icon icon-user"></span>
            </div>
            <div class="conv-info">
                <span class="conv-name">${escapeHtml(conv.username)}${conv.publisher ? ` <span class="conv-publisher" title="Captado por la pauta de ${escapeHtml(conv.publisher)}">📣 ${escapeHtml(conv.publisher)}</span>` : ''}</span>
                <span class="conv-preview">${escapeHtml(conv.lastMessage || 'Sin mensajes')}</span>
            </div>
            <div class="conv-meta">
                <span class="conv-time">${formatTime(conv.lastMessageAt)}</span>
                ${conv.unread > 0 ? `<span class="conv-badge">${conv.unread}</span>` : ''}
            </div>
        </div>
    `).join('');
    
    // Add click handlers
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('click', () => {
            const userId = item.dataset.userid;
            const username = item.dataset.username;
            selectConversation(userId, username);
        });
    });
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
    if (elements.chatBlockedReason) elements.chatBlockedReason.textContent = '';
    if (elements.btnBlock) elements.btnBlock.style.display = 'none';
    if (elements.btnUnblock) elements.btnUnblock.style.display = 'none';
    
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
            console.log('🔔 Permiso de notificación:', permission);
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
            console.log('No se pudo mostrar notificación:', e);
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
            console.log('⚠️ Respuesta de chat antiguo ignorada:', userId, '!= activo:', activeConversationId);
            return;
        }
        
        // Cache messages
        messageCache.set(userId, messages);
        
        // Solo re-renderizar si hay cambios
        renderMessages(messages);
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('🚫 Fetch de mensajes cancelado para:', userId);
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
            console.log('⚠️ Mensaje ya existe por ID, ignorando:', message.id);
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
                console.log('✅ Mensaje temporal actualizado con ID real:', message.id);
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
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    msgDiv.dataset.messageid = message.id;
    msgDiv.innerHTML = `
        <div class="message-header">
            <span class="icon icon-user"></span>
            <span>${escapeHtml(message.senderUsername)}</span>
        </div>
        <div class="message-content">${formatMessageContent(message)}</div>
        <div class="message-time">${formatDateTime(message.timestamp || new Date())}</div>
    `;
    
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
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
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
                console.log('⚠️ Mensaje duplicado detectado (enviado hace menos de 3s), ignorando');
                elements.messageInput.value = '';
                elements.messageInput.style.height = 'auto';
                return;
            }
        }
    }
    
    // CORREGIDO: Verificar si ya se envió este contenido recientemente
    if (lastSentMessageContent === messageToSend && (now - lastSentMessageTime) < 5000) {
        console.log('⚠️ Mensaje duplicado detectado (mismo contenido reciente), ignorando');
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

// COMANDOS: Manejar teclas de navegación
function handleCommandKeydown(e) {
    if (commandSuggestions.length === 0) return;
    
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedCommandIndex = (selectedCommandIndex + 1) % commandSuggestions.length;
        updateCommandSelection();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedCommandIndex = (selectedCommandIndex - 1 + commandSuggestions.length) % commandSuggestions.length;
        updateCommandSelection();
    } else if (e.key === 'Tab' || e.key === 'Enter') {
        if (selectedCommandIndex >= 0) {
            e.preventDefault();
            insertCommand(commandSuggestions[selectedCommandIndex].name);
        }
    } else if (e.key === 'Escape') {
        hideCommandSuggestions();
    }
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

        // Update unread count
        loadStats();
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
            console.log('⚠️ Respuesta de userInfo de chat antiguo ignorada:', userId);
            return;
        }
        
        elements.chatBalance.textContent = formatMoney(user.balance);
        elements.chatStatus.textContent = user.online ? 'En línea' : 'Desconectado';
        elements.chatStatus.className = user.online ? 'status online' : 'status';

        // Reflejar estado de bloqueo en el header del chat
        applyBlockStateToChatHeader(user);

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
    } catch (error) {
        console.error('Error loading user info:', error);
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
    
    console.log('👋 Chat deseleccionado');
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
let allUsersCache = [];

async function loadUsers() {
    try {
        const response = await fetch(`${API_URL}/api/admin/users`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load users');
        
        const data = await response.json();
        allUsersCache = data.users || [];
        filterAndRenderUsers();
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

function filterAndRenderUsers() {
    const searchInput = document.getElementById('searchUsers');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (!query) {
        renderUsers(allUsersCache);
        return;
    }
    const filtered = allUsersCache.filter(u => {
        return (
            (u.username && u.username.toLowerCase().includes(query)) ||
            (u.id && String(u.id).toLowerCase().includes(query)) ||
            (u.accountId && String(u.accountId).toLowerCase().includes(query)) ||
            (u.phone && u.phone.toLowerCase().includes(query)) ||
            (u.email && u.email.toLowerCase().includes(query))
        );
    });
    renderUsers(filtered);
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
        const isAdminUser = ['admin', 'depositor', 'withdrawer'].includes(user.role);
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

        return `
        <tr class="${isAdminUser ? 'admin-row' : ''}">
            <td>${escapeHtml(user.username)}</td>
            <td>${escapeHtml(user.accountId || '-')}</td>
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
window.handleBlockUser = handleBlockUser;
window.handleUnblockUser = handleUnblockUser;
window.handleToggleVerifyPhone = handleToggleVerifyPhone;
window.handleToggleLoginNoPwd = handleToggleLoginNoPwd;

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
    const isAdminUser = ['admin', 'depositor', 'withdrawer'].includes(user.role);
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
                    byLine += ` — ${blockedAt.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}`;
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
    
    // Update nav
    elements.navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.section === section);
    });
    
    // Update sections
    elements.sections.forEach(sec => {
        sec.classList.toggle('active', sec.id === `${section}Section`);
    });
    
    // Load section data
    if (section === 'users') loadUsers();
    if (section === 'transactions') loadTransactions();
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
    if (section === 'database') {
        if (!dbAccessGranted) {
            showDatabasePasswordModal();
        } else {
            loadDatabaseUsers();
        }
    }
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
        console.log('No se pudo reproducir sonido:', e);
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
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatMoney(amount) {
    if (amount === undefined || amount === null) return '$0';
    return '$' + parseFloat(amount).toLocaleString('es-AR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
}

function formatDate(date) {
    if (!date) return 'Nunca';
    const d = new Date(date);
    return d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function formatTime(date) {
    if (!date) return '';
    const d = new Date(date);
    const now = new Date();
    const diff = now - d;
    
    if (diff < 60000) return 'Ahora';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
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
        year: '2-digit',
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

async function loadTransactions() {
    try {
        let url = `${API_URL}/api/admin/transactions`;
        const params = [];
        
        if (transactionDateFrom) {
            params.push(`from=${transactionDateFrom}`);
        }
        if (transactionDateTo) {
            params.push(`to=${transactionDateTo}`);
        }
        if (transactionUsernameFilter) {
            params.push(`username=${encodeURIComponent(transactionUsernameFilter)}`);
        }
        
        if (params.length > 0) {
            url += '?' + params.join('&');
        }
        
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load transactions');
        
        const data = await response.json();
        transactionsData = data.transactions || [];
        renderTransactions(transactionsData);
        renderTransactionStats(data.summary || {});
    } catch (error) {
        console.error('Error loading transactions:', error);
    }
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
    
    // Filtrar transacciones
    let filtered = transactions;
    if (transactionsFilter !== 'all') {
        filtered = transactions.filter(t => t.type === transactionsFilter);
    }
    
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No hay transacciones</td></tr>';
        return;
    }
    
    tbody.innerHTML = filtered.map(t => `
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
    renderTransactions(transactionsData);
}

// ============================================
// SMS MASIVO SECTION - Password Gate
// ============================================
let smsAccessGranted = false;

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
            hideModal('smsPasswordModal');
            document.getElementById('smsPasswordInput').value = '';
            document.getElementById('smsSectionContent').classList.remove('hidden');
            showToast('Acceso concedido', 'success');
        } else {
            showToast('Contraseña incorrecta', 'error');
        }
    } catch (error) {
        console.error('Error verifying SMS access:', error);
        showToast('Error al verificar acceso', 'error');
    }
}

// ============================================
// DATABASE SECTION
// ============================================
let dbAccessGranted = false;
let dbStoredPassword = ''; // Issue #2: Almacenar contraseña para reuso sin requerir re-entrada

function showDatabasePasswordModal() {
    showModal('databasePasswordModal');
}

async function verifyDatabaseAccess() {
    const password = document.getElementById('dbPassword').value;
    
    if (!password) {
        showToast('Ingresa la contraseña', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/database/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ dbPassword: password })
        });
        
        if (response.ok) {
            dbAccessGranted = true;
            dbStoredPassword = password; // Issue #2: guardar para reuso
            hideModal('databasePasswordModal');
            document.getElementById('databasePasswordInput').classList.add('hidden');
            document.getElementById('databaseContent').classList.remove('hidden');
            loadDatabaseUsers();
            showToast('Acceso concedido', 'success');
        } else {
            showToast('Contraseña incorrecta', 'error');
        }
    } catch (error) {
        console.error('Error verifying database access:', error);
        showToast('Error al verificar acceso', 'error');
    }
}

async function loadDatabaseUsers() {
    if (!dbAccessGranted) return;
    
    try {
        // Issue #2: Usar contraseña almacenada para evitar pérdida del valor del campo
        const password = dbStoredPassword || document.getElementById('dbPassword').value;
        if (!password) {
            console.warn('[DB] Contraseña no disponible, se requiere re-verificación');
            dbAccessGranted = false;
            switchSection('database');
            return;
        }
        const response = await fetch(`${API_URL}/api/admin/database/users`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ dbPassword: password })
        });
        
        if (!response.ok) throw new Error('Failed to load database users');
        
        const data = await response.json();
        renderDatabaseUsers(data.users || []);
    } catch (error) {
        console.error('Error loading database users:', error);
    }
}

function renderDatabaseUsers(users) {
    const tbody = document.getElementById('databaseTableBody');
    
    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No hay usuarios en la base de datos</td></tr>';
        return;
    }
    
    tbody.innerHTML = users.map(user => `
        <tr class="${user.role !== 'user' ? 'admin-row' : ''}">
            <td>${escapeHtml(user.username)}</td>
            <td>${user.email || '-'}</td>
            <td>${user.phone || '-'}</td>
            <td><span class="role-badge ${user.role}">${getRoleLabel(user.role)}</span></td>
            <td>${formatMoney(user.balance)}</td>
            <td>${user.isActive ? 'Activo' : 'Inactivo'}</td>
            <td>${formatDate(user.lastLogin)}</td>
            <td>${formatDate(user.createdAt)}</td>
        </tr>
    `).join('');
    
    // Update count
    document.getElementById('dbTotalUsers').textContent = users.length;
    document.getElementById('dbTotalAdmins').textContent = users.filter(u => u.role !== 'user').length;
}

function getRoleLabel(role) {
    const labels = {
        user: 'Usuario',
        admin: 'Admin General',
        depositor: 'Admin Depositor',
        withdrawer: 'Admin Withdrawer'
    };
    return labels[role] || role;
}

async function exportDatabaseCSV() {
    if (!dbAccessGranted) return;
    
    try {
        // Issue #2: Usar contraseña almacenada para exportar todos los usuarios
        const password = dbStoredPassword || document.getElementById('dbPassword').value;
        if (!password) {
            console.warn('[DB] Contraseña no disponible para exportar, se requiere re-verificación');
            dbAccessGranted = false;
            switchSection('database');
            return;
        }
        const response = await fetch(`${API_URL}/api/admin/database/export/csv`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ dbPassword: password })
        });
        
        if (!response.ok) throw new Error('Failed to export database');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `base_de_datos_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast('Base de datos exportada correctamente', 'success');
    } catch (error) {
        console.error('Error exporting database:', error);
        showToast('Error al exportar base de datos', 'error');
    }
}

async function verifyDatabaseAccessFromModal() {
    const password = document.getElementById('dbPasswordInput').value;
    document.getElementById('dbPassword').value = password;
    
    try {
        const response = await fetch(`${API_URL}/api/admin/database/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ dbPassword: password })
        });
        
        if (response.ok) {
            dbAccessGranted = true;
            dbStoredPassword = password; // Issue #2: guardar para reuso
            hideModal('databasePasswordModal');
            document.getElementById('databasePasswordInput').classList.add('hidden');
            document.getElementById('databaseContent').classList.remove('hidden');
            loadDatabaseUsers();
            showToast('Acceso concedido', 'success');
        } else {
            showToast('Contraseña incorrecta', 'error');
        }
    } catch (error) {
        console.error('Error verifying database access:', error);
        showToast('Error al verificar acceso', 'error');
    }
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
    loadCanalUrlConfig();
    // Cargar la config de la Comunidad (Telegram)
    loadCommunityConfig();
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

async function loadCanalUrlConfig() {
    try {
        const response = await fetch(`${API_URL}/api/admin/config`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (response.ok) {
            const data = await response.json();
            const urlInput = document.getElementById('canalInformativoUrl');
            if (urlInput) {
                urlInput.value = data.canalInformativoUrl || '';
            }
        }
    } catch (error) {
        console.error('Error loading canal URL:', error);
    }
}

async function saveCanalUrl() {
    const urlInput = document.getElementById('canalInformativoUrl');
    const url = urlInput ? urlInput.value.trim() : '';
    
    try {
        const response = await fetch(`${API_URL}/api/admin/canal-url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ url })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast('URL del Canal Informativo guardada correctamente', 'success');
        } else {
            showToast(data.error || data.message || 'Error al guardar URL', 'error');
        }
    } catch (error) {
        console.error('Error saving canal URL:', error);
        showToast('Error al guardar URL', 'error');
    }
}

async function loadCommunityConfig() {
    try {
        const response = await fetch(`${API_URL}/api/config/community`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (response.ok) {
            const data = await response.json();
            const channelInput = document.getElementById('communityChannelUrl');
            const supportInput = document.getElementById('communitySupportUrl');
            if (channelInput) channelInput.value = data.channelUrl || '';
            if (supportInput) supportInput.value = data.supportUrl || '';
        }
    } catch (error) {
        console.error('Error loading community config:', error);
    }
}

async function saveCommunityConfig() {
    const channelInput = document.getElementById('communityChannelUrl');
    const supportInput = document.getElementById('communitySupportUrl');
    const channelUrl = channelInput ? channelInput.value.trim() : '';
    const supportUrl = supportInput ? supportInput.value.trim() : '';
    try {
        const response = await fetch(`${API_URL}/api/admin/community`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ channelUrl, supportUrl })
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
        console.log('✅ App ya instalada (standalone mode)');
        return true;
    }
    return false;
}

// Inicializar PWA - Escuchar evento beforeinstallprompt
function initPWA() {
    console.log('🚀 Inicializando PWA...');
    
    // Verificar si ya está instalada
    if (checkAppInstalled()) {
        hideInstallButton();
        return;
    }
    
    // Escuchar evento beforeinstallprompt
    window.addEventListener('beforeinstallprompt', (e) => {
        console.log('📱 beforeinstallprompt event recibido');
        // Prevenir que el navegador muestre el prompt automático
        e.preventDefault();
        // Guardar el evento para usarlo después
        deferredInstallPrompt = e;
        // Mostrar el botón de instalación
        showInstallButton();
    });
    
    // Escuchar cuando la app es instalada
    window.addEventListener('appinstalled', (e) => {
        console.log('✅ App instalada exitosamente');
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
        console.log('📱 Botón de instalación visible');
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
    console.log('📱 Click en botón de instalación');
    
    if (!deferredInstallPrompt) {
        console.log('⚠️ No hay prompt de instalación disponible');
        showToast('La instalación no está disponible en este momento', 'info');
        return;
    }
    
    // Mostrar el prompt de instalación
    deferredInstallPrompt.prompt();
    
    // Esperar la respuesta del usuario
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.log('📱 Resultado de instalación:', outcome);
    
    if (outcome === 'accepted') {
        console.log('✅ Usuario aceptó instalar');
        isAppInstalled = true;
        hideInstallButton();
    } else {
        console.log('❌ Usuario rechazó instalar');
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
        console.log('⚠️ Service Worker no soportado');
        return false;
    }
    
    try {
        const registration = await navigator.serviceWorker.register('/admin-sw.js', { scope: '/adminprivado2026/' });
        console.log('✅ Service Worker registrado:', registration.scope);
        
        // Escuchar mensajes del service worker
        navigator.serviceWorker.addEventListener('message', (event) => {
            console.log('📨 Mensaje del SW:', event.data);
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
        console.log('⚠️ Notificaciones no soportadas');
        return false;
    }
    
    const permission = await Notification.requestPermission();
    console.log('🔔 Permiso de notificaciones:', permission);
    
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
            console.log('✅ Notificación push enviada');
        }
    } catch (error) {
        console.error('❌ Error enviando notificación push:', error);
    }
}

// ============================================
// CHAT ULTRA-RÁPIDO - OPTIMIZACIONES
// ============================================

// Precargar mensajes de conversaciones frecuentes
async function prefetchFrequentConversations() {
    const frequentUsers = conversations.slice(0, 5); // Top 5 conversaciones
    
    for (const conv of frequentUsers) {
        if (!messageCache.has(conv.userId)) {
            fetch(`${API_URL}/api/messages/${conv.userId}?limit=50`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            })
            .then(r => r.json())
            .then(data => {
                if (data.messages) {
                    messageCache.set(conv.userId, data.messages);
                    console.log('✅ Prefetch completado para:', conv.username);
                }
            })
            .catch(() => {});
        }
    }
}

// Renderizado ultra-rápido de mensajes
function renderMessagesUltraFast(messages) {
    // Usar DocumentFragment para minimizar reflows
    const fragment = document.createDocumentFragment();
    
    messages.forEach(msg => {
        if (msg.id && processedMessageIds.has(msg.id)) return;
        
        const msgDiv = createMessageElement(msg);
        fragment.appendChild(msgDiv);
        
        if (msg.id) {
            processedMessageIds.add(msg.id);
        }
    });
    
    // Limpiar y agregar todo de una vez
    elements.chatMessages.innerHTML = '';
    elements.chatMessages.appendChild(fragment);
    
    // Scroll inmediato sin animación para máxima velocidad
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

// Crear elemento de mensaje optimizado
function createMessageElement(message) {
    // Fix #3: Mensajes de sistema (ej. cierre de chat) con estilo propio
    if (message.type === 'system') {
        const div = document.createElement('div');
        div.className = 'message system';
        div.dataset.messageid = message.id || '';
        div.innerHTML = `<span class="icon icon-lock"></span> <span>${escapeHtml(message.content)}</span>`;
        return div;
    }
    
    const isOutgoing = getMessageType(message) === 'outgoing';
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    msgDiv.dataset.messageid = message.id;
    
    const time = formatDateTime(message.timestamp || new Date());
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
        loadSchedules()
    ]);
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
    const TYPE_LABELS = { bono_50: 'Bono 50%', bono_100: 'Bono 100%', invitacion: 'Invitación a jugar', regalo: 'Regalo', reembolso: 'Reembolso' };
    const DOW = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    el.innerHTML = list.map(s => {
        let cuando;
        if (s.mode === 'once') {
            cuando = 'Una vez — ' + (s.runAt ? new Date(s.runAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—');
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
                    ${u.tokenUpdatedAt ? new Date(u.tokenUpdatedAt).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—'}
                </td>
                <td style="padding:.5rem .75rem;color:#888;font-size:.8rem">
                    ${u.lastLogin ? new Date(u.lastLogin).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—'}
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
    const dt = new Date(d);
    return dt.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
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
                <td style="padding:7px 6px;color:#888;font-size:11px;">${fs.lastPayoutDate ? new Date(fs.lastPayoutDate).toLocaleDateString('es-AR') : '—'}</td>
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
                            <td style="padding:6px 6px;color:#888;font-size:11px;">${p.creditedAt ? new Date(p.creditedAt).toLocaleString('es-AR', {dateStyle:'short',timeStyle:'short'}) : '—'}</td>
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

function smsValidarTelefono(phone) {
    if (!phone || typeof phone !== 'string') return { valid: false, reason: 'Número ausente o inválido' };
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) return { valid: false, reason: 'Menos de 8 dígitos' };
    if (digits.length > 15) return { valid: false, reason: 'Más de 15 dígitos' };
    if (SMS_FAKE_PATTERN.test(digits)) return { valid: false, reason: 'Patrón falso o de prueba' };
    const hasValidPrefix = SMS_VALID_COUNTRY_CODES.some(code => phone.startsWith(code));
    if (!hasValidPrefix) return { valid: false, reason: 'Prefijo de país no reconocido' };
    return { valid: true };
}

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
            body: JSON.stringify({ filters, onlyVerified })
        });
        const data = await res.json();
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
            body: JSON.stringify({ message: mensaje, filters, onlyVerified })
        });
        const data = await res.json();
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
        showToast('Campaña guardada', 'success');
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
                ? new Date(fecha).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' })
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

async function loadRouletteAdmin() {
    const days = parseInt((document.getElementById('rouletteDays') || {}).value || '14', 10) || 14;
    const body = document.getElementById('rouletteAdminBody');
    if (!body) return;
    body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    // Cargar budget en paralelo (no bloqueante).
    loadRouletteBudget();
    try {
        const [statsResp, historyResp] = await Promise.all([
            rouletteAuthFetch('/api/admin/roulette/stats?days=' + days),
            rouletteAuthFetch('/api/admin/roulette/history?pageSize=100')
        ]);
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
        html += '<h3 style="color:#ffd700;font-size:12px;margin:18px 0 8px;letter-spacing:1.5px;text-transform:uppercase;">🏆 Quién ganó qué (últimos 100)</h3>';
        const items = (history && history.items) || [];
        if (items.length === 0) {
            html += '<div style="color:#aaa;text-align:center;padding:20px;background:rgba(255,255,255,0.03);border-radius:8px;">Todavía nadie giró la ruleta.</div>';
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
                const when = it.spunAt ? new Date(it.spunAt).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';
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
    try {
        return new Date(d).toLocaleString('es-AR', {
            day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
        });
    } catch (e) { return '—'; }
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

// --- Bono $5.000 ---
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
        html += _centStatCard('💸', _centMoney(j.totalPaid), 'Total pagado', '#ffc107');
        html += _centStatCard('✅', _centNum(j.stillInstalled), 'Siguen con la app', '#4caf50');
        html += '</div>';
        if (!users.length) {
            html += '<div class="empty-state"><p>Todavía nadie reclamó el bono.</p></div>';
        } else {
            html += '<table class="data-table"><thead><tr><th>Usuario</th><th>Reclamó el</th>'
                + '<th>App</th><th>Notifs</th><th>Plan</th><th>Último ingreso</th></tr></thead><tbody>';
            users.forEach(function (u) {
                const appCell = u.appInstalled
                    ? '<span style="color:#4caf50;font-weight:700;">📲 Sí</span>'
                    : (u.hasToken ? '<span style="color:#ff9800;">🌐 Navegador</span>'
                        : '<span style="color:#ff5050;font-weight:700;">❌ Sin app</span>');
                const npColor = u.notifPermission === 'granted' ? '#4caf50'
                    : (u.notifPermission === 'denied' ? '#ff5050' : '#ff9800');
                html += '<tr><td><strong>' + _centEsc(u.username) + '</strong></td>'
                    + '<td>' + _centDate(u.claimedAt) + '</td>'
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
    // Mueve al panel de chats abriendo el chat de ese usuario si existe la función.
    if (typeof openChatByUsername === 'function') {
        openChatByUsername(username);
    } else if (typeof switchSection === 'function') {
        switchSection('users');
        showToast('Buscá "' + username + '" en la lista de usuarios.', 'info');
    }
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
async function loadReembolsos() {
    const body = document.getElementById('reembolsosBody');
    if (!body) return;
    body.innerHTML = '<div style="color:#aaa;text-align:center;padding:24px;">⏳ Cargando…</div>';
    try {
        const r = await authFetch('/api/admin/reembolsos');
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Error');
        const types = j.types || {};
        const recent = j.recent || [];
        const typeLabels = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual' };
        let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:18px;">';
        html += _centRefundCard('📅 Diarios', types.daily, '#4caf50');
        html += _centRefundCard('📆 Semanales', types.weekly, '#2196f3');
        html += _centRefundCard('🗓️ Mensuales', types.monthly, '#d4af37');
        html += '</div>';
        html += '<h3 style="color:#d4af37;font-size:12.5px;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;">Últimos reembolsos reclamados</h3>';
        if (!recent.length) {
            html += '<div class="empty-state"><p>Todavía nadie reclamó reembolsos.</p></div>';
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
    const lastFired = r.lastFiredAt ? new Date(r.lastFiredAt).toLocaleString('es-AR') : 'Nunca';
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
        const when = r.createdAt ? new Date(r.createdAt).toLocaleString('es-AR') : '';
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
        el.style.background = 'linear-gradient(90deg,#0f8a2f,#0a6b25)';
        el.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:#fff;">' +
            '<span style="font-size:18px;">🎁</span>' +
            '<div style="flex:1;min-width:120px;"><strong style="font-size:13px;">BONO VIGENTE: ' + b.percent + '% en la carga</strong>' +
            '<div style="font-size:11px;opacity:0.9;">Vence en ' + mins + ' min · regla ' + escapeHtml(b.sourceRuleCode || '-') + '</div></div>' +
            '<button onclick="markChatPromoBonusUsed(\'' + b.id + '\')" style="background:#fff;color:#0a7a2f;border:none;border-radius:7px;padding:6px 11px;font-weight:800;font-size:11.5px;cursor:pointer;">✓ Marcar usado</button>' +
            '</div>';
    } catch (e) {
        el.style.display = 'none';
    }
}

async function markChatPromoBonusUsed(id) {
    if (!confirm('¿Marcar el bono como usado? Vale por 1 sola carga — después de esto el cliente no lo tiene más.')) return;
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
        _bsField('bsS' + n + 'Percent', '% de bono', step.percent, 'number', 'min="1" max="1000"') +
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
                + '<span style="color:#777;margin-left:auto;">' + (v.votedAt ? new Date(v.votedAt).toLocaleString('es-AR') : '') + '</span></div>';
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
        + '<input type="text" id="encInp_percents" value="' + ((cfg.bonoPercents || [50, 100]).join(',')) + '" style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.45);color:#ffd700;border:1px solid rgba(255,215,0,0.35);border-radius:6px;padding:7px;font-size:12px;font-weight:800;"></div>';
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
        const [cfgR, statsR] = await Promise.all([
            fetch(`${API_URL}/api/admin/inactividad/config`, { headers }),
            fetch(`${API_URL}/api/admin/inactividad/stats`, { headers })
        ]);
        const cfg = (await cfgR.json()).config || {};
        const stats = await statsR.json();
        _inactivosRender(cfg, stats);
    } catch (e) {
        body.innerHTML = '<div style="color:#ff6b6b;text-align:center;padding:24px;">Error cargando.</div>';
    }
}

function _inactivosRender(cfg, stats) {
    const body = document.getElementById('inactivosBody');
    if (!body) return;
    const active = cfg.isActive === true;
    const pasos = cfg.pasos || [];
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
            + '<td style="padding:5px;text-align:center;">' + _encInput('inacInp_' + i + '_percent', p.percent, 0, 500) + '</td>'
            + '<td style="padding:5px;text-align:center;">' + _encInput('inacInp_' + i + '_monto', p.montoARS, 0, 10000000) + '</td>'
            + '</tr>';
    });
    h += '</table>';
    h += '<div style="margin-top:10px;"><label style="display:block;color:#888;font-size:10px;margin-bottom:3px;">Vigencia del bono/regalo (horas)</label>'
        + '<input type="number" id="inacInp_vigencia" value="' + (cfg.bonoVigenciaHoras || 72) + '" min="1" max="720" style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.45);color:#ffd700;border:1px solid rgba(255,215,0,0.35);border-radius:6px;padding:7px;font-size:12px;font-weight:800;"></div>';
    h += '<button onclick="inactivosSaveConfig()" style="margin-top:12px;width:100%;background:linear-gradient(135deg,#d4af37,#ffd700);color:#000;border:none;border-radius:9px;padding:11px;font-weight:900;font-size:13px;cursor:pointer;">💾 Guardar escalera</button>';
    h += '</div>';

    // --- Últimos disparos ---
    h += '<h3 style="color:#d4af37;font-size:13px;margin:0 0 8px;">🔎 Últimos disparos</h3>';
    if (ultimos.length) {
        h += '<div style="display:flex;flex-direction:column;gap:5px;">';
        ultimos.forEach(function (u) {
            const premio = u.tipo === 'regalo' ? ('🎁 $' + (u.montoARS || 0)) : ('🎁 ' + (u.percent || 0) + '%');
            h += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,255,255,0.07);border-radius:7px;padding:6px 9px;font-size:11px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
                + '<span style="color:#fff;font-weight:700;">' + _escInac(u.username) + '</span>'
                + '<span style="color:#c9a0ff;">+' + u.stepDias + 'd · ' + premio + '</span>'
                + '<span style="color:#777;margin-left:auto;">' + (u.firedAt ? new Date(u.firedAt).toLocaleString('es-AR') : '') + '</span></div>';
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
            const lastLogin = pa.lastLogin ? new Date(pa.lastLogin).toLocaleString('es-AR') : '<em style="color:#666;">nunca</em>';
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
                        <div>📅 Creada: ${new Date(pa.createdAt).toLocaleDateString('es-AR')}</div>
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
                                <td style="padding:8px;color:#888;">${new Date(u.createdAt).toLocaleDateString('es-AR')}</td>
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
    _analysisState = { publisher, analysis: null, daily: null };
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
