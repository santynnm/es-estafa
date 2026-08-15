export class FileReadError extends Error {}

// Lee un File y devuelve su contenido en base64 sin el prefijo data:*;base64,
// — el mismo formato que espera /api/extract-image.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = typeof result === "string" ? result.split(",")[1] : undefined;
      if (!base64) {
        reject(new FileReadError("No se pudo leer el archivo."));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new FileReadError("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
