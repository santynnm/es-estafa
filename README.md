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
avisarle a un contacto familiar por email vía [Brevo](https://www.brevo.com) (plan
transaccional gratuito). **Todavía no hay botón en la interfaz** — el flujo se probó por
API; el botón "Avisarle a un familiar" es el Día 7B.

**Corrección 7A.1**: el proveedor de email original era Resend. Se reemplazó por Brevo
porque, sin comprar/verificar un dominio propio, el remitente de prueba de Resend
(`onboarding@resend.dev`) solo puede entregar al email con el que se creó la cuenta de
Resend — no a un contacto familiar arbitrario. Brevo permite verificar un remitente
individual (sin dominio) que sí entrega a cualquier destinatario, dentro de su plan
gratuito (300 emails/día). El resto de las garantías de esta sección (RLS,
`SUPABASE_SERVICE_ROLE_KEY`, compare-and-set en `alerts_sent`) no cambió.

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
  puede confirmar de verdad un envío es `BREVO_API_KEY`, y esa nunca sale del backend.
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
Brevo). El email es texto plano (nombre del contacto, nivel, señales, explicación,
acción recomendada y el disclaimer de siempre) — nunca el `raw_text` completo, ni
tokens, ni la imagen original.

**Idempotencia en la base (compare-and-set)**: la primera request para un par
(`check_id`, `contact_id`) inserta una fila `pending`, protegida por el `unique` de la
tabla — si dos requests llegan casi al mismo tiempo, la base solo deja pasar un `INSERT`,
la otra recibe automáticamente el conflicto (`23505`) y el endpoint responde `409`. Si ya
está `sent`, también `409`. Si quedó `failed` (por ejemplo, un error temporal de Brevo),
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

