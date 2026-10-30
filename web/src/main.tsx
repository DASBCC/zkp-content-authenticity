/** Monta la aplicación React y aplica su diseño compartido. */
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App/>);
