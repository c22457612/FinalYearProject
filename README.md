# Visual Privacy Toolkit

Visual Privacy Toolkit is a local-first privacy inspection project made up of:

- `vpt-control-centre/`: local Node/Express + SQLite backend and web UI
- `extension/`: Chrome MV3 extension that captures privacy signals, applies the current blocking/trust rules, and sends events to the Control Centre

No cloud service is required.

## Run locally

### 1. Start the Control Centre

From `vpt-control-centre/`:

```powershell
npm.cmd install
npm.cmd start
```

The local app runs at:

- `http://127.0.0.1:4141/`
- Site Insights deep link pattern: `http://127.0.0.1:4141/site.html?site=<domain>`

### 2. Load the extension unpacked

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Choose `Load unpacked`
4. Select the repo `extension/` folder

The current deliverable manifest version is `0.1.0` in [`extension/manifest.json`](/c:/Users/C22457612/FinalYearProject/extension/manifest.json).

## Extension flow

The popup is intentionally lightweight:

- `Record extension events` is the master capture toggle.
- `Tracking protection mode` controls the shipped network blocking rules.
- `Show first-visit trust prompt` controls whether the navigation interstitial appears on first visits.
- `Use trusted-site allow rules` pauses or resumes trusted-site bypass behavior without deleting saved trusted sites.
- Current-site trust/untrust stays in the popup, but full trusted-site management lives in the Control Centre.
- Per-surface Browser API controls stay in `/?view=api-signals`; the popup shows their current live state but does not duplicate that editor.

Important behavior notes:

- Turning capture off stops new extension events from being recorded and forwarded to the Control Centre.
- Capture off does not disable the current blocking mode or trusted-site rules.
- The interstitial remains a navigation-time trust flow only. It is not a mid-session per-API consent prompt.
- Browser API evidence remains metadata-only. VPT does not store raw canvas output, clipboard contents, SDP bodies, ICE candidate strings, or IP addresses.

## Backend dependency

The extension still works partially if the backend is not running, but the final demo flow expects the Control Centre to be available:

- Works locally without the backend:
  - popup controls
  - current blocking behavior
  - interstitial navigation trust flow
- Needs the backend running at `http://127.0.0.1:4141`:
  - event ingest into SQLite
  - Site Insights and Vendor Vault evidence views
  - Trusted Sites manager and Browser API Controls pages
  - backend-backed policy synchronization

## Permissions rationale

The extension keeps the shipped permission set minimal for its current feature set:

- `storage`
  - stores local extension state such as mode, trusted sites, capture toggle, and recent local events
- `declarativeNetRequest`
  - applies the current tracking-block rules
- `declarativeNetRequestFeedback`
  - reads block-match debug callbacks so the popup badge and blocked-event logging stay accurate
- `webNavigation`
  - drives the first-visit navigation interstitial
- `tabs`
  - reads the active tab URL for popup actions and opens Control Centre shortcuts
- `webRequest`
  - captures the limited preview-first request summary used by the interstitial receipt
- `cookies`
  - powers cookie count, cookie snapshot, and clear-cookies actions for the current site
- `notifications`
  - powers optional local notifications for Browser API detections; users can turn these off in the popup

Host permissions:

- `<all_urls>`
  - required because blocking, trust interception, Browser API capture, and preview receipt logic all operate across arbitrary user-visited sites
- `http://127.0.0.1:4141/*`
  - required so the extension can post events to the local backend and open the local Control Centre pages

## Demo / release checklist

1. Start the Control Centre backend.
2. Load the unpacked extension from `extension/`.
3. Verify the popup shows:
   - capture on/off
   - protection mode
   - trust shortcut for the active site
   - Browser API policy summary
4. Visit a normal website and confirm the first-visit trust prompt appears when enabled.
5. Open the Control Centre pages:
   - `/?view=trusted-sites`
   - `/?view=api-signals`
   - `site.html?site=<domain>`
6. Before packaging, bump the manifest version in [`extension/manifest.json`](/c:/Users/C22457612/FinalYearProject/extension/manifest.json) if you are shipping a new deliverable snapshot.
