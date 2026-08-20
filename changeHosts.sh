#!/bin/bash

TELEWORKR_PATH="$( cd "$( dirname "$0" )" && pwd )"
DOMAIN=${1:-`hostname --fqdn`}
FILES="$TELEWORKR_PATH/backend/apps/teleworkr/conf/teleworkr.json $TELEWORKR_PATH/frontend/apps/teleworkr/js/constants.mjs $TELEWORKR_PATH/../monkshu/backend/server/conf/blackboard.json $TELEWORKR_PATH/frontend/apps/teleworkr/conf/httpd.json $TELEWORKR_PATH/../monkshu/backend/server/conf/httpd.json"

echo Using domain name $DOMAIN
read -p "OK to configure? [Y|N] " -n 1 -r ; echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

cp "$TELEWORKR_PATH/backend/apps/teleworkr/conf/httpd.json" "$TELEWORKR_PATH/../monkshu/backend/server/conf/httpd.json"
for file in $FILES; do
    echo Processing file $file
    sed -i -r -e "s/https:\/\/((1?[0-9][0-9]?|2[0-4][0-9]|25[0-5])\.){3}(1?[0-9][0-9]?|2[0-4][0-9]|25[0-5])/https:\/\/$DOMAIN/g" "$file"
    sed -i -r -e "s/\[\"[\.0-9]+?:9090\".*?\]/[\"$DOMAIN:9090\"]/g" "$file"
    sed -i -r -e "s/C\:\/Users\/.+?_privkey.pem/\/etc\/letsencrypt\/live\/$DOMAIN\/privkey.pem/g" "$file"
    sed -i -r -e "s/C\:\/Users\/.+?_fullchain.pem/\/etc\/letsencrypt\/live\/$DOMAIN\/fullchain.pem/g" "$file"
    sed -i -r -e "s/\"secure\": false/\"secure\": true/g" "$file"
done
