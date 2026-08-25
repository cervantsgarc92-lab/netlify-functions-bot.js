// netlify/functions/bot.js
// Bot v7:
//   - Resguardo (v6) intacto: /resguardo, /exportar
//   - NUEVO: /resumen como comando (solo coordinador)
//   - NUEVO: esqueleto de /turno con botones inline (abrir turno: mañana/tarde/noche)
//
// Colecciones:
//   instalaciones, elementos, jefes_turno   (catálogos)
//   sesiones      (estado del flujo /resguardo)
//   resguardos    (registro final de resguardos)
//   turnos        (turnos abiertos/cerrados)   <-- nueva

const TOKEN = process.env.TELEGRAM_TOKEN;
const SECRET = process.env.TELEGRAM_SECRET;
const PROJECT = process.env.FIREBASE_PROJECT_ID;
const API_KEY = process.env.FIREBASE_API_KEY;
const COORDINADORES = (process.env.COORDINADOR_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const TG = `https://api.telegram.org/bot${TOKEN}`;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// ============ Telegram ============

async function enviarMensaje(chatId, texto, extra = {}) {
  const res = await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML", ...extra }),
  });
  if (!res.ok) console.error("sendMessage falló:", res.status, await res.text());
}

async function editarMensaje(chatId, messageId, texto, extra = {}) {
  const res = await fetch(`${TG}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: texto, parse_mode: "HTML", ...extra }),
  });
  if (!res.ok) console.error("editMessageText falló:", res.status, await res.text());
}

// Responde el "reloj de carga" de un botón inline (obligatorio para que Telegram no lo deje girando)
async function responderCallback(callbackId, texto = "") {
  await fetch(`${TG}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text: texto }),
  });
}

// Envía un documento (CSV) al chat
async function enviarDocumento(chatId, nombreArchivo, contenido, caption = "") {
  const boundary = "----csv" + Date.now();
  const partes = [];
  const push = (s) => partes.push(Buffer.from(s, "utf-8"));
  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);
  if (caption) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`);
  }
  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="document"; filename="${nombreArchivo}"\r\n`);
  push(`Content-Type: text/csv; charset=utf-8\r\n\r\n`);
  push("\uFEFF" + contenido);
  push(`\r\n--${boundary}--\r\n`);
  const cuerpo = Buffer.concat(partes);
  const res = await fetch(`${TG}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(cuerpo.length) },
    body: cuerpo,
  });
  if (!res.ok) console.error("sendDocument falló:", res.status, await res.text());
  return res.ok;
}

// ============ Firestore: formato ============

function planos(fields = {}) {
  const s = {};
  for (const [k, env] of Object.entries(fields)) {
    const t = Object.keys(env)[0];
    let v = env[t];
    if (t === "integerValue") v = parseInt(v, 10);
    else if (t === "arrayValue") v = (v.values || []).map((x) => {
      const tt = Object.keys(x)[0];
      return tt === "integerValue" ? parseInt(x[tt], 10) : x[tt];
    });
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

// ============ Firestore: operaciones ============

async function consultar(coleccion, campo, valor, tipoValor = "stringValue") {
  const res = await fetch(`${FS}:runQuery?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: coleccion }],
        where: { fieldFilter: { field: { fieldPath: campo }, op: "EQUAL", value: { [tipoValor]: String(valor) } } },
      },
    }),
  });
  if (!res.ok) { console.error(`runQuery falló (${coleccion}):`, res.status); return []; }
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
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
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

const buscarJefe = async (telegramId) =>
  (await consultar("jefes_turno", "telegram_id", telegramId, "integerValue"))[0] || null;

const elementosDe = async (instalacion) =>
  (await consultar("elementos", "instalacion", instalacion))
    .filter((e) => e.activo !== false)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

async function yaReportado(instalacion, fecha) {
  const docs = await consultar("resguardos", "fecha", fecha);
  return docs.some((d) => d.instalacion === instalacion);
}

function viernesDeEstaSemana() {
  const hoy = new Date();
  const diff = (hoy.getDay() - 5 + 7) % 7;
  hoy.setDate(hoy.getDate() - diff);
  return hoy.toISOString().split("T")[0];
}

function hoyISO() {
  return new Date().toISOString().split("T")[0];
}

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
  return `<b>${instalacion.toUpperCase()}</b> · Resguardo ${fechaBonita(fecha)}\n\n${items}\n\n` +
    `<i>Escribe los números de quienes resguardaron (ej: <code>1 3 5</code>).\nCuando termines escribe <code>ok</code>.</i>`;
}

