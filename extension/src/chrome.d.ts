// The few chrome.* APIs this extension uses, typed by hand. We could install @types/chrome, but the project keeps
// its dependency list short, and a small file like this also documents exactly which APIs the extension touches.
// Shapes follow https://developer.chrome.com/docs/extensions/reference/api (only the fields we read or pass).

declare namespace chrome {
  /** Every chrome.* event looks like this: you hand it a callback. */
  interface ChromeEvent<Callback> {
    addListener(callback: Callback): void
  }

  namespace runtime {
    const id: string

    /** Who sent a message or opened a port. Chrome fills this in; the sender cannot fake it. */
    interface MessageSender {
      id?: string // extension id (our own id for messages from our own pages)
      url?: string
      origin?: string // e.g. "https://grades.aarushkandukoori.com" for the website
      tab?: { id?: number }
    }

    interface Port {
      name: string
      sender?: MessageSender
      postMessage(message: unknown): void
      disconnect(): void
      onMessage: ChromeEvent<(message: unknown, port: Port) => void>
      onDisconnect: ChromeEvent<(port: Port) => void>
    }

    interface Manifest {
      version: string
      externally_connectable?: { matches?: string[] }
    }

    const onConnectExternal: ChromeEvent<(port: Port) => void>
    /** Return true from the callback to answer later with sendResponse. */
    const onMessage: ChromeEvent<
      (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined
    >
    const onInstalled: ChromeEvent<(details: { reason: string }) => void>

    function sendMessage(message: unknown): Promise<unknown>
    function getURL(path: string): string
    function getManifest(): Manifest
    function getContexts(filter: { contextTypes?: string[]; documentUrls?: string[] }): Promise<unknown[]>
    function getPlatformInfo(): Promise<unknown>
  }

  namespace storage {
    namespace local {
      function get(keys: string | string[]): Promise<Record<string, unknown>>
      function set(items: Record<string, unknown>): Promise<void>
    }
  }

  namespace tabs {
    interface Tab {
      id?: number
    }
    function create(properties: { url: string; active?: boolean; openerTabId?: number }): Promise<Tab>
    function update(tabId: number, properties: { active?: boolean }): Promise<Tab | undefined>
    function remove(tabId: number): Promise<void>
    function getCurrent(): Promise<Tab | undefined>
  }

  namespace action {
    const onClicked: ChromeEvent<() => void>
  }

  namespace offscreen {
    function createDocument(parameters: { url: string; reasons: string[]; justification: string }): Promise<void>
    function closeDocument(): Promise<void>
  }
}
