#!/bin/bash

# Teleworkr 3P App Unlinker
#
# Purpose:
# --------
# This script removes a previously mounted third-party (3P) application
# from the Teleworkr runtime by deleting the symbolic link inside:
#
#   teleworkr/backend/apps/teleworkr/3p/
# ---------------------------------------------------------------------------
# Usage:
#
#   ./rmlinktw.sh <symlink-name>

# Absolute path of directory where this script resides
# This is treated as the Teleworkr installation root
TELEWORKR_ROOT="$( cd "$( dirname "$0" )" && pwd )"

# Teleworkr 3rd-party runtime plugin directory
TELEWORKR_3P="$TELEWORKR_ROOT/backend/apps/teleworkr/3p"

# Parent directory of Teleworkr installation
# Used for resolving app names passed without paths
PARENT_DIR="$(dirname "$TELEWORKR_ROOT")"

# Ensure argument is passed
if [ -z "$1" ]; then
    echo "Usage: $0 [app-name | path-to-app]"
    exit 1
fi

INPUT="$1"

if [ -d "$INPUT" ]; then
    APP_NAME="$(basename "$(realpath "$INPUT")")"
elif [ -d "$PARENT_DIR/$INPUT" ]; then
    APP_NAME="$(basename "$(realpath "$PARENT_DIR/$INPUT")")"
else
    APP_NAME="$INPUT"
fi

# Symlink location inside Teleworkr runtime
TARGET_LINK="$TELEWORKR_3P/$APP_NAME"

# Remove symlink only if it exists
if [ -L "$TARGET_LINK" ]; then
    rm "$TARGET_LINK"
    echo "Symlink removed:"
    echo "$TARGET_LINK"
else
    echo "No symlink found at:"
    echo "$TARGET_LINK"
fi
