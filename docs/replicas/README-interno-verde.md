# Réplica — Mensajes INTERNOS en verde / automáticos en naranja (WORKLOG #123, commit 77303c6)

Solo panel (`public/adminprivado2026/admin.js` + `admin.css`), cero backend.
**Requisito:** que el backend ya mande `adminOnly` en los mensajes: en el GET de
mensajes (`$project: { …, adminOnly: 1 }`) y en el payload de socket de las notas
internas (`_emitAdminOnlyChatNote` emite `adminOnly: true`). En los repos con el
mismo código base ya está.

## Opción A — patch
```bash
curl -sL https://raw.githubusercontent.com/jupedro2112-pixel/AUTOREEMBOLSOSjygactivo/main/docs/replicas/2026-08-25-interno-verde-automatico-naranja.patch -o /tmp/iv.patch
git apply --check /tmp/iv.patch && git apply /tmp/iv.patch
```
(Incluye el bump de `admin-sw.js` v24→v25; si el otro repo está en otra versión,
ese hunk falla: aplicá el resto y bumpeá el SW a mano.)

## Opción B — a mano (3 bloques)

### 1. `admin.css` — junto a los otros `.icon-*::before`
```css
.icon-robot::before { content: "🤖"; }
```

### 2. `admin.css` — debajo del bloque `.message.system` existente
```css
/* Mensaje de sistema INTERNO (adminOnly): el cliente NO lo recibe. VERDE para
   distinguirlo al toque de los automáticos (naranja), con etiqueta explícita. */
.message.system.internal {
    background: rgba(37, 211, 102, 0.14);
    border-color: #25d366;
    color: #9ff5c0;
}
.message.system.internal .internal-badge {
    color: #2ee06f;
    font-size: 10.5px;
    font-weight: 800;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
}
```

### 3. `admin.js` — en `createMessageElement`, REEMPLAZAR la rama `if (message.type === 'system')`
```js
    if (message.type === 'system') {
        const isInternal = message.adminOnly === true;
        const div = document.createElement('div');
        div.className = 'message system' + (isInternal ? ' internal' : '');
        div.dataset.messageid = message.id || '';
        const time = formatChatTime(message.timestamp || new Date());
        const badge = isInternal ? '<div class="internal-badge">🔒 INTERNO — el cliente NO lo ve</div>' : '';
        const icon = isInternal ? '' : '<span class="icon icon-robot"></span> ';
        div.innerHTML = `${badge}<div class="message-content">${icon}<span>${escapeHtml(message.content)}</span></div><div class="message-time system-time">${time}</div>`;
        return div;
    }
```
(Si en ese repo la rama no tiene `formatChatTime`, dejá la línea de hora como
estaba y solo cambiá `className`, `badge` e `icon`.)

### 4. `public/admin-sw.js` — bumpear `CACHE_VERSION` (v+1) para que el panel tome el CSS/JS nuevo.

## Probar
"Chat cerrado por…" y las alertas internas → **verde** con etiqueta 🔒 INTERNO.
Confirmaciones de depósito/bono (que el cliente sí vio) → **naranja** con 🤖.
