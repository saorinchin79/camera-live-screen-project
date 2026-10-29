# GP Studio — Camera Live Screen

A 1920 × 1080 program output with admin-controlled split-screen overlays:
the admin splits the screen, adds the **local camera live**, **USB capture cards**, **shared screens and
windows**, **PNG** and **GIF** images on top of the main screen, and sets the size and position of every window.
The main screen can show a **live CCTV camera**, every source can be **cropped** (cut a toolbar off a video), and a
video window can **lose its background colour** (a green screen, the plain colour behind a logo).
Changes reach the output display instantly.

```
Admin (browser)  ──layout + camera, USB devices, screens (WebRTC)──▶  Node server  ──▶  Program output (browser, fullscreen 1920×1080)
```

**Installing on another computer?** Follow **[INSTALL.md](INSTALL.md)**: a step-by-step guide with one-click
installers for Windows (`Install-Windows.bat`), macOS and Linux (`setup/install.sh`), and how to connect a
webcam, USB capture cards, screen sharing and CCTV cameras.

## Run

```bash
npm install
npm start
```

Or double-click `Start-StreamStudio.bat` (Windows) / `Start-StreamStudio.command` (macOS, Linux): it starts the
server and opens the admin page in the browser.

| Page | URL | What it is |
| --- | --- | --- |
| Admin | http://localhost:3000/admin/ | Layout editor: sources, preview, properties, split layouts |
| Output | http://localhost:3000/output/ | The program — open it on the display, press **F** for fullscreen |

Open the output on a second screen, a projector, a browser on another machine on the LAN, or add it to
OBS as a **Browser Source** (1920 × 1080) to stream it.

## Features

