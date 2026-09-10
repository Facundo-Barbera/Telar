/**
 * `next/link` as a plain anchor. The harness reads `href` straight off the
 * rendered DOM — that string IS the evidence, so nothing may rewrite it.
 */
import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { setFixturePathname } from "./next-navigation";

/** `prefetch`/`replace`/`scroll` are accepted and ignored: they are Next's
 *  routing knobs, and this stub does no routing. */
type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string; children?: ReactNode; prefetch?: boolean; replace?: boolean; scroll?: boolean };

export default function Link({ href, children, onClick, ...rest }: Props) {
  const anchorProps: AnchorHTMLAttributes<HTMLAnchorElement> = { ...rest };
  delete (anchorProps as { prefetch?: unknown }).prefetch;
  delete (anchorProps as { replace?: unknown }).replace;
  delete (anchorProps as { scroll?: unknown }).scroll;
  return createElement(
    "a",
    {
      href,
      ...anchorProps,
      onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
        // No page load in a fixture: the click moves the fixture's own address,
        // which is what a client-side navigation does to the component.
        event.preventDefault();
        onClick?.(event);
        setFixturePathname(href);
      },
    },
    children,
  );
}
