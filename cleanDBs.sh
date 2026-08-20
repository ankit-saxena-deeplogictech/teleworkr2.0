#!/bin/bash
TELEWORKRDIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

rm -rf $TELEWORKRDIR/backend/apps/teleworkr/cms
mkdir -p $TELEWORKRDIR/backend/apps/teleworkr/cms
rm -rf $TELEWORKRDIR/backend/apps/teleworkr/db/teleworkr_db
mkdir -p $TELEWORKRDIR/backend/apps/teleworkr/db/teleworkr_db
rm -f $TELEWORKRDIR/backend/apps/teleworkr/db/sqlite/teleworkr.db*

echo Done.
