#!/bin/bash

dpkg -s zip &> /dev/null
if [ $? -ne 0 ]
then
    echo "Installing zip"
    sudo apt install zip
fi

dpkg -s jq &> /dev/null
if [ $? -ne 0 ]
then
    echo "Installing jq"
    sudo apt install jq
fi

npm install
npm update

npx rollup -c rollup.config.js

rm singlefile-extension-chromium.zip singlefile-extension-edge.zip

zip -r singlefile-extension-chromium.zip manifest.json lib _locales src

cp src/core/bg/config.js config.copy.js
sed -i "" 's/forceWebAuthFlow: false/forceWebAuthFlow: true/g' src/core/bg/config.js
sed -i "" 's/image\/avif,//g' src/core/bg/config.js
zip -r singlefile-extension-edge.zip manifest.json lib _locales src
mv config.copy.js src/core/bg/config.js