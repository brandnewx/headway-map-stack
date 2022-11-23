#!/bin/bash

set -xe
set -o pipefail

mkdir -p /config

if [ -f "/config/pelias.json" ]; then
    echo "Nothing to do, already have pelias config"
elif [ -f "${PELIAS_CONFIG_ARTIFACT_SOURCE_PATH}" ]; then
    echo "Copying artifact."
    cp "${PELIAS_CONFIG_ARTIFACT_SOURCE_PATH}" /config/pelias.json
elif [ ! -z "${PELIAS_CONFIG_ARTIFACT_URL}" ]; then
    echo "Downloading artifact."
    wget -O /config/pelias.json.download "${PELIAS_CONFIG_ARTIFACT_URL}"
    mv /config/pelias.json.download /config/pelias.json
else
    "No pelias config artifact available."
    exit 1
fi
