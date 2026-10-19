# Contributor instructions

- Use the repository's configured human Git author/committer identity.
- Use conventional commits. Do not add coauthor trailers.
- Publish only to origin/main; do not create PRs unless the user requests them.
- Pin Zig 0.15.2 unless updating the toolchain and validating every target together.
- Recording must use Home codecs and containers; do not add an FFmpeg dependency.
- Keep queue ownership and public ABI logic in Zig. Use the system C++ toolchain
  for the libcamera bridge so its STL ABI matches the installed libcamera.
- Run `zig fmt --check build.zig src bench`, synthetic `zig build test`, and C/Bun
  ABI tests for ownership/API changes. Compile and load the real Linux backend
  on both x86_64 and aarch64 through CI. Preserve the no-camera smoke test.
- Never recycle a leased buffer, ignore DMA coherency errors, or block a camera
  manager callback on consumer work. Keep queues bounded and image copies explicit.
- Preserve Home attribution and license notices for adapted code.
- Keep synthetic timings separate from real camera evidence. Do not claim
  Picamera2 speedups, optical quality improvements or sensor FPS without matched
  measurements. Preserve raw benchmark rows and negotiated configurations.
- Do not claim preview, DNG, video encoding, tracking or Picamera2 API compatibility
  until those implementations and tests exist.

- Implementation, bindings, tests and tooling use Zig or TypeScript/Bun. Do not
  add or execute Python. System C/C++ bridges remain for libcamera and codecs.
