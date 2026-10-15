# Test fixtures

`tone_sunrise_128x48.hdr` — 128 × 48 px, Radiance RGBE (`32-bit_rle_rgbe`), flat
scanlines. A sun-lit ridge: a 2464-radiance sun disk, two specular glints, a sky
gradient and a dark foreground, with 1593 of its 6144 pixels above 1.0. Written
by a standalone Python encoder (`numeric.frexp` → mantissa levels and a shared
exponent, the format as Ward's *Real Pixels* states it), so the decoder is
verified against an encoder that shares no code with it — the hand-authored
fixtures in `test/hdr.test.js` only prove it agrees with itself.

Regenerate at any size; the tests state the width, height and reading they
expect, so a replacement must keep them or the test must move with it:

```python
m, e = numpy.frexp(max_component)          # max = m · 2^e, m ∈ [0.5, 1)
scale = numpy.ldexp(1.0, e - 8)            # so the level lands in [128, 256)
level = numpy.rint(component / scale)      # the byte
exponent_byte = e + 128
```

Verified against two readers: three.js's `HDRLoader` (`testing/compare-three-hdr.mjs`)
agrees to 0.39 %, which is its own `byte/255` against the format's 256 levels, and
ImageMagick reads the same radiance (`convert … -define quantum:format=floating-point`).
