# Single Shell Prototype

Throwaway prototype question:

> How should quick capture, recent organization, topics, materials, and settings feel like one application instead of separate windows?

Run:

```powershell
npm.cmd run prototype:shell
```

Variants:

- `A`: Focus Rail - stable left navigation, recent directions as the home view.
- `B`: Quiet Desk - command-led workspace with no permanent sidebar.
- `C`: Material Stream - source stream first, topics as a contextual second pane.

Use the bottom switcher or left/right arrow keys. The quick-capture button opens a compact mode inside the same window and returns to the previous context when closed.

This prototype has no persistence, API calls, file access, or production error handling. After a direction is selected, record the decision and delete or absorb this directory and `scripts/open-single-shell-prototype.mjs`.
