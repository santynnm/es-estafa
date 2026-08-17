# ¿Es estafa?

MVP de una app web que ayuda a identificar si un mensaje, SMS, email o llamada es una
estafa. El usuario pega el texto o sube una captura de pantalla, se analiza con Google
Gemini y se muestra un veredicto de riesgo (bajo/medio/alto) con señales, explicación y
una acción recomendada. Ver `indicaciones.md` para la especificación completa del
proyecto.

Desde el Día 5-6A la app requiere una cuenta (Supabase Auth, email + contraseña) para
usar el analizador. Ni el texto ni las imágenes se guardan en ningún lado — se procesan
solo para responder la petición en curso.

## Stack

- **Frontend**: React + TypeScript + Tailwind CSS, con Vite.
- **Backend**: función serverless (`api/analyze.ts`) pensada para Vercel.
- **IA**: Google Gemini (Google AI Studio, tier gratuito). La API key vive únicamente
  del lado servidor — nunca se expone al navegador (podés confirmarlo corriendo el build
  y revisando que `dist/` no contenga la clave ni la URL de Gemini).

El contrato del clasificador (`shared/classifierContract.ts`) es compartido entre
frontend y backend y no debe modificarse: es lo que permitió agregar `image_ocr`
(Día 3-4A, pipeline backend) sin tocar el núcleo del clasificador, y lo mismo para
`audio_transcript` en una etapa futura.

## Instalar dependencias

```bash
npm install
```

## Configurar variables de entorno

1. Copiá `.env.example` a `.env`:

   ```bash
   cp .env.example .env
   ```

