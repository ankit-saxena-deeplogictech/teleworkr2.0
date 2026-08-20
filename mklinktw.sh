#!/bin/bash

# Teleworkr 3P App Linker
#
# Purpose:
# --------
# This script "mounts" any external application into the Teleworkr runtime
# by creating a symbolic link inside:
#
#   teleworkr/backend/apps/teleworkr/3p/
#
# Usage:
#
#   ./mklinktw.sh <app-name>
#   ./mklinktw.sh <path-to-app> <symlink-name>
#
# Default symlink name is the source folder name.
# If a second argument is provided, it overrides this name
# and the symlink will be created using the provided alias.
#
# Examples:
#   ./mklinktw.sh ASB
#   ./mklinktw.sh /home/deep/apps/ASB asb
#
# Behaviour:
# ----------
# If only an app name is passed the script will search for it in the
# parent directory of the Teleworkr install.

# Absolute path of directory where this script resides
# This is treated as the Teleworkr installation root
TELEWORKR_ROOT="$( cd "$( dirname "$0" )" && pwd )"

# Teleworkr 3rd-party applications directory (runtime plugin mount point)
TELEWORKR_3P="$TELEWORKR_ROOT/backend/apps/teleworkr/3p"

# Parent directory of Teleworkr installation
# External apps are expected to live here by default
PARENT_DIR="$(dirname "$TELEWORKR_ROOT")"

# Ensure argument is passed
if [ -z "$1" ]; then
    echo "Usage: $0 [app-name | path-to-app]"
    exit 1
fi

INPUT="$1"

if [ -d "$INPUT" ]; then
    SRC_APP="$(realpath "$INPUT")"
else
    if [ -d "$PARENT_DIR/$INPUT" ]; then
        SRC_APP="$(realpath "$PARENT_DIR/$INPUT")"
    else
        echo "Error: Application directory not found -> $INPUT"
        exit 1
    fi
fi

# Determine symlink name
if [ -n "$2" ]; then
    APP_NAME="$2"
else
    APP_NAME="$(basename "$SRC_APP")"
fi

TARGET_LINK="$TELEWORKR_3P/$APP_NAME"

if [ -e "$TARGET_LINK" ]; then
    echo "Target already exists: $TARGET_LINK"
    exit 1
fi

# Ensure 3p directory exists
mkdir -p "$TELEWORKR_3P"

# Prevent duplicate linking
if [ -L "$TARGET_LINK" ]; then
    echo "Symlink already exists:"
    echo "$TARGET_LINK"
    exit 0
fi

ln -s "$SRC_APP" "$TARGET_LINK"

echo "Symlink created:"
echo "$TARGET_LINK -> $SRC_APP"
