# MAVLink Hub

A small, dependency-free telemetry hub for a plane that streams MAVLink over Wi-Fi
(for example an ExpressLRS Backpack). One computer runs the hub; every laptop and
phone on the same network opens a live dashboard in the browser.

- **Receive-only.** Nothing is ever sent to the aircraft.
- **One UDP client.** The hub is the only thing listening on the UDP port and fans
  the bytes out to any number of browsers over Server-Sent Events.
- **Works offline.** Map tiles are cached on disk the first time they are viewed, and
  whole areas can be downloaded ahead of a trip from the *Offline* tab.
- **No install step.** Node.js is the only requirement. Leaflet and the QR library are
  vendored in `vendor/`.

New here? Jump to [Setting up a hub laptop](#setting-up-a-hub-laptop-windows).

## Setting up a hub laptop (Windows)

The hub laptop is the one computer that receives the telemetry. Everyone else just opens a
web page on it. Allow about fifteen minutes the first time.

### 1. Install Node.js

1. Go to <https://nodejs.org> and download the **LTS** installer for Windows.
2. Run it and accept the defaults. Nothing else needs installing.
3. To check, open Command Prompt (press Start, type `cmd`) and type `node --version`. A
   version number such as `v22.x` means it worked. Anything from v18 up is fine.

### 2. Get the hub

- Easiest: on the GitHub page click **Code → Download ZIP**, then unzip it somewhere you
  will keep it, for example `C:\MAVLink Hub`. Keep all the files together.
- Or, if you use Git: `git clone https://github.com/douggreenak/Mavlink-Hub.git`

### 3. Start it for the first time

1. Double-click **MAVLink Hub.bat**. If Windows SmartScreen says it protected your PC,
   click **More info → Run anyway**; the file is a plain script you can open in Notepad.
2. A small **MAVLink Hub** window appears and the dashboard opens in your browser.
3. The first time, Windows Defender Firewall asks whether to allow **Node.js** to
   communicate on networks. Tick **Private networks** and click **Allow access**. This is
   what lets the plane's telemetry in and lets phones reach the dashboard. If you dismissed
   it, open *Windows Security → Firewall & network protection → Allow an app through
   firewall* and tick Node.js for Private networks.
4. Make sure the Wi-Fi network you fly on is marked **Private** in Windows (*Settings →
   Network & internet → Wi-Fi → the network's properties → Private network*). On a
   *Public* network Windows blocks incoming connections even for allowed apps, and phones
   will not be able to open the dashboard.

Leave the hub window open while flying. Closing it stops the hub. The window shows the
addresses phones can use, map-download progress, and a button that opens the saved-maps
folder.

### 4. Connect the plane's telemetry

The hub listens for MAVLink on UDP port 14550 and nothing else needs configuring on the
laptop. What matters is that the telemetry source and the laptop are on the same network.

**ExpressLRS TX Backpack** (the usual case; see the
[ExpressLRS MAVLink guide](https://www.expresslrs.org/software/mavlink/) for the full
picture). You need an ESP-based TX module with a backpack, ELRS 3.5 or newer and backpack
firmware 1.5 or newer.

1. In the ELRS Lua script on the radio, set the link mode to **MAVLink**.
2. Still in the Lua script, go to **Backpack → Telemetry** and set it to **WiFi**. The
   backpack then starts Wi-Fi and forwards MAVLink on its own. Do not use *Enable Backpack
   WiFi*; that is the firmware-update mode and sends nothing.
3. Put the laptop on the same Wi-Fi as the backpack. Two ways:
   - **The backpack's own network**, named `ExpressLRS TX Backpack XXXXXX`, password
     `expresslrs`. Simple, needs no other hardware, but has no internet and only room for a
     few devices.
   - **A shared network**: set the backpack's *Home WiFi* name and password (in the ELRS
     Configurator when flashing, or the backpack's web page) to a phone hotspot or a small
     travel router, and put the laptop and the phones on that too. This is the better
     setup when several people want the dashboard, and it keeps internet for map tiles.
4. Power up the plane and radio. Within a few seconds the dashboard's chip changes from
   *Hub connected, no telemetry* to **Live**.

**Anything else that sends MAVLink over UDP** (a SiK radio through MAVProxy, a companion
computer, a simulator) works too: point it at the laptop's IP address, port 14550. The
laptop's address is shown in the hub window.

Only one program can receive the UDP stream on a given port. If Mission Planner or
QGroundControl is also running on the hub laptop and listening on 14550, they will fight
over the packets; close them there, or give the hub a different `UDP_PORT` (see Settings).

### 5. Open the dashboard on phones and other laptops

1. Put the phone on the same Wi-Fi as the hub laptop.
2. On the hub's dashboard click **Open on phone** and scan the QR code, or type the
   address from the hub window (something like `http://192.168.1.23:8080`) into the
   phone's browser.
3. Add it to the phone's home screen for a full-screen view. Any number of screens can
   watch at once; units and hidden tiles are shared across all of them.

### 6. Before a flying trip

- **Save the maps while you still have internet.** Open the *Offline* tab, frame the flying
  area, pick a detail level, and download. Tiles you merely look at on the *Map* tab are
  kept too. Saved maps live in `%APPDATA%\MAVLink Hub`, outside the program folder, and
  survive reboots.
- **Stop the laptop from sleeping** while plugged in (*Settings → System → Power & battery
  → Screen and sleep*). A sleeping laptop drops the telemetry and the phones lose the page.
- Consider a **hub.env** file (copy `hub.env.example`) if you want a different port or map
  settings. Nothing is needed for a plain setup.

### Updating

Download the new ZIP and replace the files in the hub folder. Saved maps and settings are
kept elsewhere, so nothing is lost. If you use Git, `git pull`.

### Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| Dashboard says **Hub offline** | The browser cannot reach the hub | Start MAVLink Hub.bat; on a phone, check it is on the same Wi-Fi and the network is marked Private on the laptop |
| **Hub connected, no telemetry** | The hub runs but no MAVLink arrives | Check the backpack is in MAVLink mode with Telemetry = WiFi, that the laptop is on the backpack's network, and that Node.js is allowed through the firewall |
| Hub window says it **stopped**, log mentions a port in use | Another copy of the hub, or a ground station, already holds port 8080 or 14550 | Close the other program, or change `WEB_PORT` / `UDP_PORT` in `hub.env` |
| Map is blank in the field | No internet and that area was not saved | Download it from the *Offline* tab next time you are online |
| Values look wrong or jumpy | Usually a weak link | Click the signal bars at the top right for link statistics; *All data* shows every raw message |

The hub's own messages are in `%APPDATA%\MAVLink Hub\hub.log`.

## Running it elsewhere

- **Windows without the window**: `start.bat` runs the hub in a plain console.
- **Mac or Linux**: `node server.js` in a terminal (on a Mac, double-clicking
  `start.command` does that for you).

Then open <http://localhost:8080>.

### Settings

All optional. Put them in a `hub.env` file next to `server.js` (copy `hub.env.example`) or
set them as environment variables, which take precedence.

| Variable | Default | Meaning |
| --- | --- | --- |
| `UDP_PORT` | `14550` | Port the MAVLink source sends to |
| `WEB_PORT` | `8080` | Port for the dashboard |
| `MAX_TILES` | `500` | Largest bulk map download allowed, in tiles. `0` removes the limit |
| `DATA_DIR` | per-user app folder | Where saved maps (`cache/`) and `settings.json` are kept |
| `TILE_STREET_URL` | OpenStreetMap | Street tile template, e.g. `https://example.com/{z}/{x}/{y}.png` |
| `TILE_SAT_URL` | Esri World Imagery | Satellite tile template; note Esri's order is `{z}/{y}/{x}` |

Public tile servers ask for modest use, which is why bulk downloads are limited and
paced. Point the two URL variables at your own tile source to lift that.

### Where saved maps live

Tiles are ordinary files, so they survive restarts and reboots. By default they are kept in
the per-user application folder, outside this checkout, so deleting or re-cloning the
project does not lose them:

| | |
| --- | --- |
| Mac | `~/Library/Application Support/MAVLink Hub/cache/` |
| Windows | `%APPDATA%\MAVLink Hub\cache\` |
| Linux | `~/.local/share/mavlink-hub/cache/` |

The Offline tab shows the exact path. Set `DATA_DIR` to put them on a bigger disk. Older
versions kept `cache/` next to `server.js`; the hub moves that into place the first time it
starts, so nothing is lost on upgrade.

### Downloading larger areas

The 500-tile cap exists because the default sources are shared, free servers, and it
keeps the hub's footprint small. It does not make bulk downloads allowed there:
OpenStreetMap's [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
prohibits any pre-fetching for offline use (only tiles a person is actively viewing, which
the Map tab caches as you go), and Esri says its standard World Imagery layer is not
intended for export. Violations are blocked without notice. The cap is a setting, not a
rule of the hub:

```bash
MAX_TILES=0 node server.js
```

lifts it entirely, and any other number sets a new cap. The hub still pauses briefly
between tiles so a big download trickles rather than floods. If you plan to save whole
regions, point `TILE_STREET_URL` and `TILE_SAT_URL` at a tile server you are allowed to
bulk-download from (your own, or a paid provider) and then lift the limit.

## Dashboard

- **Flight**: attitude indicator, speed/altitude/battery tiles, per-cell voltages,
  flight statistics, RC channels. *Edit tiles* hides what you do not need; the choice
  is stored on the hub so every screen matches.
- **Map**: live track with a follow mode and a street/satellite toggle, a predicted path, and optional airspace layers (below).
- **Offline**: frame an area on the map, pick Overview, Standard or Detailed (each shows its
  size before you commit), and download it. Saved areas show in green. To free space, delete
  the tiles inside the frame at the chosen detail, or everything saved for a layer.
- **All data**: every decoded MAVLink message and field, with rates.
- **Demo mode** simulates a flight so you can try the dashboard without a plane.

Decoded messages: HEARTBEAT, SYS_STATUS, SYSTEM_TIME, GPS_RAW_INT, SCALED_PRESSURE,
ATTITUDE, GLOBAL_POSITION_INT, RC_CHANNELS, VFR_HUD, RADIO_STATUS, BATTERY_STATUS and
STATUSTEXT, in MAVLink v1 or v2 (signed frames included). Anything else is counted
under *Unrecognised messages*. To add a message, append a row to the `D` table near the
top of the script in `index.html` with its id, name, `CRC_EXTRA` and fields in wire order.

## Predicted path

The Map tab draws a dashed line ahead of the aircraft showing where it ends up if it holds its current turn,
with a tick every 10 seconds. **Path** cycles it between off, 15, 30 and 60 seconds. It starts under the icon,
follows the direction of travel (not where the nose points, so wind is allowed for), and stops after one full circle.

The turn rate comes from how the direction of travel is changing and, on fixed wings, from the bank angle as well.
INAV's own yaw-rate field is not used, because INAV fills it with gyro degrees per second although MAVLink says
radians per second. The line is hidden when there is no GPS fix or the data is stale, so it never invents a path.

Honest limits: a constant-turn prediction is good for the next few seconds and for orbits. Measured against the
test flight, it was about 40% closer than a straight line at 3 s and 30% closer at 5 s, but no better than a
straight line at 10 s, because pilots roll out of turns. Treat the longer lengths as "where this turn leads", not a forecast.

Motion is smooth because the icon is dead-reckoned from each position report and corrections are faded in over
a fraction of a second. INAV's default is only two reports a second over the radio, which is why other tools look jerky.

## Airspace

Switch **Airspace** on in the Map tab. The hub fetches public FAA data for the area in view, saves it on disk
(so it keeps working offline once you have looked at an area) and the dashboard draws it:

| Layer | What it is |
| --- | --- |
| Controlled | Class B, C, D and surface-area Class E |
| Restricted & military | Prohibited, restricted, warning, alert and military operations areas, national-defense and national-security UAS restrictions |
| Flight restrictions | Current temporary flight restrictions (TFRs), refreshed every 10 minutes |
| RC flying sites | FAA-recognised recreational flying sites |
| Drone ceilings | The FAA drone ceiling grid (LAANC), only when zoomed in |
| My own files | Your own GeoJSON files (below) |

Click any shape for its name, floor and ceiling. A banner on the map warns when the aircraft is **inside** an area
that matters, or when its predicted path **will enter** one, with the time. Only airspace starting at ground level
up to 400 ft is considered (change with `AIRSPACE_MAX_FLOOR_FT`); Class A is never shown.

**This is advisory only.** The data can be out of date or incomplete, TFR altitudes and times are in the NOTAM, and
the FAA's own tools (B4UFLY, NOTAMs) and your own checks are what count. Coverage is the United States. For other
countries, or for places you want to avoid (a neighbour, a school), put GeoJSON files in the `airspace` folder inside
the saved-maps folder (the Airspace panel shows the exact path). Polygons work, and a point with a `radius_m` property becomes
a circle. Optional properties: `name`, `kind` (`restricted`, `prohibited`, `warning`, `class-d`...; anything else is
drawn as "your own area"), `floor`, `ceiling` (feet) and `note`. `AIRSPACE=off` stops the hub fetching anything.

## INAV over ELRS

The dashboard is built around what INAV actually sends, taken from INAV's own MAVLink source:

- **Missing sensors are shown as missing.** INAV sends no position messages without a GPS, reports 0 V, -1 A and
  100% remaining with no battery sensing, and 0 airspeed with no pitot. The tiles show "no GPS", "no battery sensor",
  "no airspeed sensor" and so on, those zeros never reach the statistics, and a **Sensors** card shows what is fitted
  and healthy. Altitude falls back to the HUD message when there is no GPS.
- **GPS without a fix** is shown as waiting, not as a track starting at 0,0. A lost fix keeps the last position and says so.
- **Flight modes** are INAV's ArduPilot-style mode numbers, shown as names (FBW A, Cruise, RTL, Loiter...).
- **Home** comes from INAV's `GPS_GLOBAL_ORIGIN` message when it has set one.
- **Packet loss** is counted from message sequence numbers, because INAV's own drop-rate field is always 0.
- **MAVLink 1 and 2**, signed frames, and frames split across radio packets are all handled.
- INAV repeats the pack average on every cell, so per-cell bars say that rather than pretending to be measured.
- Extra senders on the link (a ground-station heartbeat, a radio status source) do not replace the aircraft.

INAV sends attitude, position and airspeed only twice a second by default (and RC and battery once a second), to
spare the radio. The dashboard is smooth at that rate, but you can raise it in the INAV CLI, for example
`set mavlink_extra1_rate = 5` (attitude), `set mavlink_pos_rate = 5` (position) and `save`, if your link has the room.
If a bare-bones plane shows no position, check `mavlink_pos_rate` is not 0.

## Test flights without an aircraft

```bash
npm run sim                              # a plane with every sensor, INAV's default message rates
node sim/inav-sim.js --profile minimal   # no GPS, airspeed or battery sensing
node sim/inav-sim.js --list              # every profile
```

On Windows, double-click **Test flight.bat**. The simulator sends INAV-style MAVLink to the hub on UDP 14550, so
start the hub first and open the dashboard. Profiles can be combined, for example `--profile minimal,split`:
`nogps`, `nofix` (GPS that takes 25 s to lock), `nopitot`, `novbat`, `noamp`, `nomag`, `v1` (MAVLink 1), `fast`,
`lossy` (10% of frames lost), `corrupt`, `split` (frames cut across packets), `dropout` (link silent for 4 s every
30 s), `radio` (an ELRS-style radio status plus a ground-station heartbeat), `copter` and `ardupilot`. The flight is a
racetrack with wind, so the course differs from the heading and the turns are real. Use `--host` and `--port`
to point it at another machine.

## Tests

```bash
npm test
```

Uses Node's built-in test runner, so there is still nothing to install. The suite
covers the tile math and request validation, the HTTP/UDP/SSE server end to end
against a local fake tile source (no internet needed), the browser-side MAVLink decoder
(loaded from `index.html` into a stubbed DOM with a virtual clock), and the following,
all offline:

- every message the dashboard decodes is checked field by field against definitions
  extracted from the official MAVLink XML, using an encoder that shares no code with the decoder;
- the simulator is run through the dashboard for every missing-sensor and link-fault profile, and through a real
  UDP socket, the hub and the live stream, checking the bytes arrive unchanged and are understood;
- smoothness and prediction are measured frame by frame at 60 fps, including against a straight-line baseline;
- the airspace service is tested against a fake FAA server using trimmed real FAA responses in `test/fixtures`
  (caching, offline use, FAA outages, paging, your own files), plus the inside / will-enter logic.
