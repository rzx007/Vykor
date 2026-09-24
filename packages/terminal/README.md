# @vykor/terminal

Portable terminal protocol and interfaces for Vykor surfaces.

This package intentionally does not depend on Electron, React, xterm, or node-pty. It only defines
the terminal session model, event model, and provider/connection interfaces.

Sessions are named and remain addressable after their shell exits. Their lifecycle uses the shared
`@vykor/jobs` status set, including the observable `stopping` transition. A host can list sessions and use
`read()` to restore the bounded in-memory output snapshot before it resumes consuming live events.
Data events and snapshots carry a monotonic sequence number so an attaching view can join the two
streams without dropping or duplicating output. Reads may provide an earlier sequence cursor to
receive only newer retained output, and `wait()` waits for process settlement without cancelling it.
