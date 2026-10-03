# 4) HOOKS en los flujos de carga (dónde se aplica el % automático del lote)

Estos fragmentos NO se pegan sueltos: van DENTRO de los flujos de carga que ya tiene el repo destino.
Son el contrato de "una carga = como mucho UN bono automático" (bono app o lote, nunca ambos).

## 4.a Carga MANUAL del agente — `POST /api/admin/deposit` (después de acreditar la carga y el bonus del agente)

Variables del flujo que usa: `user`, `amount`, `bonus` (let), `bonusRequested`, `bonusActuallyApplied`,
`bonusJgResult`, `_dupBankManual` (anti-multicuenta por banco #152; si el destino no lo tiene, tratarlo como `null`),
`_loteClaim` (declarar `let _loteClaim = null;` arriba, se usa después para el mensaje al cliente).

```js
      // #149 BONO DE LOTE AUTOMÁTICO (carga manual SIN bonus del agente): si el
      // cliente tiene un % de "Lote con regalo" automático vigente (alcance y
      // franja horaria incluidos), se reserva ATÓMICO, se acredita como
      // individual_bonus y, si el crédito falla, se libera para la próxima.
      // Si el agente ya cargó un bonus a mano, va el suyo (el lote NO se suma).
      // #165: resultado del bono app automático en la carga manual → nota interna que
      // explica qué se dio y por qué (y revierte la marca del cupón si el crédito falló).
      if (_appFirst) {
        const cB = _appFirst.cfg; const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
        const formula = cB.firstCapARS > 0
          ? `${cB.firstPct}% sobre los primeros ${money(cB.firstCapARS)}${parseFloat(amount) > cB.firstCapARS ? ` + ${cB.firstExcessPct}% sobre los ${money(parseFloat(amount) - cB.firstCapARS)} que exceden el tope` : ''}`
          : `${cB.firstPct}% sobre toda la carga`;
        if (bonusActuallyApplied) {
          const cual = _appFirst.agentBonus === _appFirst.expected
            ? 'coincide con lo que pusiste'
            : (_appFirst.agentBonus > 0 ? `el agente había puesto ${money(_appFirst.agentBonus)} → SE CORRIGIÓ al bono que corresponde` : 'no habías puesto bonus → se aplicó solo');
          await _emitAdminOnlyChatNote(user.id, user.username,
            `🎁 BONO APP (primera carga) aplicado AUTOMÁTICO en esta carga manual: ${money(_appFirst.expected)} = ${formula} sobre ${money(parseFloat(amount))}. ${cual}. El cupón quedó marcado USADO (no se repite). No hay que marcar nada.`);
          logger.info(`[deposit] bono app auto (manual) user=${user.username} amount=$${amount} bono=$${_appFirst.expected} agentPuso=$${_appFirst.agentBonus} by=${req.user.username}`);
        } else {
          // Deshacer la marca del cupón para que el cliente no lo pierda sin cobrarlo.
          try {
            if (_appFirst.branch === 'pending') await User.updateOne({ id: user.id, installBonus100UsedBy: _appFirst.usedByLbl }, { $set: { installBonus100Pending: true }, $unset: { installBonus100UsedAt: 1, installBonus100UsedBy: 1 } });
            else await User.updateOne({ id: user.id, installBonus100UsedBy: _appFirst.usedByLbl }, { $unset: { installBonusClaimed: 1, installBonusClaimedAt: 1, installBonus100GrantedAt: 1, installBonus100Pending: 1, installBonus100UsedAt: 1, installBonus100UsedBy: 1 } });
          } catch (_) {}
          await _emitAdminOnlyChatNote(user.id, user.username,
            `🎁 ⚠️ El BONO APP automático de ${money(_appFirst.expected)} (${formula}) NO se pudo acreditar (${jugaygana.errToString((bonusJgResult && bonusJgResult.error) || 'sin respuesta')}). El cupón volvió a quedar pendiente: aplicalo con el botón Bonus cuando JUGAYGANA responda.`);
        }
      }

      // #152: con multicuenta confirmada por banco (otra cuenta fondeada por el mismo
      // titular que ya fondeó a ésta) el lote automático NO se aplica; el bonus
      // que el agente cargue a mano sí va (es su decisión — el modal se lo avisa).
      if (_dupBankManual && !bonusRequested) {
        await _emitAdminOnlyChatNote(user.id, user.username,
          `🚨 MULTICUENTA CONFIRMADA POR BANCO: ${_dupBankManual.holders.join(' / ')} también cargó en ${_dupBankManual.accounts.map(a => '@' + a.username).join(', ')}. Esta carga manual entró SIN bono de lote automático. Verificá y bloqueá si corresponde.`);
      }
      if (!bonusRequested && !_dupBankManual) {
        const _lc = await claimAutoPromoPercent(user, req.user.username || 'agente');
        if (_lc.claimed) {
          const _loteCfg = await getHgcashAppBonusConfig();
          const _loteAmt = _loteBonusAmount(parseFloat(amount), _lc.pct, _loteCfg); // #172 tope
          const _loteCapNote = _loteCapTxt(_lc.pct, _loteCfg);
          await new Promise(r => setTimeout(r, 700));
          const _lcRes = await jugaygana.creditUserBalance(user.username, _loteAmt, user.jugayganaUserId || null).catch(() => null);
          if (_lcRes && _lcRes.success && _loteAmt > 0) {
            _loteClaim = _lc;
            await settleAutoPromoPercent(_lc, parseFloat(amount), _loteAmt);
            bonus = String(_loteAmt); bonusRequested = true; bonusActuallyApplied = true; bonusJgResult = _lcRes;
            try {
              await Transaction.create({
                id: uuidv4(), type: 'bonus', userId: user.id, username: user.username, amount: _loteAmt,
                description: `Bono de lote automático +${_lc.pct}% (${_lc.label})`,
                adminId: req.user.userId, adminUsername: req.user.username, adminRole: req.user.role,
                transactionId: _lcRes.data?.transfer_id || _lcRes.data?.transferId || null,
                metadata: { source: 'notif_batch_auto', promoBonusId: _lc.id }, timestamp: new Date()
              });
            } catch (_) {}
            await _emitAdminOnlyChatNote(user.id, user.username,
              `⚡ BONO DE LOTE AUTOMÁTICO aplicado en esta carga: +${_lc.pct}%${_loteCapNote} = $${_loteAmt.toLocaleString('es-AR')} (${_lc.label}). ` +
              (_lc.scope === 'first' ? 'El bono quedó USADO (era por una sola carga).' : 'El bono sigue vigente para sus próximas cargas.') + ' No hay que marcar nada.');
          } else if (_lcRes && _lcRes.ambiguous) {
            // #151: puede haber entrado → el bono queda consumido (no se revierte) y se verifica a mano.
            _loteClaim = _lc;
            await _alertMoneyAmbiguous(`Bono de lote automático +${_lc.pct}%`, user.id, user.username, _loteAmt, _lcRes.error);
          } else {
            await revertAutoPromoPercent(_lc);
            await _emitAdminOnlyChatNote(user.id, user.username,
              `⚠️ El bono de LOTE automático (+${_lc.pct}%) NO se pudo acreditar en esta carga (${jugaygana.errToString((_lcRes && _lcRes.error) || 'sin respuesta')}). El bono sigue vigente: aplicalo a mano si corresponde y marcalo usado desde el cartel.`);
          }
        }
      }
```

Mensaje al cliente (donde se arma el texto de /sys_deposit_bonus):

```js
        if (_loteClaim) messageContent += `\n🎁 Incluye tu regalo: +${_loteClaim.pct}% extra por el lote de regalo${_loteClaim.scope === 'first' ? ' (ya utilizado)' : ''}.`;
```

## 4.b Carga AUTOMÁTICA hgcash — `hgcashAutoCarga` (después de `_hgcashApplyAppBonus`)

`appBonus` tiene que ser `let`. `_dupBank` = multicuenta por banco (#152) o `null`.

```js
    // #149 BONO DE LOTE AUTOMÁTICO en la carga hgcash: solo si NO hubo bono de app
    // (nunca se suman entre sí). Reserva atómica → crédito → settle; si falla, se
    // libera y el agente lo ve en una nota.
    if (!appBonus.applied && !_dupBank) {
      const _lcH = await claimAutoPromoPercent(user, 'auto-hgcash');
      if (_lcH.claimed) {
        const _lcAmt = _loteBonusAmount(Number(amount), _lcH.pct, await getHgcashAppBonusConfig()); // #172 tope
        await new Promise(r => setTimeout(r, 700));
        const _lcRes = _lcAmt > 0 ? await jugaygana.creditUserBalance(user.username, _lcAmt, user.jugayganaUserId || null).catch(() => null) : null;
        if (_lcRes && _lcRes.success) {
          await settleAutoPromoPercent(_lcH, Number(amount), _lcAmt);
          appBonus = Object.assign({}, appBonus, { applied: true, amount: _lcAmt, pct: _lcH.pct, kind: 'lote', loteLabel: _lcH.label, loteScope: _lcH.scope });
          try {
            await Transaction.create({
              id: uuidv4(), type: 'bonus', userId: user.id, username: user.username, amount: _lcAmt,
              description: `Bono de lote automático +${_lcH.pct}% (${_lcH.label}) — carga hgcash`,
              adminUsername: 'auto-hgcash', adminRole: 'system',
              transactionId: _lcRes.data?.transfer_id || _lcRes.data?.transferId || null,
              metadata: { source: 'notif_batch_auto', promoBonusId: _lcH.id, movementId: movement.movementId }, timestamp: new Date()
            });
          } catch (_) {}
        } else if (_lcRes && _lcRes.ambiguous) {
          await _alertMoneyAmbiguous(`Bono de lote automático +${_lcH.pct}% (hgcash)`, user.id, user.username, _lcAmt, _lcRes.error);
        } else {
          await revertAutoPromoPercent(_lcH);
          await _emitAdminOnlyChatNote(user.id, user.username,
            `⚠️ El bono de LOTE automático (+${_lcH.pct}%) NO se pudo acreditar en la carga hgcash (${jugaygana.errToString((_lcRes && _lcRes.error) || 'sin respuesta')}). Sigue vigente: aplicalo a mano si corresponde.`);
        }
      }
    }
```

Mensaje al cliente y nota interna de la carga automática:

```js
      if (appBonus.kind === 'lote') clientMsg += `\n🎁 Incluye tu regalo: +${appBonus.pct}% extra por el lote de regalo${appBonus.loteScope === 'first' ? ' (ya utilizado)' : ''}.`;

    const bonusNote = appBonus.applied
      ? (appBonus.kind === 'lote'
        ? ` ⚡ + BONO DE LOTE AUTOMÁTICO +${appBonus.pct}% (${appBonus.loteLabel}): $${Number(appBonus.amount).toLocaleString('es-AR')}. ${appBonus.loteScope === 'first' ? 'El bono quedó USADO.' : 'El bono sigue vigente para sus próximas cargas.'} No hay que marcar nada.`
        : ` 🎁 + BONO AUTOMÁTICO ${appBonus.pct}% ${appBonus.kind === 'install_100' ? '(primera carga, app instalada)' : '(app instalada)'}: $${Number(appBonus.amount).toLocaleString('es-AR')}.`)
      : (appBonus.skippedForBank
        ? ` 🚨 SIN bonos automáticos: multicuenta confirmada por banco (${_dupBank.holder} ya cargó en @${_dupBank.matchedUsername || '?'}).`
```

## 4.c Si el repo destino NO tiene hgcash

Solo va 4.a. El motor del lote y el canje no dependen de hgcash.
