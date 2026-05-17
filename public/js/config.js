// ========================================
// CONFIG - VIP Namespace & shared state
// ========================================

window.VIP = window.VIP || {};

VIP.config = {
    API_URL: '',
    FRONTEND_MSG_RATE_MAX: 2,
    FRONTEND_MSG_RATE_WINDOW_MS: 1000,
    CBU_CLICK_COOLDOWN_MS: 10000
};

// Shared mutable application state (all modules read/write through here)
VIP.state = {
    currentToken: localStorage.getItem('userToken'),
    currentUser: null,
    socket: null,
    refundStatus: null,
    refundTimers: {},
    lastMessageId: null,
    messageCheckInterval: null,
    balanceCheckInterval: null,
    processedMessageIds: new Set(),
    pendingSentMessages: new Map(),
    lastSentMessageTimestamp: 0,
    passwordChangePending: false,
    sentMessageTimestamps: [],
    lastCbuClickTime: 0,
    notificationAudioContext: null,
    isLoadingMessages: false,
    lastMessagesHash: '',
    fireStatus: null,
    fireCountdownInterval: null,
    referralData: null,
    sessionPassword: '',
    linePhone: null,
    communityLink: null,
    teamName: null
};

// ---- Argentina timezone helpers (used across modules) ----

function getArgentinaDate(date = new Date()) {
    return new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
}

function getArgentinaMidnight() {
    const argentinaNow = getArgentinaDate();
    const midnight = new Date(argentinaNow);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime();
}

window.getArgentinaDate = getArgentinaDate;
window.getArgentinaMidnight = getArgentinaMidnight;
