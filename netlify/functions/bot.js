// netlify/functions/bot.js
// Bot v8:
//   - Resguardo (/resguardo, /exportar) y /resumen intactos
//   - /turno INTELIGENTE:
//       · Sin turno abierto  -> botones Iniciar turno (Mañana/Tarde/Noche)
//       · Turno en curso      -> menú de acciones (por ahora solo "Finalizar")
//       · Finalizar           -> pide confirmación, luego cierra
//   - Regla: un solo turno abierto a la vez por jefe
//   - Reapertura permitida solo el mismo día
//
// Colecciones: instalaciones, elementos, jefes_turno, sesiones, resguardos, turnos

const TOKEN = process.env.TELEGRAM_TOKEN;
const SECRET = process.env.TELEGRAM_SECRET;
const PROJECT = process.env.FIREBASE_PROJECT_ID;
const API_KEY = process.env.FIREBASE_API_KEY;
const COORDINADORES = (process.env.COORDINADOR_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

const TG = `https://api.telegram.org/bot${TOKEN}`;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// ============ Telegram ============

async function enviarMensaje(chatId, texto, extra = {}) {
  const res = await fetch(`${TG}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML", ...extra }),
  });
  if (!res.ok) console.error("sendMessage falló:", res.status, await res.text());
}

async function editarMensaje(chatId, messageId, texto, extra = {}) {
  const res = await fetch(`${TG}/editMessageText`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: texto, parse_mode: "HTML", ...extra }),
  });
  if (!res.ok) console.error("editMessageText falló:", res.status, await res.text());
}

async function responderCallback(id, texto = "") {
  await fetch(`${TG}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text: texto }),
  });
}

async function enviarDocumento(chatId, nombreArchivo, contenido, caption = "") {
  const boundary = "----csv" + Date.now();
  const partes = [];
  const push = (s) => partes.push(Buffer.from(s, "utf-8"));
  push(`--${boundary}\r\n`); push(`Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);
  if (caption) { push(`--${boundary}\r\n`); push(`Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`); }
  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="document"; filename="${nombreArchivo}"\r\n`);
  push(`Content-Type: text/csv; charset=utf-8\r\n\r\n`); push("\uFEFF" + contenido); push(`\r\n--${boundary}--\r\n`);
  const cuerpo = Buffer.concat(partes);
  const res = await fetch(`${TG}/sendDocument`, {
    method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(cuerpo.length) },
    body: cuerpo,
  });
  if (!res.ok) console.error("sendDocument falló:", res.status, await res.text());
  return res.ok;
}

// ============ Firestore ============

function planos(fields = {}) {
  const s = {};
  for (const [k, env] of Object.entries(fields)) {
    const t = Object.keys(env)[0]; let v = env[t];
    if (t === "integerValue") v = parseInt(v, 10);
    else if (t === "arrayValue") v = (v.values || []).map((x) => { const tt = Object.keys(x)[0]; return tt === "integerValue" ? parseInt(x[tt], 10) : x[tt]; });
    s[k] = v;
  }
  return s;
}

function aFirestore(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "boolean") f[k] = { booleanValue: v };
    else if (typeof v === "number" && Number.isInteger(v)) f[k] = { integerValue: String(v) };
    else if (Array.isArray(v)) f[k] = { arrayValue: { values: v.map((x) => Number.isInteger(x) ? { integerValue: String(x) } : { stringValue: String(x) }) } };
    else f[k] = { stringValue: String(v) };
  }
  return f;
}

async function consultar(coleccion, campo, valor, tipoValor = "stringValue") {
  const res = await fetch(`${FS}:runQuery?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coleccion }], where: { fieldFilter: { field: { fieldPath: campo }, op: "EQUAL", value: { [tipoValor]: String(valor) } } } } }),
  });
  if (!res.ok) { console.error(`runQuery falló (${coleccion}):`, res.status); return []; }
  const data = await res.json();
  return data.filter((f) => f.document).map((f) => ({ id: f.document.name.split("/").pop(), ...planos(f.document.fields) }));
}

// Consulta con dos condiciones (AND)
async function consultar2(coleccion, c1, v1, c2, v2) {
  const res = await fetch(`${FS}:runQuery?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: coleccion }],
        where: { compositeFilter: { op: "AND", filters: [
          { fieldFilter: { field: { fieldPath: c1 }, op: "EQUAL", value: { stringValue: String(v1) } } },
          { fieldFilter: { field: { fieldPath: c2 }, op: "EQUAL", value: { stringValue: String(v2) } } },
        ] } },
      },
    }),
  });
  if (!res.ok) { console.error(`runQuery2 falló (${coleccion}):`, res.status); return []; }
  const data = await res.json();
  return data.filter((f) => f.document).map((f) => ({ id: f.document.name.split("/").pop(), ...planos(f.document.fields) }));
}

