# @vykor/terminal-node

Node-backed terminal runtime for Vykor.

This package owns local PTY process management and keeps `node-pty` out of UI surfaces.

`LocalTerminalProvider` keeps a bounded, in-memory output snapshot for each process. The snapshot is
not persisted to disk and is discarded when the provider is disposed. Cancelling a terminal keeps
its terminal snapshot addressable: it moves through `stopping` and settles as `killed` after the PTY
or sandbox process releases its resources.
