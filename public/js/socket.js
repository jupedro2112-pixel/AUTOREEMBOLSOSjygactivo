// ========================================
// SOCKET - Socket.IO real-time module
// ========================================

window.VIP = window.VIP || {};

VIP.socket = (function () {

    function initSocket() {
        if (VIP.state.socket && VIP.state.socket.connected) return;

        if (VIP.state.socket && !VIP.state.socket.connected) {
            VIP.state.socket.connect();
            return;
        }


        VIP.state.socket = io({
            // WebSocket primero (baja latencia); si la red lo bloquea —proxies
            // corporativos, algunas redes móviles— cae a polling para que el
            // chat siga siendo en tiempo real en vez de depender del poll de 30s.
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
        });

        VIP.state.socket.on('connect', function () {
            VIP.state.socket.emit('authenticate', VIP.state.currentToken);
        });

        VIP.state.socket.on('authenticated', function (data) {
            if (data.success) {
                VIP.state.socketAuthed = true;
                if (VIP.state.currentUser && VIP.state.currentUser.userId) {
                    VIP.state.socket.emit('join_user_room', { userId: VIP.state.currentUser.userId });
                }
                VIP.chat.loadMessages(true);
            } else {
                VIP.state.socketAuthed = false;
                console.error('❌ Error autenticando socket:', data.error);
            }
        });

        VIP.state.socket.on('reconnect', function (attemptNumber) {
            VIP.state.socket.emit('authenticate', VIP.state.currentToken);
            setTimeout(() => { VIP.chat.loadMessages(true); }, 500);
        });

        VIP.state.socket.on('reconnect_attempt', function (attemptNumber) {
        });

        VIP.state.socket.on('connect_error', function (error) {
            console.error('❌ Error de conexión:', error);
        });

        VIP.state.socket.on('reconnect_error', function (error) {
            console.error('❌ Error de reconexión:', error);
        });

        VIP.state.socket.on('admin_typing', function (data) {
            const typingIndicator = document.getElementById('typingIndicator');
            if (typingIndicator) {
                typingIndicator.style.display = 'inline';
                typingIndicator.textContent = '✍️ ' + (data.adminName || 'Agente') + ' está escribiendo...';
            }
        });

        VIP.state.socket.on('push_notification', function (data) {
            VIP.notifications.showBrowserNotification(
                data.title || 'Nueva notificación',
                data.body || '',
                data.icon || '/favicon.ico'
            );
            VIP.notifications.playNotificationSound();
        });

        VIP.state.socket.on('admin_stop_typing', function () {
            const typingIndicator = document.getElementById('typingIndicator');
            if (typingIndicator) {
                typingIndicator.style.display = 'none';
            }
        });

        VIP.state.socket.on('new_message', function (data, ack) {
            // Acuse de recibo inmediato: el server emite con ack-timeout 3s.
            // Si no llamamos ack, el server asume socket fantasma y manda push
            // FCM de respaldo. Llamarlo lo más temprano posible reduce falsos
            // positivos cuando el dispositivo está lento procesando el mensaje.
            try { if (typeof ack === 'function') ack({ ok: true }); } catch (_) {}

            const message = data.message || data;

            if (message.id && VIP.state.processedMessageIds.has(message.id)) {
                return;
            }

            const existingMsg = document.querySelector(`[data-message-id="${message.id}"]`);
            if (existingMsg) {
                return;
            }

            if (message.id) {
                VIP.state.processedMessageIds.add(message.id);
                if (VIP.state.processedMessageIds.size > 100) {
                    const iterator = VIP.state.processedMessageIds.values();
                    VIP.state.processedMessageIds.delete(iterator.next().value);
                }
            }

            const tempElements = document.querySelectorAll('[data-temp-id]');
            let tempReplaced = false;
            tempElements.forEach(tempEl => {
                const tempContent = tempEl.querySelector('.message > div')?.textContent;
                const tempTime = new Date(tempEl.querySelector('.message-time')?.textContent);
                const msgTime = new Date(message.timestamp);
                if (tempContent === message.content && Math.abs(msgTime - tempTime) < 60000) {
                    tempEl.setAttribute('data-message-id', message.id);
                    tempEl.removeAttribute('data-temp-id');
                    tempEl.classList.add('message-saved');
                    const msgDiv = tempEl.querySelector('.message');
                    if (msgDiv) { msgDiv.style.opacity = '1'; msgDiv.style.border = ''; }
                    tempReplaced = true;
                }
            });

            if (!tempReplaced) {
                VIP.chat.addMessageToChat(message);
                VIP.notifications.playNotificationSound();

                const adminRoles = ['admin', 'depositor', 'withdrawer'];
                const isFromAdmin = adminRoles.includes(message.senderRole);
                // Solo mostrar notificación nativa cuando la pestaña NO está
                // visible. Si el user está mirando la app, el mensaje ya
                // aparece en pantalla y el evento 'admin_notification' (vía
                // sendPushIfOffline en el backend) muestra un banner in-app.
                // Sin esta guarda veíamos hasta 2 alertas por un solo mensaje.
                const tabVisible = document.visibilityState === 'visible';
                if (isFromAdmin && !tabVisible) {
                    const senderName = message.senderUsername || 'Soporte';
                    const messagePreview = message.type === 'image'
                        ? '📸 Imagen'
                        : (message.content?.substring(0, 50) + '...');
                    VIP.notifications.showBrowserNotification(
                        `💬 Nuevo mensaje de ${senderName}`,
                        messagePreview,
                        '/favicon.ico'
                    );
                }
            }

            requestAnimationFrame(() => {
                VIP.chat.scrollToBottom();
                setTimeout(VIP.chat.scrollToBottom, 50);
                setTimeout(VIP.chat.scrollToBottom, 150);
                setTimeout(VIP.chat.scrollToBottom, 300);
            });

            VIP.state.lastMessageId = message.id;
        });

        VIP.state.socket.on('message_sent', function (data) {
            if (data && data.id) {
                const tempEl = document.querySelector('[data-temp-id]');
                if (tempEl) {
                    tempEl.setAttribute('data-message-id', data.id);
                    tempEl.removeAttribute('data-temp-id');
                    tempEl.classList.add('message-saved');
                    const msgDiv = tempEl.querySelector('.message');
                    if (msgDiv) { msgDiv.style.opacity = '1'; msgDiv.style.border = ''; }
                }
                VIP.state.processedMessageIds.add(data.id);
            }
        });

        VIP.state.socket.on('error', function (data) {
            console.error('❌ Error de socket:', data);
        });

        VIP.state.socket.on('rate_limited', function (data) {
            VIP.ui.showToast(data.message || 'Estás enviando mensajes muy rápido. Esperá un momento.', 'info');
        });

        VIP.state.socket.on('disconnect', function () {
            VIP.state.socketAuthed = false;
        });
    }

    // Tick del poll de mensajes: es solo RESPALDO del socket. Si el socket está
    // conectado y autenticado, los mensajes ya llegan en tiempo real por
    // 'new_message' → se saltea el fetch (antes: ~120 requests/hora por usuario
    // totalmente redundantes). Si el socket cae, el poll de 30s sigue cubriendo.
    function _pollTick() {
        if (VIP.state.socket && VIP.state.socket.connected && VIP.state.socketAuthed) return;
        VIP.chat.loadMessages();
    }

    function startMessagePolling() {
        VIP.chat.loadMessages();
        VIP.state.messageCheckInterval = setInterval(_pollTick, 30000);
        initSocket();
    }

    function stopMessagePolling() {
        if (VIP.state.messageCheckInterval) {
            clearInterval(VIP.state.messageCheckInterval);
            VIP.state.messageCheckInterval = null;
        }
        if (VIP.state.socket) {
            VIP.state.socket.disconnect();
            VIP.state.socket = null;
        }
    }

    return { initSocket, startMessagePolling, stopMessagePolling };

})();
