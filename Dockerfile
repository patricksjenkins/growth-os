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
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      fonts-dejavu-core \
      fonts-liberation \
      fontconfig && \
    fc-cache -fv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy the rest of the repo
COPY . .

# Railway sets PORT at runtime; code defaults to 3000 if unset.
EXPOSE 3000

CMD ["node", "api/server.js"]
