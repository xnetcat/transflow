# Lambda Node.js 20 base
FROM public.ecr.aws/lambda/nodejs:20 as base

# Install ffmpeg and libvips (for sharp)
RUN yum install -y tar gzip xz && \
    curl -L -o /tmp/ffmpeg.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz && \
    mkdir -p /opt/ffmpeg && \
    tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1 && \
    ln -s /opt/ffmpeg/ffmpeg /usr/local/bin/ffmpeg && \
    ln -s /opt/ffmpeg/ffprobe /usr/local/bin/ffprobe && \
    rm -f /tmp/ffmpeg.tar.xz

# libvips (prebuilt) - using sharp's prebuild during npm install, ensure dependencies
RUN yum install -y libvips && yum clean all

# Copy app (expect baked templates and handler in context root)
WORKDIR /var/task
COPY package.json package-lock.json* .npmrc* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY . .

# Command points to handler
CMD ["dist/lambda/handler.handler"]

