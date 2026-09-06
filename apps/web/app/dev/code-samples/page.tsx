import { notFound } from "next/navigation";
import { CodeSamples } from "./samples";

/**
 * A DEVELOPMENT-ONLY GALLERY of every monospace surface the transcript draws —
 * short and long fenced blocks (with and without a language), a streaming
 * fragment, tool output under and over the fold, a diff, an approval's
 * argument, at full width and at a narrow measure — with no engine, no
 * session and no Telar home behind it. It exists so a change to one of these
 * can be looked at beside the others before a build, which is the only way
 * "they read as one system" is checkable.
 *
 * 404 in production: a gallery is not a product screen.
 */
export const dynamic = "force-static";

export default function CodeSamplesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <CodeSamples />;
}
