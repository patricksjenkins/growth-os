# Growth OS — Railway runtime image
#
# Adds the fonts that librsvg (Sharp's SVG renderer) needs to render text
# overlays on generated slide images. Without these, librsvg falls back to
# a glyph-less base font and text renders as tofu squares (□).
#
# Fonts installed:
#   - fonts-dejavu-core         DejaVu Sans + Serif + Mono (full Unicode)
#   - fonts-liberation          Metric-compatible with Arial/Times (web-safe look)
#   - fontconfig                Font lookup cache librsvg queries
#
# Everything else mirrors Railway's default nixpacks Node 22 build.

FROM node:22-bookworm-slim

# System fonts + fontconfig. Rebuild the font cache after install so librsvg
# picks them up on first render. `fonts-inter` is not in Debian stable so we
# skip it; DejaVu is what the code's font stack falls back to.
#
# ffmpeg is required by the Marketing Studio Sora pipeline to composite a
# real FGA brand logo over the last ~1.5 seconds of each render. Bookworm
# ships ffmpeg 5.x with the overlay filter + libx264 + AAC passthrough
# we need.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      fonts-dejavu-core \
      fonts-liberation \
      fontconfig \
      ffmpeg && \
    fc-cache -fv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Playwright Chromium for the content-screenshot agent (headless capture of
# safe FGA marketing/product pages, with allowlist + PII redaction). --with-deps
# pulls the required system libraries. Capture is gated + degrades gracefully,
# so a missing browser never breaks the content pipeline.
RUN npx playwright install --with-deps chromium

# Copy the rest of the repo
COPY . .

# Railway sets PORT at runtime; code defaults to 3000 if unset.
EXPOSE 3000

CMD ["node", "api/server.js"]
