// netlify/functions/bot.js
// Bot v18: /turnos (coordinador) — resumen de turnos por instalación y día.
// Bot v17: Fallas (grupo + descripción, folio CFE en eléctricas), nacen abiertas,
//          se heredan hasta reparar; reporte /fallas para coordinador.
// Bot v16: /incidentes (coordinador) — elige estado (todos/abiertos/cerrados),
// rango de fechas, devuelve resumen + CSV.
// Bot v14: Incidentes (categoría grupo->tipo + descripción), nacen abiertos,
// se heredan turno tras turno; el jefe que hereda los cierra.
// Bot v13: agrega /faltas (solo coordinador) — reporte por rango de fechas,
// resumen en chat + CSV, marca lo exportado.
// Bot v12: corrige clave/nombre "undefined" en faltas.
// La sesión guarda solo índices (números) y motivos (strings) — arrays simples que
// Firestore sí serializa. Clave y nombre se sacan de `elementos` fresco al guardar.
// Bot v11: corrige el guardado de motivos (ya no usa índices como llaves de objeto).
// Bot v10: faltas con botones de motivo (Incapacitado / No avisó / Permiso / Otro)
// Bot v9:
//   - Todo lo de v8 (resguardo, /resumen, /exportar, /turno con iniciar/entregar)
//   - NUEVO: botón "Registrar faltas" dentro del turno en curso
//       · lista vigilantes numerados -> jefe escribe números -> motivo por cada uno
//       · guarda en colección `eventos` (tipo: falta)
//
// Colecciones: instalaciones, elementos, jefes_turno, sesiones, resguardos, turnos, eventos

const TOKEN = process.env.TELEGRAM_TOKEN;
const SECRET = process.env.TELEGRAM_SECRET;
const PROJECT = process.env.FIREBASE_PROJECT_ID;
const API_KEY = process.env.FIREBASE_API_KEY;
const COORDINADORES = (process.env.COORDINADOR_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

const TG = `https://api.telegram.org/bot${TOKEN}`;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// ============ Telegram ============

async function enviarMensaje(chatId, texto, extra = {}) {
  const res = await fetch(`${TG}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML", ...extra }) });
  if (!res.ok) console.error("sendMessage falló:", res.status, await res.text());
}
async function editarMensaje(chatId, messageId, texto, extra = {}) {
  const res = await fetch(`${TG}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: texto, parse_mode: "HTML", ...extra }) });
  if (!res.ok) console.error("editMessageText falló:", res.status, await res.text());
}
async function responderCallback(id, texto = "") {
  await fetch(`${TG}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id, text: texto }) });
}
async function enviarDocumento(chatId, nombreArchivo, contenido, caption = "") {
  const boundary = "----csv" + Date.now(); const partes = []; const push = (s) => partes.push(Buffer.from(s, "utf-8"));
  push(`--${boundary}\r\n`); push(`Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);
  if (caption) { push(`--${boundary}\r\n`); push(`Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`); }
  push(`--${boundary}\r\n`); push(`Content-Disposition: form-data; name="document"; filename="${nombreArchivo}"\r\n`); push(`Content-Type: text/csv; charset=utf-8\r\n\r\n`); push("\uFEFF" + contenido); push(`\r\n--${boundary}--\r\n`);
  const cuerpo = Buffer.concat(partes);
  const res = await fetch(`${TG}/sendDocument`, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(cuerpo.length) }, body: cuerpo });
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
  const res = await fetch(`${FS}:runQuery?key=${API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coleccion }], where: { fieldFilter: { field: { fieldPath: campo }, op: "EQUAL", value: { [tipoValor]: String(valor) } } } } }) });
  if (!res.ok) { console.error(`runQuery falló (${coleccion}):`, res.status); return []; }
  const data = await res.json();
  return data.filter((f) => f.document).map((f) => ({ id: f.document.name.split("/").pop(), ...planos(f.document.fields) }));
}
async function consultar2(coleccion, c1, v1, c2, v2) {
  const res = await fetch(`${FS}:runQuery?key=${API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coleccion }], where: { compositeFilter: { op: "AND", filters: [ { fieldFilter: { field: { fieldPath: c1 }, op: "EQUAL", value: { stringValue: String(v1) } } }, { fieldFilter: { field: { fieldPath: c2 }, op: "EQUAL", value: { stringValue: String(v2) } } } ] } } } }) });
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
  const res = await fetch(`${FS}/${coleccion}/${id}?key=${API_KEY}&${mask}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: aFirestore(obj) }) });
  if (!res.ok) console.error(`escribirDoc falló (${coleccion}/${id}):`, res.status, await res.text());
  return res.ok;
}
// Crea un doc con ID automático
async function crearDoc(coleccion, obj) {
  const res = await fetch(`${FS}/${coleccion}?key=${API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: aFirestore(obj) }) });
  if (!res.ok) console.error(`crearDoc falló (${coleccion}):`, res.status, await res.text());
  return res.ok;
}
async function borrarDoc(coleccion, id) { await fetch(`${FS}/${coleccion}/${id}?key=${API_KEY}`, { method: "DELETE" }); }

