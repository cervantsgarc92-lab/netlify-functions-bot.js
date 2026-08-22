// netlify/functions/bot.js
// Hito 5: agrega /exportar (solo coordinador) sobre el flujo de resguardo del Hito 4.
//
// Colecciones:
//   instalaciones, elementos, jefes_turno  (catálogos)
//   sesiones     (estado temporal del flujo /resguardo)
//   resguardos   (registro final: un doc por fecha+clave; campo "exportado")

const TOKEN = process.env.TELEGRAM_TOKEN;
const SECRET = process.env.TELEGRAM_SECRET;
const PROJECT = process.env.FIREBASE_PROJECT_ID;
const API_KEY = process.env.FIREBASE_API_KEY;

// IDs de Telegram con permiso de coordinador (separados por coma en la variable)
const COORDINADORES = (process.env.COORDINADOR_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

// Envía un archivo (documento) al chat
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
  push("\uFEFF" + contenido); // BOM para que Excel respete acentos
  push(`\r\n--${boundary}--\r\n`);

  const cuerpo = Buffer.concat(partes);
  const res = await fetch(`${TG}/sendDocument`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(cuerpo.length),
    },
    body: cuerpo,
  });
  if (!res.ok) console.error("sendDocument falló:", res.status, await res.text());
  return res.ok;
}

// ============ Firestore: formato ============

function planos(fields = {}) {
  const salida = {};
  for (const [clave, envoltorio] of Object.entries(fields)) {
    const tipo = Object.keys(envoltorio)[0];
    let valor = envoltorio[tipo];
    if (tipo === "integerValue") valor = parseInt(valor, 10);
    else if (tipo === "arrayValue") {
      valor = (valor.values || []).map((v) => {
        const t = Object.keys(v)[0];
        return t === "integerValue" ? parseInt(v[t], 10) : v[t];
      });
    }
    salida[clave] = valor;
  }
  return salida;
}

function aFirestore(obj) {
  const fields = {};
  for (const [clave, valor] of Object.entries(obj)) {
    if (typeof valor === "boolean") fields[clave] = { booleanValue: valor };
    else if (typeof valor === "number" && Number.isInteger(valor))
      fields[clave] = { integerValue: String(valor) };
    else if (Array.isArray(valor))
      fields[clave] = {
        arrayValue: {
          values: valor.map((v) =>
            Number.isInteger(v) ? { integerValue: String(v) } : { stringValue: String(v) }
          ),
        },
      };
    else fields[clave] = { stringValue: String(valor) };
  }
  return fields;
}

// ============ Firestore: operaciones ============

async function consultar(coleccion, campo, valor, tipoValor = "stringValue") {
  const res = await fetch(`${FS}:runQuery?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: coleccion }],
        where: {
          fieldFilter: {
            field: { fieldPath: campo },
            op: "EQUAL",
            value: { [tipoValor]: String(valor) },
          },
        },
      },
    }),
  });
  if (!res.ok) {
    console.error(`runQuery falló (${coleccion}):`, res.status, await res.text());
    return [];
  }
  const data = await res.json();
  return data
    .filter((f) => f.document)
    .map((f) => ({ id: f.document.name.split("/").pop(), ...planos(f.document.fields) }));
}

// Trae toda una colección (paginada)
async function listar(coleccion) {
  const salida = [];
  let pageToken = "";
  do {
    const url = `${FS}/${coleccion}?key=${API_KEY}&pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`listar falló (${coleccion}):`, res.status);
      break;
    }
    const data = await res.json();
    (data.documents || []).forEach((d) =>
      salida.push({ id: d.name.split("/").pop(), ...planos(d.fields) })
    );
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return salida;
}

async function leerDoc(coleccion, id) {
  const res = await fetch(`${FS}/${coleccion}/${id}?key=${API_KEY}`);
  if (!res.ok) return null;
  const doc = await res.json();
  return doc.fields ? { id, ...planos(doc.fields) } : null;
}

async function escribirDoc(coleccion, id, obj) {
  const mask = Object.keys(obj)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");
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

const esCoordinador = (telegramId) => COORDINADORES.includes(String(telegramId));

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
  const items = elementos
    .map((e, i) => `${seleccion.includes(i) ? "✅" : "▫️"} ${i + 1}. ${e.nombre}`)
    .join("\n");
  return (
    `<b>${instalacion.toUpperCase()}</b> · Resguardo ${fechaBonita(fecha)}\n\n` +
    items +
    `\n\n<i>Escribe los números de quienes resguardaron (ej: <code>1 3 5</code>).\n` +
    `Cuando termines escribe <code>ok</code>.</i>`
  );
}

