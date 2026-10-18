# Pi 5 camera choice: outdoors, trails, mountains, lakes and a moving dog

Research date: 2026-10-17. The user prioritizes image quality over price and owns
a Pi 5, but has no camera yet. The scene combines high-detail landscapes and
moving people/animals, so usable autofocus, lens field of view, shutter time,
weather protection and highlight handling matter alongside sensor resolution.
No hardware was purchased and no image-quality comparison has been performed.

**Practical primary candidate: Arducam OwlSight 64MP autofocus (OV64A40)** for
high-detail outdoor stills, subject to a walking/running-subject autofocus test.
The manufacturer specifies a 1/1.32-inch Quad-Bayer sensor, 9248x6944 output,
1.008µm photosites, rolling shutter and native libcamera support. Its focus is
contrast-detect/software controlled, so autofocus tracking must be verified;
64MP output is not proof of 64MP of resolved scene detail. Capture at its native
still mode for landscapes, and use a supported reduced-resolution mode for
continuous capture. Verify the exact camera SKU includes autofocus and the
correct Pi 5 cable. [Manufacturer specification](https://docs.arducam.com/Raspberry-Pi-Camera/Native-camera/64MP-OV64A40/),
[product overview](https://www.arducam.com/blog/64mp-ov64a40-camera-module/).

**Action/reference candidate: Camera Module 3 standard, colour with IR cut.**
It provides 12MP IMX708, phase-detection autofocus, 75° diagonal field of view
and an HDR mode limited to 3MP output. It is the safer starting point for
moving-dog autofocus and a useful fully supported reference camera. This is an
engineering recommendation based on its autofocus design, not a measured claim
that it always focuses faster or produces the best images. The wide version
covers 120° but trades pixels on the subject for a wider view. Standard colour
is appropriate for natural daytime colours; NoIR serves infrared work.
[Official specs](https://www.raspberrypi.com/products/camera-module-3/).

| Option | Potential strength | Limitation for this use |
| --- | --- | --- |
| OwlSight 64MP AF | Landscape detail potential, autofocus, larger sensor than official compact modules | Quad-Bayer, contrast AF, full-resolution cadence and moving-subject focus need verification |
| Camera Module 3 standard | PDAF, compact, official tuning/support, usable hiking field of view | Lower still resolution; HDR uses a smaller 3MP mode |
| 1-inch IMX283 + quality C-mount lens | Larger-sensor still-image quality potential and interchangeable optics | Typically manual focus, bulk, narrower lens choices; less convenient for following a moving dog |
| FourthirdEye V2/IMX294 | Micro Four Thirds sensor and adaptable lens mount | Research hardware; vendor libcamera fork, lens coverage requirements, sold out when checked |
| Official HQ/IMX477 | Mature support and interchangeable lenses | Manual focus; no universal best lens for all subject distances |

For a larger-sensor build, [OneInchEye](https://github.com/will127534/OneInchEye)
explicitly supports Pi 5 and a four-lane 22-pin CSI connection. Arducam also lists
an [IMX283 Pi 5 kit](https://www.arducam.com/arducam-pivistation-5-klarity-20mp-imx283-all-in-one-high-resolution-raspberry-pi-5-camera-kit.html)
with a manual-focus 16mm C-mount lens; its listed full-size cadence is only 6 FPS.
That kit includes another Pi, so verify a module-only purchase for an existing
Pi 5. A lens must cover the sensor and meet its detail requirements. Do not buy
a lens based only on whether the mount fits.

[FourthirdEye V2](https://shop.willwhang.dev/shop/p/fourthirdeye-v20) is a real
larger-sensor Pi 5 option, but its vendor says upstream support is incomplete
and a fork is required. It was marked sold out at research time. Price alone
does not remove driver/tuning/availability constraints. It is a separate
experimental integration target, not the default build requirement.

## Implementation consequences

- Retain the system libcamera ISP/tuning; a faster wrapper cannot improve optics
  or invent dynamic range. No lower-quality software demosaic is substituted.
- Use continuous AF when supported. Allow manual lens position as an opt-in.
  This supplies autofocus, not object detection or an automated tracking mount.
- Warm up AE/AWB/AF before recording, and inspect actual metadata. In motion,
  expose fast enough to avoid blur and accept the resulting gain/noise tradeoff.
  Use auto exposure initially as sun/shade changes on trails.
- Lossless RGB PPM and paired native raw preserve useful evidence; JPEG 98/4:4:4
  is a high-quality convenience output. Raw format and row stride are explicit.
- Use active cooling, stable power, a rigid mount, suitable IR-cut optics and a
  weather enclosure with a clear optical window. The Pi/camera board itself is
  not a weatherproof trail camera.

Once a module is available, choose between these candidates using matched real
photos and an AF test on the intended route. There is no defensible universal
"highest quality" answer across distant landscapes, fast motion and low light.
