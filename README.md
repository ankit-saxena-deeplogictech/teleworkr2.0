# Teleworkr 2.0
Remote work, collaboration and telepresence platform built on the Monkshu server.

Getting Started
===============
Step 1: Download the Monkshu server https://github.com/TekMonks/monkshu.git  
Step 2: Clone this repository next to the Monkshu checkout (siblings of the same parent folder)  
Step 3: Run `<monkshu>/mklink.sh teleworkr2.0` to link this app's frontend and backend apps into Monkshu  
Step 4: Run `sh install.sh.bat` to install the required NPMs etc.  
Step 5: Start the backend using `<monkshu>/backend/server/server.sh`  
Step 6: Start the frontend using `<monkshu>/frontend/server/server.sh`  
Step 7: Browse to https://<your IP>/ 

Layout
======
```
backend/apps/teleworkr     Backend app - APIs, libs, conf, DB schema, plugins
frontend/apps/teleworkr    Frontend app - views, components, i18n, conf, assets
```

Login
=====
Uses Tekmonks Unified Login. Configure `tkmlogin_api` in `backend/apps/teleworkr/conf/teleworkr.json`.

Scripts
=======
| Script | Purpose |
| --- | --- |
| `install.sh.bat` | Installs the NPM dependencies |
| `mklinktw.sh` / `rmlinktw.sh` | Mounts / unmounts an external app into `backend/apps/teleworkr/3p` |
| `changeHosts.sh` | Rewrites hostnames and SSL paths across the conf files |
| `cleanDBs.sh` / `cleanDBs.bat` | Wipes the runtime databases and CMS folders |
| `webpack.config.js` | Builds the frontend web bundle |
