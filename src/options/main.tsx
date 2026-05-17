import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../ui/styles.css";
import { Options } from "./Options";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Options root element was not found");
}

createRoot(root).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
