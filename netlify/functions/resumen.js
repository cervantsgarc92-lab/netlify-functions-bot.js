// netlify/functions/resumen.js
// Resumen semanal de resguardos. Lo dispara un cron externo (cron-job.org)
// visitando la URL cada sábado por la mañana.
//
// Seguridad: la URL lleva ?token=... para que nadie más pueda dispararla.

const TOKEN = process.env.TELEGRAM_TOKEN;
const PROJECT = process.env.FIREBASE_PROJECT_ID;
const API_KEY = process.env.FIREBASE_API_KEY;
const CRON_TOKEN = process.env.CRON_TOKEN;
const COORDINADORES = (process.env.COORDINADOR_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const TG = `https://api.telegram.org/bot${TOKEN}`;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// Instalaciones que sí operan (capule está inactiva)
const INSTALACIONES_ACTIVAS = ["ceuta", "bellavista", "tayoltita", "caimanes", "campo-5"];

async function enviarMensaje(chatId, texto) {
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML" }),
  });
}

function planos(fields = {}) {
  const s = {};
  for (const [k, env] of Object.entries(fields)) {
    const t = Object.keys(env)[0];
    let v = env[t];
    if (t === "integerValue") v = parseInt(v, 10);
    s[k] = v;
  }
  return s;
}

async function consultar(coleccion, campo, valor) {
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
            value: { stringValue: String(valor) },
          },
        },
      },
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.filter((f) => f.document).map((f) => planos(f.document.fields));
}

// El viernes más reciente respecto a hoy
function viernesReciente() {
  const hoy = new Date();
  const diff = (hoy.getDay() - 5 + 7) % 7;
  hoy.setDate(hoy.getDate() - diff);
  return hoy.toISOString().split("T")[0];
}

function fechaBonita(iso) {
  const dias = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const d = new Date(iso + "T12:00:00");
  return `${dias[d.getDay()]} ${d.getDate()} de ${meses[d.getMonth()]}`;
}

exports.handler = async (event) => {
  // Verificar token del cron
  const token = event.queryStringParameters?.token;
  if (!CRON_TOKEN || token !== CRON_TOKEN) {
    return { statusCode: 401, body: "no autorizado" };
  }

  const fecha = viernesReciente();
  const resguardos = await consultar("resguardos", "fecha", fecha);

  // Agrupar por instalación
  const porInstalacion = {};
  resguardos.forEach((r) => {
    porInstalacion[r.instalacion] = porInstalacion[r.instalacion] || { total: 0, quien: r.reportado_por };
    porInstalacion[r.instalacion].total++;
  });

  const reportaron = [];
  const faltaron = [];
  for (const inst of INSTALACIONES_ACTIVAS) {
    if (porInstalacion[inst]) {
      reportaron.push(`✅ ${inst.toUpperCase()}: ${porInstalacion[inst].total} elementos (${porInstalacion[inst].quien})`);
    } else {
      faltaron.push(`❌ ${inst.toUpperCase()}: sin reporte`);
    }
  }

  let mensaje = `<b>Resumen de resguardos</b>\n${fechaBonita(fecha)}\n\n`;
  if (reportaron.length) mensaje += reportaron.join("\n") + "\n";
  if (faltaron.length) mensaje += "\n" + faltaron.join("\n") + "\n";

  mensaje += `\n<b>${reportaron.length} de ${INSTALACIONES_ACTIVAS.length}</b> instalaciones reportaron.`;
  if (faltaron.length) {
    mensaje += `\n\n⚠️ Revisa las que faltan antes de exportar a pagos.`;
  } else {
    mensaje += `\n\nTodas reportaron. Usa /exportar cuando quieras el archivo.`;
  }

  // Enviar a cada coordinador
  for (const id of COORDINADORES) {
    await enviarMensaje(id, mensaje);
  }

  return { statusCode: 200, body: `Resumen enviado. ${reportaron.length}/${INSTALACIONES_ACTIVAS.length} reportaron.` };
};