2. Generá una API key gratuita en [Google AI Studio](https://aistudio.google.com/apikey)
   y pegala en `.env` como `GEMINI_API_KEY`.

   `GEMINI_MODEL` es opcional (por defecto usa `gemini-3.5-flash-lite`). Google deprecia
   modelos con el tiempo — si empieza a fallar con 404 "model ... is no longer
   available", corré `node scripts/check-models.mjs TU_API_KEY` para ver qué modelos
   responden OK.

`.env` está en `.gitignore`: nunca se commitea.

## Configurar Supabase Auth (Día 5-6A)

La app usa [Supabase](https://supabase.com) Auth con email + contraseña para proteger el
analizador. Nada de esto toca base de datos ni Storage todavía — solo Auth.

1. Creá un proyecto gratuito en [supabase.com](https://supabase.com/dashboard) (o usá uno
   existente).
2. En el dashboard del proyecto → **Settings → API**, copiá:
   - **Project URL** → pegalo en `.env` como `VITE_SUPABASE_URL`.
   - **anon / public key** → pegalo en `.env` como `VITE_SUPABASE_ANON_KEY`.

   Ambas son públicas por diseño (van al bundle del navegador, protegidas por Row Level
   Security del lado de Supabase). **Nunca** uses la `service_role` key acá — esa key
   tiene privilegios de administrador y no debe existir en el frontend.
3. Confirmación de email: por defecto Supabase pide confirmar el email antes de dar una
   sesión al registrarse (**Authentication → Providers → Email → "Confirm email"**). Con
   eso activado, `signUp` no devuelve sesión inmediata y la UI muestra "revisá tu correo
   para confirmar la cuenta". Para probar más rápido en desarrollo podés desactivar esa
   opción (la app ya maneja los dos casos: con y sin confirmación).
4. Crear un usuario de prueba — dos formas:
   - Desde la propia app: "Crear cuenta" con cualquier email/contraseña (≥6 caracteres).
   - Desde el dashboard: **Authentication → Users → Add user** (podés crear uno ya
     confirmado, sin pasar por el flujo de email).

## Ejecutar localmente

Para levantar frontend **y** la función `/api/analyze` juntos (necesario para probar el
flujo completo), usá el CLI de Vercel:

```bash
npx vercel dev
```

La primera vez te va a pedir vincular el proyecto (podés elegir "no" para no crear
ningún proyecto remoto; funciona igual en local). La app queda disponible en
`http://localhost:3000` (o el puerto que indique la consola).

Si solo querés iterar sobre la interfaz sin backend (las llamadas a `/api/analyze`
van a fallar con un error de conexión, ya que no hay servidor atendiéndolas):

```bash
npm run dev
```

El login funciona igual con `npm run dev` solo (Vite lee `VITE_SUPABASE_URL` y
`VITE_SUPABASE_ANON_KEY` de `.env` directamente, sin pasar por `/api/`) — lo que no
funciona sin `vercel dev` es el análisis en sí, una vez que ya estás adentro.

## Build y chequeos

```bash
npm run build      # tsc -b + build de producción con Vite
npm run typecheck   # solo chequeo de tipos (frontend, api y shared)
npm run lint         # oxlint
```

## Probar el flujo

Con `vercel dev` corriendo y `GEMINI_API_KEY` configurada, pegá un texto como:

> "Su tarjeta fue bloqueada. Ingrese ahora a este enlace y confirme su clave para
> reactivarla."

y tocá "Analizar". Deberías ver un resultado con nivel de riesgo, señales detectadas,
una explicación simple y una acción recomendada.

## Endpoints protegidos con sesión de Supabase

`/api/analyze` y `/api/extract-image` requieren un usuario autenticado: exigen el header
`Authorization: Bearer <access_token>` con un JWT válido de Supabase (verificado contra
la misma URL/anon key públicas, nunca la service role key). Sin ese header, con un token
inventado o vencido, devuelven `401` — incluso antes de mirar el body de la request. El
frontend (`src/lib/api.ts`) pide el token actual con `supabase.auth.getSession()` en cada
llamada (nunca lo guarda en una variable propia, así siempre usa uno vigente) y lo agrega
solo; no hay nada manual que hacer para usar la app normalmente.

Si necesitás llamar a los endpoints vos mismo (por ejemplo con `curl`), primero necesitás
un access token real de un usuario de Supabase. `scripts/evalAuth.mts` (usado por los
scripts de evaluación de abajo) es la referencia más simple de cómo conseguirlo por
código, con `supabase.auth.signInWithPassword(...)`.

## Evaluar el clasificador (Día 2)

Hay un conjunto de evaluación reproducible en `scripts/eval-classifier.mts` con los seis
casos de la sección 10 de `indicaciones.md` (cinco de estafa + un control neutral) más
tres casos de robustez: intento de inyección de instrucciones dentro del texto, un
mensaje urgente pero legítimo (para chequear que no se marque como riesgo alto solo por
tener urgencia), y texto vacío. Llama al endpoint real `/api/analyze` — no usa mocks.

Como el endpoint ahora requiere sesión, el script primero inicia sesión con un usuario de
evaluación (`scripts/evalAuth.mts`, compartido también por `eval-image-pipeline.mts`) y
usa ese access token en cada request. Las credenciales se leen exclusivamente de
variables de entorno — nunca hardcodeadas —, definidas en `.env` (se cargan solas vía
`dotenv`) o exportadas en la shell:

```bash
# .env (o exportadas en la shell antes de correr el script)
EVAL_USER_EMAIL=tu-usuario-de-prueba@example.com
EVAL_USER_PASSWORD=tu-contraseña-de-prueba
```

Usá una cuenta de prueba dedicada, no una cuenta real — podés crearla con "Crear cuenta"
en la propia app, o desde **Authentication → Users → Add user** en el dashboard de
Supabase. Si falta alguna de las dos variables (o `VITE_SUPABASE_URL`/
`VITE_SUPABASE_ANON_KEY`), el script se corta con un mensaje claro que dice qué falta,
sin imprimir ningún valor.

```bash
npm run eval                                      # contra la producción (https://codercup.vercel.app)
EVAL_BASE_URL=http://localhost:3000 npm run eval   # contra vercel dev en local
```

Por cada caso imprime el riesgo esperado vs. el obtenido, las señales detectadas y
PASS/FAIL, y al final un resumen. Termina con exit code distinto de 0 si algún caso falla
(sirve para CI). Correlo más de una vez si querés chequear consistencia entre corridas —
el resultado de `risk_level` debería ser estable aunque la redacción de `signals`/
`explanation` varíe levemente.

## Pipeline de imagen → texto → clasificador (Día 3-4A)

Además del análisis de texto, hay un endpoint separado `api/extract-image.ts` que
transcribe el texto visible de una captura de pantalla (imagen → `raw_text`, sin
clasificar riesgo) usando la visión de Gemini. Ese texto extraído se manda después a
`/api/analyze` con `source_type: "image_ocr"`, reutilizando el mismo clasificador
calibrado del Día 2 — no hay un prompt de riesgo separado para imágenes.

Desde el Día 3-4B la interfaz tiene un selector **"Pegar un texto" / "Subir una
captura"** (arranca en modo texto). En modo imagen: se elige un archivo PNG/JPEG/WebP de
hasta 3 MB desde el selector estándar del dispositivo (incluye galería en mobile), se
muestra nombre, tamaño y una preview, y se puede cambiar o quitar antes de analizar. Al
tocar "Analizar" se ven dos estados de carga en secuencia — "Leyendo la captura..." y
"Analizando..." — y el resultado se muestra en el mismo `ResultCard` que en modo texto.
La imagen nunca se persiste ni se sube a otro lado más que a `/api/extract-image`; el
base64 tampoco se loguea en ningún momento (ni consola del navegador, ni logs del
servidor). Cambiar de modo limpia el resultado/error anterior y no dispara ninguna
llamada automática.

`/api/extract-image` recibe:

```json
{ "image_base64": "contenido base64 sin el prefijo data:", "mime_type": "image/png | image/jpeg | image/webp" }
```

y devuelve `{ "raw_text": "..." }`, o un error controlado si el `mime_type` no está
permitido, el base64 no es válido, la imagen decodificada supera 3 MB, o no hay texto
legible (nunca se llama al clasificador en esos casos). Las imágenes no se guardan en
ningún lado — se procesan en memoria para esa única request y se descartan.

Hay un conjunto de pruebas reproducible en `scripts/eval-image-pipeline.mts`, con
fixtures pequeñas y sin datos reales en `tests/fixtures/` (una captura generada
localmente con el mensaje de estafa de "tarjeta bloqueada" de la sección 10, en PNG/JPEG/
WebP, más una imagen sin texto):

```bash
npm run eval:image                                      # contra producción
EVAL_BASE_URL=http://localhost:3000 npm run eval:image   # contra vercel dev en local
```

Cubre: PNG válido, WebP válido, MIME inválido, base64 inválido, imagen > 3 MB, imagen sin
texto legible, y el flujo de integración completo (imagen de estafa → extracción →
`/api/analyze` con `image_ocr` → `risk_level: "alto"`).

## Contactos familiares (Día 5-6B)

Cada usuario autenticado puede guardar contactos de confianza (nombre + email) para,
en una etapa futura (Día 7), avisarles por email si un análisis da riesgo medio o alto.
Por ahora esta sección solo hace alta, listado y baja — todavía no envía nada.

### Esquema (`family_contacts`)

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` | PK, generado automáticamente (`gen_random_uuid()`) |
| `user_id` | `uuid` | FK a `auth.users(id)`, `on delete cascade`, obligatorio |
| `nombre` | `text` | obligatorio, no vacío, máx. 200 caracteres |
| `email` | `text` | obligatorio, no vacío, formato válido, máx. 320 caracteres |
| `created_at` | `timestamptz` | default `now()` |

Sin límite de cantidad de contactos por usuario. Un mismo email no puede cargarse dos
veces para el mismo usuario (índice único case-insensitive en `(user_id, lower(email))`);
sí puede repetirse entre usuarios distintos.

### Aplicar la migración

La migración vive versionada en `supabase/migrations/20260816033400_family_contacts.sql`.
Para aplicarla a un proyecto de Supabase:

```bash
npx supabase login                       # pide un access token (supabase.com/dashboard/account/tokens)
npx supabase link --project-ref TU_REF   # conecta el repo al proyecto
npx supabase db push                     # aplica las migraciones pendientes
```

(La migración ya está aplicada en el proyecto de producción "Codercup Project"; estos
pasos son para replicarla en otro proyecto — por ejemplo, para desarrollo local.)

### Row Level Security

RLS está habilitado en `family_contacts` con tres políticas, todas restringidas al rol
`authenticated` (nada para `anon` — sin sesión, no hay acceso):

- **`family_contacts_select_own`**: `SELECT` solo donde `auth.uid() = user_id`.
- **`family_contacts_insert_own`**: `INSERT` solo si el `user_id` insertado coincide con
  `auth.uid()` (evita que alguien inserte contactos a nombre de otro usuario).
- **`family_contacts_delete_own`**: `DELETE` solo donde `auth.uid() = user_id`.

No hay política de `UPDATE` — esta etapa solo implementa alta, listado y baja. El
frontend (`src/lib/contacts.ts`) usa siempre la sesión del usuario logueado con la
`anon key` pública; la `service_role key` no se usa ni se expone en ningún lado del
cliente.

### Verificar aislamiento entre usuarios manualmente

1. Creá (o usá) dos usuarios distintos — podés hacerlo desde la propia app con "Crear
   cuenta", o desde el dashboard (**Authentication → Users → Add user**).
2. Iniciá sesión con el usuario A y agregá un contacto.
3. Cerrá sesión e iniciá con el usuario B: la lista de A no debería aparecer.
4. Con las DevTools abiertas (o la consola del navegador), intentá ejecutar, logueado
   como B, una consulta directa a un contacto de A por `id` (por ejemplo, copiando el
   `id` desde el dashboard de Supabase y corriendo
   `supabase.from('family_contacts').select('*').eq('id', 'EL_ID_DE_A')` en la consola)
   — RLS tiene que devolver una lista vacía, no el contacto.
5. Repetí el mismo intento con `.delete()` en vez de `.select()`: tiene que devolver
   `data: []` (cero filas afectadas), y el contacto de A tiene que seguir existiendo.

## Persistencia de análisis y alertas por email (Día 7A)

Esta etapa agrega el backend para guardar cada análisis y, para riesgo medio/alto, poder
avisarle a un contacto familiar por email vía [Resend](https://resend.com). **Todavía no
hay botón en la interfaz** — el flujo se probó por API; el botón "Avisarle a un familiar"
es el Día 7B.

### Privacidad de los análisis persistidos

Desde esta etapa, los análisis (`raw_text` normalizado, `source_type`, y el resultado del
clasificador) se guardan en la tabla `checks`, asociados al usuario que los generó. Son
**privados**, protegidos por RLS igual que los contactos familiares (sección 12 de
`indicaciones.md`): cada usuario solo puede ver los suyos, nadie más. Para capturas de
pantalla, **nunca se guarda la imagen** — solo el `raw_text` ya extraído por OCR, el mismo
texto que ya le llega al clasificador.

### Esquema (`checks`)

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `user_id` | `uuid` | FK a `auth.users(id)`, `on delete cascade` |
| `source_type` | `text` | `text` \| `image_ocr` \| `audio_transcript` (reservado, sin implementar) |
| `raw_text` | `text` | no vacío, máx. 6000 caracteres (mismo límite que `/api/analyze`) |
| `risk_level` | `text` | `bajo` \| `medio` \| `alto` |
| `signals` | `jsonb` | array (mismo array del contrato del clasificador) |
| `explanation` | `text` | no vacío |
| `recommended_action` | `text` | no vacío |
| `created_at` | `timestamptz` | default `now()` |

RLS: `checks_select_own` e `checks_insert_own`, ambas `auth.uid() = user_id`. Sin política
de `update`/`delete` — en esta etapa los análisis persistidos son de solo lectura una vez
creados (no hay edición ni historial visible todavía).

### Esquema (`alerts_sent`)

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK a `auth.users(id)` |
| `check_id` | `uuid` | FK a `checks(id)` |
| `contact_id` | `uuid` | FK a `family_contacts(id)` |
| `status` | `text` | `pending` \| `sent` \| `failed` |
| `error_message` | `text` | detalle solo cuando `status = 'failed'` |
| `sent_at` | `timestamptz` | seteado solo al pasar a `sent` |
| `created_at` | `timestamptz` | |

`unique (check_id, contact_id)`: como máximo una alerta por combinación
análisis+contacto — es la base de la idempotencia (ver abajo).

**Corrección de seguridad** (migración
`supabase/migrations/20260817004349_alerts_sent_lockdown.sql`, posterior a la creación de
la tabla): la versión original permitía que el propio usuario insertara una fila
`pending` y usara una función `security definer` (`set_alert_status`) para transicionar
el estado. Se detectó que, sin una service role key, no hay forma de distinguir "nuestro
backend" de "un usuario con su propia sesión llamando a la misma función RPC a mano" — el
mismo JWT que usa el servidor es el mismo que tiene el usuario. Por eso:

- Se eliminó la política de `INSERT` (`alerts_sent_insert_own_pending`).
- Se eliminó por completo la función `set_alert_status` (`DROP FUNCTION`, no solo
  `REVOKE`).
- Ahora RLS solo deja **`alerts_sent_select_own`** — un usuario autenticado puede
  consultar sus propias alertas, pero no puede insertar, actualizar, ni invocar nada para
  cambiarles el estado.
- Todas las escrituras (crear la fila `pending`, pasar a `sent`/`failed`, reintentar un
  `failed`) las hace `api/send-alert.ts` con un cliente **service role** (ver
  `SUPABASE_SERVICE_ROLE_KEY` más abajo), que bypassea RLS por diseño. La única llave que
  puede confirmar de verdad un envío es `RESEND_API_KEY`, y esa nunca sale del backend.
- Como el cliente service role ignora RLS, la integridad de "quién es dueño de qué" se
  garantiza con **foreign keys compuestas**, no con políticas: `alerts_sent` tiene
  `foreign key (check_id, user_id) references checks (id, user_id)` y
  `foreign key (contact_id, user_id) references family_contacts (id, user_id)` — ni
  siquiera el backend puede insertar una fila donde `user_id` no coincida con el dueño
  real del `check_id` o del `contact_id`, sin importar qué cliente use.

### Identidad privilegiada server-only (`SUPABASE_SERVICE_ROLE_KEY`)

- Se obtiene en el dashboard de Supabase → **Settings → API → service_role**. Es secreta
  (a diferencia de la anon key, que es pública por diseño).
- Vive **exclusivamente** en `api/_lib/supabaseAdmin.ts` (`createAdminClient()`), con
  `persistSession: false` y `autoRefreshToken: false` — no tiene sentido cachear/renovar
  sesión para una key que no expira sola.
- **Nunca** lleva prefijo `VITE_` (eso la incluiría en el bundle del navegador), **nunca**
  se importa desde `src/`, y no se loguea en ningún lado.
- Se usa únicamente para las escrituras de `alerts_sent`. Las lecturas de `checks` y
  `family_contacts` en `api/send-alert.ts` siguen usando `createUserScopedClient()` (RLS
  normal) — el cliente admin no reemplaza esas lecturas, solo evita que la falta de una
  política de escritura bloquee al propio backend.

### `/api/analyze` — persistencia

Después de que Gemini devuelve un resultado válido, se guarda en `checks` usando el
**token del propio usuario** (no una service role key), así RLS sigue siendo la barrera
real. El `body` de la respuesta sigue siendo exactamente el contrato del clasificador —
sin `check_id` adentro — y el id de la fila creada viaja en el header **`X-Check-ID`**. Si
falla el guardado, el endpoint no devuelve el resultado como si estuviera disponible para
alertar: responde `502`.

### `POST /api/send-alert`

Protegido con `requireAuth()`. Recibe únicamente:

```json
{ "check_id": "uuid", "contact_id": "uuid" }
```

Todo lo demás (email destinatario, nivel de riesgo, señales, explicación, acción
recomendada) se recupera de Supabase con la sesión del usuario — nunca se confía en un
valor mandado por el cliente para esos campos. Verifica que el análisis y el contacto
sean del usuario autenticado (si no, `404` genérico, sin distinguir "no existe" de "es de
otra cuenta"), y que el riesgo sea `medio` o `alto` (si es `bajo`, `422`, sin llamar a
Resend). El email es texto plano (nombre del contacto, nivel, señales, explicación,
acción recomendada y el disclaimer de siempre) — nunca el `raw_text` completo, ni
tokens, ni la imagen original.

**Idempotencia en la base (compare-and-set)**: la primera request para un par
(`check_id`, `contact_id`) inserta una fila `pending`, protegida por el `unique` de la
tabla — si dos requests llegan casi al mismo tiempo, la base solo deja pasar un `INSERT`,
la otra recibe automáticamente el conflicto (`23505`) y el endpoint responde `409`. Si ya
está `sent`, también `409`. Si quedó `failed` (por ejemplo, un error temporal de Resend),
el reintento hace `UPDATE ... SET status = 'pending' WHERE id = ... AND status = 'failed'`
— es decir, **solo transiciona si el estado seguía siendo exactamente `failed`** en el
momento del `UPDATE`. Postgres serializa los `UPDATE` concurrentes sobre la misma fila: si
dos requests intentan este mismo reintento a la vez, la primera en commitear gana (deja el
estado en `pending`) y la segunda evalúa su `WHERE status = 'failed'` contra el valor ya
actualizado, no matchea, afecta 0 filas, y el endpoint responde `409` — nunca se disparan
dos emails para la misma alerta. Las transiciones posteriores (`pending → sent`,
`pending → failed`) son igual de condicionales: cada `UPDATE` exige `status = 'pending'` y
se verifica que haya afectado exactamente una fila antes de confiar en el resultado. Si la
confirmación final a `sent` no puede aplicarse de forma consistente, el endpoint responde
`500` en vez de devolver `{ "status": "sent" }` sin esa garantía.

**Idempotencia en Resend**: cada llamada a `resend.emails.send()` incluye
`{ idempotencyKey: alertId }` (el UUID de la fila de `alerts_sent`, vía el segundo
parámetro `CreateEmailRequestOptions` del SDK — confirmado contra los tipos instalados,
`node_modules/resend/dist/index.d.mts`), enviado como header `Idempotency-Key`. Como el
`alertId` es siempre el mismo en todos los reintentos de una misma alerta (nunca se crea
una fila nueva para un reintento), esto evita un segundo email real si Resend aceptó el
envío pero se perdió la respuesta, o si el endpoint se reintenta tras un timeout — Resend
devuelve el mismo `id` de email para la misma `idempotencyKey` en vez de crear uno nuevo.
**Resend mantiene esta deduplicación durante 24 horas** desde el primer uso de la clave;
pasado ese margen, un reintento con la misma clave ya no está garantizado como duplicado
(ver [docs de Resend](https://resend.com/docs/dashboard/emails/idempotency-keys)) — un
reintento manual más de un día después de un fallo original podría generar un email
nuevo, algo razonable para este caso de uso.

Respuestas: `401` sin sesión · `400` ids con formato inválido · `404` análisis o contacto
inexistente/ajeno · `409` ya enviado o en curso (incluye la carrera perdida en un
reintento) · `422` riesgo bajo · `500` config faltante, inconsistencia de estado o error
interno · `502` Resend rechazó el envío.

### Configurar Resend

1. Creá una cuenta gratuita en [resend.com](https://resend.com) y generá una API key en
   **API Keys** (alcanza con una key restringida a "solo enviar").
2. Sin un dominio propio verificado, usá el remitente de prueba
   `onboarding@resend.dev` como `RESEND_FROM_EMAIL` — con ese remitente, Resend solo
   entrega al email con el que te registraste en la cuenta (no a cualquier destinatario).
   Para mandar a cualquier contacto real hace falta verificar un dominio propio en
   **Domains** y usar una dirección de ese dominio.
3. Cargá `RESEND_API_KEY` y `RESEND_FROM_EMAIL` en `.env` (ver `.env.example`) y, para
   producción, en Vercel (**Settings → Environment Variables**).

**Estado actual (bloqueo externo real, sin resolver):** el proyecto **no tiene un dominio
propio verificado en Resend**. Producción usa `onboarding@resend.dev`, que Resend
restringe a entregar únicamente al email con el que se creó la cuenta de Resend — **no a
un contacto familiar arbitrario**. El flujo funciona end-to-end (confirmado con envíos
reales), pero solo puede demostrarse con ese único destinatario hasta que se verifique un
dominio propio en **Resend → Domains** (agregar registros DNS del dominio elegido). No se
compró ni registró ningún dominio como parte de esta corrección — es una decisión que le
corresponde al usuario del proyecto, no algo para resolver unilateralmente. Una vez
verificado un dominio, alcanza con actualizar `RESEND_FROM_EMAIL` a una dirección de ese
dominio (en `.env` y en Vercel) y volver a desplegar; el resto del código no cambia.

### Probar un envío real manualmente

1. Analizá un texto que dé riesgo medio o alto (`POST /api/analyze` autenticado) y
   guardate el header `X-Check-ID` de la respuesta.
2. Agregá (o usá) un contacto familiar cuyo email puedas revisar vos.
3. `POST /api/send-alert` con `{ "check_id": "...", "contact_id": "..." }` y el mismo
   Bearer token.
4. Revisá la bandeja de entrada de ese contacto — asunto, nivel de riesgo, señales,
   explicación, acción recomendada y el disclaimer tienen que estar presentes, sin ningún
   dato interno (tokens, claves, la imagen original).

## Límite del tier gratuito de Gemini (429)

El modelo usado permite 15 solicitudes por minuto en el tier gratuito. Si se supera, `/api/analyze`
y `/api/extract-image` devuelven **HTTP 429** (con header `Retry-After` cuando Gemini lo informa) y
la interfaz muestra: *"Se hicieron muchos análisis en poco tiempo. Esperá unos segundos y volvé a
intentar."* No hay reintentos automáticos (consumirían más cuota) — el usuario reintenta
manualmente cuando quiera. Por eso `npm run eval` y `npm run eval:image` no deben correrse repetidas
veces dentro de la misma ventana de un minuto contra producción.

## Deploy (Vercel)

El proyecto está listo para desplegar en Vercel sin configuración adicional (detecta
Vite automáticamente y despliega `api/` como funciones serverless).

1. Instalar el CLI si hace falta: `npm i -g vercel` (o usar `npx vercel`).
2. Iniciar sesión: `vercel login`.
3. Desde la carpeta del proyecto: `vercel` (preview) o `vercel --prod` (producción).
4. En el dashboard de Vercel del proyecto, ir a **Settings → Environment Variables** y
   cargar, para los entornos Production/Preview/Development:
   - `GEMINI_API_KEY` (y opcionalmente `GEMINI_MODEL`).
   - `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`.
5. Volver a desplegar (`vercel --prod`) para que build tome las variables (las `VITE_*`
   se inyectan en tiempo de build, no de runtime — por eso hace falta redeployar después
   de cargarlas o cambiarlas, no alcanza con solo guardarlas).

Alternativas equivalentes (requieren adaptar la función de `api/` al formato del
proveedor): Netlify Functions o Cloudflare Pages Functions.

## Seguridad y disclaimers

- La app nunca debe usarse para ingresar contraseñas, códigos de seguridad ni datos
  bancarios reales — se lo advierte de forma visible antes del formulario.
- El resultado siempre se acompaña de un disclaimer: la herramienta orienta, no
  garantiza certeza absoluta; ante la duda, verificar por el canal oficial.
- El analizador está protegido por Supabase Auth: sin sesión, solo se puede ver la
  pantalla de login/registro. La `anon key` de Supabase es pública por diseño (va al
  bundle); la `service_role key` nunca debe cargarse en variables `VITE_*` ni usarse del
  lado del cliente.