// Escapa un campo para CSV
function csvCampo(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ============ /exportar ============

async function exportar(chatId) {
  const pendientes = (await consultar("resguardos", "exportado", false, "booleanValue"))
    .sort((a, b) => (a.fecha + a.clave).localeCompare(b.fecha + b.clave));

  if (!pendientes.length) {
    await enviarMensaje(chatId, "No hay resguardos pendientes de exportar.");
    return;
  }

  // CSV: columnas que copiarás a tu formato de pagos
  const encabezado = ["CLAVE", "NOMBRE", "FECHA", "INSTALACION"];
  const filas = pendientes.map((r) =>
    [r.clave, r.nombre, r.fecha, r.instalacion].map(csvCampo).join(",")
  );
  const csv = [encabezado.join(","), ...filas].join("\r\n");

  // Resumen por fecha e instalación
  const fechas = [...new Set(pendientes.map((r) => r.fecha))].sort();
  const porInst = {};
  pendientes.forEach((r) => (porInst[r.instalacion] = (porInst[r.instalacion] || 0) + 1));
  const resumen =
    `Resguardos: <b>${pendientes.length}</b>\n` +
    `Fechas: ${fechas.map(fechaBonita).join(", ")}\n` +
    Object.entries(porInst)
      .map(([i, n]) => `• ${i.toUpperCase()}: ${n}`)
      .join("\n");

  const nombre = `resguardos_${fechas[0]}_a_${fechas[fechas.length - 1]}.csv`;
  const ok = await enviarDocumento(chatId, nombre, csv, "Resguardos pendientes");

  if (!ok) {
    await enviarMensaje(chatId, "No pude generar el archivo. Revisa el log.");
    return;
  }

  // Marcar como exportado
  for (const r of pendientes) {
    await escribirDoc("resguardos", r.id, { exportado: true, exportado_en: new Date().toISOString() });
  }

  await enviarMensaje(chatId, `✅ Exportado y marcado.\n\n${resumen}`);
}

// ============ Handler ============

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "Bot vivo" };
  if (SECRET && event.headers["x-telegram-bot-api-secret-token"] !== SECRET) {
    return { statusCode: 401, body: "no autorizado" };
  }

  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 200, body: "ok" };
  }

  const msg = update.message;
  if (!msg || !msg.text) return { statusCode: 200, body: "ok" };

  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const bruto = msg.text.trim();
  const texto = bruto.toLowerCase();

  try {
    const jefe = await buscarJefe(telegramId);

    // ---- /start ----
    if (texto.startsWith("/start")) {
      const rolExtra = esCoordinador(telegramId) ? "\n\n(Coordinador: puedes usar /exportar)" : "";
      if (jefe) {
        const elementos = await elementosDe(jefe.instalacion);
        await enviarMensaje(
          chatId,
          `Hola ${jefe.nombre}.\n\n` +
            `Instalación: <b>${jefe.instalacion.toUpperCase()}</b>\n` +
            `Elementos: <b>${elementos.length}</b>\n\n` +
            `Usa /resguardo para reportar.${rolExtra}`
        );
      } else {
        await enviarMensaje(
          chatId,
          `Hola ${msg.from.first_name || ""}.\n\n` +
            `Tu ID: <code>${telegramId}</code>\n\n` +
            `Envíaselo a Efraín para que te dé de alta.${rolExtra}`
        );
      }
      return { statusCode: 200, body: "ok" };
    }

    // ---- /exportar (solo coordinador) ----
    if (texto.startsWith("/exportar")) {
      if (!esCoordinador(telegramId)) {
        await enviarMensaje(chatId, "Este comando es solo para el coordinador.");
        return { statusCode: 200, body: "ok" };
      }
      await exportar(chatId);
      return { statusCode: 200, body: "ok" };
    }

    if (!jefe) {
      await enviarMensaje(chatId, "No estás dado de alta. Usa /start y envía tu ID a Efraín.");
      return { statusCode: 200, body: "ok" };
    }

    // ---- /cancelar ----
    if (texto.startsWith("/cancelar")) {
      await borrarSesion(chatId);
      await enviarMensaje(chatId, "Resguardo cancelado. Usa /resguardo para empezar de nuevo.");
      return { statusCode: 200, body: "ok" };
    }

    // ---- /resguardo ----
    if (texto.startsWith("/resguardo")) {
      const fecha = viernesDeEstaSemana();
      if (await yaReportado(jefe.instalacion, fecha)) {
        await enviarMensaje(
          chatId,
          `⚠️ Ya se reportó el resguardo de <b>${jefe.instalacion.toUpperCase()}</b> ` +
            `para el ${fechaBonita(fecha)}.\n\nSi hubo un error, avísale a Efraín.`
        );
        return { statusCode: 200, body: "ok" };
      }
      const elementos = await elementosDe(jefe.instalacion);
      await guardarSesion(chatId, {
        instalacion: jefe.instalacion,
        fecha,
        seleccion: [],
        paso: "seleccionando",
      });
      await enviarMensaje(chatId, pintarLista(jefe.instalacion, fecha, elementos, []));
      return { statusCode: 200, body: "ok" };
    }

    // ---- Mensajes dentro del flujo ----
    const sesion = await leerSesion(chatId);
    if (!sesion || !sesion.paso) {
      await enviarMensaje(chatId, "Usa /resguardo para comenzar.");
      return { statusCode: 200, body: "ok" };
    }

    const elementos = await elementosDe(sesion.instalacion);

    if (sesion.paso === "confirmando") {
      if (texto === "si" || texto === "sí" || texto === "ok") {
        const seleccion = sesion.seleccion || [];
        for (const idx of seleccion) {
          const el = elementos[idx];
          if (!el) continue;
          await escribirDoc("resguardos", `${sesion.fecha}_${el.clave}`, {
            instalacion: sesion.instalacion,
            clave: el.clave,
            nombre: el.nombre,
            fecha: sesion.fecha,
            reportado_por: jefe.nombre,
            reportado_en: new Date().toISOString(),
            exportado: false,
          });
        }
        await borrarSesion(chatId);
        await enviarMensaje(
          chatId,
          `✅ Resguardo guardado.\n\n` +
            `<b>${sesion.instalacion.toUpperCase()}</b> · ${fechaBonita(sesion.fecha)}\n` +
            `Elementos: <b>${seleccion.length}</b>\n\nGracias, ${jefe.nombre}.`
        );
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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bruto)) {
        await enviarMensaje(chatId, "Formato inválido. Usa <code>AAAA-MM-DD</code>.");
        return { statusCode: 200, body: "ok" };
      }
      const d = new Date(bruto + "T12:00:00");
      if (d.getDay() !== 5) {
        await enviarMensaje(chatId, "⚠️ Esa fecha no es viernes. Escribe otra.");
        return { statusCode: 200, body: "ok" };
      }
      if (await yaReportado(sesion.instalacion, bruto)) {
        await enviarMensaje(chatId, `⚠️ Ya hay resguardo para ${fechaBonita(bruto)}. Avísale a Efraín.`);
        await borrarSesion(chatId);
        return { statusCode: 200, body: "ok" };
      }
      await guardarSesion(chatId, { ...sesion, fecha: bruto, paso: "confirmando" });
      const nombres = (sesion.seleccion || []).map((i) => `• ${elementos[i].nombre}`).join("\n");
      await enviarMensaje(chatId, `Resguardo del <b>${fechaBonita(bruto)}</b>:\n\n${nombres}\n\n¿Confirmas? "<code>sí</code>".`);
      return { statusCode: 200, body: "ok" };
    }

    if (sesion.paso === "seleccionando") {
      if (texto === "ok") {
        const seleccion = sesion.seleccion || [];
        if (!seleccion.length) {
          await enviarMensaje(chatId, "No has seleccionado a nadie. Escribe los números, o /cancelar.");
          return { statusCode: 200, body: "ok" };
        }
        await guardarSesion(chatId, { ...sesion, paso: "confirmando" });
        const nombres = seleccion.map((i) => `• ${elementos[i].nombre}`).join("\n");
        await enviarMensaje(
          chatId,
          `Vas a registrar ${seleccion.length} resguardo(s) para <b>${fechaBonita(sesion.fecha)}</b>:\n\n` +
            nombres +
            `\n\n¿La fecha es correcta? "<code>sí</code>" para guardar, "<code>cambiar</code>" para otra fecha.`
        );
        return { statusCode: 200, body: "ok" };
      }

      const numeros = bruto.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
      if (!numeros.length) {
        await enviarMensaje(chatId, "Escribe números (ej: <code>1 3 5</code>) o <code>ok</code>.");
        return { statusCode: 200, body: "ok" };
      }
      const invalidos = numeros.filter((n) => n < 1 || n > elementos.length);
      if (invalidos.length) {
        await enviarMensaje(chatId, `Fuera de rango: ${invalidos.join(", ")}. Válidos: 1 a ${elementos.length}.`);
        return { statusCode: 200, body: "ok" };
      }
      const seleccion = new Set(sesion.seleccion || []);
      numeros.forEach((n) => {
        const idx = n - 1;
        if (seleccion.has(idx)) seleccion.delete(idx);
        else seleccion.add(idx);
      });
      const nueva = [...seleccion].sort((a, b) => a - b);
      await guardarSesion(chatId, { ...sesion, seleccion: nueva });
      await enviarMensaje(chatId, pintarLista(sesion.instalacion, sesion.fecha, elementos, nueva));
      return { statusCode: 200, body: "ok" };
    }
  } catch (e) {
    console.error("Error:", e.message);
    await enviarMensaje(chatId, "Algo falló. Ya quedó en el log. Intenta de nuevo.");
  }

  return { statusCode: 200, body: "ok" };
};
