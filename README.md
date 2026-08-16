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
