# Hikvision relay

Cameras and the NVR sit on the hotel network and cannot reach the cloud PMS. This small program runs on an
always-on PC there, collects movement from them and forwards it to the PMS. If the internet is down, it keeps
everything on disk and sends it when the connection returns (up to 50,000 sightings; oldest dropped first).

A camera repeats an event about once a second while someone moves. The relay groups those repeats, so one
person walking past becomes **one sighting**. Each sighting records the camera, the channel, the event type,
start and end time, how many repeats there were, and whether the camera classed it as a person.

## Two ways to get events

| | **Pull** (recommended) | **Push** |
|---|---|---|
| How | The relay logs in to the camera or NVR and reads its live event stream (`/ISAPI/Event/notification/alertStream`) | The NVR or camera sends each event to the relay ("HTTP Listening" / "Alarm Server") |
| When | Always works if you can log in to the device. Use it when an NVR does not pass on its cameras' smart events | When the NVR forwards events reliably |
| Needs | IP (and port) of each device, a user and password | NVR set to send to this PC, port 8090; `ALLOWED_IPS` |

### Lessons from the first site test

- **The NVR may not pass on smart events.** Reading the NVR (192.168.88.111) gave only heartbeats while people
  walked past. Reading a device with its own IP (192.168.88.153) gave the real events. That device served
  several channels on one stream (5 = FRONT AREA, 2 = another camera).
- **A camera with no IP of its own** (plugged into the NVR's PoE ports) is reached through the NVR's
  **Virtual Host**: Configuration → Network → Advanced Settings → Virtual Host → enable. Each camera then gets a
  port on the NVR's IP, e.g. `192.168.88.111:65001`.
- **Few detections = detection settings, not the relay.** In the camera: Configuration → Event → Basic Event →
  Motion Detection. Draw the grid over the **whole** walkway or doorway, raise sensitivity to about **80**, and
  set target **Human**. After that, it fired steadily on every person.

## Install

1. On an always-on PC on the hotel network, install Node.js 18 or newer. Copy `tools/hikvision-relay` and
   `supabase/functions/_shared`, keeping the folder layout (the relay uses `_shared/hikvision.js`).
2. **Make a camera user for the relay.** Do not use `admin`. On each device: Configuration → System → User
   Management → Add, e.g. `pms-relay`, level **Operator**, with only "Remote: Notify surveillance center / Alarm"
   and "Remote: Parameters view". Use a long password that is used nowhere else.
3. **Get a relay key**: in the PMS, Integrations → Hikvision → **Create relay key**.
4. **Settings**: in this folder copy `relay.env.example` to `relay.env` and fill it in (`PMS_URL`, `RELAY_KEY`,
   `PULL_HOSTS`, `HIK_USER`, `HIK_PASS`; `DEBUG=1` while testing). The relay reads `relay.env` by itself; settings
   given in the environment win over the file. Then start it from this folder: `node relay.mjs`.

   Walk past a camera. With `DEBUG=1` you see each event as it arrives (`event vmd active ch 5 human`) and a
   `sighting` line about 10 seconds after the person has gone. Then a `sent 1 sightings` line. Set `DEBUG=0`
   once it works.
5. **Run it as a service** so it starts with the PC and restarts after power cuts. Set the PC's BIOS to power on
   after a power failure.
   - Windows (NSSM from nssm.cc, as administrator):
     ```
     nssm install BMG-Relay "C:\Program Files\nodejs\node.exe" "C:\bmg\tools\hikvision-relay\relay.mjs"
     nssm set BMG-Relay AppDirectory C:\bmg\tools\hikvision-relay
     nssm set BMG-Relay AppStdout C:\bmg\relay.log
     nssm set BMG-Relay AppStderr C:\bmg\relay.log
     nssm start BMG-Relay
     ```
   - Linux: `cd tools/hikvision-relay && pm2 start relay.mjs --name bmg-relay && pm2 save && pm2 startup`.
6. In the PMS: **Occupancy audit → Cameras and rules**: one line per channel (the `ch` shown in the debug lines)
   saying what it watches: a room door (and which room), the entrance, reception, a corridor or an outlet. Fill in
   Device (the camera's MAC address) only when two devices use the same channel numbers.
7. Room sightings now feed the occupancy audit: every 30 minutes they are compared with check-ins, check-outs,
   door openings and payments (see GO-LIVE.md, step 12a).

## Settings

| Setting | Meaning |
|---|---|
| `RELAY_ENV` | Read settings from another file instead of `relay.env` next to `relay.mjs` |
| `PMS_URL`, `RELAY_KEY` | Where to send, and this property's key. Required |
| `PULL_HOSTS` | Devices to read, comma-separated: `IP` or `IP:port` |
| `HIK_USER`, `HIK_PASS` | Login for those devices |
| `HIK_PASS_<IP with _>` | A different password for one device, e.g. `HIK_PASS_192_168_88_153` |
| `HUMAN_ONLY=1` | Keep only detections the camera classed as a person (AcuSense cameras); events with no class are kept |
| `GAP_SECONDS` | Quiet time that ends a sighting (default 10) |
| `PUSH` | `on` to also listen for pushed events (default: on only when `PULL_HOSTS` is empty) |
| `PORT`, `ALLOWED_IPS` | Push mode: port (8090) and the only devices allowed to push (your NVR's IP) |
| `TZ_OFFSET` | For devices whose clock sends no time zone (default `+03:00`) |
| `DEBUG=1` | Print every event the devices send |

## Push mode (if the NVR forwards events)

On the NVR: Configuration → Network → Advanced Settings → **HTTP Listening** (or "Alarm Server"): this PC's IP,
port 8090, URL `/`. On each camera: Event → Motion Detection or Line Crossing → Linkage → **Notify
Surveillance Center**. Start the relay with `PUSH=on ALLOWED_IPS=<NVR IP>`.

## Security

- Each property's relay key only posts events for that property. Revoke it on the Hikvision tab if the PC is lost.
- Passwords stay on the relay PC (environment or service settings), never in the PMS or in the code.
- `ALLOWED_IPS` stops other devices on the hotel network from pushing fake movement.
- The older shared `HIKVISION_RELAY_KEY` (with `PROPERTY_ID`) still works but trusts whatever property id it is
  given, so move to per-property keys.

Test: `npm run test:relay` (a fake camera with digest login and a fake PMS).
