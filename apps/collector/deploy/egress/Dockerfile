# This local tag must be created from the inspected immutable collector image ID.
# Do not pull a replacement base during deployment.
FROM adtrender-egress-base:20261009
USER 0:0
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/ssh"]
