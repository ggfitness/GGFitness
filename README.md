# 💪 GG Fitness — Landing + tienda online

Web de venta para personal trainer: landing con los planes, carrito con
**descuentos automáticos por combo**, cobro con **Mercado Pago** y **entrega
automática del material** por Google Drive al aprobarse el pago.

## Cómo funciona

```
Landing → Planes / Combos → Carrito → Mercado Pago → Pago aprobado
   → 📧 Al COMPRADOR: confirmación + acceso al material (automático)
   → 📧 A la TRAINER: aviso de venta + estado de la entrega
   → 🤝 Si compró un servicio a medida, la trainer lo contacta
```

Los packs con carpeta configurada se entregan solos: el servidor le da acceso de
lectura al mail del comprador sobre la carpeta de Drive y le manda el link. Las
carpetas quedan privadas, así que reenviar el link no sirve. Los servicios
personalizados (planes a medida) generan un aviso para que la trainer los
coordine a mano.

## 🧰 Tecnologías

| Capa | Qué usa |
|---|---|
| **Backend** | Node.js 20+ y [Express](https://expressjs.com/) 4 (CommonJS) |
| **Frontend** | HTML, CSS y JavaScript nativo — **sin framework ni build step** |
| **Base de datos** | [Upstash Redis](https://upstash.com/) vía REST en producción; archivo JSON en local |
| **Pagos** | [Mercado Pago](https://www.mercadopago.com.ar/developers) (SDK oficial v2) con webhook firmado |
| **Mails** | [Resend](https://resend.com/) por API, o cualquier SMTP con [Nodemailer](https://nodemailer.com/) |
| **Entrega del material** | Google Drive API con cuenta de servicio (JWT firmado a mano, sin SDK) |
| **Hosting** | [Vercel](https://vercel.com/) serverless + cron diario |
| **Entorno local** | Docker + Docker Compose (`node:20-slim`) |

**Dependencias de producción** (4 en total, `package.json`):

```
express          servidor HTTP y ruteo
mercadopago      SDK oficial de Mercado Pago
@upstash/redis   cliente Redis por HTTP (funciona en serverless)
nodemailer       envío por SMTP
```

Decisiones que conviene conocer:

- **Sin build step.** El front es HTML y JS servidos tal cual. No hay Webpack,
  Vite ni transpilación: lo que ves en `public/` es lo que corre en el navegador.
- **Sin ORM ni SQL.** Las órdenes son documentos JSON en Redis, con la misma API
  para los dos backends (`src/store.js`), así local y producción se comportan igual.
- **Sin `dotenv`.** Se usa `--env-file-if-exists`, nativo de Node 20.
- **Redis por HTTP, no TCP.** En serverless no se pueden sostener conexiones
  persistentes; por eso `@upstash/redis` y no `ioredis`.
- **Google Drive sin SDK.** `src/drive.js` arma y firma el JWT con el módulo
  `crypto` de Node. Evita arrastrar `googleapis`, que pesa decenas de MB y
  complica el cold start en serverless.
- **Validación de email compartida.** `public/js/email.js` lo usan el navegador
  **y** el servidor: una sola regla, sin poder quedar desincronizadas.

**Requisitos para desarrollar:** Node.js 20 o superior. Nada más.

## 🚀 Cómo levantarla

Con **Docker** — es la forma recomendada, no necesitás Node instalado:

```bash
# 1) Copiá la configuración de ejemplo
cp .env.example .env

# 2) Levantá el contenedor
docker compose up
```

Abrí http://localhost:3000

Para pararlo, `Ctrl+C`. Para levantarlo en segundo plano, `docker compose up -d`
(y `docker compose down` para bajarlo).

> El `.env` es **obligatorio**: `docker-compose.yml` lo carga con `env_file` y si
> no existe, el comando falla. En Windows (PowerShell) usá `copy .env.example .env`.

Cuando cambies algo del código, reconstruí la imagen:

```bash
docker compose up --build
```

Las órdenes quedan en `./data`, montada como volumen, así que sobreviven a
reinicios del contenedor.

### Sin Docker

Si tenés **Node.js 20 o superior**, también corre directo:

```bash
cp .env.example .env
npm install
npm run dev
```

`npm run dev` levanta con recarga automática (`--watch`), así que para
desarrollar activamente es más cómodo que reconstruir la imagen cada vez.

Los scripts cargan el `.env` con `--env-file-if-exists`, que es nativo de Node:
no hace falta `dotenv`. En producción el archivo no existe y las variables las
inyecta la plataforma, por eso se usa la variante `-if-exists`, que no falla si
no está.

## 🧪 Modo demo

Con el `.env` de ejemplo sin tocar, la web **ya funciona** para desarrollo:

- **Pagos simulados:** sin `MP_ACCESS_TOKEN`, el pago se aprueba solo.
- **Mails en consola:** en vez de enviarse, se imprimen. Ahí ves el mail del
  comprador con sus accesos y el aviso a la trainer.

> ⚠️ Si el `.env` tiene `RESEND_API_KEY`, los mails **se envían de verdad**. Para
> probar sin enviar nada, arrancá con la variable vacía:
> `RESEND_API_KEY= npm run dev`

El modo demo solo está disponible en local. En un sitio público las compras se
bloquean si falta la configuración de Mercado Pago, para que nadie se lleve el
material gratis.

## ⚙️ Configuración

Todas las variables están documentadas una por una en **`.env.example`**, con qué
hace cada una y qué pasa si la dejás vacía.

Con `ADMIN_TOKEN` cargado, este endpoint dice en castellano qué está configurado
y qué falta, sin mostrar ningún secreto:

```
GET /api/admin/estado?token=...
```

## 📦 Editar el contenido

| Qué | Dónde |
|---|---|
| Productos y precios | `src/products.js` |
| Descuentos por combo | `src/discounts.js` |
| Estilos | `public/css/styles.css` |
| Fotos y logo | `public/img/` |

> ⚠️ En `src/products.js` **no van links de Drive**: ese archivo se sube al repo.
> La carpeta de cada pack se configura en la variable `DRIVE_FOLDERS`.

## 🛠️ Scripts

```bash
npm run dev          # servidor con recarga automática
npm start            # servidor
npm run check:drive  # diagnóstico de la entrega automática por Drive
npm run precios      # neto por venta descontando la comisión de Mercado Pago
```

## 🗂️ Estructura

```
├── docker-compose.yml     # Levantar en local con Docker
├── Dockerfile
├── vercel.json            # Configuración del deploy
├── api/index.js           # Entrada serverless
├── .env.example           # Configuración (copiar a .env)
├── src/
│   ├── server.js          # Servidor, API y flujo de orden/mails
│   ├── products.js        # Catálogo de productos
│   ├── discounts.js       # Reglas de descuento por combo
│   ├── store.js           # Órdenes: Upstash Redis o archivo JSON
│   ├── payments.js        # Integración Mercado Pago
│   ├── fees.js            # Comisión de MP: neto estimado por venta
│   ├── ratelimit.js       # Topes de requests por IP
│   ├── delivery.js        # Qué pack va con qué carpeta
│   ├── drive.js           # Google Drive: auth y permisos
│   ├── emails.js          # Plantillas HTML de los mails
│   └── mailer.js          # Envío: Resend / SMTP / demo
├── scripts/               # Diagnóstico de Drive y cálculo de precios
└── public/                # Landing, carrito y assets
```
