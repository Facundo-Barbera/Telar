# WHERE A BUILD'S UPDATE FEED LIVES IN THE BUCKET (#1042). Sourced by
# build-desktop.sh; kept apart so its decisions can be tested without a build.
#
# The bucket root holds the feeds every com.telar.desktop install follows, and
# Squirrel will only swap in a build carrying that same bundle id. So the root
# belongs to the legacy id for good: once the hand-off release (H) is there,
# nothing else may be written to it. Every other id publishes under a prefix,
# normally the id itself (io.github.novarix.telar/beta-mac.yml). The proxy uses
# the whole path as the object key, so a prefix needs no change there.

LEGACY_APP_ID="com.telar.desktop"

# A prefix is a relative key path: no leading or trailing slash, no empty or
# dot segments, nothing a shell or a URL would read differently.
feed_prefix_valid() {
  local prefix="$1"
  [[ "$prefix" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || return 1
  case "/$prefix/" in */./*|*/../*) return 1 ;; esac
  return 0
}

# Refuse a publish that would land where it must not. Prints why and returns 1.
feed_refuse() {
  local app_id="$1" prefix="$2"
  if [ -z "$prefix" ] && [ "$app_id" != "$LEGACY_APP_ID" ]; then
    echo "build-desktop: $app_id must publish with --feed-prefix; the bucket root belongs to $LEGACY_APP_ID installs" >&2
    return 1
  fi
  return 0
}

# The object key an artifact is uploaded to.
feed_object_key() {
  local prefix="$1" file="$2"
  if [ -n "$prefix" ]; then
    printf '%s/%s\n' "$prefix" "$(basename "$file")"
  else
    basename "$file"
  fi
}

# The publish.url baked into the app, which is where it will look for its feed.
feed_publish_url() {
  local base="${1%/}" prefix="$2"
  if [ -n "$prefix" ]; then
    printf '%s/%s\n' "$base" "$prefix"
  else
    printf '%s\n' "$base"
  fi
}
