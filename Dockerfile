FROM node:20-slim

# Install Python, pip, and yt-dlp dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip in a virtual environment to avoid externally-managed error
RUN python3 -m venv /opt/ytdlp-venv \
    && /opt/ytdlp-venv/bin/pip install --no-cache-dir yt-dlp

# Make yt-dlp available in PATH
RUN ln -sf /opt/ytdlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

# Non-root user for security
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

CMD ["node", "src/index.js"]
