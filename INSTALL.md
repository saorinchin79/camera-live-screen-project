# Install Stream Studio on another computer

Stream Studio turns a computer into a live screen: a **1920 × 1080 program output** for a TV, projector or
second monitor, controlled from an **admin page** where you add your own **camera (webcam)**, **USB capture cards**,
**shared screens and windows**, a **CCTV camera**, pictures and logos. This guide installs it on a new computer and
connects your cameras, step by step.

- Time needed: about 10 minutes.
- No technical knowledge needed and no administrator password: the installer does everything for you.
- Stream Studio and everything it needs go into one folder, `StreamStudio`, in your user folder. Besides that,
  the installer only adds shortcuts.

**Contents**

1. [Before you start](#1-before-you-start)
2. [Install on Windows](#2-install-on-windows)
3. [Install on a Mac](#3-install-on-a-mac)
4. [Install on Linux](#4-install-on-linux-ubuntu-debian)
5. [Start and stop Stream Studio](#5-start-and-stop-stream-studio)
6. [Cameras, capture cards and screen sharing](#6-cameras-capture-cards-and-screen-sharing)
7. [Add a CCTV camera](#7-add-a-cctv-camera)
8. [Show the program on a TV or second screen](#8-show-the-program-on-a-tv-or-second-screen)
9. [Update to a new version](#9-update-to-a-new-version)
10. [Uninstall](#10-uninstall)
11. [Problems and solutions](#11-problems-and-solutions)
12. [Safety](#12-safety)

---

## 1. Before you start

| You need | Notes |
| --- | --- |
| A computer | Windows 10 or 11 (64-bit), macOS 13.5 (Ventura) or newer, or Ubuntu / Debian Linux |
| The installation password | Windows only: you get it from the person who gave you Stream Studio |
| Internet | Only while installing: about 70 to 90 MB is downloaded |
| A web browser | **Google Chrome** or **Microsoft Edge** work best |
| A webcam | Built in, or plugged in by USB, if you want to show a local camera |
| A CCTV camera or NVR | On the **same network** as the computer (same Wi-Fi or same router), if you want CCTV |

For a CCTV camera, also have its **IP address**, **user name** and **password** ready. [Section 7](#7-add-a-cctv-camera)
explains where to find them.

---

## 2. Install on Windows

### Option A: download and double-click (recommended)

1. Download Stream Studio:
   **https://github.com/saorinchin79/camera-live-screen-project/archive/refs/heads/main.zip**
2. Open your **Downloads** folder, right-click **camera-live-screen-project-main.zip** and choose **Extract All… → Extract**.
3. In the extracted folder, double-click **Install-Windows.bat**.
   - If Windows shows **"Windows protected your PC"**, click **More info → Run anyway**.
4. A black window opens and asks for the **installation password**. Type it and press **Enter**. Each letter
   shows as `*`, and capital and small letters count. After three wrong tries the installer stops; run it again.
5. The window then shows the installation. It:
   - copies Stream Studio to `C:\Users\<your name>\StreamStudio`
   - downloads Node.js (the engine that runs Stream Studio) into that folder, if the computer does not have it
   - installs the program's parts, including **ffmpeg** for CCTV cameras
   - adds **Stream Studio** to the desktop and the Start menu
6. It asks two questions. Type the letter and press **Enter**:
   - *Start Stream Studio automatically when you log in to Windows?* Type **y** for a computer that is only used
     as a display, otherwise **n**.
   - *Start Stream Studio now?* Press **Enter** (yes).
7. When the message **"Stream Studio is installed"** appears, the installation is done. You can delete the
   downloaded ZIP and the extracted folder.

### Option B: one line in PowerShell

Open the Start menu, type **PowerShell**, open it, paste this line and press **Enter**:

```powershell
irm https://raw.githubusercontent.com/saorinchin79/camera-live-screen-project/main/setup/install-windows.ps1 | iex
```

It does the same as option A, password included, without the ZIP. You can also send someone the single file **Install-Windows.bat**:
on its own, it downloads Stream Studio by itself.

### The first start on Windows

The first time Stream Studio starts, **Windows Defender Firewall** may ask about **Node.js JavaScript Runtime**.
Tick **Private networks** and click **Allow access**. This lets a TV or another computer on your network open the
program output. On the computer itself, Stream Studio works either way.

---

## 3. Install on a Mac

1. Open **Terminal**: press **⌘ Space**, type **Terminal**, press **Enter**.
2. Paste this line and press **Enter**:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/saorinchin79/camera-live-screen-project/main/setup/install.sh | bash
   ```

   If you downloaded the ZIP instead, type `bash ` and drag the file **setup/install.sh** from the extracted
   folder into Terminal, then press **Enter**.
3. If macOS asks **"Terminal would like to access files in your Desktop folder"**, click **Allow**. The
   installer puts the **Stream Studio** icon there.
4. Answer the two questions as on Windows (**y** or **n**, then **Enter**).
5. When **"Stream Studio is installed"** appears, the installation is done.

Stream Studio is installed in your home folder, in `StreamStudio`. The first time you use a camera, macOS asks for permissions:
allow the **browser** to use the **camera**, and allow **Terminal** to find devices on your **local network**
(needed for CCTV cameras).

---

## 4. Install on Linux (Ubuntu, Debian)

Open a terminal, paste this line and press **Enter**:

```bash
curl -fsSL https://raw.githubusercontent.com/saorinchin79/camera-live-screen-project/main/setup/install.sh | bash
```

If `curl` is missing, install it first with `sudo apt install curl`. **Stream Studio** then appears in the
applications menu and on the desktop. On some desktops you must right-click the desktop icon once and choose
**Allow Launching**.

---

## 5. Start and stop Stream Studio

**Start:** double-click **Stream Studio** on the desktop (on Windows also in the Start menu).

- A black window opens with lines like these. **Keep this window open** while you use Stream Studio:

  ```
  Stream Studio is running
  Admin  : http://localhost:3000/admin/
  Output : http://localhost:3000/output/   (press F for fullscreen)
  LAN    : http://192.168.1.25:3000/
  CCTV   : ffmpeg 6.0 (installed with Stream Studio)
  Stop   : close this window or press Ctrl+C
  ```

- Your browser opens the **admin page** by itself. If it does not, type `http://localhost:3000/admin/` into the browser.
- Write down the **LAN** address: TVs and other computers use it to show the program (section 8).

**Stop:** close the black window.

If you double-click the icon while Stream Studio is already running, it just opens the admin page again.

| Page | Address on this computer | What it is |
| --- | --- | --- |
| Admin | http://localhost:3000/admin/ | Where you build the screen: cameras, pictures, layout |
| Output | http://localhost:3000/output/ | The program itself, for the TV or second screen |

---

## 6. Cameras, capture cards and screen sharing

A webcam, a USB capture card and a shared screen all come from the computer the admin page is open on. The
program shows them while that admin page stays open, so open it on that computer and leave it open.

### 6.1 Your own camera (webcam)

1. In the admin page, click **Add source** (top left). The **Local camera** tab is open.
2. Choose the **Capture resolution** (1280 × 720 is a good choice). Optional: tick **Mirror horizontally** to show
   the picture like a mirror.
3. Choose the **Initial size** and **Position**, then click **Start camera & add to layout**.
4. The browser asks to use your camera. Click **Allow**.
5. If the computer has more than one camera, open **Add source** again: the **Camera device** list now shows their
   names, and picking another one switches the camera.
6. The camera now shows in the preview and on the output. Drag it to move it, pull the white corner handles to
   resize it, or pick a ready-made layout under **Split layouts** (Picture-in-picture, Half split,
   1/2 horizontal, 1/3 horizontal, …).

Important:

- Open the admin page **on the computer the webcam is connected to**, at `http://localhost:3000/admin/`.
  Browsers only allow the camera on "localhost" (or on an HTTPS address, see the README).
- Close Zoom, Teams, Skype and other programs that use the camera: a webcam works in only one program at a time.
- If the camera is blocked, see [Problems and solutions](#11-problems-and-solutions).

### 6.2 A USB capture card or another USB camera

An HDMI capture card brings in a camera, a laptop or a game console; it plugs into USB. Webcams and other USB video
devices work the same way, and several can be live at once.

1. Plug the device in, then click **Add source** → **USB device**.
2. The first time, the browser asks to use the camera: click **Allow**. The **Device** list shows every video device
   plugged into the computer, with a live preview of the one you choose.
3. Choose the **Format**: 1920 × 1080 at 30 fps suits most capture cards. 60 fps is smoother but needs a faster
   computer.
4. Optional: type a **Name**, such as *Laptop HDMI*. Choose the **Initial size** (*Full screen* fills the whole
   program) and the **Position**, then click **Add to layout**.
5. To add another device, open **Add source** → **USB device** again and choose it.

A device that is on the layout starts again by itself when the admin page opens again, and when it is plugged back
in after being unplugged. To switch it off, select its overlay and click **Stop device** under **Source**.
Changing the **Format** of a device that is live applies straight away.

### 6.3 Share a screen or window

1. Click **Add source** → **Screen share**.
2. Choose the **Frame rate**: 15 fps for slides and documents, 30 fps for video, 60 fps for games.
3. Click **Choose a screen or window…**. The browser asks what to share: a whole **screen**, one **window** (such as
   PowerPoint or a video player) or a **browser tab**. Pick it and click **Share**.
4. Check the preview, optionally type a **Name**, choose the **Initial size** and **Position**, then click
   **Add to layout**.
5. To share another window as well, repeat these steps.

The browser shows a "sharing" bar while a share runs; **Stop sharing** there ends it, and the overlay then says
*Not shared*. Select the overlay and click **Share again…** under **Source** to share again, or **Change window…**
to show another window in its place. After the admin page is reloaded, shares have to be started again this way:
browsers never share a screen without asking.

### 6.4 On the main screen or in the split screen

**Sources** has two cards, and each one opens **Add source**:

- **Main Screen**: what you add fills the whole program, such as a shared browser tab, a capture card or the webcam.
  Here the **Custom** tab also gives the main screen its own video, picture or CCTV camera underneath (see 7.3).
- **Split Screen**: what you add is a window on top of the main screen, such as the webcam in a corner. The
  **Add source** button at the top does the same.

PNG and GIF pictures, such as a logo or an animated sticker, are in the **Custom** tab for both cards.

Each source shows under its card as a layer. Click a layer to change it in **Properties**: size and position, crop,
order. **Move to main screen** / **Move to split screen** under **Layer** moves it to the other card. The split layouts
(Picture-in-picture, Half split, …) arrange the split screen's camera.

---

## 7. Add a CCTV camera

Stream Studio plays CCTV cameras and NVR/DVR recorders that offer an **RTSP** stream. Almost all brands do
(Hikvision, Dahua, EZVIZ, Imou, Reolink, TP-Link Tapo, Uniview…). Cameras that only work through a cloud app,
with no RTSP option (many Xiaomi models, for example), cannot be used.

### 7.1 Find the camera's details

You need four things:

| Detail | Where to find it |
| --- | --- |
| **IP address** (for example `192.168.1.64`) | In the NVR's menu (Network settings), in the camera's phone app (device info), in your router's list of connected devices, or with the brand's finder tool: **SADP** for Hikvision, **ConfigTool** for Dahua |
| **User name** | Usually `admin` |
| **Password** | The camera or NVR password (for EZVIZ: the 6-letter **verification code** on the camera's label) |
| **RTSP port** | Usually **554** |

The computer must be on the **same network** as the camera or NVR.

### 7.2 Build the stream address (RTSP URL)

Replace `user`, `password` and `IP` with your details:

| Brand | Stream address |
| --- | --- |
| **Hikvision**, HiLook | `rtsp://user:password@IP:554/Streaming/Channels/101` |
| **EZVIZ** | `rtsp://admin:VERIFICATIONCODE@IP:554/h264/ch1/main/av_stream` (the code is on the camera's label) |
| **Dahua**, Imou, Amcrest | `rtsp://user:password@IP:554/cam/realmonitor?channel=1&subtype=0` |
| **Reolink** | `rtsp://user:password@IP:554/h264Preview_01_main` |
| **TP-Link Tapo** | `rtsp://user:password@IP:554/stream1` (first create a *Camera Account* in the Tapo app: the camera's settings → Advanced Settings → Camera Account; use that user and password) |
| **Uniview** | `rtsp://user:password@IP:554/unicast/c1/s0/live` |

Through an **NVR / DVR**, each camera is a channel:

- **Hikvision**: `101` is camera 1, `201` camera 2, `301` camera 3…
- **Dahua**: `channel=1`, `channel=2`…
- **Sub stream** (smaller picture, uses less network and computer power): Hikvision `102` instead of `101`,
  Dahua `subtype=1`, Reolink `h264Preview_01_sub`, Tapo `stream2`. A sub stream is often enough for a screen.

Brand notes:

- **EZVIZ:** in the EZVIZ app, turn **Image Encryption** off for the camera; otherwise the picture cannot be read.
- **Passwords with special characters:** if the password contains `@`, `/`, `?` or `#` and the test fails, give
  the camera (or a separate viewer account on the NVR) a password of only letters and numbers.

Optional check: in **VLC media player** choose **Media → Open Network Stream**, paste the address and click
**Play**. If VLC shows the picture, Stream Studio can too.

### 7.3 Put the camera on the main screen

1. In the admin page, click **Main Screen** (left, at the top of Sources). The **Add source** window opens on the
   **Custom** tab.
2. Choose **Live CCTV camera**.
3. Fill in:
   - **Camera name**, for example *Front gate*
   - **Stream URL**: the address from 7.2
   - **Frame rate**: 15 fps is smooth and light; choose 5 or 10 fps for a slow computer or network
4. Click **Test connection**. After a few seconds you see a picture from the camera and
   **"Connected · 1920 × 1080 · H264"**. If you see an error instead, check the table in 7.6.
5. Click **Apply to main screen**. The camera fills the program and is live, and shows under **Main Screen** in
   Sources.

The camera is saved. To add more cameras, choose **+ Add a new camera** in the **Camera** list. To switch, click
**Main Screen** again (or the pencil next to the camera under it), pick another camera and click
**Apply to main screen**.

The password is kept on this computer only. The admin page shows it as `••••`, and the screens never receive it.

### 7.4 Cut a toolbar or timestamp off the picture (crop)

Many CCTV pictures, and screen recordings of CCTV apps, have a timestamp, a channel name or a toolbar along an edge.

1. In Sources, click the camera under **Main Screen**.
2. In **Properties → Crop**, drag **Top**, **Bottom**, **Left** or **Right** until the toolbar is gone.
   The preview changes as you drag.
3. **Reset** puts the picture back.

The rest of the picture fills the screen. Under **Fit**, choose **Cover** (fill the screen),
**Contain** (show everything, with black bars) or **Stretch**. Crop works the same way for the webcam and for
pictures: select them and use **Crop** in Properties.

### 7.5 What you see while a camera connects

- **"LIVE CCTV · CONNECTING…"** on the main screen until the first picture arrives (a few seconds).
- **"● RECONNECTING"** in the top-right corner when the camera drops. Stream Studio tries again by itself, and the
  picture comes back when the camera is reachable again.
- The admin page shows the status when you click the camera under **Main Screen**, in **Properties → Source**, for
  example **"Live · 1920 × 1080 · 2 viewers"**, or what is wrong.

### 7.6 If the test fails

| Message | What to do |
| --- | --- |
| *Wrong user name or password for the camera* | Check the user name and password. For EZVIZ, use the verification code from the label |
| *The camera refused the connection* | Check the IP address and the port (554). Make sure RTSP is turned on in the camera's settings |
| *The camera cannot be reached from this computer* | The computer and the camera are not on the same network, or the IP address is wrong. On a Mac, allow **Local Network** for Terminal (System Settings → Privacy & Security → Local Network) |
| *The camera did not answer in time* | Wrong IP address, or the camera is off or busy. Try the sub stream |
| *The camera answered, but the stream path is wrong* | The part after the port is wrong for this brand: check the table in 7.2 |
| *This URL did not give a video stream that ffmpeg can read* | The address is not a video stream: use the RTSP address, not the camera's web page |
| *ffmpeg is not installed on the server* | Run the installer again (section 9); on a Mac you can also run `brew install ffmpeg` |

---

## 8. Show the program on a TV or second screen

**A second monitor or projector on the same computer**

1. Open `http://localhost:3000/output/` in a new browser window.
2. Drag the window to the second screen and press **F** for fullscreen. Press **F** again to leave fullscreen.

**A smart TV, another computer, or a tablet on the same network**

1. Open the **LAN** address from the black window and add `output/`, for example
   `http://192.168.1.25:3000/output/`, in the device's browser.
2. Press **F**, or use the browser's fullscreen.
3. If it does not open, allow Node.js in the Windows Firewall (section 2), and make sure the Windows network is set
   to **Private** (Settings → Network & internet → your network → Network profile type → Private).

**Live streaming with OBS Studio**

Add a **Browser** source with the output address, width **1920** and height **1080**.

Changes you make in the admin page appear on every output at once. Several screens can show the output at the
same time.

---

## 9. Update to a new version

Your layout, cameras, passwords and uploaded pictures and videos are kept.

- **Windows:** Start menu → **Stream Studio - Update**. Or double-click **Install-Windows.bat** in the
  `StreamStudio` folder. It asks for the installation password again.
- **Mac and Linux:** run the installation line from section 3 / 4 again, or in Terminal:
  `bash ~/StreamStudio/setup/install.sh`

If Stream Studio is running, the installer closes it first. Afterwards, start it again from the desktop icon.

---

## 10. Uninstall

**Windows**

1. Close Stream Studio.
2. Delete the folder `C:\Users\<your name>\StreamStudio`.
3. Delete the **Stream Studio** shortcut from the desktop.
4. Delete the shortcuts from the Start menu folder: press **Windows + R**, type `shell:programs`, press **Enter**.
5. If you chose to start it at log-in, press **Windows + R**, type `shell:startup`, press **Enter**, and delete the
   shortcut there.

**Mac**

Delete these:

- `StreamStudio` in your home folder
- **Stream Studio** on the desktop
- if you chose to start it at log-in, `~/Library/LaunchAgents/com.streamstudio.server.plist`. In Finder use
  **Go → Go to Folder…** and paste `~/Library/LaunchAgents`.

**Linux**

Delete these:

- `~/StreamStudio`
- `~/.local/share/applications/stream-studio.desktop`
- the desktop icon
- `~/.config/autostart/stream-studio.desktop`

---

## 11. Problems and solutions

| Problem | Solution |
| --- | --- |
| The installer stopped with *"Installation failed"* | Read the message above it, fix it (usually the internet connection), and run the installer again. It continues where it stopped |
| *"Wrong password"*, then *"The password was wrong 3 times"* (Windows) | Run the installer again and type the installation password exactly, with the same capital and small letters. If you do not have it, ask the person who gave you Stream Studio |
| *"The downloaded Node.js does not run on this computer"* (older Mac) | The current Node.js needs macOS 13.5 or newer. On macOS 11 or 12, install **Node.js 22** from https://nodejs.org/en/download (choose v22), then run the installer again: it uses that Node.js |
| *"Windows protected your PC"* | Click **More info → Run anyway** |
| The black window shows *"Port 3000 is used by another program"* | Another program uses the same port. Close it, or give Stream Studio another port: create a text file **port.txt** in the `StreamStudio\data` folder containing only `3001` (check that Windows did not name it `port.txt.txt`). Then use `http://localhost:3001/…` |
| The browser does not open by itself | Type `http://localhost:3000/admin/` into the browser |
| *"Camera access was blocked"* in the admin | Click the camera icon in the browser's address bar and choose **Always allow**, then reload the page. **Windows:** Settings → Privacy & security → Camera → turn on *Camera access* and *Let desktop apps access your camera*. **Mac:** System Settings → Privacy & Security → Camera → turn on your browser |
| The webcam list says *"No camera found"* | Plug the webcam in again, close other programs that use it, and reload the admin page |
| The camera works in the admin but not on the TV | The output receives the webcam from the admin page: keep the admin page open on the computer with the webcam |
| A USB device says *"The device is busy"* | Another program uses it: close Zoom, Teams, OBS or the Camera app, then choose the device again |
| The USB device list says *"No device found"* | Plug the device in again (into a blue USB 3 port if the capture card needs one), and check that it shows in the computer's Camera app |
| *"This computer does not let the browser share the screen"* (Mac) | System Settings → Privacy & Security → Screen & System Audio Recording → turn on your browser, then quit and reopen the browser |
| A shared window is black on the program | Some programs block window capture: share the whole **screen** instead, or turn off the program's hardware acceleration |
| A TV or other computer cannot open the output | Use the **LAN** address, not `localhost`. Allow Node.js in the firewall and set the Windows network to **Private** |
| The CCTV picture is slow or jerky | Use the camera's **sub stream** and a lower frame rate (5 or 10 fps) |
| A CCTV camera stops working after its password was changed | Main Screen → Live CCTV camera → pick the camera, type the new password into the Stream URL, Test connection, Apply |

---

## 12. Safety

- Stream Studio has **no login**. Anyone on the same network can open the admin page, change the screen and watch the
  CCTV cameras through it. Use it on your own trusted network only.
- Do not make port 3000 reachable from the internet (no port forwarding on the router).
- Camera passwords are saved only on this computer, in `StreamStudio/data/cctv.json`.