// Trae todos los documentos de una colección (paginado)
async function listar(coleccion) {
  const salida = []; let pageToken = "";
  do {
    const url = `${FS}/${coleccion}?key=${API_KEY}&pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) { console.error(`listar falló (${coleccion}):`, res.status); break; }
    const data = await res.json();
    (data.documents || []).forEach((d) => salida.push({ id: d.name.split("/").pop(), ...planos(d.fields) }));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return salida;
}

// ============ Dominio ============

const esCoordinador = (id) => COORDINADORES.includes(String(id));
const buscarJefe = async (telegramId) => (await consultar("jefes_turno", "telegram_id", telegramId, "integerValue"))[0] || null;
const elementosDe = async (instalacion) => (await consultar("elementos", "instalacion", instalacion)).filter((e) => e.activo !== false).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
async function yaReportado(instalacion, fecha) { const docs = await consultar("resguardos", "fecha", fecha); return docs.some((d) => d.instalacion === instalacion); }

function viernesDeEstaSemana() { const h = new Date(); h.setDate(h.getDate() - ((h.getDay() - 5 + 7) % 7)); return h.toISOString().split("T")[0]; }
function hoyISO() { return new Date().toISOString().split("T")[0]; }
function fechaBonita(iso) {
  const dias = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const d = new Date(iso + "T12:00:00"); return `${dias[d.getDay()]} ${d.getDate()} ${meses[d.getMonth()]}`;
}

const leerSesion = (chatId) => leerDoc("sesiones", String(chatId));
const guardarSesion = (chatId, datos) => escribirDoc("sesiones", String(chatId), datos);
const borrarSesion = (chatId) => borrarDoc("sesiones", String(chatId));

function pintarListaResguardo(instalacion, fecha, elementos, seleccion) {
  const items = elementos.map((e, i) => `${seleccion.includes(i) ? "✅" : "▫️"} ${i + 1}. ${e.nombre}`).join("\n");
  return `<b>${instalacion.toUpperCase()}</b> · Resguardo ${fechaBonita(fecha)}\n\n${items}\n\n<i>Escribe los números de quienes resguardaron (ej: <code>1 3 5</code>).\nCuando termines escribe <code>ok</code>.</i>`;
}

function csvCampo(v) { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
const INSTALACIONES_ACTIVAS = ["ceuta", "bellavista", "tayoltita", "caimanes", "campo-5"];

// ============ Turnos ============

const NOMBRE_TURNO = { manana: "Mañana", tarde: "Tarde", noche: "Noche" };
const idTurno = (instalacion, fecha, turno) => `${fecha}_${instalacion}_${turno}`;
async function turnoAbierto(instalacion) { const a = await consultar2("turnos", "instalacion", instalacion, "estado", "abierto"); return a[0] || null; }

const tecladoIniciar = { inline_keyboard: [
  [{ text: "🌅 Iniciar Mañana", callback_data: "turno_iniciar_manana" }],
  [{ text: "☀️ Iniciar Tarde", callback_data: "turno_iniciar_tarde" }],
  [{ text: "🌙 Iniciar Noche", callback_data: "turno_iniciar_noche" }],
] };

// Menú del turno en curso: ahora con Faltas
// Menú del turno en curso. Los viernes agrega el botón de Resguardo.
function tecladoEnCursoFn() {
  const esViernes = new Date().getDay() === 5;
  const filas = [
    [{ text: "👤 Registrar faltas", callback_data: "turno_faltas" }],
    [{ text: "⚠️ Registrar incidente", callback_data: "turno_incidente" }],
    [{ text: "📋 Incidentes pendientes", callback_data: "turno_pendientes" }],
    [{ text: "🔧 Registrar falla", callback_data: "turno_falla" }],
    [{ text: "🛠️ Fallas pendientes", callback_data: "turno_fallas_pend" }],
  ];
  if (esViernes) filas.push([{ text: "🔒 Resguardo de cajeros", callback_data: "turno_resguardo" }]);
  filas.push([{ text: "✅ Entregar reporte del turno", callback_data: "turno_finalizar" }]);
  return { inline_keyboard: filas };
}

const tecladoConfirmarCierre = { inline_keyboard: [
  [{ text: "Sí, entregar", callback_data: "turno_finalizar_si" }],
  [{ text: "No, seguir", callback_data: "turno_finalizar_no" }],
] };

const tecladoMotivo = { inline_keyboard: [
  [{ text: "🏥 Incapacitado", callback_data: "motivo_incapacitado" }],
  [{ text: "🚫 No avisó", callback_data: "motivo_no_aviso" }],
  [{ text: "📄 Permiso", callback_data: "motivo_permiso" }],
  [{ text: "✏️ Otro (escribir)", callback_data: "motivo_otro" }],
] };

const ETIQUETA_MOTIVO = { incapacitado: "Incapacitado", no_aviso: "No avisó", permiso: "Permiso" };

// ---- Categorías de incidente (grupo -> tipos) ----
const CATEGORIAS_INCIDENTE = {
  social: { nombre: "Problemática social", tipos: {
    conflicto: "Conflicto familiar o vecinal", consumo: "Consumo de alcohol o drogas", otro: "Otro",
  } },
  administrativa: { nombre: "Falta administrativa", tipos: {
    orden: "Alteración del orden", agresion: "Agresión física", otro: "Otro",
  } },
  delito: { nombre: "Delito", tipos: {
    robo: "Robo", lesiones: "Lesiones", otro: "Otro",
  } },
};

const tecladoGrupoIncidente = { inline_keyboard: [
  [{ text: "🟡 Problemática social", callback_data: "inc_grupo_social" }],
  [{ text: "🟠 Falta administrativa", callback_data: "inc_grupo_administrativa" }],
  [{ text: "🔴 Delito", callback_data: "inc_grupo_delito" }],
] };

function tecladoTipoIncidente(grupo) {
  const tipos = CATEGORIAS_INCIDENTE[grupo].tipos;
  return { inline_keyboard: Object.entries(tipos).map(([k, v]) => [{ text: v, callback_data: `inc_tipo_${grupo}_${k}` }]) };
}

// ---- Grupos de falla ----
const GRUPOS_FALLA = {
  electrica: "Eléctrica",
  cajero: "Cajero automático",
  instalacion: "Instalaciones (alumbrado, daños)",
  agua: "Fuga de agua (baños, tuberías)",
};

const tecladoGrupoFalla = { inline_keyboard: [
  [{ text: "⚡ Eléctrica", callback_data: "falla_grupo_electrica" }],
  [{ text: "🏧 Cajero automático", callback_data: "falla_grupo_cajero" }],
  [{ text: "🏚️ Instalaciones", callback_data: "falla_grupo_instalacion" }],
  [{ text: "💧 Fuga de agua", callback_data: "falla_grupo_agua" }],
] };

async function menuTurno(chatId, jefe, messageIdParaEditar = null) {
  const abierto = await turnoAbierto(jefe.instalacion);
  if (abierto) {
    // Contar faltas de este turno e incidentes pendientes de la instalación
    const faltas = await consultar("eventos", "turno_id", abierto.id);
    const nFaltas = faltas.filter((e) => e.tipo === "falta").length;
    const nPend = (await incidentesAbiertos(jefe.instalacion)).length;
    const nPendF = (await fallasAbiertas(jefe.instalacion)).length;
    const contadores = (nFaltas ? `Faltas registradas: <b>${nFaltas}</b>\n` : "") +
      (nPend ? `⚠️ Incidentes pendientes: <b>${nPend}</b>\n` : "") +
      (nPendF ? `🔧 Fallas pendientes: <b>${nPendF}</b>\n` : "");
    const texto = `<b>${jefe.instalacion.toUpperCase()}</b> · Turno <b>${NOMBRE_TURNO[abierto.turno]}</b> en curso\n${fechaBonita(abierto.fecha)}\n\n` +
      (contadores ? contadores + "\n" : "") + `¿Qué deseas hacer?`;
    if (messageIdParaEditar) await editarMensaje(chatId, messageIdParaEditar, texto, { reply_markup: tecladoEnCursoFn() });
    else await enviarMensaje(chatId, texto, { reply_markup: tecladoEnCursoFn() });
  } else {
    const texto = `<b>${jefe.instalacion.toUpperCase()}</b> · ${fechaBonita(hoyISO())}\n\n¿Qué turno vas a iniciar?`;
    if (messageIdParaEditar) await editarMensaje(chatId, messageIdParaEditar, texto, { reply_markup: tecladoIniciar });
    else await enviarMensaje(chatId, texto, { reply_markup: tecladoIniciar });
  }
}

async function iniciarTurno(chatId, jefe, turno, callbackId, messageId) {
  const abierto = await turnoAbierto(jefe.instalacion);
  if (abierto) {
    await responderCallback(callbackId, "Ya tienes un turno abierto");
    await editarMensaje(chatId, messageId, `⚠️ Ya tienes el turno <b>${NOMBRE_TURNO[abierto.turno]}</b> en curso.\nDebes entregarlo antes de iniciar otro.`, { reply_markup: tecladoEnCursoFn() });
    return;
  }
  const fecha = hoyISO(); const id = idTurno(jefe.instalacion, fecha, turno);
  const existente = await leerDoc("turnos", id);
  if (existente && existente.estado === "cerrado") {
    if (existente.fecha === fecha) {
      await escribirDoc("turnos", id, { estado: "abierto", reabierto_en: new Date().toISOString() });
      await responderCallback(callbackId, "Turno reabierto");
      await editarMensaje(chatId, messageId, `🔓 Turno <b>${NOMBRE_TURNO[turno]}</b> reabierto\n<b>${jefe.instalacion.toUpperCase()}</b> · ${fechaBonita(fecha)}\n\n¿Qué deseas hacer?`, { reply_markup: tecladoEnCursoFn() });
      return;
    } else {
      await responderCallback(callbackId, "Ese turno ya se cerró otro día");
      await editarMensaje(chatId, messageId, `⚠️ El turno <b>${NOMBRE_TURNO[turno]}</b> ya fue cerrado y no es de hoy. No se puede reabrir.`);
      return;
    }
  }
  await escribirDoc("turnos", id, { instalacion: jefe.instalacion, fecha, turno, estado: "abierto", jefe_abrio: jefe.nombre, abierto_en: new Date().toISOString() });
  await responderCallback(callbackId, "Turno iniciado");
  const pend = await incidentesAbiertos(jefe.instalacion);
  const pendF = await fallasAbiertas(jefe.instalacion);
  let avisoPend = "";
  if (pend.length) avisoPend += `\n\n⚠️ <b>${pend.length} incidente(s) pendiente(s)</b> del turno anterior.`;
  if (pendF.length) avisoPend += `\n🔧 <b>${pendF.length} falla(s) pendiente(s)</b> sin reparar.`;
  await editarMensaje(chatId, messageId, `✅ Turno <b>${NOMBRE_TURNO[turno]}</b> iniciado\n<b>${jefe.instalacion.toUpperCase()}</b> · ${fechaBonita(fecha)}${avisoPend}\n\n¿Qué deseas hacer?`, { reply_markup: tecladoEnCursoFn() });
}

async function pedirConfirmacionCierre(chatId, jefe, callbackId, messageId) {
  const abierto = await turnoAbierto(jefe.instalacion);
  if (!abierto) { await responderCallback(callbackId, "No hay turno abierto"); await editarMensaje(chatId, messageId, "No tienes ningún turno abierto."); return; }
  const faltas = (await consultar("eventos", "turno_id", abierto.id)).filter((e) => e.tipo === "falta");
  await responderCallback(callbackId);
  await editarMensaje(chatId, messageId,
    `Vas a entregar el reporte del turno <b>${NOMBRE_TURNO[abierto.turno]}</b>.\n\n` +
    `Faltas registradas: <b>${faltas.length}</b>\n\n` +
    `<i>Una vez entregado, solo podrás reabrirlo hoy mismo.</i>\n\n¿Confirmas?`,
    { reply_markup: tecladoConfirmarCierre });
}

async function finalizarTurno(chatId, jefe, callbackId, messageId) {
  const abierto = await turnoAbierto(jefe.instalacion);
  if (!abierto) { await responderCallback(callbackId, "No hay turno abierto"); await editarMensaje(chatId, messageId, "No tienes ningún turno abierto."); return; }
  const faltas = (await consultar("eventos", "turno_id", abierto.id)).filter((e) => e.tipo === "falta");
  await escribirDoc("turnos", abierto.id, { estado: "cerrado", jefe_cerro: jefe.nombre, cerrado_en: new Date().toISOString() });
  await responderCallback(callbackId, "Reporte entregado");
  await editarMensaje(chatId, messageId,
    `✅ Reporte del turno <b>${NOMBRE_TURNO[abierto.turno]}</b> entregado.\n<b>${jefe.instalacion.toUpperCase()}</b> · ${fechaBonita(abierto.fecha)}\n\n` +
    `Faltas: <b>${faltas.length}</b>\n\nGracias, ${jefe.nombre}.`);
}

// ---- Faltas ----

async function iniciarFaltas(chatId, jefe, callbackId, messageId) {
  const abierto = await turnoAbierto(jefe.instalacion);
  if (!abierto) { await responderCallback(callbackId, "No hay turno abierto"); return; }
  const els = await elementosDe(jefe.instalacion);
  await guardarSesion(chatId, { flujo: "faltas", turno_id: abierto.id, instalacion: jefe.instalacion, paso: "seleccionando_faltas" });
  await responderCallback(callbackId);
  const lista = els.map((e, i) => `${i + 1}. ${e.nombre}`).join("\n");
  await editarMensaje(chatId, messageId,
    `<b>Registrar faltas</b> · ${jefe.instalacion.toUpperCase()}\n\n${lista}\n\n` +
    `<i>Escribe los números de quienes faltaron (ej: <code>2 5</code>).\nSi no faltó nadie, escribe <code>ninguno</code>.</i>`);
}

// Pide el motivo de la falta en la posición actual (sesion.pos), con botones.
// El nombre se saca de `els` (fresco), no de la sesión.
async function pedirMotivo(chatId, sesion, els) {
  const idx = sesion.indices[sesion.pos];
  await enviarMensaje(chatId, `Motivo de la falta de <b>${els[idx].nombre}</b>:`, { reply_markup: tecladoMotivo });
}

// Recibe el motivo elegido por botón
async function recibirMotivoBoton(chatId, jefe, data, callbackId) {
  const sesion = await leerSesion(chatId);
  if (!sesion || sesion.flujo !== "faltas" || sesion.paso !== "motivo") { await responderCallback(callbackId); return; }
  const els = await elementosDe(sesion.instalacion);
  const clave = data.replace("motivo_", "");

  if (clave === "otro") {
    await responderCallback(callbackId);
    await guardarSesion(chatId, { ...sesion, paso: "esperando_motivo_otro" });
    const idx = sesion.indices[sesion.pos];
    await enviarMensaje(chatId, `Escribe el motivo de <b>${els[idx].nombre}</b>:`);
    return;
  }

  const motivos = (sesion.motivos || []).slice();
  motivos[sesion.pos] = ETIQUETA_MOTIVO[clave] || clave;
  await responderCallback(callbackId, ETIQUETA_MOTIVO[clave]);
  await avanzarMotivo(chatId, jefe, { ...sesion, motivos }, els);
}

// Avanza a la siguiente falta o guarda todo si ya no quedan
async function avanzarMotivo(chatId, jefe, sesion, els) {
  const siguiente = sesion.pos + 1;

  if (siguiente < sesion.indices.length) {
    const nueva = { ...sesion, pos: siguiente, paso: "motivo" };
    await guardarSesion(chatId, nueva);
    await pedirMotivo(chatId, nueva, els);
    return;
  }

  // Guardar cada falta, sacando clave y nombre de `els` fresco por su índice
  const resumenLineas = [];
  for (let i = 0; i < sesion.indices.length; i++) {
    const el = els[sesion.indices[i]];
    const motivo = (sesion.motivos || [])[i] || "";
    await crearDoc("eventos", {
      tipo: "falta", turno_id: sesion.turno_id, instalacion: sesion.instalacion,
      clave: el.clave, nombre: el.nombre, motivo,
      reportado_por: jefe.nombre, fecha: hoyISO(), creado_en: new Date().toISOString(), exportado: false,
    });
    resumenLineas.push(`• ${el.nombre} — ${motivo}`);
  }
  await borrarSesion(chatId);
  await enviarMensaje(chatId, `✅ Faltas registradas:\n\n${resumenLineas.join("\n")}`);
  await menuTurno(chatId, jefe);
}

// ---- Incidentes ----

// Trae los incidentes abiertos de una instalación
async function incidentesAbiertos(instalacion) {
  return await consultar2("eventos_inc", "instalacion", instalacion, "estado", "abierto");
}

// Inicia el registro de un incidente: elegir grupo
async function iniciarIncidente(chatId, jefe, callbackId, messageId) {
  const abierto = await turnoAbierto(jefe.instalacion);
  if (!abierto) { await responderCallback(callbackId, "No hay turno abierto"); return; }
  await guardarSesion(chatId, { flujo: "incidente", turno_id: abierto.id, instalacion: jefe.instalacion, paso: "grupo" });
  await responderCallback(callbackId);
  await editarMensaje(chatId, messageId, `<b>Registrar incidente</b>\n\n¿Qué tipo de incidente?`, { reply_markup: tecladoGrupoIncidente });
}

// Recibe el grupo elegido -> muestra tipos
async function incidenteGrupo(chatId, jefe, grupo, callbackId, messageId) {
  const sesion = await leerSesion(chatId);
  if (!sesion || sesion.flujo !== "incidente") { await responderCallback(callbackId); return; }
  await guardarSesion(chatId, { ...sesion, grupo, paso: "tipo" });
  await responderCallback(callbackId);
  await editarMensaje(chatId, messageId, `<b>${CATEGORIAS_INCIDENTE[grupo].nombre}</b>\n\n¿Qué específicamente?`, { reply_markup: tecladoTipoIncidente(grupo) });
}

// Recibe el tipo -> pide descripción
async function incidenteTipo(chatId, jefe, grupo, tipo, callbackId, messageId) {
  const sesion = await leerSesion(chatId);
  if (!sesion || sesion.flujo !== "incidente") { await responderCallback(callbackId); return; }
  await guardarSesion(chatId, { ...sesion, grupo, tipo, paso: "descripcion" });
  await responderCallback(callbackId);
  const nombreTipo = CATEGORIAS_INCIDENTE[grupo].tipos[tipo];
  await editarMensaje(chatId, messageId, `<b>${CATEGORIAS_INCIDENTE[grupo].nombre} · ${nombreTipo}</b>\n\nDescribe qué pasó:`);
}

// Guarda el incidente (nace abierto)
async function guardarIncidente(chatId, jefe, descripcion) {
  const sesion = await leerSesion(chatId);
  if (!sesion || sesion.flujo !== "incidente") return;
  const grupoNombre = CATEGORIAS_INCIDENTE[sesion.grupo].nombre;
  const tipoNombre = CATEGORIAS_INCIDENTE[sesion.grupo].tipos[sesion.tipo];
  await crearDoc("eventos_inc", {
    instalacion: sesion.instalacion, turno_id_origen: sesion.turno_id,
    grupo: grupoNombre, tipo: tipoNombre, descripcion,
    estado: "abierto", reportado_por: jefe.nombre,
    fecha: hoyISO(), creado_en: new Date().toISOString(),
  });
  await borrarSesion(chatId);
  await enviarMensaje(chatId, `✅ Incidente registrado (queda <b>abierto</b>):\n\n<b>${grupoNombre} · ${tipoNombre}</b>\n${descripcion}`);
  await menuTurno(chatId, jefe);
}

// Muestra los incidentes pendientes con botón para cerrar cada uno
async function verPendientes(chatId, jefe, callbackId, messageId) {
  const abiertos = await incidentesAbiertos(jefe.instalacion);
  if (callbackId) await responderCallback(callbackId);
  if (!abiertos.length) {
    const texto = `<b>${jefe.instalacion.toUpperCase()}</b>\n\nNo hay incidentes pendientes. 👍`;
    if (messageId) await editarMensaje(chatId, messageId, texto, { reply_markup: tecladoEnCursoFn() });
    else await enviarMensaje(chatId, texto);
    return;
  }
  let texto = `<b>Incidentes pendientes</b> · ${jefe.instalacion.toUpperCase()}\n\n`;
  const botones = [];
  abiertos.forEach((inc, i) => {
    texto += `${i + 1}. <b>${inc.grupo} · ${inc.tipo}</b>\n${inc.descripcion}\n<i>Desde ${fechaBonita(inc.fecha)}, reportó ${inc.reportado_por}</i>\n\n`;
    botones.push([{ text: `✅ Cerrar #${i + 1}`, callback_data: `inc_cerrar_${inc.id}` }]);
  });
  botones.push([{ text: "« Volver", callback_data: "turno_volver" }]);
  if (messageId) await editarMensaje(chatId, messageId, texto, { reply_markup: { inline_keyboard: botones } });
  else await enviarMensaje(chatId, texto, { reply_markup: { inline_keyboard: botones } });
}

