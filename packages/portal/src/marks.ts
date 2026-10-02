/**
 * Marks that stand in for words on controls used constantly. A glyph borrowed
 * from the text font is at the mercy of whatever font the machine has, and a
 * missing glyph renders as a box; these are drawn.
 */

const SVG = "http://www.w3.org/2000/svg";

function mark(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const definition of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", definition);
    svg.append(path);
  }
  return svg;
}

/** Two overlapping sheets: take a copy of this. */
export function copyMark(): SVGSVGElement {
  return mark(["M6 6h7v7H6z", "M3 10V3h7"]);
}

/** A ring on a crosshair: show me where this is. */
export function locateMark(): SVGSVGElement {
  return mark([
    "M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
    "M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15",
  ]);
}

/** A chevron, pointing where the group will go. */
export function chevronMark(open: boolean): SVGSVGElement {
  return mark([open ? "M4 6.5L8 10.5L12 6.5" : "M6.5 4L10.5 8L6.5 12"]);
}
