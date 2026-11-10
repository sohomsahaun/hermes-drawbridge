# Hermes Drawbridge

Share a folder from your computer with one Hermes chat. Drawbridge lets the Hermes agent in that chat list and read the files you share. Access starts read-only. You can allow the agent to propose text edits or new files and review them in Hermes Desktop.

## Install

In native Hermes Desktop, connect to your Hermes backend and select the profile you want to use. If the backend is remote, connect over HTTPS or SSH. Open **Capabilities → Plugins → Install from Git**, paste the Drawbridge repository URL, and install and enable both the Agent and Desktop components. Open a new chat on the selected profile so it can use `drawbridge_folder`.

<details>
<summary>Install the components separately</summary>

1. On the machine running the Hermes backend, run `hermes -p <profile> plugins install <repository-url> --enable`. Open a new chat after Hermes reloads the plugin. If the tool or plugin endpoint is unavailable after installation, restart the backend that Desktop connects to.
2. On Windows, copy `desktop/plugin.js` from the same revision to `%LOCALAPPDATA%\hermes\desktop-plugins\hermes-drawbridge\plugin.js`. If you set `HERMES_HOME`, use that as the Hermes directory. Open **Capabilities → Plugins** and turn on **Drawbridge** if needed.

</details>

## Share a folder

The Drawbridge sidebar page lists **Active shares** and lets you edit **Share defaults**. When there are no active shares, it explains how to start one. To start sharing, open Drawbridge beside the message box in the target chat.

1. Select the profile that owns the chat, open the chat, and click **Drawbridge** by the message box. If the chat is new, send a message first.
2. Choose a folder, review the permissions, and click **Start sharing**. Ask Hermes to list the folder or read a file by its relative path.
3. Use **Change access** to adjust permissions or **Stop sharing** to end access. To switch folders, stop the current share and choose another.

Each chat can share one folder at a time. To share the same folder with another chat, grant access there separately. Stopping one share leaves the others active. Switching profiles or gateways stops the affected shares on Desktop. The old backend grant expires after its heartbeat timeout. Start a new share when you return. Drawbridge uses the public `ctx.rest` API, which follows the active profile. If you open a chat from All profiles, switch to the profile that owns the chat before using Drawbridge. Install matching versions of both Drawbridge components. To revoke Drawbridge’s Desktop permission for a folder, go to **Capabilities → Plugins → Folder access**.

## Review file changes

Enable **Update existing files** or **Create new files** to allow the corresponding proposals. These options require a Desktop build with file write support. Delete is unavailable. Ask Hermes to make a change, then review the diff in its approval card. **Run** applies the displayed edit. **Reject** leaves the file unchanged. **Allow this session** also approves later edits within that chat’s current share and permissions. This approval ends with the share.

If the file changed after the proposal was prepared, ask Hermes to prepare a fresh edit. **Create** refuses to overwrite an existing file. An editor can still save between Drawbridge’s final comparison and its write. If a save’s outcome is unclear after a disconnect, check the local file before retrying.

## Respond to a folder access request

Hermes can request folder access in chat on Desktop builds that support transcript cards.

- **Approve and continue** starts a share when Desktop already has permission for the requested folder, the requested permissions are supported, and the chat has no active share.
- **Confirm folder** opens the system folder picker for a requested folder you have yet to authorize. Selecting the requested folder starts the share and resumes the chat. Selecting a different folder opens a review of the selected folder, permissions, and duration.
- **Approve upgrade and continue** replaces a read-only share of the same folder with the permissions and duration shown on the card.
- **Choose folder** appears when the request gives no folder. Select a folder, then use **Share and continue**.
- **Review folder access** opens the dashboard to review the existing share or available permissions.
- **Reject** dismisses the request.

Canceling the picker leaves the request pending until it expires.

## Access and limits

- Drawbridge uses your existing authenticated Hermes connection and the Desktop folder picker. Windows needs no separate file server or inbound listener.
- Shares default to read-only and stay open while Desktop is connected unless you set a duration or stop sharing. If Desktop stops polling, the backend grant expires after the configured heartbeat timeout, eight seconds by default.
- **Share settings** apply to new shares. Set a duration, heartbeat timeout, polling interval, or retry count. The default polling interval is 800 ms and the default retry count is three. Longer intervals reduce gateway requests and may make file operations slower.
- Drawbridge handles UTF-8 text and returns up to 100 entries per listing.
- Shared file contents and edit diffs are sent to the Hermes backend serving the chat. Contents can appear in chat history and reach the configured model provider. Use Drawbridge with a Hermes backend and plugin installation you trust. Revoking a share ends future access through it.

## File size settings

Set file size preferences in **Share defaults** on the Drawbridge sidebar page, or in **Share settings** when preparing a share. Set backend ceilings in the Hermes plugin settings for the profile running Drawbridge, or under `plugins.entries.hermes-drawbridge.settings` in that profile's `config.yaml`.

| Desktop setting | Backend key | Default and maximum |
|---|---|---:|
| Maximum read size | `max_read_kib` | 96 KiB |
| Maximum reviewed write size | `max_reviewed_write_kib` | 64 KiB |
| Maximum session-approved write size | `max_session_write_kib` | 128 KiB |

Each setting takes a positive whole number in KiB. For each new share, Drawbridge uses the lower of the Desktop preference and the backend ceiling. The active share displays the negotiated values. End and restart a share to pick up changes. **Reset to defaults** clears Desktop preferences. The backend ceilings still apply.

The session-approved limit applies only after an individually reviewed edit receives **Allow this session** for that chat's active share. Later edits skip the approval diff and still require Create or Update permission. Updates check the existing file and the replacement against the applicable write limit. Ending the share clears its session approval. The encoded response is limited to 384 KiB, and the full approval display is limited to 144 KiB. An edit can fit the file size limit and still exceed the approval display limit.

## Developer checks

The Windows smoke suite exercises the native Hermes file API with simulated Desktop UI and transport. It covers chat isolation, path and link boundaries, expiry, profile-switch revocation, read-only share upgrades, reviewed saves, and negotiated file size limits. It requires Node 24, Python with Hermes dependencies (including FastAPI and ruamel.yaml), a Hermes Agent source checkout, and permission to create links inside a disposable workspace folder. Set `DRAWBRIDGE_PYTHON` to the Hermes virtual environment Python executable if your default Python lacks these dependencies.

```powershell
node --experimental-transform-types ./tests/smoke.mjs "C:/path/to/hermes-agent"
```

[Hermes Desktop Plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk) · [Hermes Agent plugin guide](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
