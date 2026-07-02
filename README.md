# IFR Trainer for Microsoft Flight Simulator 2024

An IFR moving map for MSFS 2024. It shows where you are flying on an
enroute-chart-style map, draws a **persistent flight track** behind the
aircraft, and overlays **VORs, NDBs, waypoints/intersections and airports read
live from the native MSFS facility database** via SimConnect — no external
navdata subscription needed.

It ships in **two forms**:

1. 🖥️ **A Windows desktop app** you install from an `.exe` (runs in its own
   window, sits in the system tray while you fly).
2. 🧭 **An in-sim MSFS toolbar panel** — the same map, shown **inside the MSFS
   2024 toolbar menu**, with your flight track/tracklogs.

Both show the *same* aircraft, track and navdata, because the desktop app is
what feeds the in-sim panel.

## ⬇️ Download & install (for users)

Grab the ready-to-run installer — no development tools needed:

**→ [Download IFR-Trainer-Setup.exe](../../releases/latest/download/IFR-Trainer-Setup.exe)**

Run it, then launch **IFR Trainer**. To also show the map inside MSFS, download
`IFR-Trainer-MSFS-Addon.zip` from the [latest release](../../releases/latest)
and follow [Show the map inside MSFS](#show-the-map-inside-msfs-toolbar-panel).

> The installer is built automatically by GitHub Actions on every push to
> `main` and attached to the **ifr-trainer-latest** release.

![screenshot](docs/screenshot.png)

## Features

- **Live moving map** — aircraft symbol with heading/track rotation, follow
  mode, 10/25/50 NM range rings
- **Persistent flight track** (tracklogs / breadcrumbs) so you can review your
  flown path — holds, procedure turns, intercepts. Clear it any time, export
  it as **GeoJSON or KML**
- **Native MSFS navdata** — VORs (with DME flag + frequency), NDBs, RNAV
  waypoints/intersections and airports streamed from the simulator's own
  facility database as you fly
- **IFR chart symbology** — VOR hexagon (boxed when DME), dotted NDB circle,
  waypoint triangles, airport circles, chart-style labels with frequencies
- **Trainer readout** — click any fix to get a live
  **bearing / radial / DME distance** from your aircraft (great for VOR radial
  interception and holding practice)
- **Flight data bar** — ground speed, altitude, magnetic heading, true track,
  vertical speed
- **Runs inside MSFS** as a toolbar panel, or as a standalone desktop window
- **Demo mode** to explore the app without the simulator running

---

## Quick start (installed app)

1. **Get the installer.** Either download `IFR-Trainer-Setup-x.y.z.exe` from
   the GitHub Actions **build artifact** (see
   [Getting the .exe](#getting-the-exe)), or build it yourself
   (`npm run dist`).
2. **Run the installer** and launch **IFR Trainer**. It opens the moving-map
   window and starts serving the map on `http://localhost:8642`.
3. Start MSFS 2024 and load a flight. The status chip shows **MSFS** once
   connected (it retries automatically until the sim is ready).

That's the desktop app. To also see the map **inside MSFS**, add the toolbar
panel below.

## Show the map inside MSFS (toolbar panel)

The in-sim panel is a small MSFS add-on that displays the same map in the
simulator's toolbar.

1. Make sure the **IFR Trainer desktop app is running** (it serves the map the
   panel displays). It can sit minimised in the system tray.
2. Copy the folder

   ```
   msfs-addon/joybuy-ifr-trainer
   ```

   into your MSFS **Community** folder. Typical locations:

   - MS Store / Game Pass:
     `%LOCALAPPDATA%\Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache\Packages\Community`
   - Steam:
     `%APPDATA%\Microsoft Flight Simulator 2024\Packages\Community`

   (In MSFS you can find the exact path under **Options → General → Developers**,
   or in older builds via the content manager. If unsure, search for a folder
   named `Community` under your MSFS installation.)

3. **Restart MSFS 2024.** Load a flight, move the mouse to the top of the
   screen to reveal the toolbar, and open the **IFR Trainer Map** panel.

If the app is not running you'll see an "IFR Trainer app not running" message in
the panel — just start the desktop app and reopen the panel.

> The in-sim panel loads the plain **IFR chart** map (vector navaids + your
> track). Online tile base maps (Dark/OSM) are only meant for the desktop
> window; the vector chart is the right choice for IFR training anyway and
> needs no internet.

---

## Getting the `.exe`

You don't need a development setup to get the installer.

### Option A — download the build artifact (recommended)

A GitHub Actions workflow builds the Windows installer automatically on every
push to the `main` branch:

1. Open the repository's **Actions** tab on GitHub.
2. Click the latest **“Build Windows installer”** run.
3. Download the **`IFR-Trainer-Windows-Setup`** artifact (contains the `.exe`).
   The **`IFR-Trainer-MSFS-Addon`** artifact contains the Community-folder
   package.

You can also trigger it manually via **Actions → Build Windows installer → Run
workflow**.

### Option B — build it yourself (on Windows)

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm run dist
```

The installer is written to `dist/IFR-Trainer-Setup-x.y.z.exe`.

---

## Running without installing (developers)

```bash
npm install

npm run app        # Electron desktop app (live MSFS data)
npm run app:demo   # Electron desktop app, simulated flight

npm start          # headless server only, open http://localhost:8642
npm run demo       # headless server, simulated flight around Frankfurt
```

- `PORT=9000 npm start` — use a different port. If you change the port, also
  edit `PANEL_URL` in
  `msfs-addon/joybuy-ifr-trainer/html_ui/InGamePanels/IFRTrainer/IFRTrainer.js`
  and re-run `npm run layout`.
- Open the map on a tablet on the same network: `http://<pc-ip>:8642`
  (allow Node.js/IFR Trainer through the Windows firewall).

## How it works

```
                       ┌─────────────────────────────────────┐
MSFS 2024 ─SimConnect─▶│  IFR Trainer server (localhost:8642) │
   │  (position +      │   • records the flight track          │
   │   facility DB)    │   • serves the map UI + WebSocket     │
   └───────────────────│   • exports GeoJSON / KML             │
                       └───────────────┬─────────────────────┘
                                       │ HTTP + WebSocket
                        ┌──────────────┴───────────────┐
                        ▼                               ▼
              Desktop window (Electron)      MSFS toolbar panel (iframe)
```

- Aircraft state (`PLANE LATITUDE/LONGITUDE/ALTITUDE`, headings, speeds,
  vertical speed, magnetic variation) is requested ~4×/second.
- Facilities come from `SimConnect_SubscribeToFacilities` for `VOR`, `NDB`,
  `WAYPOINT` and `AIRPORT`. MSFS keeps sending the facilities cached around
  your aircraft as you fly, so the chart always shows nearby navaids — straight
  from the same database the sim's own avionics use.
- The track is recorded server-side, so the desktop window and the in-sim panel
  always show the same path, and reloading either keeps your full flight track.

## Project layout

```
msfs-ifr-trainer/
  server/          SimConnect bridge + HTTP/WebSocket server (createServer.js)
  public/          moving-map web UI (Leaflet + IFR symbology)
  electron/        desktop-app wrapper (main + preload)
  build/           app icons for the installer
  msfs-addon/
    joybuy-ifr-trainer/   ← copy this into the MSFS Community folder
    build-layout.js       regenerates the package layout.json
```

## Training ideas

- **VOR tracking**: click a VOR, then intercept and hold a specific radial —
  the live `R-xxx` readout shows the radial you are currently on.
- **Holding patterns**: fly a hold and check the shape of your track (wind
  correction!) afterwards.
- **Procedure review**: export the track as KML after an approach and replay it
  in Google Earth in 3D.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Status chip stays `OFFLINE` | Make sure MSFS is fully loaded into a flight; the server retries automatically. Run the app on the same PC as MSFS. |
| In-sim panel says "app not running" | Start the IFR Trainer desktop app (it can stay in the tray), then reopen the panel. |
| Panel not in the MSFS toolbar | Confirm `joybuy-ifr-trainer` is directly inside the **Community** folder and you restarted MSFS. Enable Developer Mode to see load errors. |
| No navaids shown | Zoom in (waypoints/airports from zoom 8, VOR/NDB from 6–7) and check the layer boxes. Facilities stream in once connected and a flight is loaded. |
| Port already in use | Run on another port (`PORT=9000`) and update `PANEL_URL` in the panel JS. |
| Dark/OSM base maps empty | Those need internet; the plain **IFR chart** base works fully offline. |
