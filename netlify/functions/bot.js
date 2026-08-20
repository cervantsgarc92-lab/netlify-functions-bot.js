// netlify/functions/bot.js
// Hito 1: el bot recibe mensajes de Telegram y contesta.
// No usa base de datos todavía. No tiene dependencias: no hace falta npm install.

const TOKEN = process.env.TELEGRAM_TOKEN;
const SECRET = process.env.TELEGRAM_SECRET;
const API = `https://api.telegram.org/bot${TOKEN}`;

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
    // Se ve en Netlify > Logs > Functions
    console.error("sendMessage falló:", res.status, await res.text());
  }
}

exports.handler = async (event) => {
  // Telegram siempre manda POST. Si abres la URL en el navegador cae aquí:
  // sirve para confirmar que la función está desplegada.
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "Bot vivo" };
  }

  // Solo aceptamos peticiones que traigan nuestro secreto.
  // Sin esto, cualquiera que adivine tu URL puede mandarle datos falsos al bot.
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
    const nombre = msg.from.first_name || "";
    const texto = msg.text.trim();

    if (texto.startsWith("/start")) {
      await enviarMensaje(
        chatId,
        `Hola ${nombre}. Soy el bot de Protección y Seguridad.\n\n` +
          `Tu ID de Telegram es: <code>${msg.from.id}</code>\n\n` +
          `Envíaselo a Efraín para que te dé de alta como jefe de turno.`
      );
    } else {
      await enviarMensaje(
        chatId,
        `Recibí tu mensaje: "${texto}"\n\nTodavía no sé hacer nada más. Pronto.`
      );
    }
  }

  // Siempre responder 200, aunque algo haya fallado arriba.
  // Si devuelves un error, Telegram reintenta el mismo mensaje una y otra vez.
  return { statusCode: 200, body: "ok" };
};