// Cierra un incidente por su id
async function cerrarIncidente(chatId, jefe, incId, callbackId, messageId) {
  await escribirDoc("eventos_inc", incId, { estado: "cerrado", cerrado_por: jefe.nombre, cerrado_en: new Date().toISOString() });
  await responderCallback(callbackId, "Incidente cerrado");
  await verPendientes(chatId, jefe, null, messageId);
}

// Inicia el flujo de resguardo desde el botón del turno (solo viernes)
async function iniciarResguardoDesdeBoton(chatId, jefe, callbackId, messageId) {
  const fecha = viernesDeEstaSemana();
  if (await yaReportado(jefe.instalacion, fecha)) {
    await responderCallback(callbackId, "Ya reportado");
    await editarMensaje(chatId, messageId, `⚠️ Ya se reportó el resguardo de <b>${jefe.instalacion.toUpperCase()}</b> para el ${fechaBonita(fecha)}.`);
    return;
  }
  const els = await elementosDe(jefe.instalacion);
  await guardarSesion(chatId, { flujo: "resguardo", instalacion: jefe.instalacion, fecha, seleccion: [], paso: "seleccionando" });
  await responderCallback(callbackId);
  await editarMensaje(chatId, messageId, pintarListaResguardo(jefe.instalacion, fecha, els, []));
}

