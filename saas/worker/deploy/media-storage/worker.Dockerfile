# Preserve the verified API image, dependencies and browser runtime; replace only the worker bundle.
ARG MEDIA_BASE_IMAGE
FROM ${MEDIA_BASE_IMAGE}
ARG MEDIA_SOURCE_COMMIT
ARG MEDIA_WORKER_SHA256
LABEL org.opencontainers.image.revision=${MEDIA_SOURCE_COMMIT} \
      com.adthrender.worker.bundle-sha256=${MEDIA_WORKER_SHA256}
COPY --chown=1000:1000 index.mjs index.mjs.map /opt/ad-research/app/dist-worker/
