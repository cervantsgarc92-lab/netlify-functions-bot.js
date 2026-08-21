// netlify/functions/bot.js
// Hito 2: el bot ahora conecta a Firestore

const TOKEN = process.env.TELEGRAM_TOKEN;
const SECRET = process.env.TELEGRAM_SECRET;
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID;
const API = `https://api.telegram.org/bot${TOKEN}`;
const FIRESTORE_API = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// Enviar un mensaje de vuelta a Telegram
async function enviarMensaje(chatId, texto, extra = {}) {
  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: texto,
      parse_mode: "HTML",
      ...extra,
    }),
  });

  if (!res.ok) {
    console.error("sendMessage falló:", res.status, await res.text());
  }
}

// Buscar un jefe de turno en Firestore por ID de Telegram
async function buscarJefeTurno(telegramId) {
  try {
    const query = `${FIRESTORE_API}/jefes_turno?pageSize=100`;
    const res = await fetch(query);

    if (!res.ok) return null;

    const data = await res.json();
    if (!data.documents) return null;

    for (const doc of data.documents) {
      const fields = doc.fields || {};
      if (fields.telegram_id?.integerValue == telegramId) {
        return {
          id: doc.name.split("/").pop(),
          nombre: fields.nombre?.stringValue,
          instalacion: fields.instalacion?.stringValue,
          ...fields,
        };
      }
    }
  } catch (e) {
    console.error("Error buscando jefe:", e.message);
  }

  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "Bot vivo" };
  }

  const secretRecibido = event.headers["x-telegram-bot-api-secret-token"];
  if (SECRET && secretRecibido !== SECRET) {
    return { statusCode: 401, body: "no autorizado" };
  }

  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 200, body: "ok" };
  }

  const msg = update.message;

  if (msg && msg.text) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const nombre = msg.from.first_name || "";
    const texto = msg.text.trim();

    if (texto.startsWith("/start")) {
      // Buscar si ya está registrado
      const jefe = await buscarJefeTurno(telegramId);

      if (jefe) {
        await enviarMensaje(
          chatId,
          `Bienvenido de vuelta, ${jefe.nombre}.\n\n` +
            `Tu instalación: ${jefe.instalacion}\n\n` +
            `Usa /resguardo para reportar resguardos.`
        );
      } else {
        await enviarMensaje(
          chatId,
          `Hola ${nombre}. Soy el bot de Protección y Seguridad.\n\n` +
            `Tu ID de Telegram es: <code>${telegramId}</code>\n\n` +
            `Envíaselo a Efraín para que te dé de alta como jefe de turno.`
        );
      }
    } else if (texto.startsWith("/resguardo")) {
      const jefe = await buscarJefeTurno(telegramId);

      if (!jefe) {
        await enviarMensaje(
          chatId,
          "No estás registrado aún. Usa /start para enviar tu ID a Efraín."
        );
      } else {
        await enviarMensaje(
          chatId,
          `Resguardo para ${jefe.instalacion}.\n\n` +
            `Próximamente: seleccionarás qué elementos resguardaron hoy.`
        );
      }
    } else {
      await enviarMensaje(
        chatId,
        `Recibí tu mensaje: "${texto}"\n\nComandos: /start, /resguardo`
      );
    }
  }

  return { statusCode: 200, body: "ok" };
};