// ---- Fallas ----

async function fallasAbiertas(instalacion) {
  return await consultar2("fallas", "instalacion", instalacion, "estado", "abierto");
}

// Inicia registro de falla: elegir grupo
async function iniciarFalla(chatId, jefe, callbackId, messageId) {
  const abierto = await turnoAbierto(jefe.instalacion);
  if (!abierto) { await responderCallback(callbackId, "No hay turno abierto"); return; }
  await guardarSesion(chatId, { flujo: "falla", turno_id: abierto.id, instalacion: jefe.instalacion, paso: "falla_grupo" });
  await responderCallback(callbackId);
  await editarMensaje(chatId, messageId, `<b>Registrar falla</b>\n\n¿De qué tipo?`, { reply_markup: tecladoGrupoFalla });
}

// Recibe el grupo -> si es eléctrica pide folio CFE, si no pide descripción
async function fallaGrupo(chatId, jefe, grupo, callbackId, messageId) {
  const sesion = await leerSesion(chatId);
  if (!sesion || sesion.flujo !== "falla") { await responderCallback(callbackId); return; }
  await responderCallback(callbackId);
  if (grupo === "electrica") {
    await guardarSesion(chatId, { ...sesion, grupo, paso: "falla_folio" });
    await editarMensaje(chatId, messageId, `<b>${GRUPOS_FALLA[grupo]}</b>\n\nEscribe el <b>folio CFE</b> del reporte.\nSi no tienes folio, escribe <code>sin folio</code>.`);
  } else {
    await guardarSesion(chatId, { ...sesion, grupo, folio: "", paso: "falla_descripcion" });
    await editarMensaje(chatId, messageId, `<b>${GRUPOS_FALLA[grupo]}</b>\n\nDescribe la falla:`);
  }
}

// Guarda la falla (nace abierta)
async function guardarFalla(chatId, jefe, sesion, descripcion) {
  await crearDoc("fallas", {
    instalacion: sesion.instalacion, turno_id_origen: sesion.turno_id,
    grupo: GRUPOS_FALLA[sesion.grupo], folio_cfe: sesion.folio || "",
    descripcion, estado: "abierto", reportado_por: jefe.nombre,
    fecha: hoyISO(), creado_en: new Date().toISOString(),
  });
  await borrarSesion(chatId);
  const folioTxt = sesion.folio ? `\nFolio CFE: <b>${sesion.folio}</b>` : "";
  await enviarMensaje(chatId, `✅ Falla registrada (queda <b>abierta</b>):\n\n<b>${GRUPOS_FALLA[sesion.grupo]}</b>${folioTxt}\n${descripcion}`);
  await menuTurno(chatId, jefe);
}