function csvCampo(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const INSTALACIONES_ACTIVAS = ["ceuta", "bellavista", "tayoltita", "caimanes", "campo-5"];

// ============ /exportar ============

async function exportar(chatId) {
  const pendientes = (await consultar("resguardos", "exportado", false, "booleanValue"))
    .sort((a, b) => (a.fecha + a.clave).localeCompare(b.fecha + b.clave));
  if (!pendientes.length) { await enviarMensaje(chatId, "No hay resguardos pendientes de exportar."); return; }

  const encabezado = ["CLAVE", "NOMBRE", "FECHA", "INSTALACION"];
  const filas = pendientes.map((r) => [r.clave, r.nombre, r.fecha, r.instalacion].map(csvCampo).join(","));
  const csv = [encabezado.join(","), ...filas].join("\r\n");

  const fechas = [...new Set(pendientes.map((r) => r.fecha))].sort();
  const nombre = `resguardos_${fechas[0]}_a_${fechas[fechas.length - 1]}.csv`;
  const ok = await enviarDocumento(chatId, nombre, csv, "Resguardos pendientes");
  if (!ok) { await enviarMensaje(chatId, "No pude generar el archivo. Revisa el log."); return; }

  for (const r of pendientes) {
    await escribirDoc("resguardos", r.id, { exportado: true, exportado_en: new Date().toISOString() });
  }
  await enviarMensaje(chatId, `✅ Exportado y marcado. ${pendientes.length} resguardo(s).`);
}

// ============ /resumen ============

async function resumen(chatId) {
  const fecha = viernesDeEstaSemana();
  const resguardos = await consultar("resguardos", "fecha", fecha);

  const porInst = {};
  resguardos.forEach((r) => {
    porInst[r.instalacion] = porInst[r.instalacion] || { total: 0, quien: r.reportado_por };
    porInst[r.instalacion].total++;
  });

  const reportaron = [], faltaron = [];
  for (const inst of INSTALACIONES_ACTIVAS) {
    if (porInst[inst]) reportaron.push(`✅ ${inst.toUpperCase()}: ${porInst[inst].total} (${porInst[inst].quien})`);
    else faltaron.push(`❌ ${inst.toUpperCase()}: sin reporte`);
  }

  let msg = `<b>Resumen de resguardos</b>\n${fechaBonita(fecha)}\n\n`;
  if (reportaron.length) msg += reportaron.join("\n") + "\n";
  if (faltaron.length) msg += "\n" + faltaron.join("\n") + "\n";
  msg += `\n<b>${reportaron.length} de ${INSTALACIONES_ACTIVAS.length}</b> instalaciones reportaron.`;
  await enviarMensaje(chatId, msg);
}

// ============ /turno (esqueleto - hito 1) ============

// Teclado para elegir el turno
const tecladoTurno = {
  inline_keyboard: [
    [{ text: "🌅 Mañana", callback_data: "turno_abrir_manana" }],
    [{ text: "☀️ Tarde", callback_data: "turno_abrir_tarde" }],
    [{ text: "🌙 Noche", callback_data: "turno_abrir_noche" }],
  ],
};

const NOMBRE_TURNO = { manana: "Mañana", tarde: "Tarde", noche: "Noche" };

// ID del turno: fecha_instalacion_turno (uno por instalación/turno/día)
const idTurno = (instalacion, fecha, turno) => `${fecha}_${instalacion}_${turno}`;

async function abrirTurno(chatId, jefe, turno, callbackId, messageId) {
  const fecha = hoyISO();
  const id = idTurno(jefe.instalacion, fecha, turno);

  const existente = await leerDoc("turnos", id);
  if (existente && existente.estado === "abierto") {
    await responderCallback(callbackId, "Ese turno ya está abierto");
    await editarMensaje(chatId, messageId,
      `⚠️ El turno <b>${NOMBRE_TURNO[turno]}</b> de <b>${jefe.instalacion.toUpperCase()}</b> ya está abierto.`);
    return;
  }
  if (existente && existente.estado === "cerrado") {
    await responderCallback(callbackId, "Ese turno ya se cerró");
    await editarMensaje(chatId, messageId,
      `⚠️ El turno <b>${NOMBRE_TURNO[turno]}</b> de hoy ya fue cerrado. No se puede reabrir.`);
    return;
  }

  await escribirDoc("turnos", id, {
    instalacion: jefe.instalacion,
    fecha,
    turno,
    estado: "abierto",
    jefe_abrio: jefe.nombre,
    abierto_en: new Date().toISOString(),
  });

  await responderCallback(callbackId, "Turno abierto");
  await editarMensaje(chatId, messageId,
    `✅ Turno <b>${NOMBRE_TURNO[turno]}</b> abierto\n` +
    `<b>${jefe.instalacion.toUpperCase()}</b> · ${fechaBonita(fecha)}\n\n` +
    `<i>Durante el turno podrás registrar reportes.\nAl terminar, usa /turno y elige Cerrar turno.\n\n` +
    `(El cierre y sus reportes vienen en el siguiente paso.)</i>`);
}

// ============ Handler ============

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "Bot vivo" };
  if (SECRET && event.headers["x-telegram-bot-api-secret-token"] !== SECRET) {
    return { statusCode: 401, body: "no autorizado" };
  }

  let update;
  try { update = JSON.parse(event.body || "{}"); } catch { return { statusCode: 200, body: "ok" }; }

  // ---------- Botones inline (callback_query) ----------
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    const telegramId = cq.from.id;
    const data = cq.data || "";

    try {
      const jefe = await buscarJefe(telegramId);
      if (!jefe) {
        await responderCallback(cq.id, "No estás dado de alta");
        return { statusCode: 200, body: "ok" };
      }

      if (data === "turno_abrir_manana") await abrirTurno(chatId, jefe, "manana", cq.id, messageId);
      else if (data === "turno_abrir_tarde") await abrirTurno(chatId, jefe, "tarde", cq.id, messageId);
      else if (data === "turno_abrir_noche") await abrirTurno(chatId, jefe, "noche", cq.id, messageId);
      else await responderCallback(cq.id);
    } catch (e) {
      console.error("Error callback:", e.message);
      await responderCallback(cq.id, "Algo falló");
    }
    return { statusCode: 200, body: "ok" };
  }

  // ---------- Mensajes de texto ----------
  const msg = update.message;
  if (!msg || !msg.text) return { statusCode: 200, body: "ok" };

  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const bruto = msg.text.trim();
  const texto = bruto.toLowerCase();

  try {
    const jefe = await buscarJefe(telegramId);

    // /start
    if (texto.startsWith("/start")) {
      const extra = esCoordinador(telegramId) ? "\n\n(Coordinador: /resumen y /exportar)" : "";
      if (jefe) {
        const els = await elementosDe(jefe.instalacion);
        await enviarMensaje(chatId,
          `Hola ${jefe.nombre}.\n\nInstalación: <b>${jefe.instalacion.toUpperCase()}</b>\n` +
          `Elementos: <b>${els.length}</b>\n\nComandos: /resguardo · /turno${extra}`);
      } else {
        await enviarMensaje(chatId,
          `Hola ${msg.from.first_name || ""}.\n\nTu ID: <code>${telegramId}</code>\n\n` +
          `Envíaselo a Efraín para que te dé de alta.${extra}`);
      }
      return { statusCode: 200, body: "ok" };
    }

    // /resumen (coordinador)
    if (texto.startsWith("/resumen")) {
      if (!esCoordinador(telegramId)) { await enviarMensaje(chatId, "Este comando es solo para el coordinador."); return { statusCode: 200, body: "ok" }; }
      await resumen(chatId);
      return { statusCode: 200, body: "ok" };
    }

    // /exportar (coordinador)
    if (texto.startsWith("/exportar")) {
      if (!esCoordinador(telegramId)) { await enviarMensaje(chatId, "Este comando es solo para el coordinador."); return { statusCode: 200, body: "ok" }; }
      await exportar(chatId);
      return { statusCode: 200, body: "ok" };
    }

    if (!jefe) {
      await enviarMensaje(chatId, "No estás dado de alta. Usa /start y envía tu ID a Efraín.");
      return { statusCode: 200, body: "ok" };
    }

    // /turno (esqueleto: por ahora solo abrir)
    if (texto.startsWith("/turno")) {
      await enviarMensaje(chatId,
        `<b>${jefe.instalacion.toUpperCase()}</b> · ${fechaBonita(hoyISO())}\n\n` +
        `¿Qué turno vas a abrir?`,
        { reply_markup: tecladoTurno });
      return { statusCode: 200, body: "ok" };
    }

    // /cancelar (resguardo)
    if (texto.startsWith("/cancelar")) {
      await borrarSesion(chatId);
      await enviarMensaje(chatId, "Resguardo cancelado. Usa /resguardo para empezar de nuevo.");
      return { statusCode: 200, body: "ok" };
    }

    // /resguardo
    if (texto.startsWith("/resguardo")) {
      const fecha = viernesDeEstaSemana();
      if (await yaReportado(jefe.instalacion, fecha)) {
        await enviarMensaje(chatId, `⚠️ Ya se reportó el resguardo de <b>${jefe.instalacion.toUpperCase()}</b> para el ${fechaBonita(fecha)}.\n\nSi hubo un error, avísale a Efraín.`);
        return { statusCode: 200, body: "ok" };
      }
      const els = await elementosDe(jefe.instalacion);
      await guardarSesion(chatId, { instalacion: jefe.instalacion, fecha, seleccion: [], paso: "seleccionando" });
      await enviarMensaje(chatId, pintarLista(jefe.instalacion, fecha, els, []));
      return { statusCode: 200, body: "ok" };
    }

    // Dentro del flujo de resguardo
    const sesion = await leerSesion(chatId);
    if (!sesion || !sesion.paso) {
      await enviarMensaje(chatId, "Usa /resguardo o /turno para comenzar.");
      return { statusCode: 200, body: "ok" };
    }
    const els = await elementosDe(sesion.instalacion);

    if (sesion.paso === "confirmando") {
      if (texto === "si" || texto === "sí" || texto === "ok") {
        for (const idx of (sesion.seleccion || [])) {
          const el = els[idx]; if (!el) continue;
          await escribirDoc("resguardos", `${sesion.fecha}_${el.clave}`, {
            instalacion: sesion.instalacion, clave: el.clave, nombre: el.nombre, fecha: sesion.fecha,
            reportado_por: jefe.nombre, reportado_en: new Date().toISOString(), exportado: false,
          });
        }
        await borrarSesion(chatId);
        await enviarMensaje(chatId, `✅ Resguardo guardado.\n\n<b>${sesion.instalacion.toUpperCase()}</b> · ${fechaBonita(sesion.fecha)}\nElementos: <b>${(sesion.seleccion || []).length}</b>\n\nGracias, ${jefe.nombre}.`);
        return { statusCode: 200, body: "ok" };
      }
      if (texto === "cambiar" || texto === "cambiar fecha") {
        await guardarSesion(chatId, { ...sesion, paso: "esperando_fecha" });
        await enviarMensaje(chatId, "Escribe la fecha en formato <code>AAAA-MM-DD</code>. Ej: <code>2026-08-14</code>");
        return { statusCode: 200, body: "ok" };
      }
      await enviarMensaje(chatId, 'Responde "<code>sí</code>" para confirmar o "<code>cambiar</code>".');
      return { statusCode: 200, body: "ok" };
    }

    if (sesion.paso === "esperando_fecha") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bruto)) { await enviarMensaje(chatId, "Formato inválido. Usa <code>AAAA-MM-DD</code>."); return { statusCode: 200, body: "ok" }; }
      const d = new Date(bruto + "T12:00:00");
      if (d.getDay() !== 5) { await enviarMensaje(chatId, "⚠️ Esa fecha no es viernes. Escribe otra."); return { statusCode: 200, body: "ok" }; }
      if (await yaReportado(sesion.instalacion, bruto)) { await enviarMensaje(chatId, `⚠️ Ya hay resguardo para ${fechaBonita(bruto)}. Avísale a Efraín.`); await borrarSesion(chatId); return { statusCode: 200, body: "ok" }; }
      await guardarSesion(chatId, { ...sesion, fecha: bruto, paso: "confirmando" });
      const nombres = (sesion.seleccion || []).map((i) => `• ${els[i].nombre}`).join("\n");
      await enviarMensaje(chatId, `Resguardo del <b>${fechaBonita(bruto)}</b>:\n\n${nombres}\n\n¿Confirmas? "<code>sí</code>".`);
      return { statusCode: 200, body: "ok" };
    }

    if (sesion.paso === "seleccionando") {
      if (texto === "ok") {
        const seleccion = sesion.seleccion || [];
        if (!seleccion.length) { await enviarMensaje(chatId, "No has seleccionado a nadie. Escribe los números, o /cancelar."); return { statusCode: 200, body: "ok" }; }
        await guardarSesion(chatId, { ...sesion, paso: "confirmando" });
        const nombres = seleccion.map((i) => `• ${els[i].nombre}`).join("\n");
        await enviarMensaje(chatId, `Vas a registrar ${seleccion.length} resguardo(s) para <b>${fechaBonita(sesion.fecha)}</b>:\n\n${nombres}\n\n¿La fecha es correcta? "<code>sí</code>" para guardar, "<code>cambiar</code>" para otra fecha.`);
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
