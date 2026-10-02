import "./styles.css";
import { PortalApplication } from "./app.js";

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) throw new Error("Portal root is unavailable");

void new PortalApplication(root).start();
