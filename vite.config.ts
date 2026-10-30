/** Construye la aplicación React y utiliza solamente la implementación WASM de Poseidon en el navegador. */
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// La importación específica evita incorporar las utilidades Node de firma y claves al bundle público.
const require = createRequire(import.meta.url);
const poseidonModule = path.resolve(path.dirname(require.resolve("circomlibjs")), "../src/poseidon_wasm.js");

export default defineConfig({
  root: path.resolve("web"), plugins: [react()],
  resolve: { alias: [{ find: /^circomlibjs$/, replacement: poseidonModule }] },
  worker: { format: "es" },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
