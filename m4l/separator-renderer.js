// Oedipa vertical separator (jsui).
// Sub-pixel thin line, mimicking Live native section dividers.
// mgraphics handles fractional stroke widths via anti-aliasing,
// giving a thinner appearance than a panel of width=1 (which is the
// minimum for the [panel] object).

inlets = 1
outlets = 0

mgraphics.init()
mgraphics.relative_coords = 0
mgraphics.autofill = 0

function paint() {
  var w = box.rect[2] - box.rect[0]
  var h = box.rect[3] - box.rect[1]

  // Visible line stops short of jsui's bottom edge. The jsui box itself
  // remains tall to set the device's height (so the Voicing tab below
  // gets bottom padding); the line just doesn't draw all the way down.
  var lineEnd = h - 18

  mgraphics.set_source_rgba(0.10, 0.10, 0.10, 1)
  mgraphics.set_line_width(1)
  mgraphics.move_to(w / 2, 0)
  mgraphics.line_to(w / 2, lineEnd)
  mgraphics.stroke()
}
