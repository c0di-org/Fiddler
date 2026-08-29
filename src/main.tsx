import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { start as startPlayer } from "./audio/player";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installHardwareKeyboardUX } from "./hardware-keyboard";
import "./styles.css";
import "./hardware-keyboard.css";

installHardwareKeyboardUX();
// Before React, and outside it. The player owns an element that has to outlive
// every folder, every preview and every remount, and StrictMode's deliberate
// double-mount is exactly the thing that would otherwise cut a book in half.
startPlayer();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
