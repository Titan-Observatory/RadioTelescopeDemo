#!/usr/bin/env bash
set -u

BASE="https://alasky.cds.unistra.fr/HI4PI/P_HI4PI_NHI"
DEST="public/hips/HI4PI/P_HI4PI_NHI"

mkdir -p "$DEST"

download_if_missing() {
  local url="$1"
  local out="$2"

  # Skip files that already exist and are non-empty
  if [ -s "$out" ]; then
    echo "skip: $out"
    return 0
  fi

  mkdir -p "$(dirname "$out")"

  echo "get:  $out"

  # Download to temp file first so interrupted downloads do not look valid
  local tmp="${out}.tmp"

  if wget -q -O "$tmp" "$url"; then
    if [ -s "$tmp" ]; then
      mv "$tmp" "$out"
      return 0
    else
      rm -f "$tmp"
      echo "empty response: $url"
      return 1
    fi
  else
    rm -f "$tmp"
    echo "failed: $url"
    return 1
  fi
}

echo "Downloading HI4PI NHI HiPS survey"
echo "Base: $BASE"
echo "Dest: $DEST"
echo

# Root metadata
for f in properties Moc.fits; do
  download_if_missing "$BASE/$f" "$DEST/$f" || true
done

# HiPS tiles: orders 0..3
# Tile count per order is 12 * 4^order.
# For this survey, all tile numbers are under 10000, so Dir0 is used.
for order in 0 1 2 3; do
  npix=$((12 * 4**order))
  dir="$DEST/Norder$order/Dir0"

  mkdir -p "$dir"

  echo
  echo "Downloading order $order: $npix tile positions"

  for n in $(seq 0 $((npix - 1))); do
    for ext in png fits; do
      url="$BASE/Norder$order/Dir0/Npix$n.$ext"
      out="$dir/Npix$n.$ext"

      download_if_missing "$url" "$out" || true
    done
  done
done

# Allsky previews, usually under deepest order
echo
echo "Downloading Allsky previews"

mkdir -p "$DEST/Norder3"

for ext in png fits jpg; do
  download_if_missing \
    "$BASE/Norder3/Allsky.$ext" \
    "$DEST/Norder3/Allsky.$ext" || true
done

# Clean up any empty files just in case
find "$DEST" -type f -empty -delete
find "$DEST" -type f -name "*.tmp" -delete

echo
echo "Done."
echo

echo "Summary:"
du -sh "$DEST" 2>/dev/null || true
echo "Files:"
find "$DEST" -type f | wc -l

echo
echo "Key properties:"
if [ -f "$DEST/properties" ]; then
  grep -E 'hips_order|hips_tile_format|hips_tile_width|hips_frame|obs_title|hips_service_url' "$DEST/properties" || true
else
  echo "Missing properties file."
fi

echo
echo "Empty files left:"
find "$DEST" -type f -empty
