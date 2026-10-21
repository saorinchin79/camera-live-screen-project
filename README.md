# Stream Studio — Camera Live Screen

A 1920 × 1080 program output with admin-controlled split-screen overlays:
the admin splits the screen, adds the **local camera live**, **PNG** and **GIF** images on top of the
main screen, and sets the size and position of every window. The main screen can show a **live CCTV
camera**, and every source can be **cropped** (cut a toolbar off a video). Changes reach the output display instantly.

```
Admin (browser)  ──layout + camera (WebRTC)──▶  Node server  ──▶  Program output (browser, fullscreen 1920×1080)
```

## Run

```bash
npm install
npm start
```

| Page | URL | What it is |
| --- | --- | --- |
| Admin | http://localhost:3000/admin/ | Layout editor: sources, preview, properties, split layouts |
| Output | http://localhost:3000/output/ | The program — open it on the display, press **F** for fullscreen |

Open the output on a second screen, a projector, a browser on another machine on the LAN, or add it to
OBS as a **Browser Source** (1920 × 1080) to stream it.

## Features

- **Main screen** — placeholder text, an uploaded MP4/WebM video, an image, a direct video URL, or a live CCTV camera; cover / contain / stretch. Select it in Sources to change its source, fit and crop.
- **Live CCTV** — RTSP (Hikvision, Dahua, Imou, NVRs…), RTMP, HTTP MJPEG or HLS cameras on the main screen; test a camera before it goes on air, keep several cameras and switch between them. See [Live CCTV](#live-cctv).
- **Crop** — cut a percentage off the top, bottom, left or right of any source (main screen or overlay) to remove a toolbar, a timestamp or black bars; the rest fills the window. Sliders in Properties, live in the preview.
- **Split screen** — overlays stack on top of the main screen. Presets: Picture-in-picture, Half split, 1/2 horizontal, 1/3 horizontal, Presenter corner, Camera full screen.
- **Local camera live** — pick the camera device, resolution and mirroring; the stream goes to every output over WebRTC (optional microphone audio).
- **PNG / GIF** — upload (transparency kept, GIFs animate) or reuse an uploaded file; drag and drop supported.
- **Size & position** — drag the window in the preview, pull the handles to resize, type X / Y / Width / Height in output pixels, lock aspect ratio, quick sizes (1/4 … full width), 3 × 3 snap grid with a 48 px safe margin, arrow-key nudging.
- **Appearance** — opacity, corner radius, fit, white border, mirror (camera).
- **Layer order** — bring forward / send back, hide without removing, duplicate, remove.
- **Auto take** — every change goes to the program; turn it off to prepare changes and press **Take to program**.
- Layout is saved to `data/layout.json` and restored on restart; uploads live in `uploads/`.

## Live CCTV

Browsers cannot play RTSP, so the server converts the camera with **ffmpeg** (install it: `brew install ffmpeg`
on macOS, `apt install ffmpeg` on Linux). While anyone watches a camera, one ffmpeg reads it and sends Motion JPEG
to every output, so ten screens still cost the camera one connection. ffmpeg starts with the first viewer,
reconnects on its own when the camera drops (the output shows a RECONNECTING badge) and stops 15 s after
the last viewer leaves.

In the admin: select **Main Screen** → **Change main screen source…** → **Live CCTV camera**, enter the camera's
stream URL, press **Test connection**, then **Apply to main screen**.

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
| `PORT` | `3000` | HTTP(S) port |
| `MAX_UPLOAD_MB` | `500` | Upload size limit |
| `SSL_KEY`, `SSL_CERT` | – | PEM files; when both are set the server runs HTTPS |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg used for CCTV cameras (the startup log shows the version found) |

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/layout` | Current layout (JSON) |
| `PUT` | `/api/layout` | Replace the layout and push it to all outputs |
| `POST` | `/api/upload` | Multipart upload, field `file` (PNG, GIF, JPG, WebP, MP4, WebM) → `{ url }` |
| `GET` | `/api/uploads` | List uploaded files |
| `DELETE` | `/api/uploads/:name` | Delete an uploaded file |
| `GET` | `/api/cctv` | CCTV cameras (passwords masked) with their live status |
| `POST` | `/api/cctv` | Add a camera `{ name, url, fps }` (fps 5 / 10 / 15 / 25) |
| `PUT` | `/api/cctv/:id` | Change a camera; a masked password in `url` keeps the stored one |
| `DELETE` | `/api/cctv/:id` | Delete a camera (a main screen showing it goes back to the placeholder) |
| `POST` | `/api/cctv/test` | Grab one frame `{ url }` or `{ id, url }` → `{ ok, width, height, codec, image }` or `{ ok: false, error, hint }` |
| `GET` | `/api/cctv/:id/stream.mjpg` | The camera live as `multipart/x-mixed-replace` MJPEG |

Socket.IO events: `hello {role}`, `layout`, `layout:set`, `camera:state`, `peers`, `output:joined`,
`output:left`, `admin:left`, `rtc:signal {to, data}` (WebRTC offer / answer / ICE relay),
`cctv:status {id, state, message, hint, width, height, viewers}` (state: idle / connecting / live / error).

## Layout format

```json
{
  "output": { "width": 1920, "height": 1080 },
  "main": { "type": "video", "src": "/uploads/program.mp4", "fit": "cover", "loop": true, "muted": true, "label": "Main Screen",
            "crop": { "top": 7.5, "right": 0, "bottom": 0, "left": 0 } },
  "layers": [
    { "id": "cam-main", "type": "camera", "name": "Local Camera", "x": 48, "y": 48, "w": 640, "h": 360,
      "opacity": 1, "radius": 8, "visible": true, "fit": "cover", "mirror": false, "border": true,
      "crop": { "top": 0, "right": 0, "bottom": 0, "left": 0 } },
    { "id": "img-1", "type": "image", "name": "Logo", "src": "/uploads/logo.png", "x": 1712, "y": 48, "w": 160, "h": 160,
      "opacity": 1, "radius": 0, "visible": true, "fit": "contain", "border": false,
      "crop": { "top": 0, "right": 0, "bottom": 0, "left": 0 } }
  ],
  "template": "pip"
}
```

`layers` are drawn back to front; coordinates are output pixels on the 1920 × 1080 program.
`crop` is the percentage cut off each edge of the source (0–45 per edge) before it is fitted.
A CCTV main screen is `{ "type": "cctv", "src": "/api/cctv/<id>/stream.mjpg", "label": "<camera name>", … }`.

## Project structure

```
server.js                 Express + Socket.IO server, uploads, WebRTC signaling relay
cctv.js                   Live CCTV: camera list, one ffmpeg per watched camera, MJPEG streams
public/shared/layout.js   Layout model, templates, snapping, crop (shared by server and browser)
public/shared/stage.js    Stage renderer (main screen + overlays, crop, drag/resize in the admin)
public/shared/stage.css   Stage styles
public/admin/             Admin layout editor
public/output/            Program output page
data/layout.json          Saved layout (created on first run)
data/cctv.json            CCTV cameras with their URLs and passwords (created when the first camera is added)
uploads/                  Uploaded media (created on first run)
```

Requires Node 18 or newer, and ffmpeg for CCTV cameras. No build step.
