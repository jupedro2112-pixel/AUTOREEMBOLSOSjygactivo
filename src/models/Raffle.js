/**
 * Sorteo paid: cada sorteo tiene un cupo fijo de numeros, cada numero tiene
 * un costo, los users compran con su saldo de JUGAYGANA. Cuando el cupo se
 * llena, se cierra y se respawnea automaticamente otra instancia del mismo
 * tipo. Todos los lunes en la nocturna se sortea contra el 1er premio de la
 * Loteria Nacional.
 *
 * Tipos: 4 niveles de premio paralelos:
 *   $1.000.000 (100 numeros x $15.000)
 *   $2.000.000 (100 numeros x $30.000)
 *   $500.000   (100 numeros x $7.500)
 *   $100.000   (100 numeros x $2.000)
 *
 * Lifecycle:
 *   active → closed (cupo lleno) → drawn (admin carga ganador) → archived (cleanup)
 *   o: active → cancelled (admin cancela)
 *
 * Campos legacy: monthKey, entryMode, wageredThreshold, maxCuposPerUser,
 * raffleType (con enum 'iphone'/'caribe'/'auto') quedan para compat con
 * documentos viejos pero no se usan en el modelo nuevo.
 */
const mongoose = require('mongoose');

const raffleSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  prizeName: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: '', maxlength: 500 },
  imageUrl: { type: String, default: null, maxlength: 800 },
  emoji: { type: String, default: '🎁', maxlength: 8 },

  // Tipo de sorteo: identifica la "linea" de premio. Se usa para respawnear
  // una instancia nueva con los mismos parametros cuando el cupo se llena.
  // Tipos del modelo nuevo (paid): 'p1m', 'p2m', 'p500', 'p100'. El enum
  // tambien acepta los tipos legacy ('iphone'/'caribe'/'auto'/'other') para
  // que las migraciones no rompan validacion.
  raffleType: {
    type: String,
    enum: [
      // Sorteo RELAMPAGO: hero del sistema, va arriba de todo en la app.
      // Premio chico-medio ($200k), entry baja, 100 cupos. Mismo draw.
      'relampago',
      // Modelo paid actual:
      'p1m', 'p2m', 'p500', 'p100',
      // Modelo free (clientes activos, auto-enrollment por carga):
      'free_p2m', 'free_p1m', 'free_p500', 'free_p100',
      // Estructura nueva (2026-05): gates explícitos en el nombre del tipo.
      // Por cargas: 1× $1M, 1× $500K, 5× $100K (parallelInstances=5)
      // Por netwin: 1× $500K, 5× $100K (parallelInstances=5)
      'free_1m_cargas', 'free_500k_cargas', 'free_100k_cargas',
      'free_500k_netwin', 'free_100k_netwin',
      // Sorteo de prueba (admin lo seedea on-demand para validar el flujo
      // buy -> draw -> auto-credit con poca plata real). No auto-respawnea.
      'test',
      // Legacy (loss-credit):
      'iphone', 'caribe', 'auto', 'other'
    ],
    default: 'other',
    index: true
  },
  // Costo minimo de cargas en los ultimos 30 dias para entrar al sorteo
  // gratis. Solo aplica a free_*. Legacy: ahora preferimos minNetLossARS.
  minCargasARS: { type: Number, default: 0, min: 0 },
  // Perdida neta minima (deposits - withdrawals, clamp >= 0) en la ventana
  // semanal para entrar al sorteo gratis. Si > 0 reemplaza a minCargasARS
  // como gating para los free_*. La idea: "si perdiste $X, tenes 1 numero".
  minNetLossARS: { type: Number, default: 0, min: 0 },
  // Si entryCost === 0 Y minCargasARS > 0 -> es un sorteo gratis exclusivo.
  // Lo marcamos explicito tambien para queries faciles.
  isFree: { type: Boolean, default: false, index: true },
  // Solo aplica a 'relampago': si esta en true, el user necesita haber
  // participado en al menos 1 sorteo PAGO (entryCost > 0) en el pasado para
  // inscribirse. Sirve como gancho: el primer relampago es libre, los
  // siguientes son recompensa para quienes ya jugaron pagos.
  requiresPaidTicket: { type: Boolean, default: false },
  // Solo aplica a 'relampago': si > 0, el user necesita haber tenido al
  // menos N cargas REALES (Transaction type='deposit') en los ultimos 7
  // dias para poder anotarse. Las bonificaciones (type='bonus') NO cuentan
  // — solo cargas reales con plata propia. Sirve para apuntar campañas a
  // jugadores activos sin importar el monto.
  requiresMinChargesLastWeek: { type: Number, default: 0, min: 0 },

  // Audiencia por equipo o usuario. Permite que el admin restrinja la
  // visibilidad y participacion del sorteo.
  //   'all'    -> todos los users (default)
  //   'except' -> todos los equipos EXCEPTO los listados en audienceTeams
  //   'only'   -> SOLO los equipos listados en audienceTeams
  //   'user'   -> SOLO los usernames listados en audienceUsernames
  //              (modo testing: el admin elige 1 usuario especifico para
  //              probar el sorteo antes de abrirlo a todos)
  // El equipo se deriva del prefijo del username (mismo helper que el
  // refundReminder y los pushes segmentados: pickTeamNameForUsername).
  audienceMode: { type: String, enum: ['all', 'except', 'only', 'user'], default: 'all' },
  audienceTeams: { type: [String], default: [] },
  audienceUsernames: { type: [String], default: [] },
  // Numero de instancia dentro del tipo. Cada vez que se llena un sorteo,
  // se crea otro con instanceNumber = previo + 1.
  instanceNumber: { type: Number, default: 1, min: 1 },
  // Semana ISO en la que se va a sortear este cupo. Formato "YYYY-Www".
  // Si el cupo no se llena antes del lunes de esa semana, se sortea igual.
  weekKey: { type: String, default: '', index: true },

  // Costo de entrada en pesos (lo que descuenta del saldo del user por cada
  // numero comprado).
  entryCost: { type: Number, required: true, min: 0 },
  // Total de cupos disponibles. Cada cupo tiene un numero unico 1..totalTickets.
  totalTickets: { type: Number, required: true, min: 1 },
  // Valor del premio en pesos (lo que se acredita al ganador cuando reclama).
  prizeValueARS: { type: Number, default: 0, min: 0 },

  // Contador atomico de cupos vendidos. $inc en cada compra para evitar races.
  _ticketCounter: { type: Number, default: 0, min: 0 },

  // Numeros ya tomados (1..totalTickets). El user elige sus numeros del grid
  // y la compra solo prospera si NINGUNO de los pedidos esta en este array
  // ($nin atomico en findOneAndUpdate). Si hay race, el segundo caller que
  // intente reservar el mismo numero falla y reintenta con otro.
  claimedNumbers: { type: [Number], default: [], index: true },

  // Fecha de sorteo: lunes de weekKey, 21:00 ARG (Loteria Nocturna).
  drawDate: { type: Date, required: true, index: true },
  // Texto descriptivo de contra qué sorteo se sortea.
  lotteryRule: { type: String, default: '', maxlength: 300 },

  status: {
    type: String,
    enum: ['active', 'closed', 'drawn', 'archived', 'cancelled'],
    default: 'active',
    index: true
  },

  // Resultado del draw.
  winnerUsername: { type: String, default: null, index: true },
  winningTicketNumber: { type: Number, default: null },
  drawnAt: { type: Date, default: null },
  drawnBy: { type: String, default: null },

  // Trazabilidad de la Loteria Nacional.
  lotteryDrawDate: { type: Date, default: null },
  lotteryDrawNumber: { type: Number, default: null },
  lotteryDrawSource: { type: String, default: null, maxlength: 200 },

  // Premio reclamable por el ganador. Cuando admin carga el draw, el
  // ganador queda con prizeClaimable=true y puede pedir el credito a su
  // saldo desde la app. Cuando reclama, prizeClaimedAt y la transaccion
  // quedan registradas.
  prizeClaimable: { type: Boolean, default: false, index: true },
  prizeClaimedAt: { type: Date, default: null },
  prizeClaimTxId: { type: String, default: null },
  // Auditoría de intentos de acreditación. Se popula cuando el credit a
  // JUGAYGANA falla — sirve para que el admin reconcilie con el log de
  // JUGAYGANA si sospechás defasaje (plata aplicada del lado de JUGAYGANA
  // pero credit.success=false del lado nuestro).
  prizeClaimAttempts: { type: Number, default: 0 },
  prizeClaimLastError: { type: String, default: null, maxlength: 320 },
  prizeClaimLastAttemptAt: { type: Date, default: null },

  // Cuando el admin marca un premio como "pagado por fuera" (efectivo /
  // transfer manual / etc), seteamos prizeClaimedAt + estos flags. JUGAYGANA
  // NO se toca. La PWA ve el premio como acreditado y no muestra el botón
  // de reclamo — evita doble pago.
  paidOutsideSystem: { type: Boolean, default: false, index: true },
  paidOutsideNote: { type: String, default: null, maxlength: 320 },
  paidOutsideBy: { type: String, default: null },

  // ===== Campos legacy (no se usan en el modelo nuevo, mantenidos para
  // compat con documentos antiguos). =====
  monthKey: { type: String, default: '', index: true },
  entryMode: { type: String, default: 'paid' },
  wageredThreshold: { type: Number, default: 0 },
  maxCuposPerUser: { type: Number, default: 0 }
}, { timestamps: true });

raffleSchema.index({ raffleType: 1, status: 1, instanceNumber: -1 });
raffleSchema.index({ status: 1, drawDate: 1 });

// NOTA: el indice partial-unique `unique_active_per_type` fue REMOVIDO en
// la estructura nueva (2026-05) porque ahora soportamos N instancias activas
// del mismo raffleType en paralelo (ej. 5× $100K por cargas). El seed
// mantiene el conteo via findOne + create iterativo. Si querés revivir la
// restricción para un tipo puntual, hacelo a nivel de spawn config (no de
// índice).
// Boot script borra el índice físico si todavía existe (drop-once).

module.exports = mongoose.models['Raffle'] || mongoose.model('Raffle', raffleSchema);
