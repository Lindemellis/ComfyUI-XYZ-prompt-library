"""Where an incoming image goes on the canvas — in plain integers.

No Krita, no Qt, no PNG.  `ops.add_layer` decides nothing: it asks `plan_layer` what
to do and then does it.  That is the same split the mask nodes use (`build_masks` is
pure numpy, `execute` converts at the boundary) and for the same reason — this maths
is where the mistakes live, and it can only be tested if it runs outside Krita.

The three modes are the user's choice on the node:

    keep         the image keeps its own pixel size; the canvas is not touched
    fit          the image is scaled to the canvas, ASPECT RATIO KEPT
    grow_canvas  an image bigger than the canvas grows the canvas to it, scaling
                 the existing content up proportionally; the image goes in 1:1

Two rules run through all three:

* **The canvas only ever grows.**  Nothing here can make a Krita document smaller,
  in either dimension — that would crop work the user has already done.
* **Whatever does not fill the canvas is centred.**  An image smaller than the
  canvas, or the letterbox left by keeping an aspect ratio, sits in the middle.
"""

#: The `fit` values the node offers, in the order they appear in its dropdown.
FIT_MODES = ("keep", "fit", "grow_canvas")

DEFAULT_FIT = "fit"


def _centre(outer: int, inner: int) -> int:
    """The offset that centres `inner` inside `outer`.  Negative when it overhangs."""
    return (outer - inner) // 2


def plan_layer(image_w: int, image_h: int, canvas_w: int, canvas_h: int,
               fit: str = DEFAULT_FIT) -> dict:
    """What to do with an `image_w` x `image_h` image on a `canvas_w` x `canvas_h` canvas.

    Returns, in the order the caller must apply them:

        doc_scale     (w, h) to scale the EXISTING content to, or None
        canvas_resize (x, y, w, h) for `Document.resizeImage`, or None.  `x, y` is
                      where the new canvas's top-left sits in the current image's
                      coordinates, so growing it centred means negative offsets.
        image_size    (w, h) to scale the INCOMING image to (unchanged for keep/grow)
        offset        (x, y) where the image's top-left goes on the FINAL canvas
        canvas_size   (w, h) the canvas ends up as
    """
    image_w = max(1, int(image_w))
    image_h = max(1, int(image_h))
    canvas_w = max(1, int(canvas_w))
    canvas_h = max(1, int(canvas_h))
    if fit not in FIT_MODES:
        fit = DEFAULT_FIT

    if fit == "fit":
        # One factor for both axes — that is what "aspect ratio kept" means, and it is
        # the whole difference from the old behaviour, which stretched to the canvas
        # with Qt.IgnoreAspectRatio and quietly deformed anything of another shape.
        scale = min(canvas_w / image_w, canvas_h / image_h)
        width = max(1, round(image_w * scale))
        height = max(1, round(image_h * scale))
        return {
            "doc_scale": None,
            "canvas_resize": None,
            "image_size": (width, height),
            "offset": (_centre(canvas_w, width), _centre(canvas_h, height)),
            "canvas_size": (canvas_w, canvas_h),
        }

    bigger = image_w > canvas_w or image_h > canvas_h
    if fit == "grow_canvas" and bigger:
        # `max`, not the image's size outright: an image that is wider but SHORTER
        # than the canvas would otherwise crop the bottom off the user's document.
        # The canvas only ever grows.
        new_w = max(image_w, canvas_w)
        new_h = max(image_h, canvas_h)
        # The existing content is enlarged by ONE factor, so it does not deform. The
        # smaller of the two makes it fit the new canvas whole; the larger would push
        # part of it off the edge (user's call, 2026-08-05).
        scale = min(new_w / canvas_w, new_h / canvas_h)
        scaled_w, scaled_h = canvas_w, canvas_h
        doc_scale = None
        if scale > 1.0:
            scaled_w = max(1, round(canvas_w * scale))
            scaled_h = max(1, round(canvas_h * scale))
            doc_scale = (scaled_w, scaled_h)
        resize = None
        if (scaled_w, scaled_h) != (new_w, new_h):
            resize = (-_centre(new_w, scaled_w), -_centre(new_h, scaled_h), new_w, new_h)
        return {
            "doc_scale": doc_scale,
            "canvas_resize": resize,
            "image_size": (image_w, image_h),
            "offset": (_centre(new_w, image_w), _centre(new_h, image_h)),
            "canvas_size": (new_w, new_h),
        }

    # `keep` — and `grow_canvas` when there is nothing to grow for, which is the same
    # thing: the image keeps its size and the canvas is left alone.
    return {
        "doc_scale": None,
        "canvas_resize": None,
        "image_size": (image_w, image_h),
        "offset": (_centre(canvas_w, image_w), _centre(canvas_h, image_h)),
        "canvas_size": (canvas_w, canvas_h),
    }
