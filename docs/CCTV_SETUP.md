# CCTV Setup and Troubleshooting

## Requirements
- Access to an RTSP/RTSPS/HTTP stream that the app owner is authorized to use.
- Network reachability from the machine running Node/Python.
- OpenCV/FFmpeg backend support for the camera's codec.
- FastALPR model initialization completed before/while monitoring.

## Add and test a camera
1. Open **Live CCTV**.
2. Select **Add Camera**.
3. Enter a human-readable camera name and stream URL.
4. Save. The list API redacts the full URL.
5. Click **Test connection**. This opens the stream and tries to decode a frame; it does not prove number-plate recognition accuracy.
6. Click **Start monitoring**. The Python worker samples frames at `CCTV_SAMPLE_INTERVAL_SECONDS`, retains a short candidate history, emits a candidate event only after repeated support and sufficient OCR confidence, and applies a per-plate cooldown.
7. Inspect new events in **Entry History** and **Review Queue**.
8. Click **Stop** when finished.

## Configuration
- `CCTV_MAX_CONCURRENT`: concurrent stream workers.
- `CCTV_SAMPLE_INTERVAL_SECONDS`: seconds between inference samples.
- `CCTV_EVENT_COOLDOWN_SECONDS`: per-plate event de-duplication window.
- `OCR_MIN_CONFIDENCE`: minimum configured OCR confidence for auto lookup.

## Diagnostics
- **Unable to open stream:** confirm URL/protocol/port, camera access and network firewall.
- **Opens but no frame:** check codec/transport settings and OpenCV/FFmpeg build.
- **Worker initialization fails:** install `cv_worker/requirements.txt` and allow model initialization/download.
- **No plate events:** increase camera resolution/lighting; review angle, distance, blur and frame sampling; check scan output and use a labelled dataset to validate thresholds.
- **Credentials:** this local demo stores the camera URL in MongoDB but redacts it from list responses. Before production, store credentials in a secret manager or encrypt at rest and tightly restrict camera administration. Do not expose RTSP URLs in client logs/screenshots.

The browser cannot generally play an RTSP stream directly. This prototype processes the stream server-side and displays status/events. A real-time browser preview requires a separately configured authorized media gateway (e.g. a carefully secured RTSP-to-HLS/WebRTC service); that gateway is not included.
