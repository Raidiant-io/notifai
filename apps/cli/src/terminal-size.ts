/**
 * A terminal size the screens can lay out against.
 *
 * A pty nobody sized reports zero columns and zero rows: a pty opened from a
 * process with no terminal of its own, many CI runners and agent shells, and
 * `script` run without one. The prompt library wraps every frame at
 * `stream.columns`, so zero puts each character, and each piece of each colour
 * code, on a line of its own; the setup screen turns to unreadable noise.
 * Rows of zero likewise leave a list no room for its options.
 *
 * Fixed at the stream, so every reader of `columns` and `rows`, ours or a
 * library's, sees a usable size. A real size always wins, including one that
 * arrives later with a resize.
 */

export const FALLBACK_TERMINAL_SIZE = { columns: 80, rows: 24 } as const

type SizedStream = { isTTY?: boolean; columns?: number; rows?: number }

export function ensureUsableTerminalSize(stream: SizedStream): void {
  if (stream.isTTY !== true) return
  for (const dimension of ['columns', 'rows'] as const) {
    // A runtime that locks the property keeps its own size; a layout guard
    // must never be what stops the CLI from starting.
    if (Object.getOwnPropertyDescriptor(stream, dimension)?.configurable === false) continue
    let reported = stream[dimension]
    const fallback = FALLBACK_TERMINAL_SIZE[dimension]
    // Node assigns the measured size to these properties on every resize, so
    // an accessor keeps the guarantee across resizes as well as at startup.
    Object.defineProperty(stream, dimension, {
      configurable: true,
      enumerable: true,
      get: () => (typeof reported === 'number' && reported > 0 ? reported : fallback),
      set: (value: number | undefined) => {
        reported = value
      },
    })
  }
}
