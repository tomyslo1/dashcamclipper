# Dashcam Clipper

Dashcam Clipper is a small desktop app for reviewing one-minute front and rear dashcam recordings. It finds driving segments, opens them in VLC, combines both camera views, trims the result, and saves the finished clip to a fixed archive folder.

The app runs on Windows and macOS. Installers are not included yet; this repository currently runs from source.

## What it expects

Choose a folder with this structure:

```text
Selected folder/
├── DCIMA/    front camera recordings
└── DCIMB/    rear camera recordings
```

Subfolders inside `DCIMA` and `DCIMB` are scanned too. AVI, MP4, MOV, and MKV files are supported.

Clip modification times are used as recording times. Consecutive clips belong to one driving segment until there is a gap longer than three minutes. Front and rear clips are paired by relative filename first, then by a recording time within 30 seconds.

## Requirements

- Node.js 20 or newer
- FFmpeg
- VLC media player
- An NVIDIA GPU is optional on Windows

Dashcam Clipper uses `hevc_nvenc` when it is available on Windows and Apple VideoToolbox on macOS. It falls back to software HEVC or H.264 encoding.

### Windows setup

Install the external tools from PowerShell:

```powershell
winget install Gyan.FFmpeg
winget install VideoLAN.VLC
```

Close and reopen PowerShell after installation. Then open this repository and run:

```powershell
corepack pnpm install
corepack pnpm start
```

If you already use npm, `npm install` followed by `npm start` works as well.

### macOS setup

With Homebrew installed:

```bash
brew install ffmpeg
brew install --cask vlc
corepack pnpm install
corepack pnpm start
```

## Workflow

1. Choose the folder that contains `DCIMA` and `DCIMB`.
2. Show every clip or filter inclusively from a starting date and optional time. An ending date and time are optional.
3. Review the front-camera thumbnail shown for each driving segment when FFmpeg is available.
4. Choose a driving segment:
   - **Play in VLC** opens a playlist of its front-camera clips.
   - **Merge & trim** stacks every front/rear pair vertically and joins the one-minute clips.
   - **Delete** asks twice, then moves both camera files to the Recycle Bin or Trash.
5. Name a merged clip and set its start and end in the built-in trimming screen.
6. Save it to the archive.

Finished clips use this filename:

```text
YYYY-MM-DD_HH-mm Clip name.mp4
```

They are written to:

- Windows: `Y:\Videos\Dashcam\Processed`
- macOS: `/Volumes/cloud/Videos/Dashcam/Processed`

The app reports an error if the archive drive is not connected. It does not silently save to another location.

## External tools

Open **External tools** in the top-right corner of the app to see whether FFmpeg and VLC were detected. Use **Choose** to select `ffmpeg.exe` or `vlc.exe` when either program is installed in a custom location. Selected paths are saved in the app settings and reused on the next launch.

Use **Use automatic** to remove a selected path and return to the built-in search of `PATH` and common installation folders. FFmpeg is used for thumbnails, merging, and trimming. VLC is used for segment playback and merged-video previews.

## Custom tool locations

If FFmpeg or VLC is installed somewhere unusual, set one or both variables before starting the app:

```powershell
$env:DASHCAM_CLIPPER_FFMPEG = "C:\Tools\ffmpeg\bin\ffmpeg.exe"
$env:DASHCAM_CLIPPER_VLC = "C:\Program Files\VideoLAN\VLC\vlc.exe"
corepack pnpm start
```

On macOS, set the same environment variable names with `export`.

## Development

```powershell
corepack pnpm test
corepack pnpm run check
corepack pnpm start
```

The app uses Electron with plain HTML, CSS, and JavaScript. No frontend build step is required.