async function leerDoc(coleccion, id) {
  const res = await fetch(`${FS}/${coleccion}/${id}?key=${API_KEY}`);
  if (!res.ok) return null;
  const doc = await res.json();
  return doc.fields ? { id, ...planos(doc.fields) } : null;
}

async function escribirDoc(coleccion, id, obj) {
  const mask = Object.keys(obj).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const res = await fetch(`${FS}/${coleccion}/${id}?key=${API_KEY}&${mask}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: aFirestore(obj) }),
  });
  if (!res.ok) console.error(`escribirDoc falló (${coleccion}/${id}):`, res.status, await res.text());
  return res.ok;
}

async function borrarDoc(coleccion, id) {
  await fetch(`${FS}/${coleccion}/${id}?key=${API_KEY}`, { method: "DELETE" });
}

// ============ Dominio ============

const esCoordinador = (id) => COORDINADORES.includes(String(id));
const buscarJefe = async (telegramId) => (await consultar("jefes_turno", "telegram_id", telegramId, "integerValue"))[0] || null;
const elementosDe = async (instalacion) => (await consultar("elementos", "instalacion", instalacion)).filter((e) => e.activo !== false).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

async function yaReportado(instalacion, fecha) {
  const docs = await consultar("resguardos", "fecha", fecha);
  return docs.some((d) => d.instalacion === instalacion);
}

function viernesDeEstaSemana() { const h = new Date(); h.setDate(h.getDate() - ((h.getDay() - 5 + 7) % 7)); return h.toISOString().split("T")[0]; }
function hoyISO() { return new Date().toISOString().split("T")[0]; }
function fechaBonita(iso) {
  const dias = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const d = new Date(iso + "T12:00:00");
  return `${dias[d.getDay()]} ${d.getDate()} ${meses[d.getMonth()]}`;
}

const leerSesion = (chatId) => leerDoc("sesiones", String(chatId));
const guardarSesion = (chatId, datos) => escribirDoc("sesiones", String(chatId), datos);
const borrarSesion = (chatId) => borrarDoc("sesiones", String(chatId));

function pintarLista(instalacion, fecha, elementos, seleccion) {
  const items = elementos.map((e, i) => `${seleccion.includes(i) ? "✅" : "▫️"} ${i + 1}. ${e.nombre}`).join("\n");
  return `<b>${instalacion.toUpperCase()}</b> · Resguardo ${fechaBonita(fecha)}\n\n${items}\n\n<i>Escribe los números de quienes resguardaron (ej: <code>1 3 5</code>).\nCuando termines escribe <code>ok</code>.</i>`;
}

function csvCampo(v) { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
const INSTALACIONES_ACTIVAS = ["ceuta", "bellavista", "tayoltita", "caimanes", "campo-5"];

// ============ Turnos ============

const NOMBRE_TURNO = { manana: "Mañana", tarde: "Tarde", noche: "Noche" };
const idTurno = (instalacion, fecha, turno) => `${fecha}_${instalacion}_${turno}`;

// Busca el turno abierto del jefe (hoy). Como solo puede haber uno, devuelve el primero.
async function turnoAbierto(instalacion) {
  const abiertos = await consultar2("turnos", "instalacion", instalacion, "estado", "abierto");
  return abiertos[0] || null;
}

// Teclado para iniciar turno
const tecladoIniciar = {
  inline_keyboard: [
    [{ text: "🌅 Iniciar Mañana", callback_data: "turno_iniciar_manana" }],
    [{ text: "☀️ Iniciar Tarde", callback_data: "turno_iniciar_tarde" }],
    [{ text: "🌙 Iniciar Noche", callback_data: "turno_iniciar_noche" }],
  ],
};

// Teclado del turno en curso (por ahora solo finalizar; luego se agregan Faltas, etc.)
const tecladoEnCurso = {
  inline_keyboard: [
    [{ text: "✅ Entregar reporte del turno", callback_data: "turno_finalizar" }],
  ],
};

// Teclado de confirmación de cierre
const tecladoConfirmarCierre = {
  inline_keyboard: [
    [{ text: "Sí, entregar", callback_data: "turno_finalizar_si" }],
    [{ text: "No, seguir", callback_data: "turno_finalizar_no" }],
  ],
};

async function menuTurno(chatId, jefe, messageIdParaEditar = null) {
  const abierto = await turnoAbierto(jefe.instalacion);
  if (abierto) {
    const texto =
      `<b>${jefe.instalacion.toUpperCase()}</b> · Turno <b>${NOMBRE_TURNO[abierto.turno]}</b> en curso\n` +
      `${fechaBonita(abierto.fecha)}\n\n` +
      `¿Qué deseas hacer?`;
    if (messageIdParaEditar) await editarMensaje(chatId, messageIdParaEditar, texto, { reply_markup: tecladoEnCurso });
    else await enviarMensaje(chatId, texto, { reply_markup: tecladoEnCurso });
  } else {
    const texto = `<b>${jefe.instalacion.toUpperCase()}</b> · ${fechaBonita(hoyISO())}\n\n¿Qué turno vas a iniciar?`;
    if (messageIdParaEditar) await editarMensaje(chatId, messageIdParaEditar, texto, { reply_markup: tecladoIniciar });
    else await enviarMensaje(chatId, texto, { reply_markup: tecladoIniciar });
  }
}

async function iniciarTurno(chatId, jefe, turno, callbackId, messageId) {
  // Regla: un solo turno abierto a la vez
  const abierto = await turnoAbierto(jefe.instalacion);
  if (abierto) {
    await responderCallback(callbackId, "Ya tienes un turno abierto");
    await editarMensaje(chatId, messageId,
      `⚠️ Ya tienes el turno <b>${NOMBRE_TURNO[abierto.turno]}</b> en curso.\n` +
      `Debes entregarlo antes de iniciar otro.`, { reply_markup: tecladoEnCurso });
    return;
  }

  const fecha = hoyISO();
  const id = idTurno(jefe.instalacion, fecha, turno);

  // ¿Ese turno ya se cerró hoy? Permitir reapertura el mismo día.
  const existente = await leerDoc("turnos", id);
  if (existente && existente.estado === "cerrado") {
    if (existente.fecha === fecha) {
      // Reabrir el mismo día
      await escribirDoc("turnos", id, { estado: "abierto", reabierto_en: new Date().toISOString() });
      await responderCallback(callbackId, "Turno reabierto");
      await editarMensaje(chatId, messageId,
        `🔓 Turno <b>${NOMBRE_TURNO[turno]}</b> reabierto\n<b>${jefe.instalacion.toUpperCase()}</b> · ${fechaBonita(fecha)}\n\n¿Qué deseas hacer?`,
        { reply_markup: tecladoEnCurso });
      return;
    } else {
      await responderCallback(callbackId, "Ese turno ya se cerró otro día");
      await editarMensaje(chatId, messageId, `⚠️ El turno <b>${NOMBRE_TURNO[turno]}</b> ya fue cerrado y no es de hoy. No se puede reabrir.`);
      return;
    }
  }

  await escribirDoc("turnos", id, {
    instalacion: jefe.instalacion, fecha, turno, estado: "abierto",
    jefe_abrio: jefe.nombre, abierto_en: new Date().toISOString(),
  });
  await responderCallback(callbackId, "Turno iniciado");
  await editarMensaje(chatId, messageId,
    `✅ Turno <b>${NOMBRE_TURNO[turno]}</b> iniciado\n<b>${jefe.instalacion.toUpperCase()}</b> · ${fechaBonita(fecha)}\n\n` +
    `<i>Durante el turno irás registrando reportes.\nAl terminar, entrega el reporte.</i>\n\n¿Qué deseas hacer?`,
    { reply_markup: tecladoEnCurso });
}

async function pedirConfirmacionCierre(chatId, jefe, callbackId, messageId) {
  const abierto = await turnoAbierto(jefe.instalacion);
  if (!abierto) {
    await responderCallback(callbackId, "No hay turno abierto");
    await editarMensaje(chatId, messageId, "No tienes ningún turno abierto.");
    return;
  }
  await responderCallback(callbackId);
  await editarMensaje(chatId, messageId,
    `Vas a entregar el reporte del turno <b>${NOMBRE_TURNO[abierto.turno]}</b>.\n\n` +
    `<i>Una vez entregado, solo podrás reabrirlo hoy mismo.</i>\n\n¿Confirmas?`,
    { reply_markup: tecladoConfirmarCierre });
}

async function finalizarTurno(chatId, jefe, callbackId, messageId) {
  const abierto = await turnoAbierto(jefe.instalacion);
  if (!abierto) {
    await responderCallback(callbackId, "No hay turno abierto");
    await editarMensaje(chatId, messageId, "No tienes ningún turno abierto.");
    return;
  }
  await escribirDoc("turnos", abierto.id, {
    estado: "cerrado", jefe_cerro: jefe.nombre, cerrado_en: new Date().toISOString(),
  });
  await responderCallback(callbackId, "Reporte entregado");
  await editarMensaje(chatId, messageId,
    `✅ Reporte del turno <b>${NOMBRE_TURNO[abierto.turno]}</b> entregado.\n` +
    `<b>${jefe.instalacion.toUpperCase()}</b> · ${fechaBonita(abierto.fecha)}\n\n` +
    `Gracias, ${jefe.nombre}.\n<i>(Los reportes de faltas, incidentes y fallas se agregan en el siguiente paso.)</i>`);
}

// ============ /exportar y /resumen (resguardos) ============

async function exportar(chatId) {
  const pendientes = (await consultar("resguardos", "exportado", false, "booleanValue")).sort((a, b) => (a.fecha + a.clave).localeCompare(b.fecha + b.clave));
  if (!pendientes.length) { await enviarMensaje(chatId, "No hay resguardos pendientes de exportar."); return; }
  const csv = [["CLAVE", "NOMBRE", "FECHA", "INSTALACION"].join(","), ...pendientes.map((r) => [r.clave, r.nombre, r.fecha, r.instalacion].map(csvCampo).join(","))].join("\r\n");
  const fechas = [...new Set(pendientes.map((r) => r.fecha))].sort();
  const ok = await enviarDocumento(chatId, `resguardos_${fechas[0]}_a_${fechas[fechas.length - 1]}.csv`, csv, "Resguardos pendientes");
  if (!ok) { await enviarMensaje(chatId, "No pude generar el archivo. Revisa el log."); return; }
  for (const r of pendientes) await escribirDoc("resguardos", r.id, { exportado: true, exportado_en: new Date().toISOString() });
  await enviarMensaje(chatId, `✅ Exportado y marcado. ${pendientes.length} resguardo(s).`);
}

async function resumen(chatId) {
  const fecha = viernesDeEstaSemana();
  const resguardos = await consultar("resguardos", "fecha", fecha);
  const porInst = {};
  resguardos.forEach((r) => { porInst[r.instalacion] = porInst[r.instalacion] || { total: 0, quien: r.reportado_por }; porInst[r.instalacion].total++; });
  const rep = [], falt = [];
  for (const inst of INSTALACIONES_ACTIVAS) {
    if (porInst[inst]) rep.push(`✅ ${inst.toUpperCase()}: ${porInst[inst].total} (${porInst[inst].quien})`);
    else falt.push(`❌ ${inst.toUpperCase()}: sin reporte`);
  }
  let msg = `<b>Resumen de resguardos</b>\n${fechaBonita(fecha)}\n\n`;
  if (rep.length) msg += rep.join("\n") + "\n";
  if (falt.length) msg += "\n" + falt.join("\n") + "\n";
  msg += `\n<b>${rep.length} de ${INSTALACIONES_ACTIVAS.length}</b> instalaciones reportaron.`;
  await enviarMensaje(chatId, msg);
}

// ============ Handler ============

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "Bot vivo" };
  if (SECRET && event.headers["x-telegram-bot-api-secret-token"] !== SECRET) return { statusCode: 401, body: "no autorizado" };

  let update;
  try { update = JSON.parse(event.body || "{}"); } catch { return { statusCode: 200, body: "ok" }; }

  // ---------- Botones inline ----------
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message.chat.id, messageId = cq.message.message_id, telegramId = cq.from.id, data = cq.data || "";
    try {
      const jefe = await buscarJefe(telegramId);
      if (!jefe) { await responderCallback(cq.id, "No estás dado de alta"); return { statusCode: 200, body: "ok" }; }

      if (data === "turno_iniciar_manana") await iniciarTurno(chatId, jefe, "manana", cq.id, messageId);
      else if (data === "turno_iniciar_tarde") await iniciarTurno(chatId, jefe, "tarde", cq.id, messageId);
      else if (data === "turno_iniciar_noche") await iniciarTurno(chatId, jefe, "noche", cq.id, messageId);
      else if (data === "turno_finalizar") await pedirConfirmacionCierre(chatId, jefe, cq.id, messageId);
      else if (data === "turno_finalizar_si") await finalizarTurno(chatId, jefe, cq.id, messageId);
      else if (data === "turno_finalizar_no") { await responderCallback(cq.id, "Turno sigue abierto"); await menuTurno(chatId, jefe, messageId); }
      else await responderCallback(cq.id);
    } catch (e) {
      console.error("Error callback:", e.message);
      await responderCallback(cq.id, "Algo falló");
    }
    return { statusCode: 200, body: "ok" };
  }

  // ---------- Texto ----------
  const msg = update.message;
  if (!msg || !msg.text) return { statusCode: 200, body: "ok" };
  const chatId = msg.chat.id, telegramId = msg.from.id, bruto = msg.text.trim(), texto = bruto.toLowerCase();

  try {
    const jefe = await buscarJefe(telegramId);

    if (texto.startsWith("/start")) {
      const extra = esCoordinador(telegramId) ? "\n\n(Coordinador: /resumen y /exportar)" : "";
      if (jefe) await enviarMensaje(chatId, `Hola ${jefe.nombre}.\n\nInstalación: <b>${jefe.instalacion.toUpperCase()}</b>\n\nUsa /turno para tus reportes.${extra}`);
      else await enviarMensaje(chatId, `Hola ${msg.from.first_name || ""}.\n\nTu ID: <code>${telegramId}</code>\n\nEnvíaselo a Efraín para que te dé de alta.${extra}`);
      return { statusCode: 200, body: "ok" };
    }

    if (texto.startsWith("/resumen")) {
      if (!esCoordinador(telegramId)) { await enviarMensaje(chatId, "Este comando es solo para el coordinador."); return { statusCode: 200, body: "ok" }; }
      await resumen(chatId); return { statusCode: 200, body: "ok" };
    }
    if (texto.startsWith("/exportar")) {
      if (!esCoordinador(telegramId)) { await enviarMensaje(chatId, "Este comando es solo para el coordinador."); return { statusCode: 200, body: "ok" }; }
      await exportar(chatId); return { statusCode: 200, body: "ok" };
    }

    if (!jefe) { await enviarMensaje(chatId, "No estás dado de alta. Usa /start y envía tu ID a Efraín."); return { statusCode: 200, body: "ok" }; }

    // /turno inteligente
    if (texto.startsWith("/turno")) { await menuTurno(chatId, jefe); return { statusCode: 200, body: "ok" }; }

    if (texto.startsWith("/cancelar")) { await borrarSesion(chatId); await enviarMensaje(chatId, "Resguardo cancelado. Usa /resguardo para empezar de nuevo."); return { statusCode: 200, body: "ok" }; }

    // /resguardo
    if (texto.startsWith("/resguardo")) {
      const fecha = viernesDeEstaSemana();
      if (await yaReportado(jefe.instalacion, fecha)) { await enviarMensaje(chatId, `⚠️ Ya se reportó el resguardo de <b>${jefe.instalacion.toUpperCase()}</b> para el ${fechaBonita(fecha)}.\n\nSi hubo un error, avísale a Efraín.`); return { statusCode: 200, body: "ok" }; }
      const els = await elementosDe(jefe.instalacion);
      await guardarSesion(chatId, { instalacion: jefe.instalacion, fecha, seleccion: [], paso: "seleccionando" });
      await enviarMensaje(chatId, pintarLista(jefe.instalacion, fecha, els, []));
      return { statusCode: 200, body: "ok" };
    }

    // Flujo de resguardo
    const sesion = await leerSesion(chatId);
    if (!sesion || !sesion.paso) { await enviarMensaje(chatId, "Usa /resguardo o /turno para comenzar."); return { statusCode: 200, body: "ok" }; }
    const els = await elementosDe(sesion.instalacion);

    if (sesion.paso === "confirmando") {
      if (texto === "si" || texto === "sí" || texto === "ok") {
        for (const idx of (sesion.seleccion || [])) { const el = els[idx]; if (!el) continue;
          await escribirDoc("resguardos", `${sesion.fecha}_${el.clave}`, { instalacion: sesion.instalacion, clave: el.clave, nombre: el.nombre, fecha: sesion.fecha, reportado_por: jefe.nombre, reportado_en: new Date().toISOString(), exportado: false });
        }
        await borrarSesion(chatId);
        await enviarMensaje(chatId, `✅ Resguardo guardado.\n\n<b>${sesion.instalacion.toUpperCase()}</b> · ${fechaBonita(sesion.fecha)}\nElementos: <b>${(sesion.seleccion || []).length}</b>\n\nGracias, ${jefe.nombre}.`);
        return { statusCode: 200, body: "ok" };
      }
      if (texto === "cambiar" || texto === "cambiar fecha") { await guardarSesion(chatId, { ...sesion, paso: "esperando_fecha" }); await enviarMensaje(chatId, "Escribe la fecha en formato <code>AAAA-MM-DD</code>. Ej: <code>2026-08-14</code>"); return { statusCode: 200, body: "ok" }; }
      await enviarMensaje(chatId, 'Responde "<code>sí</code>" para confirmar o "<code>cambiar</code>".');
      return { statusCode: 200, body: "ok" };
    }

    if (sesion.paso === "esperando_fecha") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bruto)) { await enviarMensaje(chatId, "Formato inválido. Usa <code>AAAA-MM-DD</code>."); return { statusCode: 200, body: "ok" }; }
      const d = new Date(bruto + "T12:00:00");
      if (d.getDay() !== 5) { await enviarMensaje(chatId, "⚠️ Esa fecha no es viernes. Escribe otra."); return { statusCode: 200, body: "ok" }; }
      if (await yaReportado(sesion.instalacion, bruto)) { await enviarMensaje(chatId, `⚠️ Ya hay resguardo para ${fechaBonita(bruto)}. Avísale a Efraín.`); await borrarSesion(chatId); return { statusCode: 200, body: "ok" }; }
      await guardarSesion(chatId, { ...sesion, fecha: bruto, paso: "confirmando" });
      await enviarMensaje(chatId, `Resguardo del <b>${fechaBonita(bruto)}</b>:\n\n${(sesion.seleccion || []).map((i) => `• ${els[i].nombre}`).join("\n")}\n\n¿Confirmas? "<code>sí</code>".`);
      return { statusCode: 200, body: "ok" };
    }

    if (sesion.paso === "seleccionando") {
      if (texto === "ok") {
        const seleccion = sesion.seleccion || [];
        if (!seleccion.length) { await enviarMensaje(chatId, "No has seleccionado a nadie. Escribe los números, o /cancelar."); return { statusCode: 200, body: "ok" }; }
        await guardarSesion(chatId, { ...sesion, paso: "confirmando" });
        await enviarMensaje(chatId, `Vas a registrar ${seleccion.length} resguardo(s) para <b>${fechaBonita(sesion.fecha)}</b>:\n\n${seleccion.map((i) => `• ${els[i].nombre}`).join("\n")}\n\n¿La fecha es correcta? "<code>sí</code>" para guardar, "<code>cambiar</code>" para otra fecha.`);
        return { statusCode: 200, body: "ok" };
      }
      const numeros = bruto.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
      if (!numeros.length) { await enviarMensaje(chatId, "Escribe números (ej: <code>1 3 5</code>) o <code>ok</code>."); return { statusCode: 200, body: "ok" }; }
      const invalidos = numeros.filter((n) => n < 1 || n > els.length);
      if (invalidos.length) { await enviarMensaje(chatId, `Fuera de rango: ${invalidos.join(", ")}. Válidos: 1 a ${els.length}.`); return { statusCode: 200, body: "ok" }; }
      const seleccion = new Set(sesion.seleccion || []);
      numeros.forEach((n) => { const i = n - 1; seleccion.has(i) ? seleccion.delete(i) : seleccion.add(i); });
      const nueva = [...seleccion].sort((a, b) => a - b);
      await guardarSesion(chatId, { ...sesion, seleccion: nueva });
      await enviarMensaje(chatId, pintarLista(sesion.instalacion, sesion.fecha, els, nueva));
      return { statusCode: 200, body: "ok" };
    }
  } catch (e) {
    console.error("Error:", e.message);
    await enviarMensaje(chatId, "Algo falló. Ya quedó en el log. Intenta de nuevo.");
  }

  return { statusCode: 200, body: "ok" };
};
