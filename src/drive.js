// ============================================================================
//  Google Drive — capa de bajo nivel (autenticación + API REST)
// ============================================================================
//  Qué hace: le da permiso de LECTURA a un comprador sobre una carpeta de Drive.
//  Las carpetas quedan PRIVADAS (sin "cualquiera con el link"), así que el
//  material no se puede reenviar: solo entra la cuenta a la que se le dio acceso.
//
//  Cómo se autentica: con una "cuenta de servicio" de Google Cloud. Se firma un
//  JWT con la clave privada y Google devuelve un access token de 1 hora.
//  No usamos la librería `googleapis` a propósito: son ~50 MB de dependencias
//  para 2 llamadas HTTP. Acá se hace con `crypto` (nativo de Node) y `fetch`.
//
//  SEGURIDAD:
//  - La clave privada vive SOLO en la variable de entorno GOOGLE_SERVICE_ACCOUNT_JSON
//    (el .env está en .gitignore y en Vercel va en el panel de Variables).
//  - Nunca se loguea la clave, ni el token, ni el contenido de la variable.
//  - La cuenta de servicio solo ve lo que la cuenta técnica le compartió a mano.
//    Si mañana se filtrara, el daño se limita a las carpetas de los packs y se
//    corta borrando la clave en Google Cloud (no hay que tocar el código).
// ============================================================================
const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
// Scope mínimo que permite compartir archivos que NO creó la app.
// Igual solo alcanza a las carpetas que la cuenta técnica le compartió.
const SCOPE = 'https://www.googleapis.com/auth/drive';
const TIMEOUT_MS = 10000; // ninguna llamada puede colgar el pago

// ---------------------------------------------------------------------------
//  Credenciales
// ---------------------------------------------------------------------------
// Acepta el JSON tal cual o en base64 (recomendado: el JSON tiene saltos de
// línea en la clave privada y algunos paneles los rompen).
function loadCredentials() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null; // no configurado => entrega automática desactivada

  let text = raw;
  if (!text.startsWith('{')) {
    text = Buffer.from(raw, 'base64').toString('utf8');
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no es un JSON válido (ni en base64).');
  }

  const clientEmail = json.client_email;
  // Si el JSON se pegó "escapado", los \n vienen literales: hay que restaurarlos.
  const privateKey = String(json.private_key || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new Error('Al JSON de la cuenta de servicio le faltan client_email o private_key.');
  }
  return { clientEmail, privateKey };
}

let credentials = null;
try {
  credentials = loadCredentials();
} catch (err) {
  // Nunca tiramos abajo el servidor por una credencial mal pegada: se avisa y
  // la entrega pasa a modo manual (la trainer recibe el aviso igual).
  console.error('⚠️  Google Drive mal configurado:', err.message);
}

const HAS_DRIVE = !!credentials;
if (HAS_DRIVE) {
  console.log('📁 Google Drive: entrega automática activada (' + credentials.clientEmail + ').');
} else {
  console.log('📁 Google Drive: sin credenciales — la entrega la coordina la trainer.');
}

// ---------------------------------------------------------------------------
//  HTTP con timeout y reintentos (solo para errores temporales)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(url, options = {}, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = await res.text();
      let data = null;
      try {
        data = body ? JSON.parse(body) : null;
      } catch {
        /* respuesta no-JSON: la tratamos como vacía */
      }

      if (res.ok) return data || {};

      // 429 / 5xx son temporales: reintentamos con espera creciente.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }

      const err = new Error(
        data?.error?.message || data?.error_description || `Google respondió ${res.status}`
      );
      err.status = res.status;
      throw err;
    } catch (err) {
      if (err.status) throw err; // error de la API: no se reintenta más
      // Timeout o problema de red.
      lastErr = err;
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr || new Error('No se pudo contactar a Google.');
}

// ---------------------------------------------------------------------------
//  Access token (cacheado en memoria y compartido entre llamadas paralelas)
// ---------------------------------------------------------------------------
let cachedToken = null; // { value, expiresAt }
let inFlightToken = null; // evita pedir 3 tokens si se entregan 3 packs a la vez

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function requestToken() {
  const iat = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    b64url({
      iss: credentials.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    });

  let signature;
  try {
    signature = crypto
      .createSign('RSA-SHA256')
      .update(unsigned)
      .sign(credentials.privateKey)
      .toString('base64url');
  } catch {
    // Mensaje genérico a propósito: el error de OpenSSL puede incluir la clave.
    throw new Error('La clave privada de la cuenta de servicio no es válida.');
  }

  const data = await apiFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });

  if (!data.access_token) throw new Error('Google no devolvió un access token.');
  // Lo damos por vencido 5 minutos antes, para no usarlo justo al límite.
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) - 300) * 1000,
  };
  return cachedToken.value;
}

