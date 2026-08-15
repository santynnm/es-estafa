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
frontend y backend y no debe modificarse: es lo que permite agregar `image_ocr` (Día 3-4)
y `audio_transcript` (a futuro) sin tocar el núcleo.

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

   `GEMINI_MODEL` es opcional (por defecto usa `gemini-2.0-flash`).

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
