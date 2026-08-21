import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { formatBytes } from "../lib/imageFile";

const ALLOWED_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 3 * 1024 * 1024;

interface ImageUploadProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
  error: string | null;
  onErrorChange: (message: string | null) => void;
  disabled?: boolean;
}

export function ImageUpload({ file, onFileChange, error, onErrorChange, disabled }: ImageUploadProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Crea el ObjectURL de la preview cuando cambia el archivo y lo libera al
  // reemplazarlo o al desmontar, para no filtrar memoria.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function resetInputValue() {
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    if (!selected) {
      onFileChange(null);
      onErrorChange(null);
      return;
    }
    if (!ALLOWED_MIME_TYPES.includes(selected.type)) {
      onErrorChange("Formato no permitido. Usá una imagen PNG, JPEG o WebP.");
      onFileChange(null);
      resetInputValue();
      return;
    }
    if (selected.size === 0) {
      onErrorChange("El archivo está vacío. Elegí otra imagen.");
      onFileChange(null);
      resetInputValue();
      return;
    }
    if (selected.size > MAX_BYTES) {
      onErrorChange("La imagen es demasiado grande (máximo 3 MB).");
      onFileChange(null);
      resetInputValue();
      return;
    }
    onErrorChange(null);
    onFileChange(selected);
  }

  function handleRemove() {
    onFileChange(null);
    onErrorChange(null);
    resetInputValue();
  }

  return (
    <div>
      <label htmlFor="image-upload" className="block text-lg font-semibold">
        Subí una captura de pantalla
      </label>

      {!file && (
        <div className="mt-2 rounded-xl focus-within:ring-2 focus-within:ring-purple-400">
          <label
            htmlFor="image-upload"
            className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 bg-white p-8 text-center text-base text-gray-600 transition hover:border-purple-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"
          >
            <span className="text-3xl" aria-hidden="true">
              📷
            </span>
            <span>Tocá para elegir una imagen (PNG, JPEG o WebP, máx. 3 MB)</span>
          </label>
        </div>
      )}

      <input
        ref={inputRef}
        id="image-upload"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleChange}
        disabled={disabled}
        className="sr-only"
      />

      {file && (
        <div className="mt-2 rounded-xl border-2 border-gray-300 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          {previewUrl && (
            <img
              src={previewUrl}
              alt="Vista previa de la captura seleccionada"
              className="mx-auto max-h-64 w-auto rounded-lg object-contain"
            />
          )}
          <div className="mt-3 flex flex-col gap-2 text-sm text-gray-600 dark:text-gray-400 sm:flex-row sm:items-center sm:justify-between">
            <span className="break-words" title={file.name}>
              {file.name} · {formatBytes(file.size)}
            </span>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={disabled}
                className="inline-flex min-h-11 items-center rounded-lg border border-gray-300 px-3 font-medium text-gray-700 transition hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Cambiar
              </button>
              <button
                type="button"
                onClick={handleRemove}
                disabled={disabled}
                className="inline-flex min-h-11 items-center rounded-lg border border-gray-300 px-3 font-medium text-gray-700 transition hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Quitar
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-2 rounded-xl border-2 border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
        >
          {error}
        </div>
      )}
    </div>
  );
}