async function getAccessToken() {
  if (!HAS_DRIVE) throw new Error('Google Drive no está configurado.');
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  if (!inFlightToken) {
    inFlightToken = requestToken().finally(() => {
      inFlightToken = null;
    });
  }
  return inFlightToken;
}

// ---------------------------------------------------------------------------
//  Operaciones de Drive
// ---------------------------------------------------------------------------

// Le da acceso de SOLO LECTURA a `email` sobre `folderId`.
// Devuelve { notified } — notified=true significa que Google le mandó su propia
// invitación (pasa cuando el mail no es una cuenta de Google).
// Si ya tenía acceso, Google no se queja: la operación es idempotente.
async function grantReader({ folderId, email, message }) {
  const token = await getAccessToken();
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(folderId)}/permissions`);
  url.searchParams.set('fields', 'id');
  url.searchParams.set('supportsAllDrives', 'true');

  const request = (notify) => {
    const u = new URL(url);
    u.searchParams.set('sendNotificationEmail', notify ? 'true' : 'false');
    if (notify && message) u.searchParams.set('emailMessage', message);
    return apiFetch(u.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: email }),
    });
  };

  try {
    // Preferimos NO notificar: el mail lindo se lo mandamos nosotros.
    await request(false);
    return { notified: false };
  } catch (err) {
    // Drive devuelve 400 cuando el destinatario no tiene cuenta de Google y
    // exige que la invitación se mande por su canal. Reintentamos así.
    if (err.status === 400) {
      await request(true);
      return { notified: true };
    }
    throw err;
  }
}

// Le SACA el acceso a `email` sobre `folderId`.
// Se usa cuando un pago se devuelve o hay un contracargo: la plata volvió, el
// material tiene que dejar de estar disponible.
// Devuelve { revoked } — revoked=false significa que esa cuenta no tenía acceso
// (no es un error: puede haber sido una entrega manual).
async function revokeReader({ folderId, email }) {
  const token = await getAccessToken();
  const buscado = String(email || '').trim().toLowerCase();
  if (!buscado) return { revoked: false };

  const headers = { Authorization: `Bearer ${token}` };

  // Un pack con muchas ventas acumula muchos permisos, así que hay que paginar.
  // El tope de páginas es una red de seguridad para no quedarse dando vueltas.
  let pageToken = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(folderId)}/permissions`);
    url.searchParams.set('fields', 'nextPageToken,permissions(id,emailAddress,role,type)');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('supportsAllDrives', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const data = await apiFetch(url.toString(), { headers });

    for (const perm of data.permissions || []) {
      if (String(perm.emailAddress || '').toLowerCase() !== buscado) continue;
      // Por seguridad solo se borran permisos de lectura de una persona: nunca
      // se toca al dueño de la carpeta ni a la cuenta de servicio.
      if (perm.type !== 'user' || perm.role !== 'reader') continue;

      const del = new URL(
        `${DRIVE_API}/files/${encodeURIComponent(folderId)}/permissions/${encodeURIComponent(perm.id)}`
      );
      del.searchParams.set('supportsAllDrives', 'true');
      await apiFetch(del.toString(), { method: 'DELETE', headers });
      return { revoked: true };
    }

    pageToken = data.nextPageToken || null;
    if (!pageToken) break;
  }

  return { revoked: false };
}

// Datos de una carpeta. Se usa en el diagnóstico (scripts/check-drive.js) para
// confirmar que la cuenta de servicio la ve Y puede compartirla.
async function getFolder(folderId) {
  const token = await getAccessToken();
  const url =
    `${DRIVE_API}/files/${encodeURIComponent(folderId)}` +
    '?fields=id,name,mimeType,capabilities(canShare)&supportsAllDrives=true';
  return apiFetch(url, { headers: { Authorization: `Bearer ${token}` } });
}

module.exports = {
  HAS_DRIVE,
  serviceAccountEmail: credentials ? credentials.clientEmail : null,
  getAccessToken,
  grantReader,
  revokeReader,
  getFolder,
};
