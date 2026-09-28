import { avatarSrc, authorMonogram } from "../github-forge";
import { cn } from "@/ui/utils";

// Stateless fallback: the monogram is drawn underneath and a failed image hides itself,
// so a missing avatar reveals the letter without a re-render.
export function GitHubAvatar({ login, src, className }: { login?: string; src?: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-[0.55em] leading-none font-medium text-muted-foreground select-none",
        className,
      )}
      title={login ?? "unknown author"}
    >
      {authorMonogram(login)}
      {src && (
        /* eslint-disable-next-line @next/next/no-img-element -- GitHub's avatar CDN is not configured for next/image */
        <img
          src={avatarSrc(src)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}
