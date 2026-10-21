# Stream Studio — Camera Live Screen

A 1920 × 1080 program output with admin-controlled split-screen overlays:
the admin splits the screen, adds the **local camera live**, **PNG** and **GIF** images on top of the
main screen, and sets the size and position of every window. Changes reach the output display instantly.

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

- **Main screen** — placeholder text, an uploaded MP4/WebM video, an image, or a direct video URL; cover / contain / stretch.
- **Split screen** — overlays stack on top of the main screen. Presets: Picture-in-picture, Half split, Presenter corner, Camera full screen.
- **Local camera live** — pick the camera device, resolution and mirroring; the stream goes to every output over WebRTC (optional microphone audio).
- **PNG / GIF** — upload (transparency kept, GIFs animate) or reuse an uploaded file; drag and drop supported.
- **Size & position** — drag the window in the preview, pull the handles to resize, type X / Y / Width / Height in output pixels, lock aspect ratio, quick sizes (1/4 … full width), 3 × 3 snap grid with a 48 px safe margin, arrow-key nudging.
- **Appearance** — opacity, corner radius, fit, white border, mirror (camera).
- **Layer order** — bring forward / send back, hide without removing, duplicate, remove.
- **Auto take** — every change goes to the program; turn it off to prepare changes and press **Take to program**.
- Layout is saved to `data/layout.json` and restored on restart; uploads live in `uploads/`.

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

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/layout` | Current layout (JSON) |
| `PUT` | `/api/layout` | Replace the layout and push it to all outputs |
| `POST` | `/api/upload` | Multipart upload, field `file` (PNG, GIF, JPG, WebP, MP4, WebM) → `{ url }` |
| `GET` | `/api/uploads` | List uploaded files |
| `DELETE` | `/api/uploads/:name` | Delete an uploaded file |

Socket.IO events: `hello {role}`, `layout`, `layout:set`, `camera:state`, `peers`, `output:joined`,
`output:left`, `admin:left`, `rtc:signal {to, data}` (WebRTC offer / answer / ICE relay).

## Layout format

```json
{
  "output": { "width": 1920, "height": 1080 },
  "main": { "type": "video", "src": "/uploads/program.mp4", "fit": "cover", "loop": true, "muted": true, "label": "Main Screen" },
  "layers": [
    { "id": "cam-main", "type": "camera", "name": "Local Camera", "x": 48, "y": 48, "w": 640, "h": 360,
      "opacity": 1, "radius": 8, "visible": true, "fit": "cover", "mirror": false, "border": true },
    { "id": "img-1", "type": "image", "name": "Logo", "src": "/uploads/logo.png", "x": 1712, "y": 48, "w": 160, "h": 160,
      "opacity": 1, "radius": 0, "visible": true, "fit": "contain", "border": false }
  ],
  "template": "pip"
}
```

`layers` are drawn back to front; coordinates are output pixels on the 1920 × 1080 program.

## Project structure

```
server.js                 Express + Socket.IO server, uploads, WebRTC signaling relay
public/shared/layout.js   Layout model, templates, snapping (shared by server and browser)
public/shared/stage.js    Stage renderer (main screen + overlays, drag/resize in the admin)
public/shared/stage.css   Stage styles
public/admin/             Admin layout editor
public/output/            Program output page
data/layout.json          Saved layout (created on first run)
uploads/                  Uploaded media (created on first run)
```

Requires Node 18 or newer. No build step.
