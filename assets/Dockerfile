# Lambda Node.js 20 base
FROM public.ecr.aws/lambda/nodejs:20 as base

# Install ffmpeg (static) on Amazon Linux 2023 base (dnf)
ARG TARGETARCH
RUN dnf -y install tar gzip xz && \
    ARCH="${TARGETARCH}" && \
    URL_AMD64="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" && \
    URL_ARM64="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz" && \
    URL=$(if [ "$ARCH" = "arm64" ]; then echo "$URL_ARM64"; else echo "$URL_AMD64"; fi) && \
    curl -L -o /tmp/ffmpeg.tar.xz "$URL" && \
    mkdir -p /opt/ffmpeg && \
    tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1 && \
    ln -s /opt/ffmpeg/ffmpeg /usr/local/bin/ffmpeg && \
    ln -s /opt/ffmpeg/ffprobe /usr/local/bin/ffprobe && \
    rm -f /tmp/ffmpeg.tar.xz && \
    dnf -y clean all

# Sharp uses prebuilt binaries on Lambda; no extra system deps needed

# Copy app (expect baked templates and handler in context root)
WORKDIR /var/task
COPY package.json package-lock.json* .npmrc* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY . .

# Command points to handler
CMD ["dist/lambda/handler.handler"]

