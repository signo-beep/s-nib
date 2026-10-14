import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";

// Module loaded on export only: MathJax produces vector SVG (no external fonts)
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const document = mathjax.document("", {
  InputJax: new TeX({ packages: AllPackages }),
  OutputJax: new SVG({ fontCache: "none" }),
});

/** LaTeX to an SVG string; null if MathJax reports a syntax error. */
export function texToSvg(tex: string, display: boolean): string | null {
  const html = adaptor.innerHTML(document.convert(tex, { display }));
  if (!html.includes("<svg") || html.includes('data-mml-node="merror"')) return null;
  return html;
}