// Ver fallas pendientes con botón para marcar reparada
async function verFallasPendientes(chatId, jefe, callbackId, messageId) {
  const abiertas = await fallasAbiertas(jefe.instalacion);
  if (callbackId) await responderCallback(callbackId);
  if (!abiertas.length) {
    const texto = `<b>${jefe.instalacion.toUpperCase()}</b>\n\nNo hay fallas pendientes. 👍`;
    if (messageId) await editarMensaje(chatId, messageId, texto, { reply_markup: tecladoEnCursoFn() });
    else await enviarMensaje(chatId, texto);
    return;
  }
  let texto = `<b>Fallas pendientes</b> · ${jefe.instalacion.toUpperCase()}\n\n`;
  const botones = [];
  abiertas.forEach((f, i) => {
    const folioTxt = f.folio_cfe ? ` (CFE: ${f.folio_cfe})` : "";
    texto += `${i + 1}. <b>${f.grupo}</b>${folioTxt}\n${f.descripcion}\n<i>Desde ${fechaBonita(f.fecha)}, reportó ${f.reportado_por}</i>\n\n`;
    botones.push([{ text: `🛠️ Reparada #${i + 1}`, callback_data: `falla_cerrar_${f.id}` }]);
  });
  botones.push([{ text: "« Volver", callback_data: "turno_volver" }]);
  if (messageId) await editarMensaje(chatId, messageId, texto, { reply_markup: { inline_keyboard: botones } });
  else await enviarMensaje(chatId, texto, { reply_markup: { inline_keyboard: botones } });
}

async function cerrarFalla(chatId, jefe, fallaId, callbackId, messageId) {
  await escribirDoc("fallas", fallaId, { estado: "cerrado", reparada_por: jefe.nombre, reparada_en: new Date().toISOString() });
  await responderCallback(callbackId, "Falla marcada como reparada");
  await verFallasPendientes(chatId, jefe, null, messageId);
}

// ============ /exportar y /resumen ============

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
  for (const inst of INSTALACIONES_ACTIVAS) { if (porInst[inst]) rep.push(`✅ ${inst.toUpperCase()}: ${porInst[inst].total} (${porInst[inst].quien})`); else falt.push(`❌ ${inst.toUpperCase()}: sin reporte`); }
  let msg = `<b>Resumen de resguardos</b>\n${fechaBonita(fecha)}\n\n`;
  if (rep.length) msg += rep.join("\n") + "\n"; if (falt.length) msg += "\n" + falt.join("\n") + "\n";
  msg += `\n<b>${rep.length} de ${INSTALACIONES_ACTIVAS.length}</b> instalaciones reportaron.`;
  await enviarMensaje(chatId, msg);
}

// Genera el reporte de faltas de un rango de fechas: resumen en chat + CSV
async function reporteFaltas(chatId, desde, hasta) {
  // Traer todas las faltas y filtrar por rango (fecha es AAAA-MM-DD, comparación de strings sirve)
  const todas = await consultar("eventos", "tipo", "falta");
  const enRango = todas.filter((f) => f.fecha >= desde && f.fecha <= hasta)
    .sort((a, b) => (a.fecha + a.nombre).localeCompare(b.fecha + b.nombre, "es"));

  if (!enRango.length) {
    await enviarMensaje(chatId, `No hay faltas registradas entre ${fechaBonita(desde)} y ${fechaBonita(hasta)}.`);
    return;
  }

  // Resumen en chat: agrupado por instalación
  const porInst = {};
  enRango.forEach((f) => { (porInst[f.instalacion] = porInst[f.instalacion] || []).push(f); });
  let msg = `<b>Faltas</b> · ${fechaBonita(desde)} a ${fechaBonita(hasta)}\n\n`;
  for (const inst of Object.keys(porInst).sort()) {
    msg += `<b>${inst.toUpperCase()}</b>\n`;
    porInst[inst].forEach((f) => { msg += `• ${f.nombre} — ${f.motivo} (${fechaBonita(f.fecha)})\n`; });
    msg += "\n";
  }
  msg += `Total: <b>${enRango.length}</b> falta(s).`;
  await enviarMensaje(chatId, msg);

  // CSV para copiar al formato de RH
  const csv = [
    ["CLAVE", "NOMBRE", "FECHA", "MOTIVO", "INSTALACION"].join(","),
    ...enRango.map((f) => [f.clave, f.nombre, f.fecha, f.motivo, f.instalacion].map(csvCampo).join(",")),
  ].join("\r\n");
  await enviarDocumento(chatId, `faltas_${desde}_a_${hasta}.csv`, csv, "Faltas para RH");
}

// Reporte de incidentes por rango y estado: resumen en chat + CSV
async function reporteIncidentes(chatId, estado, desde, hasta) {
  const inc = (await listar("eventos_inc"))
    .filter((x) => x.fecha >= desde && x.fecha <= hasta)
    .filter((x) => estado === "todos" ? true : x.estado === estado)
    .sort((a, b) => (a.fecha + a.instalacion).localeCompare(b.fecha + b.instalacion, "es"));

  const etiquetaEstado = { todos: "Todos", abierto: "Abiertos", cerrado: "Cerrados" }[estado];

  if (!inc.length) {
    await enviarMensaje(chatId, `No hay incidentes (${etiquetaEstado.toLowerCase()}) entre ${fechaBonita(desde)} y ${fechaBonita(hasta)}.`);
    return;
  }

  // Resumen agrupado por instalación
  const porInst = {};
  inc.forEach((x) => { (porInst[x.instalacion] = porInst[x.instalacion] || []).push(x); });
  let msg = `<b>Incidentes · ${etiquetaEstado}</b>\n${fechaBonita(desde)} a ${fechaBonita(hasta)}\n\n`;
  for (const instk of Object.keys(porInst).sort()) {
    msg += `<b>${instk.toUpperCase()}</b>\n`;
    porInst[instk].forEach((x) => {
      const marca = x.estado === "abierto" ? "🔴" : "✅";
      msg += `${marca} ${x.grupo} · ${x.tipo}\n   ${x.descripcion}\n   <i>${fechaBonita(x.fecha)}, ${x.reportado_por}${x.estado === "cerrado" && x.cerrado_por ? ` — cerró ${x.cerrado_por}` : ""}</i>\n`;
    });
    msg += "\n";
  }
  msg += `Total: <b>${inc.length}</b> incidente(s).`;
  // Telegram limita mensajes a ~4096 chars; si es largo, mandamos aviso y solo CSV
  if (msg.length > 3800) {
    await enviarMensaje(chatId, `<b>Incidentes · ${etiquetaEstado}</b>\n${fechaBonita(desde)} a ${fechaBonita(hasta)}\n\nSon <b>${inc.length}</b> incidentes, demasiados para mostrar aquí. Te mando el CSV con el detalle.`);
  } else {
    await enviarMensaje(chatId, msg);
  }

  const csv = [
    ["FECHA", "INSTALACION", "GRUPO", "TIPO", "DESCRIPCION", "ESTADO", "REPORTO", "CERRO"].join(","),
    ...inc.map((x) => [x.fecha, x.instalacion, x.grupo, x.tipo, x.descripcion, x.estado, x.reportado_por, x.cerrado_por || ""].map(csvCampo).join(",")),
  ].join("\r\n");
  await enviarDocumento(chatId, `incidentes_${estado}_${desde}_a_${hasta}.csv`, csv, "Incidentes");
}

