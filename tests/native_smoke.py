"""The real backend must load successfully and handle a machine with no camera."""
from zigcamera import Camera, CameraError
try:
    camera = Camera()
except CameraError as error:
    assert error.status == -9, error
    print("libcamera backend loaded; no camera available (expected in hosted CI)")
else:
    assert camera.info["backend"] == "libcamera"
    camera.close()
    print("libcamera backend loaded and discovered a real camera")
