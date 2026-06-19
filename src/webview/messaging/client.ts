import type { HostMsg, WebviewMsg } from "../../shared/protocol";

/**
 * Thin messenger wrapping the VS Code webview API.
 * In the webview, acquireVsCodeApi() is globally available.
 */
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

export function createMessenger() {
  const vscode = acquireVsCodeApi();

  return {
    /** Send a message to the extension host. */
    post: (msg: WebviewMsg) => vscode.postMessage(msg),

    /** Register a handler for messages from the extension host. */
    onMessage: (handler: (msg: HostMsg) => void) => {
      window.addEventListener("message", (event) => {
        handler(event.data as HostMsg);
      });
    },
  };
}
