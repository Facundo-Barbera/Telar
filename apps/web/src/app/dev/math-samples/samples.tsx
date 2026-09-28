"use client";

import { MessageResponse } from "@/components/ui/message";

/**
 * THE TWO EQUATIONS FROM THE REPORT, verbatim, in the shape they arrived: each
 * `$$…$$` opening and closing on ONE line inside ordinary study-guide prose.
 * They are the acceptance case — everything else on this page exists to show
 * what they must not disturb.
 */
export const STUDY_GUIDE = [
  "A **simple return** measures one period's price change against where it started:",
  "",
  "$$R_t = \\frac{P_t - P_{t-1}}{P_{t-1}} = \\frac{P_t}{P_{t-1}} - 1$$",
  "",
  "Chaining periods multiplies the growth factors rather than adding the returns, so the total return over $$T$$ periods is",
  "",
  "$$1 + R_{total} = (1+R_1)(1+R_2)\\cdots(1+R_T)$$",
  "",
  "which is why a 50% loss needs a 100% gain to undo.",
].join("\n");

const DISPLAY_MULTILINE = [
  "Written across its own lines, the same block is display math:",
  "",
  "$$",
  "\\sigma = \\sqrt{\\frac{1}{N-1}\\sum_{i=1}^{N}(x_i - \\bar{x})^2}",
  "$$",
].join("\n");

const INLINE = "Inline in a sentence: the drift $$\\mu$$ and volatility $$\\sigma$$ set the shape, and $$\\alpha + \\beta = \\Gamma$$ closes it.";

const ALIGNED = ["$$", "\\begin{aligned}", "R_{log} &= \\ln(1 + R_t) \\\\", "       &= \\ln P_t - \\ln P_{t-1}", "\\end{aligned}", "$$"].join("\n");

const MATRIX = ["A covariance matrix, and a vector beside it:", "", "$$", "\\Sigma = \\begin{pmatrix} \\sigma_1^2 & \\rho\\sigma_1\\sigma_2 \\\\ \\rho\\sigma_1\\sigma_2 & \\sigma_2^2 \\end{pmatrix}", "$$"].join("\n");

/** Wide on purpose: the acceptance case for a narrow panel is a scroll port, not a clipped tail. */
const LONG = "$$f(x) = a_0 + a_1x + a_2x^2 + a_3x^3 + a_4x^4 + a_5x^5 + a_6x^6 + a_7x^7 + a_8x^8 + a_9x^9 + a_{10}x^{10} + \\cdots + a_nx^n$$";

/** Money is not math. Neither is a `$$` the author asked to be shown. */
const CURRENCY = "The plan costs $5 a month, or $10 with the add-on — a $5 saving over paying $15 twice.";
const ESCAPED = "An escaped pair reads literally: \\$\\$not math\\$\\$, and a lone \\$99 stays a price.";
const CODE = ["A fence keeps its dollars:", "", "```md", "$$E = mc^2$$", "```", "", "and so does `$$inline code$$` in a sentence."].join("\n");

/** Half-arrived TeX: the streaming state, and the state that never completes. */
const STREAMING = "Given the growth factors, the total is\n\n$$\n1 + R_{total} = (1+R_1)(1+R";
const MALFORMED = "A broken equation shows its own source rather than throwing:\n\n$$\\frac{1}{\\unknownmacro{x}$$";

const SAMPLES: Array<[string, string, boolean?]> = [
  ["Study guide · the reported case", STUDY_GUIDE],
  ["Display · $$ on its own lines", DISPLAY_MULTILINE],
  ["Inline · inside a sentence", INLINE],
  ["Aligned environment", ALIGNED],
  ["Matrix", MATRIX],
  ["Long equation · overflow", LONG],
  ["Currency · not math", CURRENCY],
  ["Escaped dollars", ESCAPED],
  ["Code · literal", CODE],
  ["Streaming · incomplete", STREAMING, true],
  ["Malformed TeX", MALFORMED],
];

function Samples() {
  return (
    <>
      {SAMPLES.map(([title, markdown, streaming]) => (
        <section key={title} className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-xs text-muted-foreground">{title}</h3>
          <div className="min-w-0 overflow-hidden rounded-md border border-border/60 bg-card p-3">
            <MessageResponse streaming={streaming}>{markdown}</MessageResponse>
          </div>
        </section>
      ))}
    </>
  );
}

export function MathSamples() {
  return (
    <div className="mx-auto flex w-full max-w-6xl gap-8 overflow-auto p-6 text-sm">
      <div className="min-w-0 flex-1">
        <section className="flex min-w-0 flex-col gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Full measure (50rem lane)</h2>
          <Samples />
        </section>
      </div>
      <div className="w-72 shrink-0">
        <section className="flex min-w-0 flex-col gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Narrow (18rem)</h2>
          <Samples />
        </section>
      </div>
    </div>
  );
}