**Idempotencia en Brevo (corrección 7A.1B — hallazgo verificado con envíos reales, no
asumido de la documentación)**: una primera investigación (corrección 7A.1) concluyó
—incorrectamente— que Brevo no ofrecía idempotencia real en este endpoint, basándose en
que el campo `headers` de `SendTransacEmailRequest` está documentado como "custom email
headers" con un ejemplo `{"Idempotency-Key": "abc-123"}`, que leído aisladamente parece
un header MIME cosmético del email de salida. Se corrigió esa conclusión tras encontrar
la página oficial ["Idempotency for batch
emails"](https://developers.brevo.com/docs/heterogenous-versions-batch-emails) y
**confirmarla con una prueba real, no solo con la documentación**: dos llamadas directas
a `sendAlertEmail()` con el mismo `idempotencyKey` (vía `headers: { idempotencyKey }`,
en `camelCase`, dentro del body de la request — no un header HTTP de la llamada, ni un
header del email saliente, sino un campo especial que la API de Brevo intercepta) dieron
como resultado: la primera, un `messageId` real; la segunda, un error estructurado real:

```json
{ "code": "duplicate_parameter", "message": "Email for the idempotency key has already been processed" }
```

(HTTP `400`, lanzado por el SDK como `BrevoError` con `statusCode: 400` y ese `body`).
Se confirmó además contra el propio panel de Brevo
(`transactionalEmails.getTransacEmailsList()`) que solo existe **un** email real para
esa prueba, no dos. `api/_lib/brevo.ts` detecta este caso específico con un type guard
acotado (`err instanceof BrevoError && err.statusCode === 400 && err.body.code ===
"duplicate_parameter"` — nunca compara el texto de `message`, que podría cambiar de
idioma) y lo trata como un envío ya confirmado (`alreadyProcessed: true`), no como un
fallo: `api/send-alert.ts` completa igual la transición `pending → sent`, sin devolver
`502` ni dejar la alerta en `failed`. Un error de Brevo con cualquier otro `code` (por
ejemplo `invalid_parameter`) sigue tratándose como un fallo genuino: `EmailSendError`,
`pending → failed`, `502` — verificado también con una llamada real.

**El TTL documentado por Brevo es de 30 minutos** desde el primer uso de la clave;
pasado ese margen, un reintento con el mismo `idempotencyKey` ya no está garantizado
como duplicado y **podría generar un email nuevo**. El `messageId` que devuelve Brevo en
cada envío exitoso, y la confirmación de `duplicate_parameter` en los reintentos, se
loguean server-side junto al `alertId` para poder reconciliar manualmente contra el
dashboard de Brevo si hiciera falta — no se persisten en la base porque el esquema de
`alerts_sent` no tiene una columna para eso y agregarla está fuera del alcance de esta
corrección. Ver la subsección siguiente para el detalle honesto de qué protege cada capa
y qué no.

### Política de reintentos y garantía de entrega (corrección 7A.1C)

Este MVP **no ofrece una garantía de "exactamente una vez"** para el envío de alertas.
La decisión explícita, para un proyecto sin capital para infraestructura adicional
(colas, webhooks de confirmación, tablas de reconciliación), es priorizar poder
reenviar una alerta importante después de una falla temporal por sobre eliminar por
completo un riesgo excepcional y de bajo impacto (un email duplicado, no una pérdida de
datos ni una brecha de seguridad). Concretamente, cada capa protege una cosa distinta,
y ninguna por sí sola cubre todos los casos:

- **`unique(check_id, contact_id)` en `alerts_sent`**: impide que exista más de una FILA
  para la misma combinación análisis+contacto — no importa cuánto tiempo pase, nunca va a
  haber dos alertas "en paralelo" para el mismo par. Esto es indefinido en el tiempo,
  pero protege la unicidad de la fila, no la unicidad del email enviado a través de ella.
- **Las transiciones compare-and-set** (`UPDATE ... WHERE status = '<esperado>'`):
  garantizan que, ante dos requests concurrentes sobre la misma fila, exactamente una
  gane cada transición de estado — la otra recibe `409` sin haber disparado un envío.
  También indefinido en el tiempo, también acotado a la concurrencia, no al reintento.
- **`headers.idempotencyKey` en Brevo**: deduplica reintentos del mismo `alertId` **solo
  dentro de un TTL de 30 minutos** desde el primer uso de la clave (ver arriba). Pasado
  ese margen, dejó de proteger.

Los cuatro escenarios reales, verificados con envíos y compare-and-set reales:

1. **Dos requests simultáneas** (mismo par análisis+contacto, cualquier estado
   reintentable): una gana la transición y responde `200`, la otra recibe `409` — nunca
   se disparan dos envíos.
2. **Reintento de una alerta `failed`, dentro de los 30 minutos** de un envío que Brevo
   ya había aceptado: Brevo responde `duplicate_parameter`, `api/send-alert.ts` lo
   interpreta como ya confirmado y transiciona a `sent` — no se genera un segundo email.
3. **Reintento de una alerta `failed`, después de los 30 minutos**: Brevo ya no puede
   distinguir ese reintento de un envío nuevo y **puede aceptarlo como tal** — existe un
   riesgo excepcional y aceptado de que el contacto reciba un email duplicado si el envío
   original en realidad sí había sido entregado (por ejemplo, si Brevo lo aceptó pero la
   aplicación no llegó a confirmar `sent` antes de que algo fallara). Es, en la
   terminología estándar de sistemas distribuidos, una política de entrega **"al menos
   una vez"**, no "exactamente una vez".
4. **Alerta ya confirmada como `sent`**: nunca se vuelve a intentar — cualquier request
   posterior para el mismo par análisis+contacto responde `409` de inmediato, sin llamar
   a Brevo.

Los límites de reintentos por usuario/globales (corrección 7A.2, todavía sin
implementar) van a acotar cuántas veces puede ocurrir el escenario 3 en la práctica, pero
no lo eliminan — ese es un límite de este MVP, documentado en vez de ocultado.

Respuestas: `401` sin sesión · `400` ids con formato inválido · `404` análisis o contacto
inexistente/ajeno · `409` ya enviado o en curso (incluye la carrera perdida en un
reintento) · `422` riesgo bajo · `500` config faltante, inconsistencia de estado o error
interno · `502` Brevo rechazó el envío.

### Configurar Brevo

1. Creá una cuenta gratuita en [brevo.com](https://www.brevo.com) (plan Free, sin tarjeta
   ni plan pago) y verificá el número de teléfono si te lo pide (paso manual de Brevo,
   no automatizable).
2. Agregá un remitente propio en **Settings → Senders, Domains & Dedicated IPs → Add a
   sender** con un email real que controles, y confirmá el código que Brevo manda a esa
   casilla. Sin un dominio propio autenticado (DKIM/SPF), la entregabilidad **no es
   equivalente a la de un dominio propio** — puede haber más probabilidad de que el email
   caiga en spam; no se compró ni registró ningún dominio como parte de esta corrección.
3. Generá una API key en **Settings → SMTP & API → API Keys → Generate a new API key**.
4. **IPs autorizadas**: por defecto Brevo puede exigir que las llamadas a la API vengan
   de una IP autorizada (**Settings → Security → Authorised IPs**). Las funciones
   serverless de Vercel **no tienen una IP de salida fija** (se observaron al menos tres
   IPs de egreso distintas entre invocaciones locales y de producción) — mantener esa
   restricción activa bloquea el envío de forma intermitente e impredecible. Por eso hay
   que **desactivar la restricción de IP** en esa pantalla (no alcanza con ir agregando
   IPs una por una). La única protección de la API key queda entonces la propia key
   (nunca expuesta al cliente), igual que con la mayoría de proveedores de email
   transaccional.
5. Cargá `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` y `BREVO_SENDER_NAME` en `.env` (ver
   `.env.example`) y, para producción, en Vercel (**Settings → Environment Variables**).

**Estado actual**: a diferencia de Resend (bloqueado a un único destinatario sin
dominio), el remitente verificado individualmente en Brevo **sí entrega a cualquier
destinatario real**, confirmado con envíos de riesgo medio y alto tanto en local como en
producción (`https://codercup.vercel.app`), a una dirección distinta de la cuenta
propietaria de Brevo. La limitación de entregabilidad (sin dominio propio autenticado)
sigue siendo real y queda documentada arriba.

### Probar un envío real manualmente

1. Analizá un texto que dé riesgo medio o alto (`POST /api/analyze` autenticado) y
   guardate el header `X-Check-ID` de la respuesta.
2. Agregá (o usá) un contacto familiar cuyo email puedas revisar vos.
3. `POST /api/send-alert` con `{ "check_id": "...", "contact_id": "..." }` y el mismo
   Bearer token.
4. Revisá la bandeja de entrada de ese contacto — asunto, nivel de riesgo, señales,
   explicación, acción recomendada y el disclaimer tienen que estar presentes, sin ningún
   dato interno (tokens, claves, la imagen original).

## Cupos diarios de email (corrección 7A.2A)

Persistencia y operación atómica para limitar cuántos intentos de envío de alerta puede
haber por día — **todavía no está conectada a `/api/send-alert`** (eso es la corrección
7A.2B, después de auditar esta subetapa). Por ahora `POST /api/send-alert` sigue
funcionando exactamente como en 7A.1C, sin ningún límite de cuota.

### Límites

- **5 intentos por usuario por día UTC.**
- **250 intentos globales por día UTC** — entre todos los usuarios juntos. Deja un margen
  de 50 respecto del límite gratuito de **300 emails/día** de Brevo, para dejar lugar a
  reintentos legítimos de alertas `failed` fuera del TTL de idempotencia (ver la sección
  "Política de reintentos y garantía de entrega" más arriba) sin arriesgarse a que Brevo
  mismo empiece a rechazar por exceso de cuota.
- El día se calcula **siempre server-side, en UTC**, a partir de `now()` dentro de la
  función SQL — ningún caller, ni siquiera uno con la service role key, puede elegir qué
  día se usa (la función no acepta ningún parámetro de fecha).

### Qué cuenta como "intento" (para cuando 7A.2B la conecte)

**Consume un intento**: cada llamada efectivamente hecha a
`transactionalEmails.sendTransacEmail()` — exista éxito, un error genuino de Brevo, o un
resultado `duplicate_parameter` (el proveedor sí recibió y procesó la solicitud, aunque
sea para deduplicarla).

**No consume un intento**: fallos de validación (`400`), sin sesión (`401`), análisis o
contacto ajeno/inexistente (`404`), riesgo bajo (`422`), una alerta que ya está `sent` o
`pending` (`409`), y una request que pierde el compare-and-set contra otra simultánea
(`409`) — ninguno de esos casos llega a llamar a Brevo.

### Esquema (`email_user_daily_usage`, `email_global_daily_usage`)

| Tabla | Columnas | Notas |
|---|---|---|
| `email_user_daily_usage` | `user_id` (FK a `auth.users`, `on delete cascade`), `usage_date`, `attempt_count`, `updated_at` | PK `(user_id, usage_date)` — una fila por usuario y día UTC |
| `email_global_daily_usage` | `usage_date`, `attempt_count`, `updated_at` | PK `usage_date` — una fila agregada por día UTC, sin referencia a ningún usuario |

Ninguna de las dos tablas guarda emails, nombres, `raw_text` ni contenido del mensaje —
solo contadores enteros por período.

### Operación atómica (`reserve_email_attempt`)

`reserve_email_attempt(p_user_id uuid)` reserva un intento o lo rechaza, en una única
transacción implícita:

1. Asegura y **bloquea** (`SELECT ... FOR UPDATE`) la fila de `email_user_daily_usage`
   del usuario para hoy (UTC). **Siempre en este orden** — la fila de usuario primero,
   la global después, nunca al revés — así ninguna invocación puede estar esperando el
   lock que tiene otra ("orden de locking consistente" pedido en el enunciado): es
   imposible que se forme un ciclo de espera entre dos llamadas.
2. Si el contador individual ya está en 5, devuelve `user_limit` sin tocar la fila
   global en absoluto.
3. Si no, asegura y bloquea la fila de `email_global_daily_usage` de hoy.
4. Si el contador global ya está en 250, devuelve `global_limit` sin haber incrementado
   el individual (el chequeo de ambos límites siempre ocurre **antes** de incrementar
   cualquiera de los dos).
5. Si ninguno de los dos límites se superó, incrementa **los dos contadores juntos**, en
   la misma transacción, y devuelve `reserved`.

Devuelve siempre una fila `{ result, user_count, global_count }`, con `result` en
`'reserved' | 'user_limit' | 'global_limit'`.

**No usa `SECURITY DEFINER`**: el único rol que puede ejecutarla es `service_role` (ver
grants abajo), que ya bypassea RLS por sí mismo — no hace falta escalar privilegios.
Se deja en `SECURITY INVOKER` (el default) para minimizar superficie de ataque, con
`search_path` fijado explícitamente (`public, pg_temp`) y todos los objetos calificados
con `public.` de todas formas, como buena práctica.

### Seguridad (defensa en profundidad)

- RLS habilitado en ambas tablas, **sin ninguna política** para `anon` ni
  `authenticated` — con RLS activo y cero políticas, ninguno de los dos roles puede leer
  ni escribir ni una fila.
- **Revocación explícita** de todos los privilegios de tabla para `PUBLIC`, `anon` y
  `authenticated` (no alcanza con RLS solo: sin el `GRANT` subyacente tampoco pueden
  emitir el comando en absoluto).
- `EXECUTE` sobre `reserve_email_attempt` revocado de `PUBLIC`/`anon`/`authenticated` y
  otorgado únicamente a `service_role`.
- Nadie puede consultar su propio consumo ni, mucho menos, el agregado global, desde el
  cliente — no hay ningún grant de lectura para `authenticated`. Si una etapa futura
  necesita mostrarle a un usuario su propio consumo, se agregará explícitamente en otra
  migración, nunca acceso al agregado global.
- Verificado con clientes reales (no solo revisando las políticas): `anon` y un usuario
  `authenticated` real reciben `42501 permission denied` tanto en `SELECT`/`INSERT`/
  `UPDATE`/`DELETE` sobre ambas tablas como al invocar la RPC; `service_role` sí puede
  ejecutarla.

### Verificado con pruebas aisladas (sin gastar cuota real de Brevo ni contaminar el día real)

Para probar límites y períodos sin tocar los contadores del día UTC real, se usó una
función SQL temporal (`_test_reserve_email_attempt_for_date`, idéntica a
`reserve_email_attempt` salvo por un parámetro de fecha explícito) creada, usada y
**eliminada** dentro de la misma sesión de pruebas — nunca formó parte de ninguna
migración ni quedó expuesta en producción. Con fechas de prueba fuera de cualquier rango
real (`2000-01-0X`) y un segundo usuario de prueba (creado y borrado en la misma sesión):

- 5 reservas secuenciales de un usuario → `reserved`; la 6ª → `user_limit`; contador
  individual final: exactamente 5; contador global no se movió con el rechazo.
- Contador global preparado en 249, dos reservas simultáneas de usuarios distintos →
  exactamente una `reserved` y una `global_limit`; contador global final: exactamente
  250; el que perdió por límite global no incrementó su contador individual.
- Contador individual preparado en 4, dos reservas simultáneas del mismo usuario →
  exactamente una `reserved` y una `user_limit`; contador individual final: exactamente
  5; el que perdió por límite individual no incrementó el contador global.
- Dos fechas UTC distintas para el mismo usuario mantienen contadores completamente
  independientes.

No se realizó ninguna llamada a Brevo durante esta verificación, ni se creó ninguna
tabla, función o usuario que haya quedado después de terminar las pruebas.

### Evaluación reproducible (corrección 7A.2A.1)

La verificación manual de arriba quedó automatizada en `scripts/eval-email-quota.mts`,
reutilizable como prueba de regresión de esta capa (incluso después de que 7A.2B la
conecte a `/api/send-alert`).

**Comando**:

```bash
npm run eval:quota
```

**Advertencia**: este script **no llama a Brevo, no envía emails, y no modifica los
contadores reales de cupo** — todas las pruebas de límites y concurrencia corren dentro
de un schema SQL aislado y descartable.

**Variables requeridas** (ver `.env.example`):

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — cliente `anon`, para las pruebas de
  permisos.
- `EVAL_USER_EMAIL`, `EVAL_USER_PASSWORD` — usuario `authenticated` real, mismas pruebas.
- `SUPABASE_ACCESS_TOKEN` — Personal Access Token de Supabase (Management API). Se lee
  **solo** de esta variable de entorno; el script nunca lo escribe a un archivo, nunca lo
  imprime y nunca lo incluye en un mensaje de error. **Pasalo solo en memoria de tu
  shell**, nunca en `.env` ni en ningún archivo del repo.
- `SUPABASE_PROJECT_REF` — ref del proyecto (no es secreto).

Si faltan `SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_REF`, el script se detiene con un
mensaje explícito y código de salida distinto de cero — nunca cae de vuelta a operar
contra las tablas reales como alternativa.

**Qué comprueba, en orden** (aborta antes de crear el schema aislado si el paso 1, 2 o 3
falla):

1. **La migración versionada no fue modificada**: compara el archivo actual contra el
   contenido exacto del mismo archivo en el commit `9ec0081` (vía `git show`), no un hash
   hardcodeado.
2. **Invariantes textuales de la migración**: límites (5 / 250), los tres nombres de
   resultado, orden de locking (usuario antes que global), exactamente dos `UPDATE` de
   incremento, ausencia de `SECURITY DEFINER`, `search_path` fijado — sobre el texto sin
   comentarios de línea (un comentario que *explica* por qué no se usa `SECURITY
   DEFINER` contiene esa misma frase, así que compararlo tal cual daría un falso
   positivo).
3. **La función realmente desplegada coincide con la migración**: trae
   `pg_get_functiondef` de `public.reserve_email_attempt` vía la Management API y lo
   compara contra la migración con una normalización mecánica documentada en el propio
   script — el **cuerpo** plpgsql se compara con espacios en blanco colapsados (Postgres
   no reescribe el cuerpo, solo el encabezado), y el **encabezado** se compara por partes
   semánticas (nombre+argumentos, columnas de retorno con sinónimos de tipo
   normalizados como `int`→`integer`, `LANGUAGE`, ausencia de `SECURITY DEFINER`,
   `search_path`), porque `pg_get_functiondef` reescribe la sintaxis del encabezado de
   forma consistente pero no idéntica carácter a carácter (ej. `set x = y` →
   `SET x TO 'y'`).
4. **Permisos sobre los objetos reales**: `anon` y un usuario `authenticated` real
   reciben `42501` en `SELECT`/`INSERT`/`UPDATE`/`DELETE` sobre ambas tablas y al invocar
   la RPC (un rechazo de permisos no llega a ejecutar el cuerpo de la función, así que no
   consume cupo real). `service_role` se verifica por catálogo
   (`has_function_privilege`/`has_table_privilege`), **sin invocar la función** — así
   tampoco consume una reserva real.
5. **Pruebas funcionales dentro de un schema aislado** (`quota_eval_<16 hex aleatorios>`,
   nombre validado con una regex estricta antes de interpolarlo en cualquier SQL, y
   rechazado explícitamente si coincidiera con `public`/`auth`/`storage`/etc.): reproduce
   fielmente la lógica de `reserve_email_attempt` (con dos diferencias documentadas y
   deliberadas — sin FK a `auth.users`, para poder usar UUIDs ficticios sin crear
   usuarios reales, y con un parámetro de fecha explícito, para poder probar distintos
   "días" sin depender del reloj real). Corre los mismos cuatro escenarios que la
   verificación manual (5 secuenciales + rechazo 6, carrera individual con contador en 4,
   carrera global con contador en 249, períodos UTC independientes) más un `user_id`
   nulo rechazado — **todas las carreras usan `Promise.all` sobre conexiones/requests
   HTTP separadas a la Management API, nunca llamadas secuenciales simulando
   concurrencia**.
6. **Limpieza garantizada ante un fallo**: crea un segundo schema aislado, fuerza
   deliberadamente un error justo después de crearlo, y confirma — desde afuera, con una
   consulta a `pg_namespace` — que el bloque `finally` lo eliminó de todas formas.
7. **Cero residuos**: confirma que no queda ningún schema `quota_eval_*` y que las
   tablas reales (`email_user_daily_usage`, `email_global_daily_usage`) tienen
   exactamente el mismo conteo de filas y la misma suma de `attempt_count` que tenían
   antes de correr el script.

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