- **Main screen** — click **Main Screen** in Sources to add to it: a shared screen or browser tab, a USB device, the camera or a PNG/GIF that fills the program, and underneath them its own picture; PNG/GIF and the picture are in the **Custom** tab (placeholder text, an uploaded MP4/WebM video, an image, a YouTube link or a direct video URL, or a live CCTV camera; cover / contain / stretch). Each shows under the card as a layer: click it to edit it; the picture's pencil changes it.
- **YouTube** — paste a YouTube video, live stream, Shorts or playlist link in **Custom → Video URL**. The server checks it first through YouTube's oEmbed: its title names the layer, and a video whose owner does not let other sites play it is refused before it goes on air. YouTube's own player then plays it on every output by itself, without controls, looping, muted unless *Mute video* is off. The outputs need internet. Browsers play sound only on a page someone has clicked: with *Mute video* off, the first click or key on the output page starts the sound, and OBS plays it straight away.
- **Live CCTV** — RTSP (Hikvision, Dahua, Imou, NVRs…), RTMP, HTTP MJPEG or HLS cameras on the main screen or in split screen windows; test a camera before it goes on air, keep several cameras and switch between them. See [Live CCTV](#live-cctv).
- **Crop** — cut a percentage off the top, bottom, left or right of any source (main screen or overlay) to remove a toolbar, a timestamp or black bars; the rest fills the window. Sliders in Properties, live in the preview.
- **Remove background** — select a video window and tick *Remove the video’s background colour* in Properties: the plain colour behind a logo or a person (a green screen, a red or a black backdrop) turns see-through on the preview and on every output, and the window loses its white border. The colour is found from the video itself and shown next to its swatch; pick another there, and fine-tune *Strength* (how much around that colour goes), *Edge softness* and *Colour spill removal* (the colour's tint on the edges that stay). *Reset* finds the colour again. A colour is matched by its tint, so the darker and lighter parts of an unevenly lit green screen go together; black, white or grey by brightness. Works on uploaded video files (a browser may not read the pictures of a video from another site); each screen keys the video on its graphics card (WebGL).
- **Split screen** — click **Split Screen** (or **Add source**) to add windows on top of the main screen; they show under the card as layers. Its **Custom** tab has the main screen's choices too (placeholder text, a video file, an image, a video URL or YouTube link, a live CCTV camera, a PNG/GIF), each as a window with its own size and position; a video or YouTube window has *Loop video* and *Mute video* in Properties. Presets for the split screen's camera: Picture-in-picture, Half split, 1/2 horizontal, 1/3 horizontal, Presenter corner, Camera full screen.
- **Local camera live** — pick the camera device, resolution and mirroring; the stream goes to every output over WebRTC (optional microphone audio).
- **USB devices** — HDMI capture cards, webcams and any other video device plugged into the admin's computer, several at once, each as its own overlay; pick the format (size and 30 / 60 fps). A device on the layout starts again by itself when the admin page opens or the device is plugged back in.
- **Screen share** — share a whole screen, one window or a browser tab of the admin's computer (the browser asks which) at 15, 30 or 60 fps; any number of shares, each its own overlay. *Share again…* / *Change window…* in Properties.
- **PNG / GIF** — in the **Custom** tab of Add source, for either screen: upload (transparency kept, GIFs animate) or reuse an uploaded file; drag and drop supported. The bin next to an uploaded file deletes it, after asking; when it is on the layout, its windows go and a main screen that shows it goes back to the placeholder.
- **Size & position** — drag the window in the preview, pull the handles to resize, type X / Y / Width / Height in output pixels, lock aspect ratio, quick sizes (1/4 … full width), 3 × 3 snap grid with a 48 px safe margin, arrow-key nudging.
- **Appearance** — opacity, corner radius, fit, white border, mirror (camera, USB device).
- **Layer order** — bring forward / send back within its screen, hide without removing, duplicate, remove, move to the other screen (*Move to main screen* / *Move to split screen*).
- **Auto take** — every change goes to the program; turn it off to prepare changes and press **Take to program**.
- **English / ខ្មែរ** — the switch in the admin's header shows the admin in Khmer; the browser remembers the choice. Layer and camera names stay as they were typed, and the program itself is never translated. The admin is written in English, and `public/admin/km.js` gives the Khmer for each English text (`{n}` stands for a number, `{name}` for a value): a text missing there shows in English.
- **Home screen** — on a phone or tablet, *Add to Home Screen* (Safari, Chrome) puts the admin on the home screen with the GP logo, and Chrome on the computer that runs it (http://localhost) installs it as an app with the GP app icon. The browser tab shows the logo too.
- Layout is saved to `data/layout.json` and restored on restart; uploads live in `uploads/`.

## Live CCTV

Browsers cannot play RTSP, so the server converts the camera with **ffmpeg**. `npm install` brings a copy
(the optional `ffmpeg-static` package); an ffmpeg already on the PATH, or `FFMPEG_PATH`, is preferred.
While anyone watches a camera, one ffmpeg reads it and sends Motion JPEG
to every output, so ten screens still cost the camera one connection. ffmpeg starts with the first viewer,
reconnects on its own when the camera drops (the output shows a RECONNECTING badge) and stops 15 s after
the last viewer leaves.

In the admin: click **Main Screen** (Add source opens on its **Custom** tab) → **Live CCTV camera**, enter the camera's
stream URL, press **Test connection**, then **Apply to main screen**. The camera then shows under Main Screen in
Sources; its pencil changes it.

| Camera | Stream URL |
| --- | --- |
| Hikvision / HiLook | `rtsp://user:password@IP:554/Streaming/Channels/101` (`102` = sub stream, `201` = channel 2 on an NVR) |
| Dahua / Imou / Amcrest | `rtsp://user:password@IP:554/cam/realmonitor?channel=1&subtype=0` (`subtype=1` = sub stream) |
| Reolink | `rtsp://user:password@IP:554/h264Preview_01_main` |
| Others | `rtsp://…`, `rtmp://…`, an HTTP MJPEG URL (`http://IP:8080/video`) or an `.m3u8` HLS link |

Camera URLs and passwords are kept in `data/cctv.json` (readable only by the server's user). Outputs and
`/api/layout` only ever see `/api/cctv/<id>/stream.mjpg`, and the admin gets the URL with the password masked.
A sub stream (640 × 360 or 720p) is usually enough for a screen and saves CPU and bandwidth.

If the test says the camera cannot be reached on macOS, allow **Local Network** access for the app that runs the
server (Terminal, VS Code…) in System Settings › Privacy & Security › Local Network.

## Camera access over the LAN (HTTPS)

Browsers only allow camera access on `localhost` or over **HTTPS**. If the admin page is opened from another
machine (e.g. `http://192.168.1.20:3000/admin/`), the camera will not start. Run the server with a certificate:

```bash
# one-off: a locally-trusted certificate with mkcert (https://github.com/FiloSottile/mkcert)
mkcert -install
mkcert localhost 192.168.1.20        # add your LAN IP / hostname

SSL_KEY=./localhost+1-key.pem SSL_CERT=./localhost+1.pem npm start
# → https://192.168.1.20:3000/admin/
```

The output page works over plain HTTP; only the admin needs HTTPS when it is not on localhost.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP(S) port; without it, a number in `data/port.txt` is used (updates keep that file) |
| `MAX_UPLOAD_MB` | `500` | Upload size limit |
| `SSL_KEY`, `SSL_CERT` | – | PEM files; when both are set the server runs HTTPS |
| `FFMPEG_PATH` | – | ffmpeg for CCTV cameras; without it the server uses `ffmpeg` on the PATH, else the copy npm installed (`ffmpeg-static`). The startup log shows which |
| `OPEN_BROWSER` | – | `1` opens the admin page in the browser once the server is ready (the Start-StreamStudio launchers set it) |

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/layout` | Current layout (JSON) |
| `PUT` | `/api/layout` | Replace the layout and push it to all outputs |
| `POST` | `/api/upload` | Multipart upload, field `file` (PNG, GIF, JPG, WebP, MP4, WebM) → `{ url }` |
| `GET` | `/api/uploads` | List uploaded files |
| `DELETE` | `/api/uploads/:name` | Delete an uploaded file (the windows that show it are removed, a main screen that shows it goes back to the placeholder) |
| `GET` | `/api/cctv` | CCTV cameras (passwords masked) with their live status |
| `POST` | `/api/cctv` | Add a camera `{ name, url, fps }` (fps 5 / 10 / 15 / 25) |
| `PUT` | `/api/cctv/:id` | Change a camera; a masked password in `url` keeps the stored one |
| `DELETE` | `/api/cctv/:id` | Delete a camera (a main screen showing it goes back to the placeholder, its split screen windows are removed) |
| `POST` | `/api/cctv/test` | Grab one frame `{ url }` or `{ id, url }` → `{ ok, width, height, codec, image }` or `{ ok: false, error, hint }` |
| `GET` | `/api/cctv/:id/stream.mjpg` | The camera live as `multipart/x-mixed-replace` MJPEG |
| `GET` | `/api/youtube?url=…` | Check a YouTube link → `{ ok, src, title, author }`, or `{ ok: false, error }` for a video that is private, removed, or not allowed on other sites |

Socket.IO events: `hello {role}`, `layout`, `layout:set`, `camera:state`, `peers`, `output:joined`,
`output:left`, `admin:left`, `rtc:signal {to, data}` (WebRTC offer / answer / ICE relay; `data.source` is
`camera` or the source id of a USB device or screen share — one connection per output and source),
`sources:state` / `sources` (`{ <source id>: { kind: usb | screen, label } }` that the admin windows publish),
`cctv:status {id, state, message, hint, width, height, viewers}` (state: idle / connecting / live / error).

## Layout format

```json
{
  "output": { "width": 1920, "height": 1080 },
  "main": { "type": "video", "src": "/uploads/program.mp4", "fit": "cover", "loop": true, "muted": true, "label": "Main Screen",
            "crop": { "top": 7.5, "right": 0, "bottom": 0, "left": 0 } },
  "layers": [
    { "id": "screen-1", "type": "screen", "group": "main", "name": "Browser tab", "source": "screen-mvqfn7ednyuf",
      "x": 0, "y": 0, "w": 1920, "h": 1080, "opacity": 1, "radius": 0, "visible": true, "fit": "contain", "mirror": false,
      "border": false, "crop": { "top": 0, "right": 0, "bottom": 0, "left": 0 } },
    { "id": "cam-main", "type": "camera", "group": "split", "name": "Local Camera", "x": 48, "y": 48, "w": 640, "h": 360,
      "opacity": 1, "radius": 8, "visible": true, "fit": "cover", "mirror": false, "border": true,
      "crop": { "top": 0, "right": 0, "bottom": 0, "left": 0 } },
    { "id": "img-1", "type": "image", "group": "split", "name": "Logo", "src": "/uploads/logo.png", "x": 1712, "y": 48, "w": 160, "h": 160,
      "opacity": 1, "radius": 0, "visible": true, "fit": "contain", "border": false,
      "crop": { "top": 0, "right": 0, "bottom": 0, "left": 0 } }
  ],
  "template": "pip"
}
```

`layers` are drawn back to front; coordinates are output pixels on the 1920 × 1080 program.
`group` is the screen a layer belongs to: `main` (part of the main screen, drawn under the split screen) or `split`
(a split-screen window on top; the default, also for layouts saved before groups existed). The main screen's layers
always come first.
`crop` is the percentage cut off each edge of the source (0–45 per edge) before it is fitted.
A video window has `"key": { "on": true, "color": "#bc0000", "similarity": 40, "smoothness": 20, "spill": 50 }`:
Remove background, the colour made see-through and the three sliders in % (`color` `""` = found from the video
by the screen that shows it; the admin then keeps what it found).
A CCTV main screen is `{ "type": "cctv", "src": "/api/cctv/<id>/stream.mjpg", "label": "<camera name>", … }`.
A YouTube main screen is `{ "type": "youtube", "src": "https://www.youtube.com/watch?v=<id>", "label": "<video title>", … }`
(`&list=` for a playlist, `&t=90s` to start later); a `video` main screen given a YouTube link becomes one.
A USB device overlay is `{ "type": "usb", "source": "usb-…", "device": { "id": "<browser device id>", "label": "<device name>",
"width": 1920, "height": 1080, "fps": 30 }, … }`, a screen share `{ "type": "screen", "source": "screen-…", … }`;
overlays with the same `source` show the same stream.
A video, YouTube or CCTV window is `{ "type": "video" | "youtube" | "cctv", "src": …, … }` with the `src` rules of the main
screen (video and YouTube add `"loop"` and `"muted"`), a text window `{ "type": "text", "name": "<the text it shows>", … }`.

## Project structure

```
server.js                 Express + Socket.IO server, uploads, WebRTC signaling relay
cctv.js                   Live CCTV: camera list, one ffmpeg per watched camera, MJPEG streams
public/shared/layout.js   Layout model, templates, snapping, crop (shared by server and browser)
public/shared/stage.js    Stage renderer (main screen + overlays, crop, drag/resize in the admin)
public/shared/keyer.js    Remove background: draws a video without its backdrop colour (WebGL), finds that colour
public/shared/stage.css   Stage styles
public/admin/             Admin layout editor
public/admin/i18n.js      English / Khmer switch: translates the admin as it is shown
public/admin/km.js        The Khmer for each English text of the admin
public/output/            Program output page
public/favicon.ico        Browser-tab icon
public/apple-touch-icon.png  Home-screen icon on iPhone and iPad
public/icons/             The installed app's icon (Chrome, Android), the logo in the admin's header
public/manifest.webmanifest  Name and icons of the admin on a home screen
INSTALL.md                Step-by-step installation on another computer, webcam and CCTV set-up
Install-Windows.bat       Windows installer (double-click); runs setup/install-windows.ps1
Start-StreamStudio.bat    Windows launcher: starts the server, opens the admin
Start-StreamStudio.command  macOS / Linux launcher
setup/install.sh          macOS / Linux installer
setup/stream-studio.ico   Icon of the shortcuts (.png for Linux)
setup/brand/              The GP logo (gp-logo.png, transparent) and the app icon (app-icon.png); after changing one, `node setup/brand/make-icons.js` makes every icon again (raise `?v=` on the pages' icon links)
data/layout.json          Saved layout (created on first run)
data/cctv.json            CCTV cameras with their URLs and passwords (created when the first camera is added)
data/port.txt             Optional: the port, when it is not 3000
uploads/                  Uploaded media (created on first run)
runtime/node/             Node.js downloaded by the installers when the computer has no Node.js 18+
```

Requires Node 18 or newer. ffmpeg for CCTV cameras comes with `npm install`. No build step.