// Reporte de fallas por rango y estado: resumen + CSV
async function reporteFallas(chatId, estado, desde, hasta) {
  const fallas = (await listar("fallas"))
    .filter((x) => x.fecha >= desde && x.fecha <= hasta)
    .filter((x) => estado === "todos" ? true : x.estado === estado)
    .sort((a, b) => (a.fecha + a.instalacion).localeCompare(b.fecha + b.instalacion, "es"));

  const etiquetaEstado = { todos: "Todas", abierto: "Abiertas", cerrado: "Reparadas" }[estado];

  if (!fallas.length) {
    await enviarMensaje(chatId, `No hay fallas (${etiquetaEstado.toLowerCase()}) entre ${fechaBonita(desde)} y ${fechaBonita(hasta)}.`);
    return;
  }

  const porInst = {};
  fallas.forEach((x) => { (porInst[x.instalacion] = porInst[x.instalacion] || []).push(x); });
  let msg = `<b>Fallas · ${etiquetaEstado}</b>\n${fechaBonita(desde)} a ${fechaBonita(hasta)}\n\n`;
  for (const instk of Object.keys(porInst).sort()) {
    msg += `<b>${instk.toUpperCase()}</b>\n`;
    porInst[instk].forEach((x) => {
      const marca = x.estado === "abierto" ? "🔧" : "✅";
      const folio = x.folio_cfe ? ` [CFE ${x.folio_cfe}]` : "";
      msg += `${marca} ${x.grupo}${folio}\n   ${x.descripcion}\n   <i>${fechaBonita(x.fecha)}, ${x.reportado_por}${x.estado === "cerrado" && x.reparada_por ? ` — reparó ${x.reparada_por}` : ""}</i>\n`;
    });
    msg += "\n";
  }
  msg += `Total: <b>${fallas.length}</b> falla(s).`;
  if (msg.length > 3800) await enviarMensaje(chatId, `<b>Fallas · ${etiquetaEstado}</b>\n${fechaBonita(desde)} a ${fechaBonita(hasta)}\n\nSon <b>${fallas.length}</b> fallas, demasiadas para mostrar aquí. Te mando el CSV.`);
  else await enviarMensaje(chatId, msg);

  const csv = [
    ["FECHA", "INSTALACION", "GRUPO", "FOLIO_CFE", "DESCRIPCION", "ESTADO", "REPORTO", "REPARO"].join(","),
    ...fallas.map((x) => [x.fecha, x.instalacion, x.grupo, x.folio_cfe || "", x.descripcion, x.estado, x.reportado_por, x.reparada_por || ""].map(csvCampo).join(",")),
  ].join("\r\n");
  await enviarDocumento(chatId, `fallas_${estado}_${desde}_a_${hasta}.csv`, csv, "Fallas");
}

