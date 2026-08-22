// netlify/functions/bot.js
// Hito 3: el bot lee los catálogos de Firestore y reconoce a los jefes de turno.

const TOKEN = process.env.TELEGRAM_TOKEN;
const SECRET = process.env.TELEGRAM_SECRET;
const PROJECT = process.env.FIREBASE_PROJECT_ID;
const API_KEY = process.env.FIREBASE_API_KEY;

const TG = `https://api.telegram.org/bot${TOKEN}`;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// ---------- Telegram ----------

async function enviarMensaje(chatId, texto, extra = {}) {
  const res = await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML", ...extra }),
  });
  if (!res.ok) console.error("sendMessage falló:", res.status, await res.text());
}

// ---------- Firestore ----------

// Convierte el formato de Firestore ({stringValue: "x"}) a algo normal ("x")
function planos(fields = {}) {
  const salida = {};
  for (const [clave, envoltorio] of Object.entries(fields)) {
    const tipo = Object.keys(envoltorio)[0];
    let valor = envoltorio[tipo];
    if (tipo === "integerValue") valor = parseInt(valor, 10);
    salida[clave] = valor;
  }
  return salida;
}

// Consulta una colección filtrando por un campo
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
    console.error(`Firestore falló (${coleccion}):`, res.status, await res.text());
    return [];
  }

  const data = await res.json();
  return data
    .filter((fila) => fila.document)
    .map((fila) => ({
      id: fila.document.name.split("/").pop(),
      ...planos(fila.document.fields),
    }));
}

const buscarJefe = async (telegramId) =>
  (await consultar("jefes_turno", "telegram_id", telegramId, "integerValue"))[0] || null;

const elementosDe = async (instalacion) =>
  (await consultar("elementos", "instalacion", instalacion))
    .filter((e) => e.activo !== false)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

// ---------- Handler ----------

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
  const texto = msg.text.trim();

  try {
    const jefe = await buscarJefe(telegramId);

    if (texto.startsWith("/start")) {
      if (jefe) {
        const elementos = await elementosDe(jefe.instalacion);
        await enviarMensaje(
          chatId,
          `Hola ${jefe.nombre}.\n\n` +
            `Instalación: <b>${jefe.instalacion.toUpperCase()}</b>\n` +
            `Elementos a tu cargo: <b>${elementos.length}</b>\n\n` +
            `Usa /resguardo para reportar quién resguardó.`
        );
      } else {
        await enviarMensaje(
          chatId,
          `Hola ${msg.from.first_name || ""}. Soy el bot de Protección y Seguridad.\n\n` +
            `Tu ID de Telegram es: <code>${telegramId}</code>\n\n` +
            `Envíaselo a Efraín para que te dé de alta.`
        );
      }
      return { statusCode: 200, body: "ok" };
    }

    if (texto.startsWith("/resguardo")) {
      if (!jefe) {
        await enviarMensaje(chatId, "No estás dado de alta. Usa /start y envía tu ID a Efraín.");
        return { statusCode: 200, body: "ok" };
      }
      const elementos = await elementosDe(jefe.instalacion);
      const lista = elementos.map((e) => `• ${e.nombre} (${e.clave})`).join("\n");
      await enviarMensaje(
        chatId,
        `<b>${jefe.instalacion.toUpperCase()}</b> — ${elementos.length} elementos:\n\n${lista}\n\n` +
          `<i>Los botones para seleccionar vienen en el siguiente paso.</i>`
      );
      return { statusCode: 200, body: "ok" };
    }

    await enviarMensaje(chatId, "Comandos disponibles: /start y /resguardo");
  } catch (e) {
    console.error("Error:", e.message);
    await enviarMensaje(chatId, "Algo falló. Ya quedó registrado en el log.");
  }

  return { statusCode: 200, body: "ok" };
};
