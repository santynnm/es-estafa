# ¿Es estafa?

MVP (Día 1) de una app web que ayuda a identificar si un mensaje, SMS, email o llamada
descripta por texto es una estafa. El usuario pega el texto, se analiza con Google Gemini
y se muestra un veredicto de riesgo (bajo/medio/alto) con señales, explicación y una
acción recomendada. Ver `indicaciones.md` para la especificación completa del proyecto.

En esta etapa **no hay login ni persistencia**: es solo el flujo de análisis de texto
funcionando de punta a punta.

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

## Evaluar el clasificador (Día 2)

Hay un conjunto de evaluación reproducible en `scripts/eval-classifier.mts` con los seis
casos de la sección 10 de `indicaciones.md` (cinco de estafa + un control neutral) más
tres casos de robustez: intento de inyección de instrucciones dentro del texto, un
mensaje urgente pero legítimo (para chequear que no se marque como riesgo alto solo por
tener urgencia), y texto vacío. Llama al endpoint real `/api/analyze` — no usa mocks.

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
calibrado del Día 2 — no hay un prompt de riesgo separado para imágenes. Todavía **no
hay interfaz de subida** en el frontend; esta etapa es solo el pipeline backend.

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

## Deploy (Vercel)

El proyecto está listo para desplegar en Vercel sin configuración adicional (detecta
Vite automáticamente y despliega `api/` como funciones serverless).

1. Instalar el CLI si hace falta: `npm i -g vercel` (o usar `npx vercel`).
2. Iniciar sesión: `vercel login`.
3. Desde la carpeta del proyecto: `vercel` (preview) o `vercel --prod` (producción).
4. En el dashboard de Vercel del proyecto, ir a **Settings → Environment Variables** y
   cargar `GEMINI_API_KEY` (y opcionalmente `GEMINI_MODEL`) para los entornos
   Production/Preview/Development.
5. Volver a desplegar (`vercel --prod`) para que la función tome la variable.

Alternativas equivalentes (requieren adaptar la función de `api/` al formato del
proveedor): Netlify Functions o Cloudflare Pages Functions.

## Seguridad y disclaimers

- La app nunca debe usarse para ingresar contraseñas, códigos de seguridad ni datos
  bancarios reales — se lo advierte de forma visible antes del formulario.
- El resultado siempre se acompaña de un disclaimer: la herramienta orienta, no
  garantiza certeza absoluta; ante la duda, verificar por el canal oficial.