// Resumen de turnos de una instalación en un día
async function reporteTurnos(chatId, instalacion, fecha) {
  const turnos = (await listar("turnos"))
    .filter((t) => t.instalacion === instalacion && t.fecha === fecha)
    .sort((a, b) => ({ manana: 0, tarde: 1, noche: 2 }[a.turno] - { manana: 0, tarde: 1, noche: 2 }[b.turno]));

  if (!turnos.length) {
    await enviarMensaje(chatId, `No hay turnos registrados en <b>${instalacion.toUpperCase()}</b> el ${fechaBonita(fecha)}.`);
    return;
  }

  // Datos del día para esa instalación (una sola lectura de cada colección)
  const faltasDia = (await listar("eventos")).filter((e) => e.tipo === "falta" && e.instalacion === instalacion && e.fecha === fecha);
  const incDia = (await listar("eventos_inc")).filter((x) => x.instalacion === instalacion && x.fecha === fecha);
  const fallasDia = (await listar("fallas")).filter((x) => x.instalacion === instalacion && x.fecha === fecha);

  let msg = `<b>Turnos · ${instalacion.toUpperCase()}</b>\n${fechaBonita(fecha)}\n\n`;
  for (const t of turnos) {
    const faltasT = faltasDia.filter((f) => f.turno_id === t.id);
    const incT = incDia.filter((x) => x.turno_id_origen === t.id);
    const fallasT = fallasDia.filter((x) => x.turno_id_origen === t.id);
    const estadoT = t.estado === "cerrado" ? "✅ Entregado" : "🟡 En curso";
    msg += `<b>${NOMBRE_TURNO[t.turno]}</b> — ${estadoT}\n`;
    msg += `Abrió: ${t.jefe_abrio || "?"}`;
    if (t.jefe_cerro) msg += ` · Entregó: ${t.jefe_cerro}`;
    msg += `\n`;
    msg += `Faltas: ${faltasT.length} · Incidentes: ${incT.length} · Fallas: ${fallasT.length}\n`;
    // Detalle breve de incidentes y fallas (por ser lo relevante)
    incT.forEach((x) => { msg += `   ⚠️ ${x.tipo}: ${x.descripcion}\n`; });
    fallasT.forEach((x) => { msg += `   🔧 ${x.grupo}: ${x.descripcion}\n`; });
    msg += `\n`;
  }
  msg += `<i>Para el detalle completo usa /faltas, /incidentes o /fallas.</i>`;

  if (msg.length > 3900) {
    // Si es muy largo, recortar el detalle
    let corto = `<b>Turnos · ${instalacion.toUpperCase()}</b>\n${fechaBonita(fecha)}\n\n`;
    for (const t of turnos) {
      const faltasT = faltasDia.filter((f) => f.turno_id === t.id).length;
      const incT = incDia.filter((x) => x.turno_id_origen === t.id).length;
      const fallasT = fallasDia.filter((x) => x.turno_id_origen === t.id).length;
      const estadoT = t.estado === "cerrado" ? "✅" : "🟡";
      corto += `${estadoT} <b>${NOMBRE_TURNO[t.turno]}</b> — Abrió ${t.jefe_abrio || "?"}${t.jefe_cerro ? `, entregó ${t.jefe_cerro}` : ""}\n   Faltas ${faltasT} · Incidentes ${incT} · Fallas ${fallasT}\n\n`;
    }
    await enviarMensaje(chatId, corto);
  } else {
    await enviarMensaje(chatId, msg);
  }
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
      // Botones de reporte de incidentes (coordinador) — antes del guard de jefe
      if (data.startsWith("rep_inc_")) {
        if (!esCoordinador(telegramId)) { await responderCallback(cq.id, "Solo coordinador"); return { statusCode: 200, body: "ok" }; }
        const estado = data.replace("rep_inc_", "");
        await guardarSesion(chatId, { flujo: "inc_reporte", estado, paso: "inc_desde" });
        await responderCallback(cq.id);
        await editarMensaje(chatId, messageId, `<b>Reporte de incidentes</b>\n\nEscribe la fecha <b>desde</b> (<code>AAAA-MM-DD</code>). Ej: <code>2026-08-01</code>`);
        return { statusCode: 200, body: "ok" };
      }
      if (data.startsWith("rep_falla_")) {
        if (!esCoordinador(telegramId)) { await responderCallback(cq.id, "Solo coordinador"); return { statusCode: 200, body: "ok" }; }
        const estado = data.replace("rep_falla_", "");
        await guardarSesion(chatId, { flujo: "falla_reporte", estado, paso: "falla_rep_desde" });
        await responderCallback(cq.id);
        await editarMensaje(chatId, messageId, `<b>Reporte de fallas</b>\n\nEscribe la fecha <b>desde</b> (<code>AAAA-MM-DD</code>). Ej: <code>2026-08-01</code>`);
        return { statusCode: 200, body: "ok" };
      }
      if (data.startsWith("rep_turnos_")) {
        if (!esCoordinador(telegramId)) { await responderCallback(cq.id, "Solo coordinador"); return { statusCode: 200, body: "ok" }; }
        const inst = data.replace("rep_turnos_", "");
        await guardarSesion(chatId, { flujo: "turnos_reporte", instalacion: inst, paso: "turnos_fecha" });
        await responderCallback(cq.id);
        await editarMensaje(chatId, messageId, `<b>${inst.toUpperCase()}</b>\n\n¿De qué día? Escribe la fecha (<code>AAAA-MM-DD</code>).\nEj: <code>${hoyISO()}</code> (hoy)`);
        return { statusCode: 200, body: "ok" };
      }

      const jefe = await buscarJefe(telegramId);
      if (!jefe) { await responderCallback(cq.id, "No estás dado de alta"); return { statusCode: 200, body: "ok" }; }
      if (data === "turno_iniciar_manana") await iniciarTurno(chatId, jefe, "manana", cq.id, messageId);
      else if (data === "turno_iniciar_tarde") await iniciarTurno(chatId, jefe, "tarde", cq.id, messageId);
      else if (data === "turno_iniciar_noche") await iniciarTurno(chatId, jefe, "noche", cq.id, messageId);
      else if (data === "turno_faltas") await iniciarFaltas(chatId, jefe, cq.id, messageId);
      else if (data.startsWith("motivo_")) await recibirMotivoBoton(chatId, jefe, data, cq.id);
      else if (data === "turno_incidente") await iniciarIncidente(chatId, jefe, cq.id, messageId);
      else if (data.startsWith("inc_grupo_")) await incidenteGrupo(chatId, jefe, data.replace("inc_grupo_", ""), cq.id, messageId);
      else if (data.startsWith("inc_tipo_")) { const p = data.replace("inc_tipo_", "").split("_"); await incidenteTipo(chatId, jefe, p[0], p[1], cq.id, messageId); }
      else if (data === "turno_pendientes") await verPendientes(chatId, jefe, cq.id, messageId);
      else if (data.startsWith("inc_cerrar_")) await cerrarIncidente(chatId, jefe, data.replace("inc_cerrar_", ""), cq.id, messageId);
      else if (data === "turno_volver") { await responderCallback(cq.id); await menuTurno(chatId, jefe, messageId); }
      else if (data === "turno_resguardo") await iniciarResguardoDesdeBoton(chatId, jefe, cq.id, messageId);
      else if (data === "turno_falla") await iniciarFalla(chatId, jefe, cq.id, messageId);
      else if (data.startsWith("falla_grupo_")) await fallaGrupo(chatId, jefe, data.replace("falla_grupo_", ""), cq.id, messageId);
      else if (data === "turno_fallas_pend") await verFallasPendientes(chatId, jefe, cq.id, messageId);
      else if (data.startsWith("falla_cerrar_")) await cerrarFalla(chatId, jefe, data.replace("falla_cerrar_", ""), cq.id, messageId);
      else if (data === "turno_finalizar") await pedirConfirmacionCierre(chatId, jefe, cq.id, messageId);
      else if (data === "turno_finalizar_si") await finalizarTurno(chatId, jefe, cq.id, messageId);
      else if (data === "turno_finalizar_no") { await responderCallback(cq.id, "Turno sigue abierto"); await menuTurno(chatId, jefe, messageId); }
      else await responderCallback(cq.id);
    } catch (e) { console.error("Error callback:", e.message); await responderCallback(cq.id, "Algo falló"); }
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
    if (texto.startsWith("/resumen")) { if (!esCoordinador(telegramId)) { await enviarMensaje(chatId, "Este comando es solo para el coordinador."); return { statusCode: 200, body: "ok" }; } await resumen(chatId); return { statusCode: 200, body: "ok" }; }
    if (texto.startsWith("/exportar")) { if (!esCoordinador(telegramId)) { await enviarMensaje(chatId, "Este comando es solo para el coordinador."); return { statusCode: 200, body: "ok" }; } await exportar(chatId); return { statusCode: 200, body: "ok" }; }

    if (texto.startsWith("/faltas")) {
      if (!esCoordinador(telegramId)) { await enviarMensaje(chatId, "Este comando es solo para el coordinador."); return { statusCode: 200, body: "ok" }; }
      await guardarSesion(chatId, { flujo: "faltas_reporte", paso: "faltas_desde" });
      await enviarMensaje(chatId, "<b>Reporte de faltas para RH</b>\n\nEscribe la fecha <b>desde</b> (formato <code>AAAA-MM-DD</code>).\nEj: <code>2026-08-01</code>");
      return { statusCode: 200, body: "ok" };
    }

    if (texto.startsWith("/incidentes")) {
      if (!esCoordinador(telegramId)) { await enviarMensaje(chatId, "Este comando es solo para el coordinador."); return { statusCode: 200, body: "ok" }; }
      await enviarMensaje(chatId, "<b>Reporte de incidentes</b>\n\n¿Cuáles quieres ver?", { reply_markup: { inline_keyboard: [
        [{ text: "Todos", callback_data: "rep_inc_todos" }],
        [{ text: "🔴 Solo abiertos", callback_data: "rep_inc_abierto" }],
        [{ text: "✅ Solo cerrados", callback_data: "rep_inc_cerrado" }],
      ] } });
      return { statusCode: 200, body: "ok" };
    }

    if (texto.startsWith("/fallas")) {
      if (!esCoordinador(telegramId)) { await enviarMensaje(chatId, "Este comando es solo para el coordinador."); return { statusCode: 200, body: "ok" }; }
      await enviarMensaje(chatId, "<b>Reporte de fallas</b>\n\n¿Cuáles quieres ver?", { reply_markup: { inline_keyboard: [
        [{ text: "Todas", callback_data: "rep_falla_todos" }],
        [{ text: "🔧 Solo abiertas", callback_data: "rep_falla_abierto" }],
        [{ text: "✅ Solo reparadas", callback_data: "rep_falla_cerrado" }],
      ] } });
      return { statusCode: 200, body: "ok" };
    }

    if (texto.startsWith("/turnos")) {
      if (!esCoordinador(telegramId)) { await enviarMensaje(chatId, "Este comando es solo para el coordinador."); return { statusCode: 200, body: "ok" }; }
      await enviarMensaje(chatId, "<b>Resumen de turnos</b>\n\n¿De qué instalación?", { reply_markup: { inline_keyboard:
        INSTALACIONES_ACTIVAS.map((i) => [{ text: i.toUpperCase(), callback_data: `rep_turnos_${i}` }]),
      } });
      return { statusCode: 200, body: "ok" };
    }

    if (!jefe && !esCoordinador(telegramId)) { await enviarMensaje(chatId, "No estás dado de alta. Usa /start y envía tu ID a Efraín."); return { statusCode: 200, body: "ok" }; }

    const sesionCoord = await leerSesion(chatId);

    // Flujo de resumen de turnos (coordinador): capturar día
    if (sesionCoord && sesionCoord.flujo === "turnos_reporte") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bruto)) { await enviarMensaje(chatId, "Formato inválido. Usa <code>AAAA-MM-DD</code>."); return { statusCode: 200, body: "ok" }; }
      await borrarSesion(chatId);
      await reporteTurnos(chatId, sesionCoord.instalacion, bruto);
      return { statusCode: 200, body: "ok" };
    }

    // Flujo de reporte de fallas (coordinador): capturar rango
    if (sesionCoord && sesionCoord.flujo === "falla_reporte") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bruto)) { await enviarMensaje(chatId, "Formato inválido. Usa <code>AAAA-MM-DD</code>."); return { statusCode: 200, body: "ok" }; }
      if (sesionCoord.paso === "falla_rep_desde") {
        await guardarSesion(chatId, { ...sesionCoord, desde: bruto, paso: "falla_rep_hasta" });
        await enviarMensaje(chatId, `Desde: <b>${fechaBonita(bruto)}</b>\n\nAhora la fecha <b>hasta</b> (<code>AAAA-MM-DD</code>).`);
        return { statusCode: 200, body: "ok" };
      }
      if (sesionCoord.paso === "falla_rep_hasta") {
        const desde = sesionCoord.desde, hasta = bruto, estado = sesionCoord.estado;
        if (hasta < desde) { await enviarMensaje(chatId, "La fecha 'hasta' es anterior a 'desde'. Escribe una válida."); return { statusCode: 200, body: "ok" }; }
        await borrarSesion(chatId);
        await reporteFallas(chatId, estado, desde, hasta);
        return { statusCode: 200, body: "ok" };
      }
    }

    // Flujo de reporte de incidentes (coordinador): capturar rango
    if (sesionCoord && sesionCoord.flujo === "inc_reporte") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bruto)) { await enviarMensaje(chatId, "Formato inválido. Usa <code>AAAA-MM-DD</code>."); return { statusCode: 200, body: "ok" }; }
      if (sesionCoord.paso === "inc_desde") {
        await guardarSesion(chatId, { ...sesionCoord, desde: bruto, paso: "inc_hasta" });
        await enviarMensaje(chatId, `Desde: <b>${fechaBonita(bruto)}</b>\n\nAhora la fecha <b>hasta</b> (<code>AAAA-MM-DD</code>).`);
        return { statusCode: 200, body: "ok" };
      }
      if (sesionCoord.paso === "inc_hasta") {
        const desde = sesionCoord.desde, hasta = bruto, estado = sesionCoord.estado;
        if (hasta < desde) { await enviarMensaje(chatId, "La fecha 'hasta' es anterior a 'desde'. Escribe una válida."); return { statusCode: 200, body: "ok" }; }
        await borrarSesion(chatId);
        await reporteIncidentes(chatId, estado, desde, hasta);
        return { statusCode: 200, body: "ok" };
      }
    }

    // Flujo de reporte de faltas (coordinador): capturar rango de fechas
    if (sesionCoord && sesionCoord.flujo === "faltas_reporte") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bruto)) { await enviarMensaje(chatId, "Formato inválido. Usa <code>AAAA-MM-DD</code>."); return { statusCode: 200, body: "ok" }; }
      if (sesionCoord.paso === "faltas_desde") {
        await guardarSesion(chatId, { ...sesionCoord, desde: bruto, paso: "faltas_hasta" });
        await enviarMensaje(chatId, `Desde: <b>${fechaBonita(bruto)}</b>\n\nAhora la fecha <b>hasta</b> (<code>AAAA-MM-DD</code>).`);
        return { statusCode: 200, body: "ok" };
      }
      if (sesionCoord.paso === "faltas_hasta") {
        const desde = sesionCoord.desde, hasta = bruto;
        if (hasta < desde) { await enviarMensaje(chatId, "La fecha 'hasta' es anterior a 'desde'. Escribe una fecha válida."); return { statusCode: 200, body: "ok" }; }
        await borrarSesion(chatId);
        await reporteFaltas(chatId, desde, hasta);
        return { statusCode: 200, body: "ok" };
      }
    }

    // A partir de aquí se requiere ser jefe (tener instalación). Un coordinador sin
    // registro de jefe solo puede usar /resumen, /exportar y /faltas (ya manejados arriba).
    if (!jefe) { await enviarMensaje(chatId, "Como coordinador puedes usar /resumen, /exportar y /faltas."); return { statusCode: 200, body: "ok" }; }

    if (texto.startsWith("/turno")) { await menuTurno(chatId, jefe); return { statusCode: 200, body: "ok" }; }
    if (texto.startsWith("/cancelar")) { await borrarSesion(chatId); await enviarMensaje(chatId, "Operación cancelada."); return { statusCode: 200, body: "ok" }; }

    if (texto.startsWith("/resguardo")) {
      const fecha = viernesDeEstaSemana();
      if (await yaReportado(jefe.instalacion, fecha)) { await enviarMensaje(chatId, `⚠️ Ya se reportó el resguardo de <b>${jefe.instalacion.toUpperCase()}</b> para el ${fechaBonita(fecha)}.\n\nSi hubo un error, avísale a Efraín.`); return { statusCode: 200, body: "ok" }; }
      const els = await elementosDe(jefe.instalacion);
      await guardarSesion(chatId, { flujo: "resguardo", instalacion: jefe.instalacion, fecha, seleccion: [], paso: "seleccionando" });
      await enviarMensaje(chatId, pintarListaResguardo(jefe.instalacion, fecha, els, []));
      return { statusCode: 200, body: "ok" };
    }

    const sesion = await leerSesion(chatId);
    if (!sesion || !sesion.paso) { await enviarMensaje(chatId, "Usa /turno o /resguardo para comenzar."); return { statusCode: 200, body: "ok" }; }

    // ===== Flujo de FALLA =====
    if (sesion.flujo === "falla") {
      if (sesion.paso === "falla_folio") {
        const folio = texto === "sin folio" ? "" : bruto;
        await guardarSesion(chatId, { ...sesion, folio, paso: "falla_descripcion" });
        await enviarMensaje(chatId, `${folio ? `Folio: <b>${folio}</b>\n\n` : ""}Ahora describe la falla:`);
        return { statusCode: 200, body: "ok" };
      }
      if (sesion.paso === "falla_descripcion") {
        if (bruto.length < 3) { await enviarMensaje(chatId, "Escribe una descripción un poco más completa."); return { statusCode: 200, body: "ok" }; }
        await guardarFalla(chatId, jefe, sesion, bruto);
        return { statusCode: 200, body: "ok" };
      }
    }

    // ===== Flujo de INCIDENTE (descripción por texto) =====
    if (sesion.flujo === "incidente" && sesion.paso === "descripcion") {
      if (bruto.length < 3) { await enviarMensaje(chatId, "Escribe una descripción un poco más completa."); return { statusCode: 200, body: "ok" }; }
      await guardarIncidente(chatId, jefe, bruto);
      return { statusCode: 200, body: "ok" };
    }

    // ===== Flujo de FALTAS =====
    if (sesion.flujo === "faltas") {
      const els = await elementosDe(sesion.instalacion);

      if (sesion.paso === "seleccionando_faltas") {
        if (texto === "ninguno") {
          await borrarSesion(chatId);
          await enviarMensaje(chatId, "✅ Sin faltas registradas en este turno.");
          await menuTurno(chatId, jefe);
          return { statusCode: 200, body: "ok" };
        }
        const numeros = bruto.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
        if (!numeros.length) { await enviarMensaje(chatId, "Escribe números (ej: <code>2 5</code>) o <code>ninguno</code>."); return { statusCode: 200, body: "ok" }; }
        const invalidos = numeros.filter((n) => n < 1 || n > els.length);
        if (invalidos.length) { await enviarMensaje(chatId, `Fuera de rango: ${invalidos.join(", ")}. Válidos: 1 a ${els.length}.`); return { statusCode: 200, body: "ok" }; }
        // Guardar SOLO índices (números) y un array de motivos vacío — arrays simples que Firestore serializa bien
        const indices = [...new Set(numeros.map((n) => n - 1))].sort((a, b) => a - b);
        const nueva = { ...sesion, indices, motivos: [], pos: 0, paso: "motivo" };
        await guardarSesion(chatId, nueva);
        await enviarMensaje(chatId, `Vas a registrar ${indices.length} falta(s). Elige el motivo de cada uno:`);
        await pedirMotivo(chatId, nueva, els);
        return { statusCode: 200, body: "ok" };
      }

      // Al paso motivo por texto solo se llega si eligió "Otro"
      if (sesion.paso === "esperando_motivo_otro") {
        const motivos = (sesion.motivos || []).slice();
        motivos[sesion.pos] = bruto;
        await avanzarMotivo(chatId, jefe, { ...sesion, motivos, paso: "motivo" }, els);
        return { statusCode: 200, body: "ok" };
      }
    }

    // ===== Flujo de RESGUARDO =====
    if (sesion.flujo === "resguardo" || !sesion.flujo) {
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
        await enviarMensaje(chatId, pintarListaResguardo(sesion.instalacion, sesion.fecha, els, nueva));
        return { statusCode: 200, body: "ok" };
      }
    }
  } catch (e) {
    console.error("Error:", e.message);
    await enviarMensaje(chatId, "Algo falló. Ya quedó en el log. Intenta de nuevo.");
  }

  return { statusCode: 200, body: "ok" };
};
