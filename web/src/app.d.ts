declare global {
  /** Versión de diff-review (package.json raíz), inyectada al compilar. */
  const __APP_VERSION__: string;
  namespace App {}
}

export {};
