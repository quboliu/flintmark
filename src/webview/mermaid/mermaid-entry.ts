// Standalone, lazily-loaded Mermaid bundle (~3MB minified). Built to
// out/mermaid.js and injected as a <script> only when a ```mermaid block is
// present — so the main webview bundle stays small. Exposes the API on window.
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict", // sanitize diagram text — it's untrusted document content
});

declare global {
  interface Window {
    __ofmMermaid?: typeof mermaid;
  }
}

window.__ofmMermaid = mermaid;
