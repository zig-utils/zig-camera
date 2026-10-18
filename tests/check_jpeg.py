"""Verify native JPEG geometry, RGB channel order and 4:4:4 sampling."""
import sys
from PIL import Image, JpegImagePlugin
image = Image.open(sys.argv[1])
assert image.size == (65, 33), image.size
assert JpegImagePlugin.get_sampling(image) == 0, "Expected 4:4:4"
r, g, b = image.getpixel((60, 25))
# Latest policy chooses initial buffer 3: blue channel = 111.
assert abs(r-60) <= 4 and abs(g-25) <= 4 and abs(b-111) <= 4, (r,g,b)
print("JPEG: geometry, channel order, 4:4:4 verified")
