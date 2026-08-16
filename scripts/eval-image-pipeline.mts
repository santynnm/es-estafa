// Pruebas reproducibles del pipeline imagen -> texto -> clasificador (Día 3-4A).
// Llama a los endpoints reales /api/extract-image y /api/analyze (sin mocks).
// Los endpoints requieren sesión desde la corrección previa al Día 7 — el
// script inicia sesión con un usuario de evaluación antes de correr los
// casos. Ver EVAL_USER_EMAIL/EVAL_USER_PASSWORD en .env.example.
//
// Uso:
//   npm run eval:image                                      # contra producción (https://codercup.vercel.app)
//   EVAL_BASE_URL=http://localhost:3000 npm run eval:image   # contra vercel dev en local

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isClassifierResult } from "../shared/classifierContract.ts";
import { getEvalAccessToken } from "./evalAuth.mts";

const BASE_URL = process.env.EVAL_BASE_URL || "https://codercup.vercel.app";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "tests", "fixtures");

function b64(file: string): string {
  return readFileSync(path.join(FIXTURES_DIR, file)).toString("base64");
}

async function extractImage(image_base64: string, mime_type: string, accessToken: string) {
  const res = await fetch(`${BASE_URL}/api/extract-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ image_base64, mime_type }),
  });
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
}

interface CaseResult {
  id: string;
  description: string;
  pass: boolean;
  detail: string;
}

const results: CaseResult[] = [];

function record(id: string, description: string, pass: boolean, detail: string) {
  results.push({ id, description, pass, detail });
  console.log(`- ${id} ... ${pass ? "PASS" : `FAIL (${detail})`}`);
}

async function main() {
  const accessToken = await getEvalAccessToken();
  console.log(`Evaluando pipeline de imagen contra: ${BASE_URL}\n`);

  // 1. PNG válido con mensaje de estafa.
  {
    const { status, body } = await extractImage(b64("scam-message.png"), "image/png", accessToken);
    const rawText = (body as { raw_text?: string } | null)?.raw_text ?? "";
    const ok =
      status === 200 &&
      /tarjeta/i.test(rawText) &&
      /bloque/i.test(rawText);
    record("png-valido", "PNG válido con mensaje de estafa", ok, `status=${status} raw_text=${JSON.stringify(rawText)}`);
  }

  // 2. WebP válido, mismo contenido.
  {
    const { status, body } = await extractImage(b64("scam-message.webp"), "image/webp", accessToken);
    const rawText = (body as { raw_text?: string } | null)?.raw_text ?? "";
    const ok = status === 200 && /tarjeta/i.test(rawText) && /bloque/i.test(rawText);
    record("webp-valido", "WebP válido con mensaje de estafa", ok, `status=${status} raw_text=${JSON.stringify(rawText)}`);
  }

  // 3. MIME inválido.
  {
    const { status, body } = await extractImage(b64("scam-message.png"), "image/gif", accessToken);
    const ok = status === 400 && typeof (body as { error?: unknown } | null)?.error === "string";
    record("mime-invalido", "mime_type no permitido (image/gif)", ok, `status=${status} body=${JSON.stringify(body)}`);
  }

  // 4. Base64 inválido.
  {
    const { status, body } = await extractImage("esto-no-es-base64-!!!valido", "image/png", accessToken);
    const ok = status === 400 && typeof (body as { error?: unknown } | null)?.error === "string";
    record("base64-invalido", "image_base64 no decodificable", ok, `status=${status} body=${JSON.stringify(body)}`);
  }

  // 5. Imagen demasiado grande: >3MB decodificados (nuestro límite) pero por debajo
  // del límite de body de la plataforma Vercel, para ejercitar nuestra propia
  // validación (400 JSON) en vez del 413 genérico de la plataforma.
  {
    const big = Buffer.alloc(3.2 * 1024 * 1024, 1).toString("base64");
    const { status, body } = await extractImage(big, "image/png", accessToken);
    const ok = status === 400 && typeof (body as { error?: unknown } | null)?.error === "string";
    record("imagen-demasiado-grande", "imagen > 3MB decodificados", ok, `status=${status} body=${JSON.stringify(body)}`);
  }

  // 6. Imagen sin texto legible.
  {
    const { status, body } = await extractImage(b64("no-text.png"), "image/png", accessToken);
    const ok = status === 422 && typeof (body as { error?: unknown } | null)?.error === "string";
    record("sin-texto-legible", "imagen sin texto legible", ok, `status=${status} body=${JSON.stringify(body)}`);
  }

  // 7. Integración completa: imagen de estafa -> extracción -> clasificador (source_type: image_ocr).
  {
    const extracted = await extractImage(b64("scam-message.png"), "image/png", accessToken);
    const rawText = (extracted.body as { raw_text?: string } | null)?.raw_text ?? "";

    if (extracted.status !== 200 || !rawText) {
      record(
        "integracion-imagen-a-clasificador",
        "imagen de estafa -> extract-image -> analyze (image_ocr)",
        false,
        `extract-image falló: status=${extracted.status} body=${JSON.stringify(extracted.body)}`,
      );
    } else {
      const res = await fetch(`${BASE_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ raw_text: rawText, source_type: "image_ocr" }),
      });
      const classifyBody: unknown = await res.json().catch(() => null);

      const ok = res.ok && isClassifierResult(classifyBody) && classifyBody.risk_level === "alto";
      record(
        "integracion-imagen-a-clasificador",
        "imagen de estafa -> extract-image -> analyze (image_ocr)",
        ok,
        `raw_text=${JSON.stringify(rawText)} status=${res.status} body=${JSON.stringify(classifyBody)}`,
      );
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} casos OK.`);
  if (failed.length > 0) {
    console.log(`Fallaron: ${failed.map((r) => r.id).join(", ")}`);
    process.exitCode = 1;
  }
}

main();
