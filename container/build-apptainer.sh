#!/bin/bash
# Build the BioClaw agent container as an Apptainer (Singularity) SIF image.
#
# Two build modes:
#   1. From definition file (requires root/fakeroot):
#      ./build-apptainer.sh
#
#   2. From existing Docker image (no root needed if image is in a registry):
#      ./build-apptainer.sh --from-docker
#
# The resulting .sif file can be copied to any HPC cluster and used without
# root privileges:
#   CONTAINER_RUNTIME=apptainer CONTAINER_IMAGE=./bioclaw-agent.sif npm run dev

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SIF_NAME="bioclaw-agent.sif"

if [ "$1" = "--from-docker" ]; then
    IMAGE="${2:-bioclaw-agent:latest}"
    echo "Building Apptainer SIF from Docker image: ${IMAGE}"
    echo "  (Make sure the Docker image is already built: ./build.sh)"
    echo ""
    apptainer build "${SIF_NAME}" "docker-daemon://${IMAGE}"
else
    echo "Building Apptainer SIF from definition file..."
    echo ""

    # Copy agent-runner into build context (Apptainer %files or %post needs it)
    # The .def bootstraps from node:22-slim and installs tools; agent-runner
    # source is bind-mounted at runtime from the host, same as Docker mode.
    apptainer build "${SIF_NAME}" Apptainer.def
fi

echo ""
echo "Build complete: ${SCRIPT_DIR}/${SIF_NAME}"
echo ""
echo "To use with BioClaw:"
echo "  export CONTAINER_RUNTIME=apptainer"
echo "  export CONTAINER_IMAGE=${SCRIPT_DIR}/${SIF_NAME}"
echo "  npm run dev"
echo ""
echo "To copy to an HPC cluster:"
echo "  scp ${SIF_NAME} cluster:~/"
echo "  # On cluster:"
echo "  export CONTAINER_RUNTIME=apptainer"
echo "  export CONTAINER_IMAGE=~/bioclaw-agent.sif"
