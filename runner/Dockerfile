FROM ubuntu:22.04 AS build

ARG DEBIAN_FRONTEND=noninteractive
ARG QUIDRA_CORE_REF=develop

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git cmake ninja-build g++ clang-15 llvm-15 llvm-15-dev \
    libcurl4-openssl-dev libpng-dev libjpeg-dev libtiff-dev libwebp-dev \
    ffmpeg libavformat-dev libavcodec-dev libavutil-dev libswscale-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN git init /src/quidra \
    && git -C /src/quidra remote add origin https://github.com/quidra-lang/quidra.git \
    && git -C /src/quidra fetch --depth 1 origin "${QUIDRA_CORE_REF}" \
    && git -C /src/quidra checkout --detach FETCH_HEAD \
    && git -C /src/quidra rev-parse HEAD > /tmp/core-commit

RUN cmake -S /src/quidra -B /src/quidra/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_CXX_COMPILER=/usr/bin/g++ \
    && cmake --build /src/quidra/build --parallel

RUN mkdir -p /opt/quidra/bin /opt/quidra/lib/quidra /opt/quidra/share/quidra \
    && cp /src/quidra/build/quidra /opt/quidra/bin/ \
    && cp /src/quidra/build/libquidra_runtime.a /opt/quidra/lib/quidra/ \
    && cp /src/quidra/build/libquidra_runtime_jit.so /opt/quidra/lib/quidra/ \
    && cp /tmp/core-commit /opt/quidra/share/quidra/core-commit

FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates clang-15 llvm-15 \
    libcurl4-openssl-dev libpng-dev libjpeg-dev libtiff-dev libwebp-dev \
    ffmpeg libavformat-dev libavcodec-dev libavutil-dev libswscale-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 runner

COPY --from=build /opt/quidra /opt/quidra
COPY runner /app/runner

ENV PYTHONPATH=/app \
    QUIDRA_BIN=/opt/quidra/bin/quidra \
    QUIDRA_CLANGXX=/usr/bin/clang++-15 \
    QUIDRA_CLANG=/usr/bin/clang-15 \
    QUIDRA_RUNTIME_LIBRARY=/opt/quidra/lib/quidra/libquidra_runtime.a \
    QUIDRA_JIT_RUNTIME_LIBRARY=/opt/quidra/lib/quidra/libquidra_runtime_jit.so \
    PORT=8080

WORKDIR /app
USER runner
EXPOSE 8080
CMD ["python3", "-m", "runner.server"]
