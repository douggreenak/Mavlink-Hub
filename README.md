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

## Run it

```bash
node server.js
```

On a Mac you can also double-click `start.command`. Then open <http://localhost:8080>,
or scan the QR code from *Open on phone* to open the dashboard on a phone.

Point the ELRS Backpack (or any MAVLink source) at this computer's IP on UDP port 14550.

### Settings

All optional, as environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `UDP_PORT` | `14550` | Port the MAVLink source sends to |
| `WEB_PORT` | `8080` | Port for the dashboard |
| `MAX_TILES` | `500` | Largest bulk map download allowed, in tiles |
| `DATA_DIR` | folder of `server.js` | Where `cache/` and `settings.json` are kept |
| `TILE_STREET_URL` | OpenStreetMap | Street tile template, e.g. `https://example.com/{z}/{x}/{y}.png` |
| `TILE_SAT_URL` | Esri World Imagery | Satellite tile template; note Esri's order is `{z}/{y}/{x}` |

Public tile servers ask for modest use, which is why bulk downloads are limited and
paced. Point the two URL variables at your own tile source to lift that.

## Dashboard

- **Flight**: attitude indicator, speed/altitude/battery tiles, per-cell voltages,
  flight statistics, RC channels. *Edit tiles* hides what you do not need; the choice
  is stored on the hub so every screen matches.
- **Map**: live track with a follow mode and a street/satellite toggle.
- **Offline**: see which areas are already downloaded and save new ones.
- **All data**: every decoded MAVLink message and field, with rates.
- **Demo mode** simulates a flight so you can try the dashboard without a plane.

Decoded messages: HEARTBEAT, SYS_STATUS, SYSTEM_TIME, GPS_RAW_INT, SCALED_PRESSURE,
ATTITUDE, GLOBAL_POSITION_INT, RC_CHANNELS, VFR_HUD, RADIO_STATUS, BATTERY_STATUS and
STATUSTEXT, in MAVLink v1 or v2 (signed frames included). Anything else is counted
under *Unrecognised messages*. To add a message, append a row to the `D` table near the
top of the script in `index.html` with its id, name, `CRC_EXTRA` and fields in wire order.

## Tests

```bash
npm test
```

Uses Node's built-in test runner, so there is still nothing to install. The suite
covers the tile math and request validation, the HTTP/UDP/SSE server end to end
against a local fake tile source (no internet needed), and the browser-side MAVLink
decoder, which is loaded from `index.html` into a stubbed DOM and fed frames built by
an independent encoder in `test/helpers/mavlink.js`.
